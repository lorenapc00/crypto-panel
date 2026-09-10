import assert from 'node:assert/strict';
import test from 'node:test';
import { contiguousDays, correlationBeta, dailyLogReturns, emergingView, launchesView, maxDrawdown, median,
  percentileRank, realizedVolatilityPct, trailingMedian, trailingWindow, transactionImbalance, volumeAcceleration,
  type EmergingInput, type LaunchesInput, type PoolRow } from './calculations.js';
import type { Coverage } from '../perp/calculations.js';

const DAY = 86400000;
const midnight = Math.floor(Date.now() / DAY) * DAY;
const days = (count: number, value: (index: number) => number | null, from = midnight - count * DAY) =>
  Array.from({ length: count }, (_, index) => ({ observedAt: new Date(from + index * DAY).toISOString(), value: value(index) }));
const coverage = (overrides: Partial<Coverage> = {}): Coverage => ({ source: 'coingecko', scope: 'fixture',
  observedAt: new Date(midnight).toISOString(), recordedAt: new Date(midnight).toISOString(), snapshotId: '1', payloadId: '1',
  replayCoverageStart: new Date(midnight).toISOString(), intervalSeconds: 3600, methodologyVersion: 'fixture:v1',
  unavailable: false, stale: false, degraded: false, error: null, replayRefused: false, classification: 'forward tracking', ...overrides });

test('contiguous windows refuse to shorten themselves across a gap or an absent value', () => {
  assert.deepEqual(trailingWindow(days(5, index => index + 1), 3), [3, 4, 5]);
  assert.equal(trailingWindow(days(5, index => index + 1), 6), null, 'not enough history');
  assert.equal(trailingWindow(days(5, index => index === 3 ? null : 1), 3), null, 'an absent value breaks the window');
  const gapped = [...days(3, () => 1, midnight - 10 * DAY), ...days(3, () => 1, midnight - 3 * DAY)];
  assert.equal(trailingWindow(gapped, 4), null, 'a calendar gap breaks the window');
  assert.deepEqual(trailingWindow(gapped, 3), [1, 1, 1], 'the contiguous tail still resolves');
  assert.equal(trailingWindow(days(5, () => 1), 0), null);
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5, 'an even count averages the middle pair');
});

test('the volume screen uses a contiguous median and a 7-over-30 acceleration ratio', () => {
  const flat = days(40, () => 2_000_000);
  assert.equal(trailingMedian(flat, 30), 2_000_000);
  assert.equal(volumeAcceleration(flat), 1, 'a flat series does not accelerate');
  const rising = days(37, index => index >= 30 ? 3_000_000 : 1_000_000);
  assert.equal(volumeAcceleration(rising), 3);
  assert.equal(volumeAcceleration(days(36, () => 1)), null, 'both windows must be complete');
  assert.equal(trailingMedian(days(30, index => index === 0 ? null : 1), 30), null);
  assert.equal(volumeAcceleration(days(37, index => index < 30 ? 0 : 5)), null, 'a zero base leaves the ratio unavailable');
});

test('cross-sectional percentiles split ties and refuse an empty population', () => {
  assert.equal(percentileRank([], 1), null);
  assert.equal(percentileRank([1, 2, 3, 4], 4), 87.5, 'the top value keeps half of its own tie');
  assert.equal(percentileRank([1, 2, 3, 4], 1), 12.5);
  assert.equal(percentileRank([5, 5, 5, 5], 5), 50, 'a fully tied population sits at the middle');
  assert.equal(percentileRank([1, 2], Number.NaN), null);
});

test('daily log returns never span a gap, and risk measures stay unavailable on an incomplete window', () => {
  const gapped = [...days(2, () => 100, midnight - 10 * DAY), ...days(2, () => 400, midnight - 3 * DAY)];
  const returns = dailyLogReturns(gapped);
  assert.equal(returns.length, 2, 'only the two same-day-adjacent pairs survive');
  assert.ok(returns.every(point => point.value === 0), 'a gap never becomes one large move');
  assert.equal(realizedVolatilityPct(days(20, () => 100), 30), null);
  assert.equal(realizedVolatilityPct(days(31, () => 100), 30), 0, 'a flat series has zero realized volatility');
  const volatile = realizedVolatilityPct(days(31, index => 100 * (index % 2 ? 1.02 : 1)), 30);
  assert.ok(volatile !== null && volatile > 0);
});

test('maximum drawdown reports its trough, and an unrecovered fall has no recovery time', () => {
  const recovered = maxDrawdown(days(10, index => [100, 110, 120, 90, 95, 100, 110, 121, 130, 140][index]), 10);
  assert.ok(recovered.drawdownPct !== null && Math.abs(recovered.drawdownPct - -25) < 1e-9, 'peak 120 to trough 90');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.recoveryDays, 4, 'trough at index 3 back to 120 at index 7');
  const open = maxDrawdown(days(6, index => [100, 200, 150, 120, 110, 105][index]), 6);
  assert.equal(open.recovered, false);
  assert.equal(open.recoveryDays, null, 'an open drawdown reports no recovery, not zero');
  assert.equal(maxDrawdown(days(5, () => 100), 5).drawdownPct, 0);
  assert.equal(maxDrawdown(days(5, () => 100), 9).drawdownPct, null, 'an incomplete window is unavailable');
});

test('correlation and beta use only the days both series share', () => {
  // Constant growth has no return variance at all, so the fixture varies each day and the
  // asset moves exactly twice as far in log space: correlation 1, beta 2.
  const drift = Array.from({ length: 120 }, (_, index) => ((index % 3) - 1) * 0.01);
  const cumulative = drift.map((_, index) => drift.slice(0, index + 1).reduce((sum, value) => sum + value, 0));
  const benchmark = days(120, index => 100 * Math.exp(cumulative[index]));
  const doubled = days(120, index => 100 * Math.exp(2 * cumulative[index]));
  const paired = correlationBeta(doubled, benchmark, 90);
  assert.equal(paired.samples, 90);
  assert.ok(paired.correlation !== null && Math.abs(paired.correlation - 1) < 1e-9);
  assert.ok(paired.beta !== null && Math.abs(paired.beta - 2) < 1e-9, 'twice the log move is a beta of two');
  const short = correlationBeta(days(10, index => 100 + index), benchmark, 90);
  assert.equal(short.correlation, null, 'too few shared days leaves correlation unavailable');
  assert.equal(short.beta, null);
  const flatBenchmark = correlationBeta(days(120, index => 100 + index), days(120, () => 100), 90);
  assert.equal(flatBenchmark.beta, null, 'a benchmark with no variance has no beta');
});

test('contiguous history counts backwards from the newest sample and stops at the first break', () => {
  assert.equal(contiguousDays(days(90, () => 1)), 90);
  assert.equal(contiguousDays([...days(50, () => 1, midnight - 100 * DAY), ...days(10, () => 1, midnight - 10 * DAY)]), 10);
  assert.equal(contiguousDays(days(5, index => index === 4 ? null : 1)), 0, 'an absent newest sample means no contiguous history');
  assert.equal(contiguousDays([]), 0);
});

const emergingInput = (overrides: Partial<EmergingInput> = {}): EmergingInput => ({
  now: new Date(midnight).toISOString(), market: { coverage: coverage(), notes: null, events: [],
    members: [
      { key: 'bitcoin', status: 'observed', first_observed_at: null, data: { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin',
        rank: 1, priceUsd: 200, marketCapUsd: 1e12, volume24hUsd: 5e10, fullyDilutedValuationUsd: 1e12,
        circulatingSupply: 19, totalSupply: 19, maxSupply: 21, change24h: 1, change7d: 2, change30d: 3 } },
      { key: 'candidate', status: 'observed', first_observed_at: null, data: { id: 'candidate', symbol: 'CAND', name: 'Candidate',
        rank: 40, priceUsd: 4, marketCapUsd: 5e8, volume24hUsd: 4e6, fullyDilutedValuationUsd: 2.5e9,
        circulatingSupply: 100, totalSupply: 500, maxSupply: 500, change24h: 5, change7d: 9, change30d: 40 } },
      { key: 'tether', status: 'observed', first_observed_at: null, data: { id: 'tether', symbol: 'USDT', name: 'Tether',
        rank: 3, priceUsd: 1, marketCapUsd: 1e9, volume24hUsd: 9e9, fullyDilutedValuationUsd: 1e9,
        circulatingSupply: 1, totalSupply: 1, maxSupply: null, change24h: 0, change7d: 0, change30d: 0 } },
      { key: 'thin', status: 'observed', first_observed_at: null, data: { id: 'thin', symbol: 'THIN', name: 'Thin',
        rank: 90, priceUsd: 1, marketCapUsd: 4e8, volume24hUsd: 1e5, fullyDilutedValuationUsd: 4e8,
        circulatingSupply: 1, totalSupply: 1, maxSupply: 1, change24h: 0, change7d: 0, change30d: 0 } },
    ] },
  prices: [{ assetId: 'bitcoin', points: days(120, index => 100 * 1.001 ** index) },
    { assetId: 'candidate', points: days(120, index => 10 * 1.006 ** index) },
    { assetId: 'thin', points: days(120, () => 1) }],
  volumes: [{ assetId: 'bitcoin', points: days(60, () => 5e10) },
    { assetId: 'candidate', points: days(60, index => index >= 53 ? 8e6 : 4e6) },
    { assetId: 'thin', points: days(60, () => 1e5) }],
  pegSymbols: [{ symbol: 'USDT', name: 'Tether' }, { symbol: 'CAND', name: 'Candidate Dollar' }],
  pegCoverage: coverage({ source: 'defillama' }),
  exclusions: [{ assetId: 'tether', symbol: 'USDT', reason: 'stablecoin', canonicalAssetId: null,
    evidence: 'USD-pegged stablecoin', methodologyVersion: 'universe-exclusions:v1' }],
  categories: [{ assetId: 'bitcoin', category: 'L1' }],
  alertRules: [{ assetId: 'candidate', title: 'Above $5', metric: 'priceUsd', comparator: 'above', threshold: 5 }],
  replayRefusals: [], filters: { screen: 'eligible', minMarketCapUsd: 1e7, maxMarketCapUsd: 2e9,
    minMedianVolumeUsd: 1e6, minHistoryDays: 90, search: null, limit: 50 }, ...overrides });

test('the eligible universe separates a failed screen from an unknown one and applies only curated exclusions', () => {
  const view = emergingView(emergingInput({ filters: { ...emergingInput().filters, screen: 'all' } }));
  const rows = new Map(view.data.rows.map(row => [row.assetId, row]));
  assert.equal(rows.get('bitcoin')!.eligibility.marketCap, 'fail', 'a $1T market cap is outside the band');
  assert.equal(rows.get('candidate')!.eligibility.eligible, true);
  assert.equal(rows.get('thin')!.eligibility.medianVolume, 'fail', 'a $100K median misses the $1M default');
  assert.equal(rows.get('tether')!.eligibility.identity, 'fail');
  assert.equal(rows.get('tether')!.identity.reason, 'stablecoin');
  // A ticker collision against the peg catalog is review evidence, never an exclusion.
  assert.equal(rows.get('candidate')!.identity.excluded, false);
  assert.equal(rows.get('candidate')!.identity.pegSymbolMatch, 'Candidate Dollar');
  assert.match(rows.get('candidate')!.identity.pegSymbolNote!, /does not exclude the asset/);
  assert.equal(view.data.universe.eligible, 1);
  assert.equal(view.data.universe.curatedExclusions, 1);
  assert.equal(view.data.universe.pegSymbolMatches, 1);
});

test('an asset with no archived history is unknown rather than failed, and stays out of the eligible screen', () => {
  const input = emergingInput();
  const missing = emergingView({ ...input, prices: input.prices.filter(row => row.assetId !== 'candidate'),
    volumes: input.volumes.filter(row => row.assetId !== 'candidate'),
    filters: { ...input.filters, screen: 'all' } });
  const candidate = missing.data.rows.find(row => row.assetId === 'candidate')!;
  assert.equal(candidate.eligibility.history, 'unknown');
  assert.equal(candidate.eligibility.medianVolume, 'unknown');
  assert.equal(candidate.eligibility.eligible, false);
  assert.deepEqual(candidate.returns.usd, { d7: null, d30: null, d90: null });
  assert.equal(candidate.risk.volatility30dPct, null);
  assert.equal(candidate.attention!.ranked, false);
  assert.match(candidate.evidence.gaps[0], /No daily price history is archived/);
  assert.equal(missing.data.universe.unknownChecks.history, 2, 'the stablecoin has no history either');
});

test('attention ranks only inside the eligible universe and reports every missing input', () => {
  const input = emergingInput();
  const view = emergingView({ ...input, filters: { ...input.filters, screen: 'all' } });
  const candidate = view.data.rows.find(row => row.assetId === 'candidate')!;
  assert.equal(candidate.attention!.ranked, true);
  // The only eligible asset holds every percentile alone: 50 across all three components.
  assert.equal(candidate.attention!.score, 50);
  assert.deepEqual(candidate.attention!.percentiles, { excess90d: 50, excess30d: 50, volumeAcceleration: 50 });
  const bitcoin = view.data.rows.find(row => row.assetId === 'bitcoin')!;
  assert.equal(bitcoin.attention!.ranked, false);
  assert.match(bitcoin.attention!.reason!, /Outside the eligible universe/);
  assert.equal(view.data.attention.prime, false, 'an unvalidated score never takes prime interface space');
  assert.match(view.data.attention.caveat, /not expected investment return/);
  assert.match(view.data.attention.caveat, /closer to a single momentum factor/);
  assert.deepEqual(view.data.attention.weights, { excess90d: 0.4, excess30d: 0.3, volumeAcceleration: 0.3 });
});

test('BTC-relative returns compound, risk travels with the row and sector comparison stays gated', () => {
  const input = emergingInput();
  const view = emergingView({ ...input, filters: { ...input.filters, screen: 'all' } });
  const candidate = view.data.rows.find(row => row.assetId === 'candidate')!;
  const btc = view.data.rows.find(row => row.assetId === 'bitcoin')!;
  const expected = ((1 + candidate.returns.usd.d30! / 100) / (1 + view.data.benchmark.returns.d30! / 100) - 1) * 100;
  assert.ok(Math.abs(candidate.returns.relative.d30! - expected) < 1e-9, 'relative return compounds, never subtracts');
  assert.equal(btc.returns.relative.d30, 0, 'BTC against itself is zero, not null');
  assert.ok(candidate.risk.btcCorrelation90d !== null && candidate.risk.btcBeta90d !== null);
  assert.equal(candidate.dilution.fdvToMarketCap, 5);
  assert.match(candidate.dilution.unlockSchedule, /unavailable/);
  assert.equal(view.data.sectors.status, 'gated');
  assert.equal(candidate.valueCapture.status, 'gated');
  assert.equal(candidate.peers.status, 'gated');
  assert.equal(candidate.evidence.savedConditions.length, 1, 'saved thesis conditions travel with the evidence panel');
  assert.match(candidate.evidence.historicalOutcomes, /gated/);
});

test('a refused feed is named, and the tracked page carries its own coverage', () => {
  const input = emergingInput();
  const view = emergingView({ ...input, replayRefusals: ['daily-histories'],
    prices: [], volumes: [], filters: { ...input.filters, screen: 'all' } });
  assert.equal(view.data.benchmark.replayRefused, true);
  assert.equal(view.data.coverage.dailyHistories.replayRefused, true);
  assert.deepEqual(view.data.methodology.replayRefusals, ['daily-histories']);
  assert.equal(view.data.universe.tracked, 4, 'the tracked page still resolves when the histories are refused');
  assert.equal(view.data.rows.every(row => row.attention!.ranked === false), true);
});

const pool = (overrides: Partial<PoolRow> & { entityKey: string }): PoolRow => ({
  chain: 'solana', datasetId: 'geckoterminal:pools:solana:v1', baseTokenAddress: 'TokenA',
  firstObservedAt: new Date(midnight).toISOString(), observedAt: new Date(midnight).toISOString(),
  inLatestSnapshot: true, priorData: null, priorObservedAt: null,
  data: { chain: 'solana', name: 'AAA / SOL', liquidityUsd: 150_000, reported24hVolumeUsd: 300_000,
    quoteTokenAddress: 'So11111111111111111111111111111111111111112', baseTokenAddress: 'TokenA',
    transactions: { h24: { buys: 70, sells: 30 } }, providerPoolCreatedAt: new Date(midnight).toISOString(),
    contractRisk: 'unknown' }, ...overrides });

const launchesInput = (overrides: Partial<LaunchesInput> = {}): LaunchesInput => ({
  now: new Date(midnight + 3600_000).toISOString(),
  pools: [pool({ entityKey: 'poolA' })], pairs: [], orders: [],
  quoteTokens: [{ chain: 'solana', tokenAddress: 'So11111111111111111111111111111111111111112', symbol: 'WSOL',
    kind: 'native-wrapped', evidence: 'Wrapped SOL' }],
  chains: [{ chain: 'solana', datasetId: 'geckoterminal:pools:solana:v1', coverage: coverage({ source: 'geckoterminal' }), notes: null }],
  replayRefusals: [], filters: { screen: 'new', windowDays: 30, chain: null, minLiquidityUsd: 100_000,
    includeUnknownLiquidity: false, search: null, limit: 50 }, ...overrides });

test('a later pool never resets the token first observation that made it new', () => {
  const old = new Date(midnight - 45 * DAY).toISOString();
  const view = launchesView(launchesInput({ pools: [
    pool({ entityKey: 'poolOld', firstObservedAt: old, inLatestSnapshot: false, observedAt: old }),
    pool({ entityKey: 'poolNew' }),
  ], filters: { ...launchesInput().filters, screen: 'all' } }));
  assert.equal(view.data.universe.tokens, 1, 'two pools of one token are one token');
  const row = view.data.rows[0];
  assert.equal(row.lifecycle.firstObservedAt, old);
  assert.equal(row.lifecycle.hasNewerPools, true);
  assert.equal(row.lifecycle.withinWindow, false, 'a 45-day-old token is not a new launch');
  assert.equal(row.screen.shortlisted, false);
  assert.equal(row.liquidity.poolsEverSampled, 2);
  assert.match(row.lifecycle.evidence, /A pool created later never resets it/);
});

test('unknown pool liquidity never becomes zero and never passes the minimum', () => {
  const view = launchesView(launchesInput({ pools: [pool({ entityKey: 'poolA', chain: 'base',
    datasetId: 'geckoterminal:pools:base:v1', data: { ...pool({ entityKey: 'poolA' }).data, liquidityUsd: null } })],
  chains: [{ chain: 'base', datasetId: 'geckoterminal:pools:base:v1', coverage: coverage(), notes: null }],
  filters: { ...launchesInput().filters, screen: 'all' } }));
  const row = view.data.rows[0];
  assert.equal(row.liquidity.liquidityUsd, null);
  assert.equal(row.screen.liquidity, 'unknown');
  assert.equal(row.screen.shortlisted, false, 'unknown liquidity is not a passing result');
  assert.equal(row.attention.turnoverPct, null);
  assert.match(row.risk.flags[0], /stays unknown and never counts as meeting the minimum/);
  const permissive = launchesView(launchesInput({ pools: [pool({ entityKey: 'poolA',
    data: { ...pool({ entityKey: 'poolA' }).data, liquidityUsd: null } })],
  filters: { ...launchesInput().filters, includeUnknownLiquidity: true } }));
  assert.equal(permissive.data.rows[0].screen.shortlisted, true, 'the operator can opt in explicitly');
});

test('a liquidity change needs every contributing pool to have its own earlier observation', () => {
  const prior = { ...pool({ entityKey: 'poolA' }).data, liquidityUsd: 100_000 };
  const priorAt = new Date(midnight - 2 * 3600_000).toISOString();
  const covered = launchesView(launchesInput({ pools: [pool({ entityKey: 'poolA', priorData: prior, priorObservedAt: priorAt })] }));
  const change = covered.data.rows[0].liquidity.changeSincePrior;
  assert.equal(change.covered, true);
  assert.ok(Math.abs(change.changePct! - 50) < 1e-9);
  assert.equal(change.elapsedHours, 2, 'the actual elapsed time is reported, never assumed');
  const partial = launchesView(launchesInput({ pools: [
    pool({ entityKey: 'poolA', priorData: prior, priorObservedAt: priorAt }),
    pool({ entityKey: 'poolB' }),
  ] }));
  const blocked = partial.data.rows[0].liquidity.changeSincePrior;
  assert.equal(blocked.covered, false);
  assert.equal(blocked.changePct, null);
  assert.match(blocked.reason!, /different pool memberships/);
});

test('risk status stays unknown, promotion stays promotion and attention is kept separate', () => {
  const view = launchesView(launchesInput({
    pairs: [{ chain: 'solana', datasetId: 'dexscreener:solana:pairs:slot0:v1', token: 'TokenA',
      data: { priceUsd: 0.5, boosts: { active: 3 } }, observedAt: new Date(midnight).toISOString() }],
    orders: [{ chain: 'solana', datasetId: 'dexscreener:solana:orders:slot0:v1', token: 'TokenA',
      data: { orders: [{ type: 'tokenProfile' }], boosts: [] }, observedAt: new Date(midnight).toISOString() }] }));
  const row = view.data.rows[0];
  assert.equal(row.risk.contract, 'unknown');
  assert.equal(row.risk.status, 'unknown');
  assert.equal(row.risk.criticalFlags.length, 0);
  assert.equal(row.promotion.boosts, 'present');
  assert.match(row.promotion.classification, /never treated as demand/);
  assert.ok(row.risk.flags.some(flag => /Paid promotion is reported/.test(flag)));
  assert.equal(row.attention.buySellImbalancePct, 40, '70 buys against 30 sells');
  assert.equal(row.attention.priceUsd, 0.5);
  assert.match(row.attention.note, /not a positive investment signal/);
  assert.match(view.data.riskGate.rule, /not a clean bill of health/);
  assert.equal(view.data.riskGate.verifiedChecks, 0);
  // The base side of a pool label is never presented as a verified token symbol.
  assert.equal(row.baseLabel, 'AAA');
  assert.match(row.labelEvidence, /not a verified token symbol/);
});

test('transaction imbalance refuses to divide an empty window and quote tokens resolve explicitly', () => {
  assert.deepEqual(transactionImbalance({ h24: { buys: 0, sells: 0 } }), { buys: 0, sells: 0, imbalancePct: null });
  assert.equal(transactionImbalance(null).imbalancePct, null);
  assert.equal(transactionImbalance({ h24: { buys: 3, sells: 1 } }).imbalancePct, 50);
  const unrecognised = launchesView(launchesInput({ pools: [pool({ entityKey: 'poolA',
    data: { ...pool({ entityKey: 'poolA' }).data, quoteTokenAddress: 'Unknown' } })] }));
  const row = unrecognised.data.rows[0];
  assert.equal(row.liquidity.verifiedQuote, false);
  assert.equal(row.liquidity.quoteTokens[0].kind, 'unrecognised');
  assert.ok(row.risk.flags.some(flag => /USD reference is unverified/.test(flag)));
  const known = launchesView(launchesInput());
  assert.equal(known.data.rows[0].liquidity.quoteTokens[0].symbol, 'WSOL');
});

test('a refused chain is named without hiding the chain that is covered', () => {
  const view = launchesView(launchesInput({ replayRefusals: ['pools:base'],
    chains: [{ chain: 'solana', datasetId: 'geckoterminal:pools:solana:v1', coverage: coverage(), notes: null },
      { chain: 'base', datasetId: 'geckoterminal:pools:base:v1', coverage: coverage({ replayRefused: true, unavailable: true }), notes: null }] }));
  assert.deepEqual(view.data.methodology.replayRefusals, ['pools:base']);
  assert.equal(view.data.chains.find(entry => entry.chain === 'base')!.coverage.replayRefused, true);
  assert.equal(view.data.rows.length, 1, 'the covered chain still returns its tokens');
  assert.match(view.data.methodology.identity, /never treated as contract addresses/);
  assert.match(view.data.methodology.launchDates, /No connected free feed publishes a verified token launch date/);
});
