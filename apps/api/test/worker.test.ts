import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../src/migrations.js';
import { ReplayCoverageError } from '../src/archive.js';
import { discoveryJobs, type DiscoveryJob } from '../src/discovery/providers.js';
import { configureWorker, schedule, claim, reserveRequest, type Run } from '../src/discovery/queue.js';
import { archiveDiscovery, readDiscovery, dataHealth } from '../src/discovery/archive.js';
import { executeRun } from '../src/discovery/worker.js';

async function isolated(run: (database: Pool) => Promise<void>) {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required');
  const schema = `worker_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const database = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5, connectionTimeoutMillis: 5000 });
  try {
    await admin.query(`create schema ${schema}`);
    await migrate(database);
    await run(database);
  } finally {
    await database.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
}

const native = discoveryJobs.find(job => job.id === 'hyperliquid:instruments:native:v1')!;
const named = discoveryJobs.find(job => job.id === 'hyperliquid:instruments:xyz:v1')!;
const pools = discoveryJobs.find(job => job.id === 'geckoterminal:pools:base:v1')!;
function instruments(entries: [string, boolean?][]) {
  return [{ universe: entries.map(([name, isDelisted]) => ({ name, isDelisted })), collateralToken: 0 },
    entries.map(() => ({ openInterest: '2', markPx: '10', funding: '0.0001' }))];
}
async function queued(database: Pool, job: DiscoveryJob) {
  return (await database.query(`insert into worker_runs (job_id,scheduled_at) values ($1,clock_timestamp()) returning id`, [job.id])).rows[0].id;
}
async function refill(database: Pool) {
  await database.query(`update worker_provider_state s set tokens=l.bucket_capacity,updated_at=clock_timestamp(),blocked_until=null
    from worker_provider_limits l where s.provider_id=l.provider_id`);
}
async function ingest(database: Pool, job: DiscoveryJob, payload: unknown) {
  await refill(database);
  await queued(database, job);
  const run = await claim(database);
  assert.ok(run);
  return executeRun(database, run, job, async () => new Response(JSON.stringify(payload)));
}

test('worker configuration respects the budget and schedules current slots once across concurrent schedulers', async () => isolated(async database => {
  await Promise.all([configureWorker(database), configureWorker(database)]);
  await Promise.all([schedule(database), schedule(database)]);
  assert.equal((await database.query('select count(*)::int as n from worker_jobs')).rows[0].n, 15);
  assert.equal((await database.query('select count(*)::int as n from worker_runs')).rows[0].n, 15);
  assert.equal((await database.query('select count(*)::int as n from discovery_replay_coverage')).rows[0].n, 0);
  const policy = (await database.query("select * from worker_provider_limits where provider_id='hyperliquid'")).rows[0];
  assert.equal(policy.units_per_minute, 300);
  assert.equal(policy.requests_per_month, 50000);
  assert.equal(policy.bucket_capacity, 20);
  assert.equal((await dataHealth(database)).jobs.length, 15);
}));

test('concurrent workers cannot claim the same run or exceed shared monthly quotas; UTC month rollover restores budget', async () => isolated(async database => {
  await configureWorker(database, [native, named]);
  await queued(database, native);
  await queued(database, named);
  const claims = await Promise.all([claim(database), claim(database), claim(database)]);
  const runs = claims.filter((run): run is Run => run != null);
  assert.equal(runs.length, 2);
  assert.equal(new Set(runs.map(run => run.id)).size, 2);
  await database.query('update worker_provider_limits set requests_per_month=1');
  const reservations = await Promise.all(runs.map(run => reserveRequest(database, run, run.job_id === native.id ? native : named)));
  assert.equal(reservations.filter(Boolean).length, 1);
  assert.equal((await database.query('select requests from worker_monthly_usage')).rows[0].requests, 1);
  assert.equal((await database.query('select sum(weight)::int as n from worker_requests')).rows[0].n, 20);
  const deferred = runs[reservations.findIndex(result => result == null)];
  const deferredState = (await database.query('select * from worker_runs where id=$1', [deferred.id])).rows[0];
  assert.equal(deferredState.status, 'retry');
  assert.equal(deferredState.attempts, 0);
  assert.equal(deferredState.error, 'Monthly quota exhausted');
  await database.query("update worker_monthly_usage set month=(month-interval '1 month')::date");
  await refill(database);
  await database.query('update worker_runs set available_at=clock_timestamp() where id=$1', [deferred.id]);
  const next = await claim(database);
  assert.ok(next);
  assert.ok(await reserveRequest(database, next, next.job_id === native.id ? native : named));
  assert.equal((await database.query('select count(*)::int as n from worker_monthly_usage')).rows[0].n, 2);
}));

test('weighted pacing survives worker reconfiguration and deferrals do not count as HTTP attempts', async () => isolated(async database => {
  await configureWorker(database, [native, named]);
  await queued(database, native);
  const first = (await claim(database))!;
  assert.ok(await reserveRequest(database, first, native));
  await configureWorker(database, [native, named]);
  await queued(database, named);
  const second = (await claim(database))!;
  assert.equal(await reserveRequest(database, second, named), null);
  assert.equal((await database.query('select count(*)::int as n from worker_requests')).rows[0].n, 1);
  const row = (await database.query('select * from worker_runs where id=$1', [second.id])).rows[0];
  assert.equal(row.status, 'retry');
  assert.equal(row.attempts, 0);
  assert.ok(row.available_at > row.started_at);
}));

test('discovery baselines suppress listing events, retain lifecycle transitions and keep earlier replays unchanged', async () => isolated(async database => {
  await configureWorker(database, [native]);
  await assert.rejects(readDiscovery(database, native.id, '2020-01-01'), ReplayCoverageError);
  assert.equal((await ingest(database, native, instruments([['BTC'], ['OLD', true]]))).status, 'succeeded');
  const cutoff = (await database.query('select clock_timestamp()::text as cutoff')).rows[0].cutoff;
  const before = (await readDiscovery(database, native.id, cutoff))!;
  assert.deepEqual(before.events.map(row => row.event_type), ['baseline', 'baseline']);
  assert.equal(before.metadata.baseline, true);
  await ingest(database, native, instruments([['BTC', true], ['OLD'], ['NEW']]));
  const changed = (await readDiscovery(database, native.id))!;
  assert.deepEqual(changed.events.map(row => row.event_type), ['delisted', 'first_observed', 'relisted']);
  await ingest(database, native, instruments([['OLD'], ['NEW']]));
  assert.deepEqual((await readDiscovery(database, native.id))!.events.map(row => row.event_type), ['catalog_absent']);
  await ingest(database, native, instruments([['BTC', true], ['OLD'], ['NEW']]));
  assert.deepEqual((await readDiscovery(database, native.id))!.events.map(row => row.event_type), ['returned']);
  assert.deepEqual(await readDiscovery(database, native.id, cutoff), before);
  await assert.rejects(readDiscovery(database, native.id, '2999-01-01'), /future/);
  await assert.rejects(database.query("update discovery_members set status='active'"), /immutable/);
  await assert.rejects(database.query('delete from discovery_replay_coverage'), /immutable/);
  const raw = (await database.query('select request_body,raw_body from source_payloads order by id limit 1')).rows[0];
  assert.deepEqual(raw.request_body, { type: 'metaAndAssetCtxs', dex: '' });
  assert.deepEqual(JSON.parse(raw.raw_body), instruments([['BTC'], ['OLD', true]]).map(value => JSON.parse(JSON.stringify(value))));
}));

test('sampled pool disappearance produces no closure or relisting event and first observation remains stable', async () => isolated(async database => {
  await configureWorker(database, [pools]);
  const payload = { data: [{ id: 'base_0xabc', attributes: { address: '0xabc', reserve_in_usd: null },
    relationships: { base_token: { data: { id: 'base_0x1' } }, quote_token: { data: { id: 'base_0x2' } } } }] };
  await ingest(database, pools, payload);
  const before = (await readDiscovery(database, pools.id))!;
  await ingest(database, pools, { data: [] });
  assert.deepEqual((await readDiscovery(database, pools.id))!.events, []);
  await ingest(database, pools, payload);
  const after = (await readDiscovery(database, pools.id))!;
  assert.deepEqual(after.events, []);
  assert.deepEqual(after.members[0].first_observed_at, before.members[0].first_observed_at);
  assert.equal(after.members[0].data.liquidityUsd, null);
}));

test('HTTP errors and malformed successes consume quota and retain raw evidence without starting replay coverage', async () => isolated(async database => {
  await configureWorker(database, [native]);
  await queued(database, native);
  const run = (await claim(database))!;
  await executeRun(database, run, native, async () => new Response('not JSON', { status: 200 }));
  const health = await dataHealth(database);
  assert.equal(health.jobs[0].state, 'unavailable');
  assert.equal(health.providers[0].requests_this_month, 1);
  assert.equal(health.providers[0].errors_24h, 1);
  assert.equal(health.gaps[0].missing_intervals, 1);
  assert.equal((await database.query('select raw_body from source_payloads')).rows[0].raw_body, 'not JSON');
  assert.equal((await readDiscovery(database, native.id))!.metadata.replayCoverageStart, null);
  await assert.rejects(readDiscovery(database, native.id, '2020-01-01'), ReplayCoverageError);
}));

test('Retry-After blocks sibling jobs, failed retries are metered, and attempts stop at three', async () => isolated(async database => {
  await configureWorker(database, [native, named]);
  await queued(database, native);
  const run = (await claim(database))!;
  await executeRun(database, run, native, async () => new Response('limited', { status: 429, headers: { 'Retry-After': '120' } }));
  const timing = (await database.query(`select extract(epoch from blocked_until-clock_timestamp())::float8 as delay from worker_provider_state`)).rows[0];
  assert.ok(timing.delay > 115);
  await queued(database, named);
  const sibling = (await claim(database))!;
  let called = false;
  assert.equal((await executeRun(database, sibling, named, async () => { called = true; return new Response('{}'); })).status, 'deferred');
  assert.equal(called, false);
  for (let attempt = 2; attempt <= 3; attempt++) {
    await refill(database);
    await database.query('update worker_runs set available_at=clock_timestamp() where id=$1', [run.id]);
    const retry = (await claim(database))!;
    assert.equal(retry.id, run.id);
    await executeRun(database, retry, native, async () => new Response('unavailable', { status: 503 }));
  }
  const state = (await database.query('select status,attempts from worker_runs where id=$1', [run.id])).rows[0];
  assert.deepEqual(state, { status: 'failed', attempts: 3 });
  assert.equal((await database.query('select requests from worker_monthly_usage')).rows[0].requests, 3);
  assert.equal((await dataHealth(database)).gaps[0].missing_intervals, 1);
}));

test('expired leases cannot append snapshots; recovery preserves consumed quota and fences stale workers', async () => isolated(async database => {
  await configureWorker(database, [native]);
  await database.query("update worker_jobs set next_run_at=clock_timestamp()+interval '1 hour'");
  await queued(database, native);
  const old = (await claim(database))!;
  await reserveRequest(database, old, native);
  await database.query("update worker_runs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [old.id]);
  await schedule(database);
  const recovered = (await claim(database))!;
  assert.equal(recovered.id, old.id);
  assert.notEqual(recovered.lease_token, old.lease_token);
  assert.equal(recovered.attempts, 1);
  await assert.rejects(archiveDiscovery(database, old, native, '1', { members: [], notes: {} }), /lease lost/);
  await assert.rejects(archiveDiscovery(database, recovered, native, '1', { members: [], notes: {} }), /does not belong/);
  assert.equal((await database.query('select requests from worker_monthly_usage')).rows[0].requests, 1);
  assert.equal((await database.query('select count(*)::int as n from discovery_replay_coverage')).rows[0].n, 0);
}));

test('restart records missed slots and detection latency without historical catalog catch-up', async () => isolated(async database => {
  await configureWorker(database, [native]);
  await database.query("update worker_jobs set next_run_at=date_trunc('hour',clock_timestamp())-interval '3 hours'");
  await Promise.all([schedule(database), schedule(database)]);
  const runs = (await database.query('select * from worker_runs')).rows;
  assert.equal(runs.length, 1);
  const gaps = (await database.query('select * from worker_gaps')).rows;
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].missing_intervals, 3);
  assert.ok((await dataHealth(database)).gaps[0].maximum_detection_latency_seconds >= 10800);
  // A deferred request in an elapsed slot is a missed acquisition, not a
  // retrospective request to an endpoint that only returns current state.
  await database.query("update worker_runs set scheduled_at=scheduled_at-interval '1 hour', status='retry'");
  await schedule(database);
  assert.equal(await claim(database), null);
  assert.equal((await database.query('select status from worker_runs')).rows[0].status, 'missed');
  assert.equal((await dataHealth(database)).gaps[0].missing_intervals, 4);
}));
