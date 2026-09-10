import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../src/migrations.js';
import { configureWorker, claim } from '../src/discovery/queue.js';
import { executeRun } from '../src/discovery/worker.js';
import type { DiscoveryJob } from '../src/discovery/providers.js';
import { snapshotJobs, marketDataset, globalDataset } from '../src/snapshots/providers.js';
import { historyJobs } from '../src/feeds/history.js';
import { btcHistoryJob, btcMetrics } from '../src/feeds/bitcoin.js';
import { capitalJobs } from '../src/feeds/capital.js';
import { marketOverviewArchive } from '../src/overview.js';
import { apiServer } from '../src/server.js';

const DAY = 86400000;
async function isolated(run: (database: Pool) => Promise<void>) {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `overview_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try { await admin.query(`create schema ${schema}`); await migrate(database); await run(database); }
  finally { await database.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); }
}
async function ingest(database: Pool, job: DiscoveryJob, payload: unknown, status = 200) {
  await configureWorker(database, [job]);
  await database.query('update worker_provider_state s set tokens=l.bucket_capacity,updated_at=clock_timestamp(),blocked_until=null from worker_provider_limits l where l.provider_id=s.provider_id');
  await database.query('insert into worker_runs (job_id,scheduled_at) values ($1,clock_timestamp())', [job.id]);
  const run = await claim(database); assert.ok(run);
  return executeRun(database, run, job, async () => new Response(JSON.stringify(payload), { status }));
}
const job = (id: string) => snapshotJobs.find(entry => entry.id === id)!;
const coin = (id: string, extra: Record<string, unknown> = {}) => ({ id, symbol: id.slice(0, 4), name: id, market_cap_rank: 1,
  current_price: 10, market_cap: 1000, total_volume: 5, circulating_supply: 10, max_supply: 100,
  price_change_percentage_24h: 2, last_updated: new Date(Date.now() - 1000).toISOString(), ...extra });
const globalValue = (volume = 1234) => ({ data: { total_market_cap: { usd: 10000 }, total_volume: { usd: volume },
  market_cap_percentage: { btc: 51, eth: 12 }, updated_at: Math.floor(Date.now() / 1000) } });
const midnight = Math.floor(Date.now() / DAY) * DAY;
const dailyChart = (start: number, step: number) => {
  const prices = Array.from({ length: 300 }, (_, i) => [midnight - (300 - i) * DAY, start + i * step]);
  return { prices, total_volumes: prices.map(([time]) => [time, 1000]) };
};
const coinMetrics = () => ({ data: Array.from({ length: 300 }, (_, i) => ({ asset: 'btc', time: new Date(midnight - (300 - i) * DAY).toISOString(),
  PriceUSD: String(20000 + i * 100), CapMrktCurUSD: '1000000', CapMVRVCur: '2', SplyCur: '1000' })) });
const stablecoins = () => Array.from({ length: 60 }, (_, i) => ({ date: String((midnight - (60 - i) * DAY) / 1000),
  totalCirculatingUSD: { peggedUSD: 100_000_000 + i * 1_000_000 } }));

test('the market overview composes archived evidence, declares every scope and keeps sectors gated', async () => isolated(async database => {
  assert.equal((await ingest(database, job(marketDataset), [coin('bitcoin'), coin('cardano', { price_change_percentage_24h: -3 })])).status, 'succeeded');
  assert.equal((await ingest(database, job(globalDataset), globalValue())).status, 'succeeded');
  assert.equal((await ingest(database, historyJobs[0], dailyChart(20000, 100))).status, 'succeeded');
  assert.equal((await ingest(database, btcHistoryJob, coinMetrics())).status, 'succeeded');
  assert.equal((await ingest(database, capitalJobs[0], stablecoins())).status, 'succeeded');
  const view = (await marketOverviewArchive(database)).data;
  assert.equal(view.global.marketCapUsd, 10000);
  assert.equal(view.global.btcDominance, 51);
  assert.match(view.global.evidence.scope, /provider-global/);
  assert.equal(view.breadth.total, 2);
  assert.equal(view.breadth.advancing, 1);
  assert.equal(view.breadth.declining, 1);
  assert.doesNotMatch(view.breadth.scope, /^Global/);
  assert.equal(view.averages.sma200.covered, 1);
  assert.equal(view.averages.sma200.above, 1);
  assert.equal(view.averages.assets[0].assetId, 'bitcoin');
  assert.equal(view.btc.regime, 'bullish');
  assert.equal(view.btc.evidence.values, 300);
  assert.equal(view.btc.evidence.seriesId, `coinmetrics:bitcoin:${btcMetrics[0].code}:daily:v1`);
  assert.ok(view.liquidity.stablecoin.value! > 0);
  assert.equal(view.liquidity.stablecoin.value, 159_000_000);
  assert.equal(view.liquidity.stablecoin.comparisonValue, 129_000_000);
  assert.ok(Math.abs(view.liquidity.stablecoin.changePct! - (159 / 129 - 1) * 100) < 1e-9);
  assert.equal(view.performance.rows[0].assetId, 'bitcoin');
  assert.equal(view.performance.rows[0].relative.d30, 0);
  assert.deepEqual(view.performance.unarchivedAssets, ['cardano']);
  assert.equal(view.sectors.status, 'gated');
  assert.equal(view.sectors.classified, 1);
  assert.equal(view.sectors.unclassified, 1);
  assert.equal(view.sectors.categories[0].category, 'L1');
  assert.equal(view.reportedVolume.latest!.volume24hUsd, 1234);
  assert.equal(view.reportedVolume.change24h.changePct, null);
}));

test('a failed provider degrades only its own block and never removes archived evidence', async () => isolated(async database => {
  assert.equal((await ingest(database, job(marketDataset), [coin('bitcoin')])).status, 'succeeded');
  assert.equal((await ingest(database, job(globalDataset), globalValue())).status, 'succeeded');
  assert.equal((await ingest(database, job(globalDataset), { data: {} })).status, 'invalid-response');
  const view = (await marketOverviewArchive(database)).data;
  assert.equal(view.global.marketCapUsd, 10000);
  assert.equal(view.global.evidence.degraded, true);
  assert.equal(view.global.evidence.stale, true);
  assert.equal(view.breadth.total, 1);
  assert.equal(view.breadth.evidence.degraded, false);
  assert.equal(view.btc.evidence.unavailable, true);
  assert.equal(view.liquidity.stablecoin.coverage.unavailable, true);
  assert.equal(view.performance.rows.length, 0);
}));

test('overview replay selects the revision known at its cutoff and refuses uncovered dates', async () => isolated(async database => {
  assert.equal((await ingest(database, job(marketDataset), [coin('bitcoin')])).status, 'succeeded');
  assert.equal((await ingest(database, job(globalDataset), globalValue(1000))).status, 'succeeded');
  const cutoff = (await database.query('select clock_timestamp()::text as time')).rows[0].time as string;
  assert.equal((await ingest(database, job(marketDataset), [coin('bitcoin'), coin('newcoin')])).status, 'succeeded');
  assert.equal((await ingest(database, job(globalDataset), globalValue(9999))).status, 'succeeded');
  const replay = (await marketOverviewArchive(database, cutoff)).data;
  assert.equal(replay.breadth.total, 1);
  assert.equal(replay.global.volume24hUsd, 1000);
  assert.equal(replay.reportedVolume.points.length, 1);
  assert.equal(replay.methodology.classification, 'point-in-time');
  assert.deepEqual(replay.methodology.replayRefusals, ['btc-history', 'stablecoin-supply']);
  assert.equal(replay.btc.evidence.replayRefused, true);
  assert.equal(replay.liquidity.stablecoin.coverage.replayRefused, true);
  assert.equal(replay.breadth.evidence.replayRefused, false);
  assert.equal(replay.methodology.snapshotAsOf, cutoff);
  const current = (await marketOverviewArchive(database)).data;
  assert.equal(current.breadth.total, 2);
  assert.equal(current.global.volume24hUsd, 9999);
  assert.ok(current.signalChanges.some(change => change.type === 'tracked-membership' && change.title.includes('newcoin')));
  assert.ok(!current.signalChanges.some(change => change.title.includes('bitcoin first observed')));
  await assert.rejects(marketOverviewArchive(database, '2020-01-01T00:00:00Z'), /replay predates production coverage/);
}));

test('the overview route reads stored data only and validates replay cutoffs', async t => isolated(async database => {
  await ingest(database, job(marketDataset), [coin('bitcoin')]);
  await ingest(database, job(globalDataset), globalValue());
  const request = globalThis.fetch;
  const provider = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected provider fetch'); });
  const server = apiServer(database).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const get = (path: string) => request(`http://127.0.0.1:${address.port}/api/v1${path}`);
  try {
    const response = await get('/market/overview');
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.data.methodology.version, 'market-overview:v1');
    assert.equal(body.data.breadth.total, 1);
    assert.equal((await get('/market/overview?asOf=bad')).status, 400);
    assert.equal((await get('/market/overview?asOf=2099-01-01')).status, 400);
    assert.equal((await get('/market/overview?asOf=2020-01-01')).status, 409);
    assert.equal((await request(`http://127.0.0.1:${address.port}/api/v1/market/overview`, { method: 'POST' })).status, 405);
    assert.equal(provider.mock.callCount(), 0);
  } finally {
    const closed = once(server, 'close');
    server.close(); server.closeAllConnections();
    await closed;
  }
}));
