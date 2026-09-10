import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewView, trailingAverage, calendarReturnPct, relativeReturnPct, averageBreadth,
  supplyChange, sampledChange, regimeChanges, OVERVIEW_METHOD } from './overview.js';

const DAY = 86400000;
const now = '2026-02-10T12:00:00Z';
const day = (index: number, value: number | null = 100) => ({ observedAt: new Date(Date.parse('2026-02-10T00:00:00Z') - index * DAY).toISOString(), value });
const series = (points: { observedAt: string; value: number | null }[]): any => ({ points, metadata: { replayCoverageStart: null } });
const asset = (id: string, extra: Record<string, unknown> = {}) => ({ id, symbol: id.toUpperCase(), name: id, rank: 1,
  priceUsd: 10, marketCapUsd: 1000, fullyDilutedValuationUsd: null, volume24hUsd: 5, circulatingSupply: 1,
  totalSupply: null, maxSupply: null, change24h: 1, change7d: 2, change30d: 3, observedAt: '2026-02-10T11:30:00Z', ...extra });
const snapshot = (members: any[], metadata: Record<string, unknown> = {}): any => ({ members: members.map(data => ({ key: data.id ?? 'global', status: 'observed', data })),
  events: [], metadata: { datasetId: 'dataset', source: 'coingecko', observedAt: '2026-02-10T11:45:00Z', recordedAt: '2026-02-10T11:45:01Z',
    coverage: 'scope', snapshotId: 's1', payloadId: 'p1', replayCoverageStart: '2026-01-01T00:00:00Z', methodologyVersion: 'v1',
    degraded: false, error: null, classification: 'forward tracking', ...metadata } });
const globalSnapshot = () => snapshot([{ globalMarketCapUsd: 3e12, volume24hUsd: 9e10, btcDominance: 55.5, ethDominance: 12, observedAt: '2026-02-10T11:40:00Z' }]);
const rising = (count: number, start = 100, step = 1) => Array.from({ length: count }, (_, i) => day(count - 1 - i, start + i * step));
const empty: any = { now, market: null, global: null, globalHistory: [], btc: null, capital: null, histories: [], categories: [], alerts: [] };

test('trailing averages require a complete contiguous daily window', () => {
  assert.equal(trailingAverage(rising(50, 1, 1), 50), 25.5);
  assert.equal(trailingAverage(rising(49), 50), null);
  const gapped = rising(51).filter((_, index) => index !== 5);
  assert.equal(trailingAverage(gapped, 50), null);
  const missing = rising(50); missing[10] = { ...missing[10], value: null };
  assert.equal(trailingAverage(missing, 50), null);
});

test('calendar returns need both exact endpoints and BTC-relative returns compound', () => {
  const points = [day(30, 100), day(7, 110), day(0, 121)];
  assert.ok(Math.abs(calendarReturnPct(points, 30)! - 21) < 1e-9);
  assert.ok(Math.abs(calendarReturnPct(points, 7)! - 10) < 1e-9);
  assert.equal(calendarReturnPct(points, 90), null);
  assert.equal(calendarReturnPct([day(0, null)], 1), null);
  assert.ok(Math.abs(relativeReturnPct(21, 10)! - 10) < 1e-9);
  assert.equal(relativeReturnPct(21, null), null);
  assert.equal(relativeReturnPct(null, 10), null);
  assert.equal(relativeReturnPct(5, -100), null);
});

test('average breadth counts assets without a complete window as uncovered, not below', () => {
  const covered = averageBreadth([
    { assetId: 'a', symbol: 'A', name: 'A', points: rising(200, 100, 1) },
    { assetId: 'b', symbol: 'B', name: 'B', points: rising(200, 300, -1) },
    { assetId: 'c', symbol: 'C', name: 'C', points: rising(60, 100, 1) },
  ]);
  assert.equal(covered.sma200.covered, 2);
  assert.equal(covered.sma200.above, 1);
  assert.equal(covered.sma200.percent, 50);
  assert.equal(covered.sma50.covered, 3);
  assert.equal(covered.assets[2].above200d, null);
  assert.equal(covered.assets[2].sma200, null);
});

test('stablecoin supply changes use exact 30-day endpoints and exclude the incomplete day', () => {
  const change = supplyChange([day(31, 200), day(30, 100), day(1, 220), day(0, 999)], Date.parse(now));
  assert.equal(change.observedAt, day(1).observedAt);
  assert.equal(change.value, 220);
  assert.equal(change.comparisonValue, 200);
  assert.ok(Math.abs(change.changePct! - 10) < 1e-9);
  assert.equal(change.changeUsd, 20);
  assert.equal(supplyChange([day(29, 100), day(1, 220)], Date.parse(now)).changePct, null);
  assert.equal(supplyChange([], Date.parse(now)).value, null);
});

test('sampled provider changes only compare archived samples inside the tolerance window', () => {
  const hour = (hours: number, value: number | null) => ({ observedAt: new Date(Date.parse(now) - hours * 3600000).toISOString(), value });
  assert.ok(Math.abs(sampledChange([hour(24, 100), hour(0, 110)], 24, 5400).changePct! - 10) < 1e-9);
  assert.equal(sampledChange([hour(30, 100), hour(0, 110)], 24, 5400).changePct, null);
  assert.equal(sampledChange([hour(24, null), hour(0, 110)], 24, 5400).comparisonAt, null);
  assert.equal(sampledChange([hour(0, 110)], 168, 5400).changePct, null);
});

test('regime changes report confirmed transitions and never the initial baseline', () => {
  const points = [{ observedAt: day(4).observedAt, regime: 'insufficient-history' }, { observedAt: day(3).observedAt, regime: 'bullish' },
    { observedAt: day(2).observedAt, regime: 'bullish' }, { observedAt: day(1).observedAt, regime: 'transitional' },
    { observedAt: day(0).observedAt, regime: 'bearish' }];
  assert.deepEqual(regimeChanges(points).map(change => change.to), ['transitional', 'bearish']);
  assert.equal(regimeChanges(points, 0).length, 1);
  assert.deepEqual(regimeChanges([]), []);
});

test('the overview declares tracked-page scope and never calls the archived page global', () => {
  const view = overviewView({ ...empty, market: snapshot([asset('bitcoin'), asset('ethereum', { change24h: -4 })]), global: globalSnapshot() }).data;
  assert.equal(view.global.marketCapUsd, 3e12);
  assert.equal(view.global.evidence.scope, 'CoinGecko provider-global coverage; USD');
  assert.equal(view.breadth.total, 2);
  assert.equal(view.breadth.advancing, 1);
  assert.equal(view.breadth.declining, 1);
  assert.match(view.breadth.scope, /up to 100 assets; not a global universe/);
  assert.match(view.averages.scope, /0 of 2 tracked assets/);
  assert.equal(view.averages.sma200.percent, null);
  assert.equal(view.methodology.version, OVERVIEW_METHOD);
  assert.equal(view.reportedChanges.leaders[0].id, 'bitcoin');
  assert.deepEqual(view.reportedChanges.laggards, []);
});

test('reported movers rank by provider change and never list one asset as both leader and laggard', () => {
  const members = Array.from({ length: 7 }, (_, index) => asset(`a${index}`, { change24h: 7 - index }));
  const view = overviewView({ ...empty, market: snapshot([...members, asset('unknown', { change24h: null })]) }).data.reportedChanges;
  assert.deepEqual(view.leaders.map(row => row.id), ['a0', 'a1', 'a2', 'a3', 'a4']);
  assert.deepEqual(view.laggards.map(row => row.id), ['a6', 'a5']);
  assert.ok(!view.laggards.some(row => view.leaders.includes(row)));
  assert.ok(![...view.leaders, ...view.laggards].some(row => row.id === 'unknown'));
});

test('each block degrades independently when its own feed is unavailable', () => {
  const view = overviewView({ ...empty, market: snapshot([asset('bitcoin')], { degraded: true, error: 'provider 500' }) }).data;
  assert.equal(view.global.marketCapUsd, null);
  assert.equal(view.global.evidence.unavailable, true);
  assert.equal(view.breadth.total, 1);
  assert.equal(view.breadth.evidence.degraded, true);
  assert.equal(view.breadth.evidence.error, 'provider 500');
  assert.equal(view.btc.regime, 'insufficient-history');
  assert.equal(view.btc.evidence.unavailable, true);
  assert.equal(view.liquidity.stablecoin.value, null);
  assert.equal(view.liquidity.stablecoin.coverage.unavailable, true);
  assert.equal(view.reportedVolume.latest, null);
  assert.equal(view.performance.rows.length, 0);
});

test('relative performance uses aligned samples, reports BTC against itself as zero and lists unarchived assets', () => {
  const histories = [
    { assetId: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', series: series([day(90, 100), day(30, 100), day(7, 100), day(0, 110)]) },
    { assetId: 'solana', symbol: 'SOL', name: 'Solana', series: series([day(30, 100), day(7, 50), day(0, 132)]) },
  ];
  const view = overviewView({ ...empty, market: snapshot([asset('bitcoin'), asset('solana'), asset('cardano')]), histories }).data.performance;
  assert.equal(view.benchmark, 'bitcoin');
  assert.equal(view.rows[0].assetId, 'solana');
  assert.ok(Math.abs(view.rows[0].usd.d30! - 32) < 1e-9);
  assert.ok(Math.abs(view.rows[0].relative.d30! - 20) < 1e-9);
  assert.equal(view.rows[1].relative.d30, 0);
  assert.ok(Math.abs(view.rows[1].usd.d90! - 10) < 1e-9);
  assert.equal(view.rows[0].usd.d90, null);
  assert.equal(view.rows[0].relative.d90, null);
  assert.deepEqual(view.unarchivedAssets, ['cardano']);
});

test('sector leadership stays gated and reports classified coverage instead of market shares', () => {
  const view = overviewView({ ...empty, market: snapshot([asset('bitcoin', { marketCapUsd: 750 }), asset('uniswap', { marketCapUsd: 250 }), asset('cardano')]),
    categories: [{ id: 'bitcoin', category: 'L1' }, { id: 'uniswap', category: 'DEX' }] }).data.sectors;
  assert.equal(view.status, 'gated');
  assert.equal(view.classified, 2);
  assert.equal(view.unclassified, 1);
  assert.equal(view.categories[0].category, 'L1');
  assert.equal(view.categories[0].classifiedSharePct, 75);
  assert.match(view.coverage, /never of the market/);
  assert.match(view.limitations, /stays gated/);
});

test('notable signal changes combine confirmed regimes, threshold crossings and membership events', () => {
  const btc: any = { data: { latest: { observedAt: day(0).observedAt, value: 60000, regime: 'bearish', candidate: 'bearish', confirmationDays: 3,
    sma200: 55000, sma200Slope20d: -10, mayerMultiple: 1.09, mvrv: 2, drawdownPct: -12, volatility30d: 40, weeklyRsi: 45 },
    points: [{ observedAt: day(2).observedAt, regime: 'bullish' }, { observedAt: day(1).observedAt, regime: 'bearish' }],
    coverage: [{ points: 5000, stale: false, replayCoverageStart: '2026-01-01T00:00:00Z' }], methodology: { version: 'btc-trend:v1', regime: 'rule' } } };
  const market = snapshot([asset('bitcoin')]);
  market.events = [{ entity_key: 'newcoin', event_type: 'first_observed' }, { entity_key: 'x', event_type: 'baseline' }];
  const view = overviewView({ ...empty, market, btc,
    alerts: [{ id: '1', asset_id: 'bitcoin', title: 'BTC below 60k', detected_at: day(0).observedAt, evidence: { metric: 'priceUsd' } }] }).data;
  assert.equal(view.btc.regime, 'bearish');
  assert.equal(view.btc.mayerMultiple, 1.09);
  assert.equal(view.btc.evidence.unavailable, false);
  assert.deepEqual(view.signalChanges.map(change => change.type), ['tracked-membership', 'threshold-alert', 'btc-regime']);
  assert.match(view.signalChanges[0].detail, /not a listing, delisting or launch event/);
});
