import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../src/migrations.js';
import { configureWorker, claim } from '../src/discovery/queue.js';
import { executeRun } from '../src/discovery/worker.js';
import { discoveryJobs, type DiscoveryJob } from '../src/discovery/providers.js';
import { capitalJobs, capitalSeriesId } from '../src/feeds/capital.js';
import { venueJobs } from '../src/feeds/venue.js';
import { readSeries } from '../src/archive.js';
import { btcContext, nativeBtcDataset } from '../src/btc/context.js';
import { seriesHealth } from '../src/health.js';
import { apiServer } from '../src/server.js';

async function isolated(run: (database: Pool) => Promise<void>) {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `context_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try { await admin.query(`create schema ${schema}`); await migrate(database); await run(database); }
  finally { await database.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); }
}
const history = (revised = false) => Array.from({ length: 40 }, (_, i) => ({ date: String(Date.UTC(2020, 0, 1 + i) / 1000), totalCirculatingUSD: { peggedUSD: revised && i === 39 ? null : 100 + i } }));
const catalog = { peggedAssets: [{ id: '1', name: 'Dollar', symbol: 'USD', pegType: 'peggedUSD', circulating: { peggedUSD: 100 }, chains: ['Ethereum'], price: 1 }] };
async function ingest(database: Pool, job: DiscoveryJob, payload: unknown) {
  await configureWorker(database, [job]);
  await database.query('update worker_provider_state s set tokens=l.bucket_capacity,updated_at=clock_timestamp(),blocked_until=null from worker_provider_limits l where l.provider_id=s.provider_id');
  await database.query('insert into worker_runs (job_id,scheduled_at) values ($1,clock_timestamp())', [job.id]);
  const run = await claim(database); assert.ok(run);
  return executeRun(database, run, job, async () => new Response(JSON.stringify(payload)));
}
test('capital archive has aggregate scope, shares quotas and preserves replay through null revisions', async () => isolated(async database => {
  assert.equal((await ingest(database, capitalJobs[0], history())).status, 'succeeded');
  const cutoff = (await database.query('select clock_timestamp()::text as time')).rows[0].time;
  const before = await readSeries(capitalSeriesId, { asOf: cutoff }, database);
  assert.equal((await ingest(database, capitalJobs[0], history(true))).status, 'succeeded');
  assert.deepEqual(await readSeries(capitalSeriesId, { asOf: cutoff }, database), before);
  assert.equal((await readSeries(capitalSeriesId, {}, database))!.points.at(-1)!.value, null);
  await assert.rejects(readSeries(capitalSeriesId, { asOf: '2019-01-01' }, database), /before/);
  assert.equal((await database.query('select asset_id from data_series where id=$1', [capitalSeriesId])).rows[0].asset_id, null);
  assert.equal((await database.query('select count(*)::int as n from assets')).rows[0].n, 0);
  const health = await seriesHealth(database); assert.equal(health.length, 1); assert.equal(health[0].state, 'unavailable');
  assert.equal((await database.query("select requests from worker_monthly_usage where provider_id='defillama'")).rows[0].requests, 2);
}));
test('BTC context keeps venue and capital revisions fixed at cutoff, with no HTTP acquisition', async () => isolated(async database => {
  const nativeJob = discoveryJobs.find(j => j.id === nativeBtcDataset)!;
  const native = (oi: string) => [{ universe: [{ name: 'BTC' }] }, [{ openInterest: oi, markPx: '100', funding: '-0.0001' }]];
  for (const [job, payload] of [[capitalJobs[0], history()], [capitalJobs[1], catalog], [nativeJob, native('2')],
    [venueJobs[1], [{ coin: 'BTC', time: Date.now() - 1000, fundingRate: '0.0002' }]]] as const) assert.equal((await ingest(database, job, payload)).status, 'succeeded');
  const cutoff = (await database.query('select clock_timestamp()::text as time')).rows[0].time;
  const before = await btcContext(database, cutoff);
  await ingest(database, nativeJob, native('5')); await ingest(database, capitalJobs[0], history(true));
  assert.deepEqual(await btcContext(database, cutoff), before);
  const current = await btcContext(database);
  assert.equal(current.data.venue.estimatedNotional.value, 500); assert.equal(current.data.capital.latest!.value, null);
  assert.equal(current.data.venue.sampledFunding.value, -0.0001); assert.equal(current.data.venue.settledFunding.value, 0.0002);
  const server = apiServer(database).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  try {
    const count = (await database.query('select count(*)::int as n from worker_requests')).rows[0].n;
    assert.equal((await fetch(`${base}/btc/context`)).status, 200);
    assert.equal((await fetch(`${base}/btc/context?asOf=2019-01-01`)).status, 409);
    assert.equal((await fetch(`${base}/btc/context?asOf=bad`)).status, 400);
    assert.equal((await fetch(`${base}/btc/context`, { method: 'POST' })).status, 405);
    const aggregate: any = await fetch(`${base}/series?seriesId=${encodeURIComponent(capitalSeriesId)}`).then(r => r.json());
    assert.equal(aggregate.data[0].metadata.scope, 'covered_usd_pegged_stablecoins');
    assert.equal((await database.query('select count(*)::int as n from worker_requests')).rows[0].n, count);
  } finally { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
}));
test('failed capital acquisition retains evidence and leaves independently missing context unavailable', async () => isolated(async database => {
  const empty = await btcContext(database);
  assert.equal(empty.data.venue.openInterest.unavailable, true); assert.equal(empty.data.capital.coverage.unavailable, true);
  await ingest(database, capitalJobs[0], history());
  const before = (await btcContext(database)).data.capital;
  assert.equal((await ingest(database, capitalJobs[0], { error: 'bad response' })).status, 'invalid-response');
  const after = await btcContext(database);
  assert.deepEqual(after.data.capital, before);
  assert.equal(after.data.capital.coverage.stale, true); assert.equal(after.data.capital.catalog.coverage.unavailable, true);
  assert.equal(after.data.venue.openInterest.value, null);
}));
