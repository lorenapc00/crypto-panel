import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate, loadMigrations } from '../src/migrations.js';
import { configureWorker, claim } from '../src/discovery/queue.js';
import { executeRun } from '../src/discovery/worker.js';
import { btcHistoryJob } from '../src/feeds/bitcoin.js';
import { runBacktests } from '../src/backtest/executor.js';
import { apiServer } from '../src/server.js';

async function isolated(run: (database: Pool) => Promise<void>) {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `backtest_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try { await admin.query(`create schema ${schema}`); await migrate(database); await run(database); }
  finally { await database.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); }
}

// Sine-wave BTC closes over ~2.7 years give the confirmed regime several bullish and
// bearish spans for the strategy to trade against.
const payload = () => ({ data: Array.from({ length: 1000 }, (_, i) => ({ asset: 'btc',
  time: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString(),
  PriceUSD: String(20000 + 8000 * Math.sin(i / 60)), CapMrktCurUSD: '10000', CapMVRVCur: '2', SplyCur: '10' })) });

async function seedBtc(database: Pool) {
  await configureWorker(database, [btcHistoryJob]);
  await database.query('update worker_provider_state set tokens=1,updated_at=clock_timestamp(),blocked_until=null');
  await database.query('insert into worker_runs (job_id,scheduled_at) values ($1,clock_timestamp())', [btcHistoryJob.id]);
  const run = await claim(database); assert.ok(run);
  assert.equal((await executeRun(database, run, btcHistoryJob, async () => new Response(JSON.stringify(payload())))).status, 'succeeded');
}

async function withServer(database: Pool, use: (base: string) => Promise<void>) {
  const server = apiServer(database).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  try { await use(base); } finally { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
}
const post = (base: string, path: string, data: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

test('migration 0012 adds backtest_runs to the applied history', async () => isolated(async database => {
  const applied = (await database.query('select count(*)::int as n from schema_migrations')).rows[0].n;
  assert.equal(applied, (await loadMigrations()).length);
  assert.equal((await database.query("select to_regclass('backtest_runs') is not null as present")).rows[0].present, true);
}));

test('a queued BTC regime backtest is executed by the worker queue and frozen', async () => isolated(async database => {
  await seedBtc(database);
  await withServer(database, async base => {
    const created = await post(base, '/backtest/runs', { templateKey: 'btc-regime-filter', params: { costBps: 50 } });
    assert.equal(created.status, 202);
    const { data } = await created.json() as any;
    assert.equal(data.status, 'queued');

    assert.deepEqual(await runBacktests(database), [`${data.id}:succeeded`]);

    const done = await fetch(`${base}/backtest/runs/${data.id}`).then(r => r.json()) as any;
    assert.equal(done.data.status, 'succeeded');
    assert.equal(done.data.result.methodologyVersion, 'btc-regime-strategy:v1');
    assert.ok(done.data.result.strategy.stats.cagrPct !== undefined);
    assert.equal(done.data.result.benchmark.label, 'BTC buy-and-hold');
    assert.equal(done.data.result.costSensitivity.length, 3);
    assert.ok(done.data.result.equity.strategy.length > 100);
    assert.equal(done.data.result.dataset.seriesId, 'coinmetrics:bitcoin:price_usd:daily:v1');

    await assert.rejects(database.query("update backtest_runs set result='{}'::jsonb where id=$1", [data.id]), /immutable/);
    await assert.rejects(database.query("update backtest_runs set status='queued' where id=$1", [data.id]), /immutable/);
    await assert.rejects(database.query('delete from backtest_runs where id=$1', [data.id]), /append-only|immutable/);
  });
}));

test('an identical request reproduces the stored result instead of recomputing', async () => isolated(async database => {
  await seedBtc(database);
  await withServer(database, async base => {
    const first = await (await post(base, '/backtest/runs', { templateKey: 'btc-regime-filter', params: {} })).json() as any;
    await runBacktests(database);
    const repeat = await post(base, '/backtest/runs', { templateKey: 'btc-regime-filter', params: {} });
    assert.equal(repeat.status, 200);
    const body = await repeat.json() as any;
    assert.equal(body.data.reproduced, true);
    assert.equal(body.data.id, first.data.id);
    assert.equal(body.data.inputHash, first.data.inputHash);
    const stored = (await database.query('select count(*)::int as n from backtest_runs')).rows[0].n;
    assert.equal(stored, 1);
  });
}));

test('deferred templates and invalid parameters are refused', async () => isolated(async database => {
  await withServer(database, async base => {
    assert.equal((await post(base, '/backtest/runs', { templateKey: 'emerging-attention-basket', params: {} })).status, 422);
    assert.equal((await post(base, '/backtest/runs', { templateKey: 'nope', params: {} })).status, 404);
    assert.equal((await post(base, '/backtest/runs', { templateKey: 'btc-regime-filter', params: { holdoutPct: 5 } })).status, 400);
    assert.equal((await post(base, '/backtest/runs', { templateKey: 'btc-regime-filter', params: { from: '2020-13-01' } })).status, 400);
  });
}));

test('historical replay refuses cutoffs before a dataset began archiving', async () => isolated(async database => {
  await seedBtc(database);
  // Captured after archiving, so it is past every coverage start but not in the future.
  const covered = (await database.query('select clock_timestamp()::text as t')).rows[0].t;
  await withServer(database, async base => {
    assert.equal((await fetch(`${base}/backtest/replay`)).status, 400);

    const old = await fetch(`${base}/backtest/replay?asOf=2019-01-01T00:00:00Z`);
    assert.equal(old.status, 409);
    assert.match((await old.json() as any).error, /predates production coverage/);

    const now = await fetch(`${base}/backtest/replay?asOf=${encodeURIComponent(covered)}`).then(r => r.json()) as any;
    assert.equal(typeof now.data.marketOverview.regime, 'string');
    assert.equal(now.data.classification, 'point-in-time');
    assert.equal(now.data.everyWorkspaceRefused, false);
  });
}));

test('the templates endpoint lists gates and the replay-coverage horizon', async () => isolated(async database => {
  await seedBtc(database);
  await withServer(database, async base => {
    const { data } = await fetch(`${base}/backtest/templates`).then(r => r.json()) as any;
    assert.equal(data.templates.length, 5);
    const regime = data.templates.find((t: any) => t.key === 'btc-regime-filter');
    assert.equal(regime.status, 'available');
    assert.ok(data.templates.filter((t: any) => t.status === 'deferred').every((t: any) => t.gate));
    assert.ok(data.coverage.series.some((s: any) => s.id === 'coinmetrics:bitcoin:price_usd:daily:v1' && s.replayCoverageStart));
  });
}));
