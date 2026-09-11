import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate, loadMigrations } from '../src/migrations.js';
import { configureWorker, claim } from '../src/discovery/queue.js';
import { executeRun } from '../src/discovery/worker.js';
import { btcHistoryJob } from '../src/feeds/bitcoin.js';
import { sentimentJobs } from '../src/feeds/sentiment.js';
import { runBacktests } from '../src/backtest/executor.js';
import { apiServer } from '../src/server.js';

async function isolated(run: (database: Pool) => Promise<void>) {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `sentiment_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try { await admin.query(`create schema ${schema}`); await migrate(database); await run(database); }
  finally { await database.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); }
}

const btcPayload = () => ({ data: Array.from({ length: 1000 }, (_, i) => ({ asset: 'btc',
  time: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString(),
  PriceUSD: String(20000 + 8000 * Math.sin(i / 60)), CapMrktCurUSD: '10000', CapMVRVCur: '2', SplyCur: '10' })) });
// A slow sine wave over 2,600 days (2019-07 .. 2026-09) crosses both a low and a high
// fear/greed threshold repeatedly, well past the 2020 and 2024 halvings.
const fearGreedPayload = (receivedAt: string) => ({ data: Array.from({ length: 2600 }, (_, i) => ({
  value: String(50 + Math.round(45 * Math.sin(i / 90))), value_classification: 'x',
  timestamp: String(Math.floor(Date.parse(receivedAt) / 86400000 - 2600 + i) * 86400) })) });

async function seed(database: Pool) {
  await configureWorker(database, [btcHistoryJob, ...sentimentJobs]);
  await database.query('update worker_provider_state set tokens=1,updated_at=clock_timestamp(),blocked_until=null');
  for (const job of [btcHistoryJob, ...sentimentJobs]) {
    await database.query('insert into worker_runs (job_id,scheduled_at) values ($1,clock_timestamp())', [job.id]);
    const run = await claim(database); assert.ok(run);
    const now = (await database.query('select clock_timestamp()::text as t')).rows[0].t as string;
    const payload = job === btcHistoryJob ? btcPayload() : fearGreedPayload(now);
    assert.equal((await executeRun(database, run, job, async () => new Response(JSON.stringify(payload)))).status, 'succeeded');
  }
}

async function withServer(database: Pool, use: (base: string) => Promise<void>) {
  const server = apiServer(database).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  try { await use(base); } finally { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
}

test('migration 0013 registers the alternative.me source and the fear-greed metric', async () => isolated(async database => {
  const applied = (await database.query('select count(*)::int as n from schema_migrations')).rows[0].n;
  assert.equal(applied, (await loadMigrations()).length);
  assert.equal((await database.query("select 1 from sources where id='alternative-me'")).rowCount, 1);
  assert.equal((await database.query("select 1 from metric_definitions where code='fear_greed_index'")).rowCount, 1);
}));

test('the worker archives Fear & Greed and GET /btc/sentiment returns points and cycle segmentation', async () => isolated(async database => {
  await seed(database);
  await withServer(database, async base => {
    const { data } = await fetch(`${base}/btc/sentiment`).then(r => r.json()) as any;
    assert.ok(data.points.length > 2000);
    assert.ok(data.points.every((p: any) => p.value === null || (p.value >= 0 && p.value <= 100)));
    assert.equal(data.cycles.length, 4); // one entry per halving in btc/calculations.ts
    const covered = data.cycles.filter((c: any) => c.points.length > 0);
    assert.ok(covered.length >= 2); // 2020 and 2024 halvings fall inside the fixture's window
    assert.ok(data.coverage.replayCoverageStart);
    assert.equal((await fetch(`${base}/btc/sentiment?asOf=2015-01-01`)).status, 409);
  });
}));

test('a custom strategy with a fear-greed guard executes against the archived indicator', async () => isolated(async database => {
  await seed(database);
  await withServer(database, async base => {
    const post = (data: unknown) => fetch(`${base}/backtest/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const spec = { contribution: { amountUsd: 500, cadence: 'monthly', day: 1 },
      entry: { trigger: 'monthly', day: 1, guard: { type: 'fear-greed', op: 'lte', value: 20 }, size: { type: 'all-cash' }, redeploy: 'immediate' },
      exit: { trigger: { type: 'fear-greed', op: 'gte', value: 80 }, size: { type: 'all' } } };
    const created = await (await post({ templateKey: 'custom-strategy', params: spec })).json() as any;
    assert.deepEqual(await runBacktests(database), [`${created.data.id}:succeeded`]);
    const done = await fetch(`${base}/backtest/runs/${created.data.id}`).then(r => r.json()) as any;
    assert.equal(done.data.status, 'succeeded');
    assert.ok(done.data.result.ledger.buys > 0);
    assert.ok(done.data.result.ledger.sells > 0);
  });
}));
