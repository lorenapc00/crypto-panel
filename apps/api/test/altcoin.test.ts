import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../src/migrations.js';
import { configureWorker, claim } from '../src/discovery/queue.js';
import { executeRun } from '../src/discovery/worker.js';
import { discoveryJobs, type DiscoveryJob } from '../src/discovery/providers.js';
import { snapshotJobs, marketDataset } from '../src/snapshots/providers.js';
import { historyJobs } from '../src/feeds/history.js';
import { capitalJobs, capitalCatalogId } from '../src/feeds/capital.js';
import { spotJobs } from '../src/feeds/spot.js';
import { emergingArchive, launchesArchive, poolDataset } from '../src/altcoin/archive.js';
import { apiServer } from '../src/server.js';

const DAY = 86400000;
const midnight = Math.floor(Date.now() / DAY) * DAY;

async function isolated(run: (database: Pool) => Promise<void>) {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `alt_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString });
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
const marketJob = snapshotJobs.find(job => job.id === marketDataset)!;
const catalogJob = capitalJobs.find(job => job.id === capitalCatalogId)!;
const historyJob = (asset: string) => historyJobs.find(job => job.id === `coingecko:${asset}:daily-history:v1`)!;
const poolJob = (chain: 'solana' | 'base') => discoveryJobs.find(job => job.id === poolDataset(chain))!;

const coin = (overrides: Record<string, unknown>) => ({ symbol: 'X', name: 'X', market_cap_rank: 50, current_price: 1,
  market_cap: 5e8, total_volume: 4e6, fully_diluted_valuation: 1e9, circulating_supply: 100, total_supply: 200,
  max_supply: 200, price_change_percentage_24h: 1, price_change_percentage_7d_in_currency: 2,
  price_change_percentage_30d_in_currency: 3, last_updated: new Date(Date.now() - 1000).toISOString(), ...overrides });
const coins = () => [
  coin({ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', market_cap_rank: 1, current_price: 100000, market_cap: 1e12 }),
  coin({ id: 'solana', symbol: 'sol', name: 'Solana', market_cap_rank: 5, current_price: 200, market_cap: 5e8 }),
  coin({ id: 'tether', symbol: 'usdt', name: 'Tether', market_cap_rank: 3, market_cap: 1e9 }),
];
// 120 completed days so the 90-day screens and risk windows are genuinely complete.
const chart = (base: number, growth: number, volume: number) => {
  const prices = Array.from({ length: 121 }, (_, index) => [midnight - (121 - index) * DAY, base * growth ** index]);
  return { prices, total_volumes: prices.map(([time]) => [time, volume]) };
};
const pegCatalog = () => ({ peggedAssets: [
  { id: '1', name: 'Tether', symbol: 'USDT', pegType: 'peggedUSD', chains: ['Ethereum'], circulating: { peggedUSD: 1 }, price: 1 },
  { id: '2', name: 'Sol Dollar', symbol: 'SOL', pegType: 'peggedUSD', chains: ['Solana'], circulating: { peggedUSD: 1 }, price: 1 }] });

const WSOL = 'So11111111111111111111111111111111111111112';
// The DEX Screener adapter validates base58 identities, so the enrichment fixture uses real shapes.
const TOKEN = '9HkKqx4MzgxQ2vb4hfBjTqU98Zmyy1TbtrTgqUgLpump';
const POOL = '2ubFGSVy5hXvpR5r86MY3dVHSeX5aL9ZLnF5x8hebVx8';
const poolPage = (pools: { address: string; base: string; liquidity: number | null; volume?: number; buys?: number; sells?: number }[]) => ({
  data: pools.map(entry => ({ id: `solana_${entry.address}`, attributes: { address: entry.address, name: 'AAA / SOL',
    pool_created_at: new Date(midnight).toISOString(), reserve_in_usd: entry.liquidity,
    volume_usd: { h24: entry.volume ?? 250000 },
    transactions: { h24: { buys: entry.buys ?? 60, sells: entry.sells ?? 40 } } },
  relationships: { base_token: { data: { id: `solana_${entry.base}` } }, quote_token: { data: { id: `solana_${WSOL}` } } } })) });

test('Emerging Projects compose stored archives, separate unknown screens from failures and refuse an uncovered cutoff', async () => isolated(async database => {
  assert.equal((await ingest(database, marketJob, coins())).status, 'succeeded');
  // An unconfigured feed is unavailable; only a configured one whose coverage starts later is refused.
  await assert.rejects(emergingArchive(database, '2017-01-01T00:00:00.000Z'), /predates production coverage/);
  assert.equal((await ingest(database, catalogJob, pegCatalog())).status, 'succeeded');
  assert.equal((await ingest(database, historyJob('bitcoin'), chart(100, 1.001, 5e10))).status, 'succeeded');
  assert.equal((await ingest(database, historyJob('solana'), chart(10, 1.004, 4e6))).status, 'succeeded');

  const view = (await emergingArchive(database, undefined, { screen: 'all' })).data;
  assert.equal(view.universe.tracked, 3);
  const solana = view.rows.find(row => row.assetId === 'solana')!;
  assert.equal(solana.eligibility.eligible, true, 'inside the band with 90 contiguous days and a $4M median');
  assert.ok(solana.eligibility.contiguousHistoryDays >= 90);
  assert.ok(solana.returns.relative.d90! > 0, 'archive-computed excess return over BTC');
  assert.ok(solana.risk.btcBeta90d !== null && solana.risk.volatility90dPct !== null);
  // A curated stablecoin row excludes; a bare ticker collision only flags.
  const tether = view.rows.find(row => row.assetId === 'tether')!;
  assert.equal(tether.eligibility.identity, 'fail');
  assert.equal(tether.identity.reason, 'stablecoin');
  assert.equal(solana.identity.excluded, false);
  assert.equal(solana.identity.pegSymbolMatch, 'Sol Dollar', 'the SOL ticker collides with a peg-catalog symbol');
  const bitcoin = view.rows.find(row => row.assetId === 'bitcoin')!;
  assert.equal(bitcoin.eligibility.marketCap, 'fail');
  assert.equal(bitcoin.returns.relative.d30, 0, 'the benchmark against itself is zero');
  assert.equal(view.universe.eligible, 1);
}));

test('an asset with no archived daily series is unknown, never failed, and is never ranked', async () => isolated(async database => {
  assert.equal((await ingest(database, marketJob, coins())).status, 'succeeded');
  const view = (await emergingArchive(database, undefined, { screen: 'all' })).data;
  assert.equal(view.universe.withArchivedPrices, 0);
  assert.equal(view.universe.eligible, 0);
  const solana = view.rows.find(row => row.assetId === 'solana')!;
  assert.equal(solana.eligibility.history, 'unknown');
  assert.equal(solana.eligibility.medianVolume, 'unknown');
  assert.equal(solana.attention!.ranked, false);
  assert.equal(view.attention.ranked, 0);
  assert.equal(view.attention.prime, false);
  assert.equal(view.sectors.status, 'gated');
}));

test('an Emerging Projects replay is stable when a later snapshot revises the same assets', async () => isolated(async database => {
  assert.equal((await ingest(database, marketJob, coins())).status, 'succeeded');
  assert.equal((await ingest(database, historyJob('solana'), chart(10, 1.004, 4e6))).status, 'succeeded');
  const before = (await database.query('select clock_timestamp()::text as now')).rows[0].now as string;
  assert.equal((await ingest(database, marketJob, [coin({ id: 'solana', symbol: 'sol', name: 'Solana', market_cap: 9e8 })])).status, 'succeeded');
  const replay = (await emergingArchive(database, before, { screen: 'all' })).data;
  assert.equal(replay.rows.find(row => row.assetId === 'solana')!.marketCapUsd, 5e8);
  assert.equal(replay.methodology.classification, 'point-in-time');
  assert.equal(replay.universe.tracked, 3, 'the earlier membership is preserved');
  const now = (await emergingArchive(database, undefined, { screen: 'all' })).data;
  assert.equal(now.rows.find(row => row.assetId === 'solana')!.marketCapUsd, 9e8);
  assert.equal(now.universe.tracked, 1, 'the newer snapshot has its own membership');
}));

test('spot launches deduplicate by token across pools so a later pool never makes an old token new', async () => isolated(async database => {
  const job = poolJob('solana');
  assert.equal((await ingest(database, job, poolPage([{ address: 'PoolOne', base: 'TokenA', liquidity: 150000 }]))).status, 'succeeded');
  const first = (await launchesArchive(database)).data;
  assert.equal(first.universe.tokens, 1);
  assert.equal(first.rows[0].liquidity.poolsEverSampled, 1);

  // A second pool for the same token, plus a genuinely new token.
  assert.equal((await ingest(database, job, poolPage([
    { address: 'PoolOne', base: 'TokenA', liquidity: 180000 },
    { address: 'PoolTwo', base: 'TokenA', liquidity: 20000 },
    { address: 'PoolThree', base: 'TokenB', liquidity: 500000 }]))).status, 'succeeded');
  const view = (await launchesArchive(database)).data;
  assert.equal(view.universe.tokens, 2, 'three pools resolve to two tokens');
  const tokenA = view.rows.find(row => row.tokenAddress === 'TokenA')!;
  assert.equal(tokenA.liquidity.poolsEverSampled, 2);
  assert.equal(tokenA.liquidity.liquidityUsd, 200000, 'liquidity sums this token’s sampled pools');
  assert.equal(tokenA.lifecycle.hasNewerPools, true);
  assert.equal(tokenA.lifecycle.firstObservedAt, first.rows[0].lifecycle.firstObservedAt,
    'the earlier first observation survives the newer pool');
  assert.equal(view.universe.multiPoolTokens, 1);
  assert.equal(view.universe.tokensWithLaterPools, 1);
  // The pool that left the newest page keeps its last observation rather than disappearing.
  assert.equal((await ingest(database, job, poolPage([{ address: 'PoolThree', base: 'TokenB', liquidity: 500000 }]))).status, 'succeeded');
  const later = (await launchesArchive(database, undefined, { screen: 'all' })).data;
  const retained = later.rows.find(row => row.tokenAddress === 'TokenA')!;
  assert.equal(retained.lifecycle.inLatestSample, false);
  assert.ok(retained.risk.flags.some(flag => /absent from the newest archived sample/.test(flag)));
}));

test('unknown pool liquidity stays unknown, keeps the token off the default shortlist and never becomes zero', async () => isolated(async database => {
  const job = poolJob('solana');
  assert.equal((await ingest(database, job, poolPage([
    { address: 'PoolOne', base: 'TokenA', liquidity: null },
    { address: 'PoolTwo', base: 'TokenB', liquidity: 50000 },
    { address: 'PoolThree', base: 'TokenC', liquidity: 250000 }]))).status, 'succeeded');
  const shortlist = (await launchesArchive(database)).data;
  assert.equal(shortlist.rows.length, 1, 'only the token above the $100K default is shortlisted');
  assert.equal(shortlist.rows[0].tokenAddress, 'TokenC');
  assert.equal(shortlist.universe.unknownLiquidity, 1);
  assert.equal(shortlist.universe.belowMinimumLiquidity, 1);
  const all = (await launchesArchive(database, undefined, { screen: 'all' })).data;
  const unknown = all.rows.find(row => row.tokenAddress === 'TokenA')!;
  assert.equal(unknown.liquidity.liquidityUsd, null);
  assert.equal(unknown.screen.liquidity, 'unknown');
  assert.equal(unknown.risk.status, 'unknown');
  assert.equal(unknown.risk.criticalFlags.length, 0);
  assert.equal(all.riskGate.verifiedChecks, 0);
  const permissive = (await launchesArchive(database, undefined, { includeUnknownLiquidity: true })).data;
  assert.ok(permissive.rows.some(row => row.tokenAddress === 'TokenA'), 'the operator can opt into unknown liquidity');
}));

test('spot launch enrichment attaches paid promotion as promotion and keeps replay stable', async () => isolated(async database => {
  const job = poolJob('solana');
  assert.equal((await ingest(database, job, poolPage([{ address: POOL, base: TOKEN, liquidity: 150000 }]))).status, 'succeeded');
  const pairsJob = spotJobs.find(entry => entry.id === 'dexscreener:solana:pairs:slot0:v1')!;
  const request = await pairsJob.request!(database);
  assert.ok(request, 'the enrichment slot selects the archived base token');
  assert.match(request!.endpoint, new RegExp(TOKEN));
  const enrichment: DiscoveryJob = { ...pairsJob, request: undefined,
    parse: payload => request!.parse!(payload) };
  assert.equal((await ingest(database, enrichment, [{ chainId: 'solana', pairAddress: POOL,
    baseToken: { address: TOKEN }, quoteToken: { address: WSOL }, priceUsd: '0.5',
    liquidity: { usd: 150000 }, volume: { h24: 250000 }, boosts: { active: 3 } }])).status, 'succeeded');

  const before = (await database.query('select clock_timestamp()::text as now')).rows[0].now as string;
  const view = (await launchesArchive(database)).data;
  const row = view.rows[0];
  assert.equal(row.enrichment.pairs, 1);
  assert.equal(row.attention.priceUsd, 0.5);
  assert.equal(row.promotion.boosts, 'present');
  assert.ok(row.risk.flags.some(flag => /Paid promotion is reported/.test(flag)));
  assert.equal(row.attention.buySellImbalancePct, 20, '60 buys against 40 sells');
  assert.equal(row.liquidity.verifiedQuote, true);
  assert.equal(row.liquidity.quoteTokens[0].symbol, 'WSOL');

  assert.equal((await ingest(database, job, poolPage([{ address: POOL, base: TOKEN, liquidity: 900000 }]))).status, 'succeeded');
  const replay = (await launchesArchive(database, before)).data;
  assert.equal(replay.rows[0].liquidity.liquidityUsd, 150000, 'a later acquisition cannot change an earlier replay');
  assert.equal(replay.methodology.classification, 'point-in-time');
  assert.equal((await launchesArchive(database)).data.rows[0].liquidity.liquidityUsd, 900000);
}));

test('spot launch replay refuses a cutoff before a chain began archiving', async () => isolated(async database => {
  assert.equal((await ingest(database, poolJob('solana'), poolPage([{ address: 'PoolOne', base: 'TokenA', liquidity: 150000 }]))).status, 'succeeded');
  await assert.rejects(launchesArchive(database, '2017-01-01T00:00:00.000Z'), /predates production coverage/);
  const cutoff = (await database.query('select clock_timestamp()::text as now')).rows[0].now as string;
  const view = (await launchesArchive(database, cutoff)).data;
  assert.deepEqual(view.methodology.replayRefusals, []);
  assert.equal(view.universe.tokens, 1);
}));

test('the altcoin routes validate their inputs and read only stored archives', async () => isolated(async database => {
  assert.equal((await ingest(database, marketJob, coins())).status, 'succeeded');
  assert.equal((await ingest(database, poolJob('solana'), poolPage([{ address: 'PoolOne', base: 'TokenA', liquidity: 150000 }]))).status, 'succeeded');
  const server = apiServer(database).listen(0);
  const port = (server.address() as { port: number }).port;
  const call = async (path: string) => { const response = await fetch(`http://127.0.0.1:${port}${path}`); return { status: response.status, body: await response.json() as any }; };
  try {
    assert.equal((await call('/api/v1/altcoin/emerging?screen=all')).status, 200);
    assert.equal((await call('/api/v1/altcoin/launches')).status, 200);
    assert.equal((await call('/api/v1/altcoin/emerging?screen=nonsense')).status, 400);
    assert.equal((await call('/api/v1/altcoin/emerging?minMarketCap=abc')).status, 400);
    assert.equal((await call('/api/v1/altcoin/emerging?minMarketCap=900&maxMarketCap=100')).status, 400);
    assert.equal((await call('/api/v1/altcoin/launches?chain=ethereum')).status, 400);
    assert.equal((await call('/api/v1/altcoin/launches?windowDays=0')).status, 400);
    assert.equal((await call('/api/v1/altcoin/launches?includeUnknownLiquidity=maybe')).status, 400);
    assert.equal((await call('/api/v1/altcoin/nonsense')).status, 404);
    assert.equal((await call('/api/v1/altcoin/emerging?asOf=2017-01-01T00:00:00.000Z')).status, 409,
      'a cutoff before coverage is refused, never reconstructed');
    const method = await fetch(`http://127.0.0.1:${port}/api/v1/altcoin/emerging`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(method.status, 405);
    const emerging = await call('/api/v1/altcoin/emerging?screen=all&limit=10');
    assert.equal(emerging.body.data.methodology.version, 'emerging-projects:v1');
    assert.match(emerging.body.data.attention.caveat, /unvalidated v0 placeholder/);
    const launches = await call('/api/v1/altcoin/launches?screen=all');
    assert.equal(launches.body.data.methodology.version, 'spot-launches:v1');
    assert.match(launches.body.data.universe.scope, /sampled radar/);
  } finally { server.close(); }
}));
