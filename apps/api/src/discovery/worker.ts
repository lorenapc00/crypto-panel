import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { discoveryJobs, type DiscoveryJob } from './providers.js';
import { archiveDiscovery } from './archive.js';
import { claim, failRun, reserveRequest, retryDelay, transaction, lockRun, type Run } from './queue.js';

export async function executeRun(database: Pool, run: Run, job: DiscoveryJob, fetchImpl: typeof fetch = fetch) {
  if (job.request) {
    const request = await job.request(database);
    if (!request) {
      await transaction(database,async client=>{
        await lockRun(client,run);
        await client.query(`update worker_runs set status='skipped',finished_at=clock_timestamp(),
          error='No eligible source member',lease_token=null,lease_until=null where id=$1`,[run.id]);
      });
      return {status:'skipped'};
    }
    job = {...job,...request};
  }
  const request = await reserveRequest(database, run, job);
  if (!request) return { status: 'deferred' };
  let response: Response;
  let raw: string;
  try {
    response = await fetchImpl(job.endpoint, {
      method: job.body ? 'POST' : 'GET', body: job.body ? JSON.stringify(job.body) : undefined,
      headers: { Accept: job.provider === 'geckoterminal' ? 'application/json;version=20230302' : 'application/json',
        ...(job.provider === 'coingecko' && process.env.COINGECKO_DEMO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_DEMO_API_KEY } : {}),
        ...(job.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(20000), redirect: 'error',
    });
    raw = await response.text();
  } catch {
    await database.query(`update worker_requests set finished_at=clock_timestamp(),error='Network request failed' where id=$1`, [request.id]);
    const delay = retryDelay(null, Date.now(), request.attempt);
    await blockProvider(database, job.provider, delay);
    await failRun(database, run, 'Network request failed', delay);
    return { status: 'request-failed' };
  }
  let parsed: unknown, validJson = true;
  try { parsed = JSON.parse(raw); } catch { parsed = null; validJson = false; }
  // Keep even rejected response bodies as provenance; only validated responses
  // can create membership snapshots or start the production archive clock.
  const payload = await transaction(database, async client => {
    const result = await client.query(`insert into source_payloads
      (source_id,endpoint,requested_at,received_at,sha256,payload,request_body,raw_body)
      values ($1,$2,$3,clock_timestamp(),$4,$5::jsonb,$6::jsonb,$7) returning id, received_at::text`,
    [job.provider, job.endpoint, request.requestedAt, createHash('sha256').update(raw).digest('hex'), JSON.stringify(parsed), JSON.stringify(job.body ?? null), raw]);
    await client.query(`update worker_requests set finished_at=clock_timestamp(),http_status=$2,payload_id=$3,
      error=$4 where id=$1`, [request.id, response.status, result.rows[0].id, response.ok ? null : `HTTP ${response.status}`]);
    return result.rows[0];
  });
  if (!response.ok) {
    const retryable = [408, 429].includes(response.status) || response.status >= 500;
    const now = (await database.query('select extract(epoch from clock_timestamp())::float8 * 1000 as now')).rows[0].now;
    const delay = retryable ? retryDelay(response.headers.get('retry-after'), now, request.attempt) : undefined;
    if (delay != null) await blockProvider(database, job.provider, delay);
    await failRun(database, run, `HTTP ${response.status}`, delay);
    return { status: 'request-failed' };
  }
  let sample;
  try {
    if (!validJson) throw new Error('Invalid provider JSON');
    sample = job.parse(parsed, payload.received_at);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid provider response';
    await database.query('update worker_requests set error=$2 where id=$1', [request.id, message]);
    await failRun(database, run, message);
    return { status: 'invalid-response' };
  }
  return { status: 'succeeded', ...await archiveDiscovery(database, run, job, payload.id, sample) };
}

async function blockProvider(database: Pool, provider: string, delay: number) {
  await database.query(`update worker_provider_state set blocked_until=greatest(blocked_until,
    clock_timestamp() + $2 * interval '1 millisecond') where provider_id=$1`, [provider, delay]);
}

export async function workOne(database: Pool, fetchImpl: typeof fetch = fetch, jobs = discoveryJobs) {
  const run = await claim(database);
  if (!run) return null;
  const job = jobs.find(job => job.id === run.job_id);
  if (!job) { await failRun(database, run, 'Job definition not present in this worker'); return { job: run.job_id, status: 'failed' }; }
  const result = await executeRun(database, run, job, fetchImpl);
  return { job: job.id, ...result };
}
