import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../src/migrations.js';
import { configureWorker, claim } from '../src/discovery/queue.js';
import { executeRun } from '../src/discovery/worker.js';
import { discoveryJobs, type DiscoveryJob } from '../src/discovery/providers.js';
import { snapshotJobs, marketDataset } from '../src/snapshots/providers.js';
import { historyJobs } from '../src/feeds/history.js';
import { venueJobs } from '../src/feeds/venue.js';
import { perpJobs, perpOpenInterestDataset, perpOpenInterestSeriesId } from '../src/feeds/perp.js';
import { perpProjectsArchive, perpListingsArchive, perpAlerts, acknowledgePerpAlert, instrumentDataset } from '../src/perp/archive.js';
import { apiServer } from '../src/server.js';

const DAY = 86400000;
const midnight = Math.floor(Date.now() / DAY) * DAY;

async function isolated(run: (database: Pool) => Promise<void>) {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `perp_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString });
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
const nativeJob = discoveryJobs.find(job => job.id === instrumentDataset(''))!;
const marketJob = snapshotJobs.find(job => job.id === marketDataset)!;
const protocolsJob = discoveryJobs.find(job => job.id === 'defillama:protocols:v1')!;
const namespacesJob = discoveryJobs.find(job => job.id === 'hyperliquid:namespaces:v1')!;

const protocols = (extra: Record<string, unknown>[] = []) => [
  { id: '5507', slug: 'hyperliquid-perps', name: 'Hyperliquid Perps', category: 'Derivatives', chains: ['Hyperliquid L1'], tvl: 180_000_000, gecko_id: null },
  { id: '9001', slug: 'emerging-perps', name: 'Emerging Perps', category: 'Derivatives', chains: ['Base'], tvl: 1_000_000, gecko_id: 'bitcoin' },
  { id: '777', slug: 'a-lender', name: 'A Lender', category: 'Lending', chains: ['Base'], tvl: 50, gecko_id: null },
  ...extra,
];
const openInterest = () => ({ total24h: 15_000_000_000,
  totalDataChart: Array.from({ length: 40 }, (_, index) => [(midnight - (40 - index) * DAY) / 1000, 10_000_000_000 + index * 100_000_000]),
  protocols: [{ defillamaId: '5507', slug: 'hyperliquid-perps', name: 'Hyperliquid Perps', category: 'Derivatives',
    chains: ['Hyperliquid L1'], parentProtocol: 'parent#hyperliquid', module: 'hyperliquid-perp-oi',
    total24h: 14_000_000_000, total7DaysAgo: 13_000_000_000, total30DaysAgo: 10_000_000_000, change_1d: 0.5 }] });
const instruments = (names: string[], overrides: Record<string, unknown>[] = []) => [
  { universe: names.map(name => ({ name, szDecimals: 5, maxLeverage: 40, marginTableId: 1, ...overrides.shift() })), collateralToken: 0 },
  names.map((_, index) => ({ openInterest: String(1000 + index * 10), markPx: '100', oraclePx: '99.5', funding: '0.00001',
    premium: '0.0005', dayNtlVlm: '5000000', impactPxs: ['99.9', '100.1'] })),
];
const namespaces = () => [null, { name: 'mkts', fullName: 'Markets DEX', deployer: '0xabc' }];
const coins = () => [{ id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', market_cap_rank: 1, current_price: 100000,
  market_cap: 2_000_000_000_000, total_volume: 10, price_change_percentage_24h: 1, last_updated: new Date(Date.now() - 1000).toISOString() }];
const chart = () => { const prices = Array.from({ length: 60 }, (_, index) => [midnight - (60 - index) * DAY, 100 + index]);
  return { prices, total_volumes: prices }; };

test('perp projects read only stored archives, declare the covered universe and keep volume and launch dates gated', async () => isolated(async database => {
  assert.equal((await ingest(database, protocolsJob, protocols())).status, 'succeeded');
  assert.equal((await ingest(database, perpJobs[0], openInterest())).status, 'succeeded');
  assert.equal((await ingest(database, marketJob, coins())).status, 'succeeded');
  assert.equal((await ingest(database, nativeJob, instruments(['BTC', 'ETH']))).status, 'succeeded');

  const view = (await perpProjectsArchive(database)).data;
  assert.equal(view.universe.matched, 2, 'the Lending protocol never enters the perp universe');
  assert.equal(view.universe.coveredOpenInterestProtocols, 1);
  assert.equal(view.universe.withVenueLink, 1);
  const hyperliquid = view.rows.find(row => row.protocolId === '5507')!;
  assert.equal(hyperliquid.adoption.openInterestUsd, 14_000_000_000);
  assert.equal(hyperliquid.adoption.tvlUsd, 180_000_000);
  assert.equal(hyperliquid.adoption.openInterestShareOfCoveredPct, 100);
  assert.equal(hyperliquid.venue!.namespace, '');
  assert.equal(hyperliquid.venue!.instruments, 2, 'linked venue activity comes from that namespace’s archived snapshot');
  assert.equal(hyperliquid.venue!.openInterestNative, 2010);
  assert.equal(hyperliquid.lifecycle.verifiedProtocolLaunchAt, null);
  assert.ok(hyperliquid.lifecycle.firstObservedAt);
  assert.equal(hyperliquid.adoption.volumeSharePct, null);
  const emerging = view.rows.find(row => row.protocolId === '9001')!;
  assert.equal(emerging.stage, 'live-token', 'the provider token link resolves to an archived market asset');
  assert.equal(emerging.token!.verifiedTerms, false);
  assert.equal(emerging.adoption.openInterestUsd, null);
  assert.equal(view.aggregate.values, 40);
  assert.equal(view.aggregate.seriesId, perpOpenInterestSeriesId);
  assert.ok(view.aggregate.replayCoverageStart, 'the aggregate records its own replay coverage start');

  // A later acquisition must not change an earlier point-in-time answer.
  const before = (await database.query('select clock_timestamp()::text as now')).rows[0].now as string;
  assert.equal((await ingest(database, perpJobs[0], { ...openInterest(),
    protocols: [{ defillamaId: '5507', slug: 'hyperliquid-perps', name: 'Hyperliquid Perps', category: 'Derivatives', chains: [], total24h: 99 }] })).status, 'succeeded');
  const replay = (await perpProjectsArchive(database, before)).data;
  assert.equal(replay.rows.find(row => row.protocolId === '5507')!.adoption.openInterestUsd, 14_000_000_000);
  assert.equal(replay.methodology.classification, 'point-in-time');
  assert.equal((await perpProjectsArchive(database)).data.rows.find(row => row.protocolId === '5507')!.adoption.openInterestUsd, 99);
}));

test('perp projects refuse a cutoff before a feed began archiving without discarding the feeds that reach it', async () => isolated(async database => {
  assert.equal((await ingest(database, protocolsJob, protocols())).status, 'succeeded');
  await assert.rejects(perpProjectsArchive(database, '2017-01-01T00:00:00.000Z'), /predates production coverage/);
  assert.equal((await ingest(database, perpJobs[0], openInterest())).status, 'succeeded');
  const cutoff = (await database.query('select clock_timestamp()::text as now')).rows[0].now as string;
  const view = (await perpProjectsArchive(database, cutoff)).data;
  assert.deepEqual(view.methodology.replayRefusals, []);
  assert.equal(view.universe.coveredOpenInterestProtocols, 1);
}));

test('new perp listings treat the first catalog as a baseline and only later markets as listings', async () => isolated(async database => {
  assert.equal((await ingest(database, namespacesJob, namespaces())).status, 'succeeded');
  assert.equal((await ingest(database, nativeJob, instruments(['BTC', 'ETH', 'GONE']))).status, 'succeeded');
  assert.equal((await ingest(database, historyJobs[0], chart())).status, 'succeeded');
  assert.equal((await ingest(database, venueJobs[0], { coin: 'BTC', time: midnight, levels: [[{ px: '99.9', sz: '5' }], [{ px: '100.1', sz: '5' }]] })).status, 'succeeded');

  const baseline = (await perpListingsArchive(database)).data;
  assert.equal(baseline.lifecycle.baselineInstruments, 3);
  assert.equal(baseline.lifecycle.newListings, 0);
  assert.equal(baseline.rows.length, 0, 'an initial catalog ingestion produces no new-listing rows');
  assert.equal(baseline.screen.excluded.baseline, 3);
  assert.equal(baseline.lifecycle.venueDelistedMarkets, 0);
  assert.deepEqual((await perpAlerts(database)).data, [], 'a baseline raises no lifecycle alert');

  await database.query(`update worker_jobs set next_run_at=clock_timestamp()-interval '2 hours' where id=$1`, [nativeJob.id]);
  assert.equal((await ingest(database, nativeJob, instruments(['BTC', 'ETH', 'NEWPERP'],
    [{}, {}, {}]))).status, 'succeeded');
  const after = (await perpListingsArchive(database)).data;
  assert.equal(after.lifecycle.newListings, 1);
  assert.deepEqual(after.rows.map(row => row.instrument), ['NEWPERP']);
  const listing = after.rows[0];
  assert.equal(listing.listing.classification, 'venue-new-to-archive');
  assert.equal(listing.listing.verifiedTradingStartAt, null);
  assert.equal(listing.underlying.assetClass, 'unknown');
  assert.equal(listing.market.openInterestUnit, 'underlying units');
  assert.equal(listing.market.openInterestChange24h.changePct, null, 'no archived snapshot sits 24 hours earlier yet');
  assert.equal(listing.liquidity.source, 'impact prices only');

  const catalog = (await perpListingsArchive(database, undefined, { screen: 'all', underlying: 'all' })).data;
  const btc = catalog.rows.find(row => row.instrument === 'BTC')!;
  assert.equal(btc.underlying.assetId, 'bitcoin');
  assert.equal(btc.underlying.spot!.relativeToBtc.d7, 0);
  assert.equal(btc.liquidity.source, 'archived order book');
  assert.equal(btc.market.openInterestChangeLatestInterval.changePct, 0, 'the previous archived snapshot reports its own interval');
  assert.ok(catalog.rows.some(row => row.instrument === 'GONE'), 'a market absent from the newer catalog keeps its last archived observation');
  assert.equal(catalog.namespaces.find(row => row.namespace === 'mkts')!.covered, false,
    'a namespace with no archived instrument dataset is uncovered, not empty');
}));

test('lifecycle alerts derive from immutable events, acknowledge separately and survive re-reading', async () => isolated(async database => {
  assert.equal((await ingest(database, namespacesJob, namespaces())).status, 'succeeded');
  assert.equal((await ingest(database, nativeJob, instruments(['BTC']))).status, 'succeeded');
  await database.query(`update worker_jobs set next_run_at=clock_timestamp()-interval '2 hours' where id=$1`, [nativeJob.id]);
  assert.equal((await ingest(database, nativeJob, instruments(['BTC', 'LATER']))).status, 'succeeded');

  const alerts = (await perpAlerts(database)).data;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'perp-listing');
  assert.equal(alerts[0].eventType, 'first_observed');
  assert.match(alerts[0].title, /LATER first observed/);
  assert.equal(alerts[0].readAt, null);
  assert.ok(alerts[0].payloadId);

  await acknowledgePerpAlert(database, alerts[0].datasetId, alerts[0].snapshotId, alerts[0].entityKey);
  const acknowledged = (await perpAlerts(database)).data[0];
  assert.ok(acknowledged.readAt);
  assert.equal(acknowledged.eventType, 'first_observed', 'acknowledgement cannot change the archived evidence');
  assert.equal((await perpAlerts(database, { unreadOnly: true })).data.length, 0);
  await assert.rejects(acknowledgePerpAlert(database, alerts[0].datasetId, '999999', alerts[0].entityKey), /Alert not found/);
  await assert.rejects(database.query(`update discovery_events set event_type='baseline' where entity_key=$1`, [alerts[0].entityKey]), /immutable|Archive/i);
}));

test('the perp routes validate input, serve stored evidence and refuse uncovered replay with HTTP 409', async () => isolated(async database => {
  assert.equal((await ingest(database, protocolsJob, protocols())).status, 'succeeded');
  assert.equal((await ingest(database, perpJobs[0], openInterest())).status, 'succeeded');
  assert.equal((await ingest(database, namespacesJob, namespaces())).status, 'succeeded');
  assert.equal((await ingest(database, nativeJob, instruments(['BTC']))).status, 'succeeded');
  const server = apiServer(database).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const call = (path: string, options?: RequestInit) => fetch(`http://127.0.0.1:${port}/api/v1${path}`, options);
  try {
    const projects = await call('/perp/projects');
    assert.equal(projects.status, 200);
    const body = await projects.json();
    assert.equal(body.data.methodology.version, 'perp-projects:v1');
    assert.equal(body.data.universe.matched, 2);
    assert.equal((await call('/perp/listings')).status, 200);
    const listings = await (await call('/perp/listings?screen=all&underlying=all&namespace=native')).json();
    assert.equal(listings.data.rows.length, 1);
    assert.equal(listings.data.methodology.version, 'perp-listings:v1');
    assert.equal((await call('/perp/alerts')).status, 200);
    assert.equal((await call('/perp/projects?window=nonsense')).status, 400);
    assert.equal((await call('/perp/listings?namespace=not-budgeted')).status, 400);
    assert.equal((await call('/perp/listings?limit=0')).status, 400);
    assert.equal((await call('/perp/projects', { method: 'DELETE' })).status, 405);
    assert.equal((await call('/perp/unknown')).status, 404);
    assert.equal((await call('/perp/projects?asOf=2017-01-01T00:00:00.000Z')).status, 409);
    assert.equal((await call('/perp/projects?asOf=not-a-date')).status, 400);
    assert.equal((await call('/perp/alerts', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ datasetId: instrumentDataset(''), snapshotId: '99999', entityKey: 'missing' }) })).status, 404);
  } finally { server.close(); server.closeAllConnections(); }
}));
