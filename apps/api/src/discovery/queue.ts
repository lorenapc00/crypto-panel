import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { discoveryJobs, type DiscoveryJob } from './providers.js';

export type Run = { id: string; job_id: string; lease_token: string; attempts: number };
type Budget = { providers: { id: string; enabled?: boolean; localLimit: { requestsPerMinute?: number; weightPerMinute?: number; requestsPerMonth: number } }[] };
export async function transaction<T>(database: Pool, action: (client: PoolClient) => Promise<T>) {
  const client = await database.connect();
  try {
    await client.query('begin');
    const result = await action(client);
    await client.query('commit');
    return result;
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

export async function configureWorker(database: Pool, jobs = discoveryJobs) {
  const raw = await readFile(new URL('../../../../docs/data/quota-budget.json', import.meta.url), 'utf8');
  const budget: Budget = JSON.parse(raw);
  const version = createHash('sha256').update(raw).digest('hex');
  await transaction(database, async client => {
    await client.query("select pg_advisory_xact_lock(hashtext(current_schema()), hashtext('discovery-config'))");
    for (const provider of [...new Set(jobs.map(job => job.provider))].sort()) {
      const policy = budget.providers.find(row => row.id === provider);
      if (!policy || policy.enabled === false) throw new Error(`Provider not enabled in budget: ${provider}`);
      const rate = policy.localLimit.weightPerMinute ?? policy.localLimit.requestsPerMinute;
      const capacity = Math.max(...jobs.filter(job => job.provider === provider).map(job => job.weight));
      if (!rate || capacity > rate || policy.localLimit.requestsPerMonth <= 0) throw new Error(`Invalid provider budget: ${provider}`);
      await client.query(`insert into worker_provider_limits (provider_id, units_per_minute, bucket_capacity, requests_per_month, budget_version)
        values ($1,$2,$3,$4,$5) on conflict (provider_id) do update set units_per_minute=$2, bucket_capacity=$3, requests_per_month=$4, budget_version=$5`,
      [provider, rate, capacity, policy.localLimit.requestsPerMonth, version]);
      await client.query(`insert into worker_provider_state (provider_id, tokens) values ($1,$2) on conflict do nothing`, [provider, capacity]);
    }
    for (const job of jobs) {
      const definition = [job.id, job.provider, job.kind, job.scope, job.intervalSeconds, job.membership, job.methodologyVersion ?? 'discovery:v1'];
      await client.query(`insert into discovery_datasets (id, source_id, kind, scope, interval_seconds, membership, methodology_version)
        values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`, definition);
      const compatible = await client.query(`select 1 from discovery_datasets where id=$1 and source_id=$2 and kind=$3
        and scope=$4 and interval_seconds=$5 and membership=$6 and methodology_version=$7`, definition);
      if (!compatible.rowCount) throw new Error(`Dataset definition changed: ${job.id}; use a new version`);
      await client.query(`insert into worker_jobs (id, provider_id, interval_seconds, next_run_at)
        values ($1,$2,$3::integer,to_timestamp(floor((extract(epoch from clock_timestamp())-$4::integer) / $3::integer) * $3::integer+$4::integer)) on conflict do nothing`,
      [job.id, job.provider, job.intervalSeconds, job.offsetSeconds ?? 0]);
    }
  });
}

// Recovery and scheduling share one short lock; network requests never hold it.
// Lost historical slots become gaps. We acquire only current observations.
export async function schedule(database: Pool) {
  return transaction(database, async client => {
    await client.query("select pg_advisory_xact_lock(hashtext(current_schema()), hashtext('discovery-schedule'))");
    const now = (await client.query('select clock_timestamp() as now')).rows[0].now as Date;
    const expired = await client.query(`update worker_runs r set status=case
        when r.scheduled_at + j.interval_seconds * interval '1 second' <= $1 then 'missed'
        when r.attempts >= 3 then 'failed' else 'retry' end,
        available_at=$1, lease_token=null, lease_until=null, error='Worker lease expired'
      from worker_jobs j where j.id=r.job_id and r.status='running' and r.lease_until <= $1
      returning r.*`, [now]);
    const obsolete = await client.query(`update worker_runs r set status='missed', finished_at=$1, error='Acquisition interval elapsed'
      from worker_jobs j where j.id=r.job_id and r.status in ('queued','retry')
      and r.scheduled_at + j.interval_seconds * interval '1 second' <= $1 returning r.*`, [now]);
    for (const row of [...expired.rows, ...obsolete.rows]) if (['missed', 'failed'].includes(row.status)) {
      await client.query('update worker_runs set finished_at=$2 where id=$1', [row.id, now]);
      await gap(client, row.job_id, row.scheduled_at, row.scheduled_at, 1, row.error);
    }
    const due = await client.query('select * from worker_jobs where enabled and next_run_at <= $1 order by id for update', [now]);
    for (const job of due.rows) {
      const step = job.interval_seconds * 1000;
      const missed = Math.floor((now.getTime() - job.next_run_at.getTime()) / step);
      const latest = new Date(job.next_run_at.getTime() + missed * step);
      if (missed) await gap(client, job.id, job.next_run_at, new Date(latest.getTime() - step), missed, 'Worker did not schedule these intervals');
      await client.query('insert into worker_runs (job_id, scheduled_at) values ($1,$2) on conflict do nothing', [job.id, latest]);
      await client.query('update worker_jobs set next_run_at=$2 where id=$1', [job.id, new Date(latest.getTime() + step)]);
    }
  });
}

async function gap(client: PoolClient, job: string, from: Date, to: Date, count: number, reason: string) {
  await client.query(`insert into worker_gaps (job_id, first_missing_at, last_missing_at, missing_intervals, reason)
    values ($1,$2,$3,$4,$5)`, [job, from, to, count, reason]);
}

export async function claim(database: Pool): Promise<Run | null> {
  return transaction(database, async client => {
    // Lock the job as well as the run so concurrent workers cannot run two slots
    // for one dataset. SKIP LOCKED still lets independent providers progress.
    const result = await client.query(`select r.id from worker_runs r join worker_jobs j on j.id=r.job_id
      where j.enabled and r.status in ('queued','retry') and r.available_at <= clock_timestamp()
      and r.scheduled_at + j.interval_seconds * interval '1 second' > clock_timestamp()
      and not exists (select 1 from worker_runs active where active.job_id=r.job_id and active.status='running')
      order by r.available_at, r.id for update of j, r skip locked limit 1`);
    if (!result.rowCount) return null;
    const claimed = await client.query(`update worker_runs set status='running', lease_token=$2,
      lease_until=clock_timestamp() + interval '90 seconds', started_at=coalesce(started_at,clock_timestamp())
      where id=$1 returning id, job_id, lease_token, attempts`, [result.rows[0].id, randomUUID()]);
    return claimed.rows[0];
  });
}

export async function lockRun(client: PoolClient, run: Run) {
  const result = await client.query(`select * from worker_runs where id=$1 and lease_token=$2
    and status='running' and lease_until > clock_timestamp() for update`, [run.id, run.lease_token]);
  if (!result.rowCount) throw new Error('Worker lease lost');
}

type Reservation = { id: string; requestedAt: string; attempt: number };
async function reserveProvider(client: PoolClient, provider: string, weight: number, runId: string | null, purpose: string, endpoint: string | null) {
  const result = await client.query(`select s.*,l.units_per_minute,l.bucket_capacity,l.requests_per_month
    from worker_provider_state s join worker_provider_limits l using(provider_id) where provider_id=$1 for update of s`, [provider]);
  const policy = result.rows[0];
  if (!policy || weight > policy.bucket_capacity || weight <= 0 || !Number.isSafeInteger(weight)) throw new Error('Request outside configured quota');
  const clock = (await client.query(`select clock_timestamp() as now,
    date_trunc('month',clock_timestamp() at time zone 'UTC')::date as month,
    (date_trunc('month',clock_timestamp() at time zone 'UTC') + interval '1 month') at time zone 'UTC' as next_month`)).rows[0];
  await client.query('insert into worker_monthly_usage (provider_id,month) values ($1,$2) on conflict do nothing', [provider,clock.month]);
  const used = (await client.query('select requests from worker_monthly_usage where provider_id=$1 and month=$2', [provider,clock.month])).rows[0].requests;
  const tokens = Math.min(policy.bucket_capacity,Number(policy.tokens)+Math.max(0,clock.now.getTime()-policy.updated_at.getTime())*policy.units_per_minute/60000);
  let available = clock.now.getTime();
  if (used >= policy.requests_per_month) available = Math.max(available,clock.next_month.getTime());
  if (policy.blocked_until) available = Math.max(available,policy.blocked_until.getTime());
  if (tokens < weight) available = Math.max(available,clock.now.getTime()+Math.ceil((weight-tokens)*60000/policy.units_per_minute));
  if (available > clock.now.getTime()) return { request:null, availableAt:new Date(available), waitMs:available-clock.now.getTime(), reason:used >= policy.requests_per_month ? 'Monthly quota exhausted' : 'Provider pacing or backoff' };
  await client.query('update worker_provider_state set tokens=$2,updated_at=$3 where provider_id=$1', [provider,tokens-weight,clock.now]);
  await client.query('update worker_monthly_usage set requests=requests+1 where provider_id=$1 and month=$2', [provider,clock.month]);
  const attempt = runId ? (await client.query('update worker_runs set attempts=attempts+1 where id=$1 returning attempts', [runId])).rows[0].attempts : 1;
  const row = (await client.query(`insert into worker_requests (provider_id,run_id,weight,purpose,endpoint)
    values ($1,$2,$3,$4,$5) returning id,requested_at::text`, [provider,runId,weight,purpose,endpoint])).rows[0];
  return { request:{id:row.id,requestedAt:row.requested_at,attempt} as Reservation, availableAt:clock.now,waitMs:0,reason:null };
}
export async function reserveRequest(database: Pool, run: Run, job: DiscoveryJob): Promise<Reservation | null> {
  return transaction(database, async client => {
    await lockRun(client,run);
    const reservation = await reserveProvider(client,job.provider,job.weight,run.id,'scheduled',job.endpoint);
    if (!reservation.request) await client.query(`update worker_runs set status='retry',available_at=$2,lease_token=null,lease_until=null,error=$3 where id=$1`,
      [run.id,reservation.availableAt,reservation.reason]);
    return reservation.request;
  });
}
export async function reserveExternalRequest(database: Pool, provider: string, weight: number, purpose: string, endpoint: string) {
  return transaction(database,client => reserveProvider(client,provider,weight,null,purpose,endpoint));
}

// Manual requests use the same configured provider policy, without reducing a
// bucket configured for heavier scheduled jobs. Disabled feeds stay gated.
export async function configureExternalProvider(database: Pool, provider: string, weight: number, probe = false) {
  const raw = await readFile(new URL('../../../../docs/data/quota-budget.json',import.meta.url),'utf8');
  const budget: Budget = JSON.parse(raw), policy = budget.providers.find(row=>row.id===provider);
  const rate = policy?.localLimit.weightPerMinute ?? policy?.localLimit.requestsPerMinute;
  if (!policy || (!probe && policy.enabled === false) || !rate || weight > rate || policy.localLimit.requestsPerMonth <= 0) throw new Error(`Provider acquisition gated: ${provider}`);
  await transaction(database,async client=>{
    await client.query("select pg_advisory_xact_lock(hashtext(current_schema()),hashtext('discovery-config'))");
    await client.query(`insert into worker_provider_limits (provider_id,units_per_minute,bucket_capacity,requests_per_month,budget_version)
      values ($1,$2,$3,$4,$5) on conflict (provider_id) do update set units_per_minute=$2,
      bucket_capacity=greatest(worker_provider_limits.bucket_capacity,$3),requests_per_month=$4,budget_version=$5`,
      [provider,rate,weight,policy.localLimit.requestsPerMonth,createHash('sha256').update(raw).digest('hex')]);
    await client.query('insert into worker_provider_state (provider_id,tokens) values ($1,$2) on conflict do nothing',[provider,weight]);
  });
}

export async function retryCurrentFailures(database:Pool) {
  return (await database.query(`update worker_runs r set status='retry',available_at=clock_timestamp(),finished_at=null,
    lease_token=null,lease_until=null from worker_jobs j where j.id=r.job_id and j.enabled and r.status='failed'
    and r.attempts<3 and r.scheduled_at+j.interval_seconds*interval '1 second'>clock_timestamp() returning r.id`)).rowCount;
}

export function retryDelay(retryAfter: string | null, now: number, attempt: number, random = Math.random()): number {
  const exponential = Math.min(300000, 5000 * 2 ** Math.max(0, attempt - 1)) + Math.floor(random * 1000);
  if (!retryAfter) return exponential;
  const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
  return Number.isFinite(seconds) ? Math.max(exponential, seconds) : exponential;
}

export async function failRun(database: Pool, run: Run, error: string, retryMilliseconds?: number) {
  await transaction(database, async client => {
    await lockRun(client, run);
    const result = await client.query(`update worker_runs set
      status=case when $3::double precision is not null and attempts < 3 then 'retry' else 'failed' end,
      available_at=clock_timestamp() + coalesce($3,0) * interval '1 millisecond',
      finished_at=case when $3::double precision is not null and attempts < 3 then null else clock_timestamp() end,
      error=$2, lease_token=null, lease_until=null where id=$1 returning *`, [run.id, error, retryMilliseconds ?? null]);
    const row = result.rows[0];
    if (row.status === 'failed') await gap(client, row.job_id, row.scheduled_at, row.scheduled_at, 1, error);
  });
}
