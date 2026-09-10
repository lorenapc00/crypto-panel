import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../src/migrations.js';
import { ReplayCoverageError } from '../src/archive.js';
import { configureWorker, claim } from '../src/discovery/queue.js';
import { discoveryJobs, type DiscoveryJob } from '../src/discovery/providers.js';
import { readDiscovery, dataHealth } from '../src/discovery/archive.js';
import { executeRun } from '../src/discovery/worker.js';
import { snapshotJobs, marketDataset, globalDataset, fundamentalDataset, issuanceDataset } from '../src/snapshots/providers.js';
import { marketData, marketOverview, assetDetails } from '../src/market.js';
import { fundamentals } from '../src/fundamentals.js';
import { issuance } from '../src/issuance.js';
import { apiServer } from '../src/server.js';

async function isolated(run: (database: Pool) => Promise<void>) {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required');
  const schema = `snapshot_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const database = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5, connectionTimeoutMillis: 5000 });
  try {
    await admin.query(`create schema ${schema}`);
    await migrate(database);
    await configureWorker(database, [...discoveryJobs, ...snapshotJobs]);
    await run(database);
  } finally {
    await database.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
}
const job = (id: string) => snapshotJobs.find(job => job.id === id)!;
async function ingest(database: Pool, job: DiscoveryJob, payload: unknown, status = 200) {
  await database.query(`update worker_provider_state s set tokens=l.bucket_capacity,updated_at=clock_timestamp(),blocked_until=null
    from worker_provider_limits l where s.provider_id=l.provider_id`);
  await database.query('insert into worker_runs (job_id,scheduled_at) values ($1,clock_timestamp())', [job.id]);
  const run = await claim(database);
  assert.ok(run);
  assert.equal(run.job_id, job.id);
  return executeRun(database, run, job, async () => new Response(JSON.stringify(payload), { status }));
}
const coin = (id: string, cap = 100, change: number | null = 2) => ({ id, symbol: id, name: id, market_cap_rank: 1,
  current_price: 10, market_cap: cap, total_volume: 5, circulating_supply: 10, max_supply: 100,
  price_change_percentage_24h: change, last_updated: new Date(Date.now() - 1000).toISOString() });
const globalValue = () => ({ data: { total_market_cap: { usd: 10000 }, total_volume: { usd: 1234 },
  market_cap_percentage: { btc: 51, eth: 12 }, updated_at: Math.floor(Date.now() / 1000) } });

test('market archive preserves membership and provider global scope across failures and revisions', async () => isolated(async database => {
  await ingest(database, job(marketDataset), [coin('bitcoin'), coin('old', 20, null)]);
  const beforeGlobal = await marketOverview(database);
  assert.equal(beforeGlobal.data.globalMarketCapUsd, null);
  assert.equal(beforeGlobal.data.globalMetadata.unavailable, true);
  await ingest(database, job(globalDataset), globalValue());
  const cutoff = (await database.query('select clock_timestamp()::text as now')).rows[0].now;
  const before = await marketOverview(database, cutoff);
  assert.equal(before.data.globalMarketCapUsd, 10000);
  assert.equal(before.data.btcDominance, 51);
  assert.equal(before.data.marketBreadth.total, 2);
  assert.equal(before.data.marketBreadth.unknown, 1);
  await ingest(database, job(marketDataset), [coin('bitcoin', 900), coin('new', 30, -2)]);
  await ingest(database, job(globalDataset), {}, 403);
  const after = await marketOverview(database);
  assert.equal(after.data.globalMarketCapUsd, 10000);
  assert.equal(after.data.globalMetadata.stale, true);
  assert.deepEqual(after.data.movers.map(asset => asset.id), ['bitcoin', 'new']);
  assert.equal((await assetDetails('old', database))?.stale, true);
  assert.equal((await database.query('select count(*)::int as n from assets')).rows[0].n, 3);
  assert.deepEqual(await marketOverview(database, cutoff), before);
  await assert.rejects(marketData(database, '2020-01-01'), ReplayCoverageError);
  await assert.rejects(database.query('update discovery_members set data=data'), /immutable/i);
  await assert.rejects(database.query('delete from observations'), /immutable/i);
}));

test('fundamental metrics fail independently and null corrections never resurrect an old value', async () => isolated(async database => {
  await ingest(database, job(fundamentalDataset('hyperliquid', 'tvl_usd')), { tvl: [{ date: Math.floor(Date.now() / 1000), totalLiquidityUSD: 500 }] });
  await ingest(database, job(fundamentalDataset('hyperliquid', 'fees_24h_usd')), { total24h: 100 });
  await ingest(database, job(fundamentalDataset('hyperliquid', 'revenue_24h_usd')), { total24h: 20 });
  await ingest(database, job(fundamentalDataset('hyperliquid', 'fees_24h_usd')), {}, 403);
  let result = await fundamentals('hyperliquid', undefined, database);
  assert.deepEqual(result.fundamentals.map(metric => [metric.value, metric.stale]), [[500, false], [100, true], [20, false]]);
  assert.equal(result.fundamentals[1].observedAt, null);
  assert.ok(result.fundamentals[1].acquiredAt);
  await ingest(database, job(fundamentalDataset('hyperliquid', 'revenue_24h_usd')), { total24h: null });
  result = await fundamentals('hyperliquid', undefined, database);
  assert.equal(result.fundamentals[2].value, null);
  assert.equal(result.fundamentals[2].available, false);
  const noFeed = await fundamentals('unverified-project', undefined, database);
  assert.equal(noFeed.category, 'unknown');
  assert.ok(noFeed.fundamentals.every(metric => !metric.available));
}));

test('new jobs share discovery quotas, retain payload provenance and do not invent metric lifecycle events', async () => isolated(async database => {
  await ingest(database, job(issuanceDataset('bitcoin')), 840000);
  await ingest(database, job(issuanceDataset('solana')), { jsonrpc: '2.0', id: 1, result: { epoch: 1, total: 0.05 } });
  const result = await issuance('bitcoin', database);
  assert.equal(result.status, 'stored');
  assert.equal(result.metrics[1].value, '3.125 BTC');
  const stored = await readDiscovery(database, issuanceDataset('solana'));
  assert.deepEqual(stored?.events, []);
  const payload = (await database.query('select request_body,raw_body from source_payloads where id=$1', [stored?.metadata.payloadId])).rows[0];
  assert.equal(payload.request_body.method, 'getInflationRate');
  assert.ok(payload.raw_body.includes('0.05'));
  await ingest(database, job(fundamentalDataset('ethereum', 'fees_24h_usd')), { total24h: 1 });
  const health = await dataHealth(database);
  assert.equal(health.jobs.length, discoveryJobs.length + snapshotJobs.length);
  assert.equal(health.providers.filter(provider => provider.provider_id === 'defillama').length, 1);
  assert.equal(health.providers.find(provider => provider.provider_id === 'defillama').requests_this_month, 1);
  assert.equal(health.providers.find(provider => provider.provider_id === 'mempool').requests_this_month, 1);
}));

test('empty or malformed market responses preserve the last universe and consume quota', async () => isolated(async database => {
  await ingest(database, job(marketDataset), [coin('bitcoin')]);
  assert.equal((await ingest(database, job(marketDataset), [])).status, 'invalid-response');
  const result = await marketData(database);
  assert.deepEqual(result.assets.map(asset => asset.id), ['bitcoin']);
  assert.equal(result.stale, true);
  const health = await dataHealth(database);
  assert.equal(health.providers.find(provider => provider.provider_id === 'coingecko').requests_this_month, 2);
  assert.equal(health.providers.find(provider => provider.provider_id === 'coingecko').errors_24h, 1);
}));

test('API routes use stored data only, validate replay cutoffs and retain per-metric degradation', async t => isolated(async database => {
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
    for (const path of ['/assets', '/overview', '/assets/bitcoin', '/watchlist', '/data-health']) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      if (path === '/assets/bitcoin') {
        const detail = await response.json() as any;
        assert.equal(detail.data.asset.id, 'bitcoin');
        assert.equal(detail.data.fundamentals.tokenomics.emissions.status, 'unavailable');
      }
    }
    assert.equal((await get('/assets/missing')).status, 404);
    assert.equal((await get('/assets?asOf=bad')).status, 400);
    assert.equal((await get('/assets?asOf=2099-01-01')).status, 400);
    assert.equal((await get('/assets?asOf=2020-01-01')).status, 409);
    assert.equal((await get('/assets/bitcoin?asOf=2020-01-01')).status, 400);
    assert.equal(provider.mock.callCount(), 0);
  } finally {
    const closed = once(server, 'close');
    server.close(); server.closeAllConnections();
    await closed;
  }
}));
