import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../src/migrations.js';
import { configureWorker, claim } from '../src/discovery/queue.js';
import { executeRun } from '../src/discovery/worker.js';
import { btcHistoryJob, btcSeriesId } from '../src/feeds/bitcoin.js';
import { readSeries } from '../src/archive.js';
import { createSignalStudy, btcArchive, btcView } from '../src/btc/routes.js';
import { signalStudy } from '../src/btc/study.js';
import { apiServer } from '../src/server.js';
import { historyJobs } from '../src/feeds/history.js';
import type { DiscoveryJob } from '../src/discovery/providers.js';

async function isolated(run: (database: Pool) => Promise<void>) {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `btc_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try { await admin.query(`create schema ${schema}`); await migrate(database); await run(database); }
  finally { await database.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); }
}
const payload = (revision = false) => ({ data: Array.from({ length: 800 }, (_, i) => ({ asset: 'btc', time: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString(),
  PriceUSD: String(revision && i === 225 ? 9000 : 1000 + 200 * Math.sin(i / 100)), CapMrktCurUSD: '10000', CapMVRVCur: i === 799 ? null : '2', SplyCur: '10' })) });
async function ingest(database: Pool, job = btcHistoryJob, data: unknown = payload()) {
  await configureWorker(database, [job]);
  await database.query('update worker_provider_state set tokens=1,updated_at=clock_timestamp(),blocked_until=null');
  await database.query('insert into worker_runs (job_id,scheduled_at) values ($1,clock_timestamp())', [job.id]);
  const run = await claim(database); assert.ok(run);
  assert.equal((await executeRun(database, run, job, async () => new Response(JSON.stringify(data)))).status, 'succeeded');
}
test('BTC worker shares quotas, archives all core series, and preserves replay through revisions', async () => isolated(async database => {
  await ingest(database);
  assert.equal((await database.query('select count(*)::int as n from data_series')).rows[0].n, 4);
  const cutoff = (await database.query('select clock_timestamp()::text as time')).rows[0].time;
  const before = await readSeries(btcSeriesId(), { asOf: cutoff, limit: 10000 }, database);
  await ingest(database, btcHistoryJob, payload(true));
  assert.deepEqual(await readSeries(btcSeriesId(), { asOf: cutoff, limit: 10000 }, database), before);
  await assert.rejects(readSeries(btcSeriesId(), { asOf: '2019-01-01' }, database), /before/);
  const view = btcView(await btcArchive(database));
  assert.equal(view.data.latest!.mvrv, null); assert.equal(view.data.latest!.realizedPrice, null);
  assert.equal(view.data.points[0].realizedPrice, 500); assert.equal(view.metadata.stale, true);
  assert.equal((await database.query("select requests from worker_monthly_usage where provider_id='coinmetrics'")).rows[0].requests, 2);
}));
test('saved studies reproduce from frozen input and stay immutable after corrections', async () => isolated(async database => {
  await ingest(database);
  const run = await createSignalStudy(database, { signal: 'custom', eventDates: ['2020-08-13'] });
  const identical = await createSignalStudy(database, { signal: 'custom', eventDates: ['2020-08-13'] });
  assert.equal(identical.input_hash, run.input_hash); assert.deepEqual(identical.result, run.result);
  const saved = (await database.query('select * from signal_studies where id=$1', [run.id])).rows[0];
  assert.deepEqual(signalStudy(saved.input.dataset.points, saved.input.benchmarkDataset.points, saved.input.eventDates), saved.result);
  await ingest(database, btcHistoryJob, payload(true));
  assert.deepEqual((await database.query('select result from signal_studies where id=$1', [run.id])).rows[0].result, saved.result);
  const revised = await createSignalStudy(database, { signal: 'custom', eventDates: ['2020-08-13'] }); assert.notEqual(revised.input_hash, run.input_hash);
  await assert.rejects(database.query("update signal_studies set result='{}' where id=$1", [run.id]), /immutable/);
}));
test('BTC HTTP reads acquire no provider data and reject unsupported replay, dates and methods', async () => isolated(async database => {
  const server = apiServer(database).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  const post = (data: unknown) => fetch(`${base}/signal-studies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  try {
    assert.equal((await fetch(`${base}/btc/cycles`).then(r => r.json()) as any).data.latest, null);
    await ingest(database); const before = (await database.query('select count(*)::int as n from worker_requests')).rows[0].n;
    assert.equal((await fetch(`${base}/btc/cycles`)).status, 200);
    assert.equal((await fetch(`${base}/btc/cycles?asOf=2019-01-01`)).status, 409);
    assert.equal((await fetch(`${base}/btc/cycles?asOf=bad`)).status, 400);
    assert.equal((await fetch(`${base}/btc/cycles`, { method: 'POST' })).status, 405);
    assert.equal((await post({ signal: 'custom', eventDates: ['2020-02-31'] })).status, 400);
    assert.equal((await post({ asOf: '2020-01-01' })).status, 400);
    const created = await post({ signal: 'custom', eventDates: ['2020-01-01'] }); assert.equal(created.status, 201);
    const result = await created.json() as any;
    assert.equal((await fetch(`${base}/signal-studies/${result.data.id}`)).status, 200);
    assert.equal((await database.query('select count(*)::int as n from worker_requests')).rows[0].n, before);
  } finally { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
}));
test('other-asset event studies align CoinGecko samples on both sides instead of mixing BTC date conventions', async () => isolated(async database => {
  for (const asset of ['bitcoin', 'ethereum']) {
    const job = historyJobs.find(j => j.id === `coingecko:${asset}:daily-history:v1`)!;
    const prices = Array.from({ length: 40 }, (_, i) => [Date.UTC(2020, 0, 1) + i * 86400000, asset === 'bitcoin' ? 100 : 100 + i]);
    await ingest(database, job as DiscoveryJob, { prices, total_volumes: prices });
  }
  const result = await createSignalStudy(database, { assetId: 'ethereum', signal: 'custom', eventDates: ['2020-01-01'] });
  const week = result.result.events[0].horizons[1];
  assert.ok(Math.abs(week.returnPct! - 7) < 1e-10); assert.equal(week.btcReturnPct, 0); assert.equal(week.relativeReturnPct, week.returnPct);
  const saved = (await database.query('select input from signal_studies where id=$1', [result.id])).rows[0].input;
  assert.equal(saved.benchmarkDataset.metadata.source, 'coingecko');
}));
