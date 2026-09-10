import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePerpOpenInterest, perpOpenInterestSeriesId } from '../feeds/perp.js';
import { annualizedFundingPct, endpointChangePct, listingClassification, listingsView, premiumBps,
  projectsView, sharePct, trailingSum, windowGrowthPct, type Coverage, type InstrumentRow } from './calculations.js';

const DAY = 86400000;
const midnight = Math.floor(Date.now() / DAY) * DAY;
const days = (count: number, value: (index: number) => number | null, from = midnight - count * DAY) =>
  Array.from({ length: count }, (_, index) => ({ observedAt: new Date(from + index * DAY).toISOString(), value: value(index) }));
const coverage = (overrides: Partial<Coverage> = {}): Coverage => ({ source: 'defillama', scope: 'fixture', observedAt: new Date(midnight).toISOString(),
  recordedAt: new Date(midnight).toISOString(), snapshotId: '1', payloadId: '1', replayCoverageStart: new Date(midnight).toISOString(),
  intervalSeconds: 86400, methodologyVersion: 'fixture:v1', unavailable: false, stale: false, degraded: false, error: null,
  replayRefused: false, classification: 'forward tracking', ...overrides });

const openInterestPayload = (overrides: Record<string, unknown> = {}) => ({
  total24h: 20_000_000_000,
  totalDataChart: [[(midnight - 2 * DAY) / 1000, 18_000_000_000], [(midnight - DAY) / 1000, 19_000_000_000], [midnight / 1000, 20_000_000_000]],
  protocols: [
    { defillamaId: '5507', slug: 'hyperliquid-perps', name: 'Hyperliquid Perps', displayName: 'Hyperliquid Perps',
      category: 'Derivatives', chains: ['Hyperliquid L1'], parentProtocol: 'parent#hyperliquid', module: 'hyperliquid-perp-oi',
      methodologyURL: 'https://example.invalid/oi', total24h: 14_000_000_000, total7DaysAgo: 13_000_000_000,
      total30DaysAgo: 10_000_000_000, change_1d: -1.45, change_7d: 5.83, change_1m: 33.27 },
    { defillamaId: '144', slug: 'dydx-v3', name: 'dYdX V3', category: 'Derivatives', chains: ['dYdX'], total24h: null },
  ], ...overrides });

test('the covered open-interest feed keeps the provider convention, excludes the live day and rejects irregular history', () => {
  const received = new Date(midnight + 3600_000).toISOString();
  const sample = parsePerpOpenInterest(openInterestPayload(), received);
  assert.equal(sample.members.length, 2);
  const hyperliquid = sample.members[0];
  assert.equal(hyperliquid.key, JSON.stringify(['defillama', '5507']));
  assert.equal(hyperliquid.data.openInterestUsd, 14_000_000_000);
  assert.equal(hyperliquid.data.openInterest30DaysAgoUsd, 10_000_000_000);
  assert.match(String(hyperliquid.data.convention), /counts both sides/);
  assert.match(String(hyperliquid.data.reportedVolume), /402/);
  // A covered protocol with no reported value stays null, never zero.
  assert.equal(sample.members[1].data.openInterestUsd, null);
  const series = sample.series![0];
  assert.equal(series.definition.id, perpOpenInterestSeriesId);
  assert.equal(series.definition.assetId, null);
  assert.equal(series.points.length, 2, 'the live provider day is excluded');
  assert.equal(series.points.at(-1)!.observedAt, new Date(midnight - DAY).toISOString());
  assert.match(String(sample.notes.volumeGate), /HTTP 402/);

  assert.throws(() => parsePerpOpenInterest(openInterestPayload({ protocols: [] }), received), /Empty covered open-interest universe/);
  assert.throws(() => parsePerpOpenInterest(openInterestPayload({
    totalDataChart: [[(midnight - DAY) / 1000 + 300, 1]] }), received), /Invalid open-interest history timestamp/);
  assert.throws(() => parsePerpOpenInterest(openInterestPayload({
    totalDataChart: [[(midnight - DAY) / 1000, 1], [(midnight - 2 * DAY) / 1000, 2]] }), received), /Invalid open-interest history timestamp/);
  assert.throws(() => parsePerpOpenInterest(openInterestPayload({
    totalDataChart: [[(midnight - DAY) / 1000, -5]] }), received), /Invalid open-interest history value/);
  assert.throws(() => parsePerpOpenInterest(openInterestPayload({
    protocols: [openInterestPayload().protocols[0], openInterestPayload().protocols[0]] }), received), /Duplicate open-interest protocol identity/);
  assert.throws(() => parsePerpOpenInterest(openInterestPayload({
    totalDataChart: [[midnight / 1000, 1]] }), received), /No completed covered open-interest values/);
});

test('trailing windows, endpoint changes and derived venue ratios refuse incomplete inputs', () => {
  const complete = days(60, () => 10);
  assert.equal(trailingSum(complete, 30), 300);
  assert.equal(windowGrowthPct(complete, 30), 0);
  assert.equal(windowGrowthPct(days(60, index => index < 30 ? 10 : 20), 30), 100);
  assert.equal(trailingSum(days(29, () => 10), 30), null, 'a short window is unavailable, not a partial sum');
  assert.equal(trailingSum(days(31, () => 10).filter((_, index) => index !== 5), 30), null, 'a missing day makes the window unavailable');
  assert.equal(trailingSum([...days(30, () => 10, midnight - 61 * DAY), ...days(30, () => 10)], 30, 1), 300,
    'the preceding window is contiguous in itself, so it stays available while the gap sits between the windows');
  assert.equal(trailingSum(days(30, index => index === 0 ? null : 10), 30), null);
  assert.equal(Number(endpointChangePct(110, 100)!.toFixed(9)), 10);
  assert.equal(endpointChangePct(110, 0), null);
  assert.equal(endpointChangePct(null, 100), null);
  assert.equal(sharePct(25, 100), 25);
  assert.equal(sharePct(25, 0), null);
  assert.equal(Number(premiumBps(100.5, 100)!.toFixed(6)), 50);
  assert.equal(premiumBps(100, null), null);
  assert.equal(annualizedFundingPct(0.00001, 3600), 0.00001 * 8760 * 100);
  assert.equal(annualizedFundingPct(0.00001, 0), null);
  assert.equal(listingClassification('baseline', ['baseline']), 'archive-baseline');
  assert.equal(listingClassification('relisted', ['baseline', 'delisted', 'relisted']), 'relisted');
  assert.equal(listingClassification(null, ['baseline', 'first_observed']), 'venue-new-to-archive');
  assert.equal(listingClassification(null, []), 'tracked');
});

const projectsInput = (overrides: Partial<Parameters<typeof projectsView>[0]> = {}): Parameters<typeof projectsView>[0] => ({
  now: new Date(midnight + 3600_000).toISOString(),
  catalog: { coverage: coverage({ scope: 'DefiLlama protocol catalog' }), notes: null, events: [{ entity_key: JSON.stringify(['defillama', '5507']), event_type: 'baseline' }],
    members: [
      { key: JSON.stringify(['defillama', '5507']), status: 'observed', first_observed_at: new Date(midnight - 2 * DAY).toISOString(),
        data: { protocolId: '5507', slug: 'hyperliquid-perps', name: 'Hyperliquid Perps', category: 'Derivatives', chains: ['Hyperliquid L1'], tvlUsd: 180_000_000, geckoId: 'hyperliquid' } },
      { key: JSON.stringify(['defillama', '999']), status: 'observed', first_observed_at: new Date(midnight - DAY).toISOString(),
        data: { protocolId: '999', slug: 'undated-perps', name: 'Undated Perps', category: 'Derivatives', chains: ['Base'], tvlUsd: null, geckoId: null } },
      { key: JSON.stringify(['defillama', '777']), status: 'observed', first_observed_at: new Date(midnight - DAY).toISOString(),
        data: { protocolId: '777', slug: 'a-lending-market', name: 'A Lending Market', category: 'Lending', chains: ['Base'], tvlUsd: 10, geckoId: null } },
    ] },
  openInterest: { coverage: coverage({ scope: 'covered open interest' }), notes: { coveredProtocols: 2 }, events: [],
    members: parsePerpOpenInterest(openInterestPayload(), new Date(midnight + 3600_000).toISOString()).members.map(member => ({
      ...member, first_observed_at: new Date(midnight - 2 * DAY).toISOString() })) },
  aggregate: { points: days(40, index => 18_000_000_000 + index * 100_000_000), metadata: { seriesId: perpOpenInterestSeriesId, replayCoverageStart: null } },
  fundamentals: [
    { assetId: 'hyperliquid', metricCode: 'fees_24h_usd', series: { points: days(60, () => 1_000_000), metadata: {} } },
    { assetId: 'hyperliquid', metricCode: 'revenue_24h_usd', series: { points: days(60, index => index < 30 ? 400_000 : 500_000), metadata: {} } },
  ],
  fundamentalLinks: [{ key: 'hyperliquid', assetId: 'hyperliquid', evidence: 'verified protocol history' }],
  venueLinks: [{ protocolId: '5507', protocolSlug: 'hyperliquid-perps', venue: 'hyperliquid', namespace: '',
    evidence: 'same venue read directly', methodologyVersion: 'perp-links:v1' }],
  venueActivity: [{ venue: 'hyperliquid', namespace: '', instruments: 234, active: 230, openInterestNative: 35_000,
    estimatedOpenInterestQuote: 2_700_000_000, reported24hNotionalVolume: 2_900_000_000, observedAt: new Date(midnight).toISOString() }],
  tokens: [{ id: 'hyperliquid', symbol: 'HYPE', name: 'Hyperliquid', priceUsd: 40, marketCapUsd: 13_000_000_000 }],
  replayRefusals: [], filters: { window: 'all', venue: null, stage: null, search: null, limit: 100 }, ...overrides });

test('perp projects compose the covered universe, declare its scope and keep volume share gated', () => {
  const view = projectsView(projectsInput()).data;
  assert.equal(view.universe.matched, 3, 'Derivatives catalog entries and covered open-interest protocols, never Lending');
  assert.match(view.universe.scope, /not a verified perp-DEX taxonomy/);
  assert.equal(view.universe.catalogDerivatives, 2);
  assert.equal(view.universe.coveredOpenInterestProtocols, 2);
  const hyperliquid = view.rows.find(row => row.protocolId === '5507')!;
  assert.equal(hyperliquid.adoption.openInterestUsd, 14_000_000_000);
  assert.equal(hyperliquid.adoption.openInterestShareOfCoveredPct, 100, 'the denominator is the covered universe, and a null value is not zero');
  assert.equal(Number(hyperliquid.adoption.openInterestChange30dPct!.toFixed(2)), 40);
  assert.equal(hyperliquid.adoption.providerChangePct1d, -1.45);
  assert.equal(hyperliquid.adoption.reportedVolumeUsd, null);
  assert.equal(hyperliquid.adoption.volumeSharePct, null);
  assert.match(hyperliquid.adoption.volumeGate, /HTTP 402/);
  assert.equal(hyperliquid.stage, 'live-token');
  assert.equal(hyperliquid.token!.verifiedTerms, false);
  assert.equal(hyperliquid.token!.unlocks, 'unavailable');
  assert.equal(hyperliquid.venue!.instruments, 234);
  assert.equal(hyperliquid.economics.fees30dUsd, 30_000_000);
  assert.equal(hyperliquid.economics.revenue30dUsd, 15_000_000);
  assert.equal(hyperliquid.economics.revenueGrowth30dPct, 25);
  assert.equal(hyperliquid.economics.retainedFeeSharePct, 50);
  assert.equal(hyperliquid.economics.effectiveFeeRate, null, 'a fee rate per unit of volume stays unavailable while volume is gated');
  assert.equal(hyperliquid.economics.scopeMatch, 'parent',
    'the archived history is scoped to parent#hyperliquid, not to the perps module alone');
  assert.ok(hyperliquid.risks.some(risk => /Archived fundamentals are scoped to parent#hyperliquid/.test(risk)));
  assert.equal(hyperliquid.lifecycle.verifiedProtocolLaunchAt, null);
  assert.equal(hyperliquid.lifecycle.verifiedTokenLaunchAt, null);
  assert.equal(hyperliquid.lifecycle.launchDates, 'unknown');
  assert.ok(hyperliquid.risks.some(risk => /Launch dates are unverified/.test(risk)));
  assert.ok(hyperliquid.risks.some(risk => /counts both sides/.test(risk)));
  assert.ok(hyperliquid.whyWatch.some(reason => /covered open-interest universe/.test(reason)));

  const undated = view.rows.find(row => row.protocolId === '999')!;
  assert.equal(undated.adoption.openInterestUsd, null);
  assert.equal(undated.stage, 'unknown');
  assert.equal(undated.token, null);
  assert.ok(undated.contradictions.some(note => /No verified tradable token/.test(note)));
  assert.ok(undated.risks.some(risk => /unavailable rather than zero/.test(risk)));
  assert.ok(undated.risks.some(risk => /No individually verified fee, revenue or TVL history/.test(risk)));

  // dYdX V3 reports no open interest and is absent from the catalog fixture.
  const dydx = view.rows.find(row => row.protocolId === '144')!;
  assert.ok(dydx.risks.some(risk => /absent from the archived protocol catalog/.test(risk)));
  assert.equal(view.sorting.applied, 'verified-milestone');
  assert.equal(view.sorting.fallback, 'first-observed');
  assert.deepEqual(view.sorting.disabled, ['30D volume market-share change', 'reported volume growth']);
  assert.equal(view.aggregate.values, 40);
  assert.equal(Number(view.aggregate.change7dPct!.toFixed(4)), Number(((21_900_000_000 / 21_200_000_000 - 1) * 100).toFixed(4)));
});

test('perp projects rank undated entries by first observation and refuse an empty verified-launch window', () => {
  const view = projectsView(projectsInput()).data;
  assert.deepEqual(view.rows.map(row => row.protocolId), ['999', '144', '5507'],
    'no verified milestone exists, so the explicit first-observed fallback orders the rows and ties break on protocol id');
  assert.equal(view.universe.withVerifiedMilestone, 0);
  const early = projectsView(projectsInput({ filters: { window: 'early', venue: null, stage: null, search: null, limit: 100 } })).data;
  assert.equal(early.rows.length, 0);
  assert.equal(early.earlyFilter.eligible, 0);
  assert.match(early.earlyFilter.explanation, /verified protocol or token launch dates/);
  const filtered = projectsView(projectsInput({ filters: { window: 'all', venue: 'hyperliquid', stage: null, search: null, limit: 100 } })).data;
  assert.deepEqual(filtered.rows.map(row => row.protocolId), ['5507']);
  const refused = projectsView(projectsInput({ openInterest: null, aggregate: null, replayRefusals: ['perp-open-interest'] })).data;
  assert.equal(refused.universe.coveredOpenInterestProtocols, 0);
  assert.equal(refused.aggregate.replayRefused, true);
  assert.equal(refused.rows.length, 2, 'the protocol catalog block survives a refused open-interest cutoff');
});

const instrument = (overrides: Partial<InstrumentRow> & { name: string; namespace: string }): InstrumentRow => ({
  key: JSON.stringify(['hyperliquid', overrides.namespace, overrides.name]),
  dataset_id: `hyperliquid:instruments:${overrides.namespace || 'native'}:v1`,
  status: 'active', first_observed_at: new Date(midnight - DAY).toISOString(),
  event_types: ['baseline'], latest_event_type: 'baseline', in_latest_snapshot: true,
  observed_at: new Date(midnight).toISOString(), prior_data: null, prior_observed_at: null,
  day_prior_data: null, day_prior_observed_at: null,
  data: { name: overrides.name, namespace: overrides.namespace, venue: 'hyperliquid', index: 0,
    openInterestNative: 1000, openInterestUnit: 'underlying units', markPrice: 100,
    estimatedOpenInterestQuote: 100_000, quoteCurrency: 'unresolved', notionalMethod: 'native OI × mark price; no USD conversion',
    fundingRate: 0.00001, fundingIntervalSeconds: 3600, reported24hNotionalVolume: 5_000_000,
    impactPrices: [99.9, 100.1], contract: { maxLeverage: 40 }, context: { oraclePx: '99.5', premium: '0.0005' } },
  ...overrides, namespace: overrides.namespace });

const listingsInput = (overrides: Partial<Parameters<typeof listingsView>[0]> = {}): Parameters<typeof listingsView>[0] => ({
  now: new Date(midnight + 3600_000).toISOString(),
  namespaces: { coverage: coverage({ scope: 'Hyperliquid perp DEX namespaces', intervalSeconds: 3600 }), notes: null, events: [],
    members: [
      { key: JSON.stringify(['hyperliquid', '']), status: 'observed', first_observed_at: new Date(midnight - DAY).toISOString(), data: { namespace: '', metadata: null, venue: 'hyperliquid' } },
      { key: JSON.stringify(['hyperliquid', 'mkts']), status: 'observed', first_observed_at: new Date(midnight - DAY).toISOString(),
        data: { namespace: 'mkts', venue: 'hyperliquid', metadata: { fullName: 'Markets DEX', deployer: '0xabc', feeRecipient: null, oracleUpdater: null } } },
    ] },
  datasets: [{ datasetId: 'hyperliquid:instruments:native:v1', namespace: '', coverage: coverage({ intervalSeconds: 3600 }) },
    { datasetId: 'hyperliquid:instruments:mkts:v1', namespace: 'mkts', coverage: coverage({ intervalSeconds: 3600 }) }],
  instruments: [
    instrument({ name: 'BTC', namespace: '', prior_data: { openInterestNative: 900 }, prior_observed_at: new Date(midnight - 3600_000).toISOString() }),
    instrument({ name: 'NEWCOIN', namespace: '', event_types: ['first_observed'], latest_event_type: 'first_observed',
      first_observed_at: new Date(midnight - 2 * 3600_000).toISOString() }),
    instrument({ name: 'mkts:AAPL', namespace: 'mkts', event_types: ['first_observed'], latest_event_type: 'first_observed' }),
    instrument({ name: 'mkts:BTC', namespace: 'mkts', event_types: ['first_observed'], latest_event_type: 'first_observed' }),
    instrument({ name: 'GONE', namespace: '', status: 'delisted', event_types: ['baseline', 'delisted'], latest_event_type: 'delisted' }),
  ],
  books: [{ entityKey: JSON.stringify(['hyperliquid', '', 'BTC']), datasetId: 'hyperliquid:book:BTC:v1',
    observedAt: new Date(midnight).toISOString(),
    data: { observedAt: new Date(midnight).toISOString(), spreadBps: 1.2, depthQuote: [500_000, 480_000], quoteCurrency: 'USDC',
      levels: [Array.from({ length: 20 }), Array.from({ length: 20 })],
      impact: [{ notionalQuote: 1000, buy: { averagePrice: 100.01, impactBps: 1 }, sell: null }] } }],
  settledFunding: [{ entityKey: JSON.stringify(['hyperliquid', '', 'BTC', midnight - 3600_000]), datasetId: 'hyperliquid:funding:BTC:v1',
    observedAt: new Date(midnight - 3600_000).toISOString(),
    data: { observedAt: new Date(midnight - 3600_000).toISOString(), fundingRate: 0.0000125, premium: -0.0003,
      intervalSeconds: 3600, definition: 'Published historical hourly funding rate; not account cash flow' } }],
  underlyingLinks: [{ venue: 'hyperliquid', namespace: '', instrument: 'BTC', assetId: 'bitcoin', assetClass: 'crypto', evidence: 'curated link' }],
  histories: [{ assetId: 'bitcoin', points: days(40, index => 100 + index) }],
  replayRefusals: [],
  filters: { screen: 'new', windowDays: 30, namespace: null, underlying: 'verified', search: null, limit: 200 }, ...overrides });

test('new perp listings exclude the archive baseline, count what was excluded and keep non-crypto underlyings out of the default screen', () => {
  const view = listingsView(listingsInput()).data;
  assert.deepEqual(view.rows.map(row => row.instrument), ['NEWCOIN'],
    'only a market this archive first observed inside the window enters the default screen');
  assert.equal(view.screen.excluded.baseline, 2);
  assert.equal(view.screen.excluded.delisted, 1);
  assert.equal(view.screen.excluded.unresolvedUnderlyingOutsideNative, 2);
  assert.match(view.screen.rule, /excluded and counted, never deleted/);
  assert.equal(view.screen.excluded.absentFromLatestCatalog, 0);
  assert.equal(view.lifecycle.baselineInstruments, 2);
  assert.equal(view.lifecycle.newListings, 3);
  assert.equal(view.lifecycle.delistings, 1);
  assert.equal(view.lifecycle.venueDelistedMarkets, 1);
  assert.equal(view.lifecycle.verifiedUnderlyings, 1);
  assert.equal(view.lifecycle.withOrderBook, 1);
  assert.match(view.methodology.underlying, /never becomes a passing result/);
  assert.equal(view.namespaces[0].instruments, 3);
  assert.equal(view.namespaces.find(row => row.namespace === 'mkts')!.verifiedUnderlyings, 0);
  assert.equal(view.namespaces.find(row => row.namespace === 'mkts')!.label, 'Markets DEX');

  const all = listingsView(listingsInput({ filters: { screen: 'all', windowDays: 30, namespace: null, underlying: 'all', search: null, limit: 200 } })).data;
  assert.equal(all.rows.length, 5, 'the venue catalog preserves delisted and unresolved markets for research');
  const apple = all.rows.find(row => row.instrument === 'mkts:AAPL')!;
  assert.equal(apple.underlying.assetClass, 'unknown');
  assert.equal(apple.underlying.spot, null);
  assert.equal(apple.underlying.preMarket, 'unknown');
  assert.ok(apple.risks.some(risk => /Underlying asset and asset class are unresolved/.test(risk)));
});

test('listing market evidence keeps open-interest units, funding intervals, liquidity coverage and spot returns separate', () => {
  const view = listingsView(listingsInput({ filters: { screen: 'all', windowDays: 30, namespace: null, underlying: 'all', search: null, limit: 200 } })).data;
  const btc = view.rows.find(row => row.instrument === 'BTC')!;
  assert.equal(btc.market.openInterestNative, 1000);
  assert.equal(btc.market.openInterestUnit, 'underlying units');
  assert.equal(btc.market.quoteCurrency, 'unresolved');
  assert.match(btc.market.notionalMethod!, /no USD conversion/);
  assert.equal(Number(btc.market.premiumBps!.toFixed(2)), 50.25);
  assert.equal(btc.market.fundingIntervalSeconds, 3600);
  assert.equal(btc.market.annualizedFundingPct, 0.00001 * 8760 * 100);
  assert.equal(btc.market.openInterestChange24h.changePct, null, 'no archived snapshot sits 24 hours back, so the window stays unavailable');
  assert.equal(btc.market.openInterestChange24h.comparisonAt, null);
  assert.equal(Number(btc.market.openInterestChangeLatestInterval.changePct!.toFixed(4)), Number(((1000 / 900 - 1) * 100).toFixed(4)));
  assert.equal(btc.liquidity.source, 'archived order book');
  assert.equal(btc.liquidity.spreadBps, 1.2);
  assert.deepEqual(btc.liquidity.levels, [20, 20]);
  assert.equal(btc.settledFunding!.rate, 0.0000125);
  assert.equal(btc.settledFunding!.intervalSeconds, 3600);
  assert.equal(btc.underlying.assetId, 'bitcoin');
  assert.equal(btc.underlying.spot!.relativeToBtc.d7, 0, 'BTC against itself compounds to zero, not to a subtraction artefact');
  assert.match(btc.underlying.spot!.scope, /never funded perpetual profit and loss/);
  assert.ok(btc.risks.some(risk => /also appears in namespace mkts/.test(risk)), 'the same symbol in another namespace is a related event');

  const newcoin = view.rows.find(row => row.instrument === 'NEWCOIN')!;
  assert.equal(newcoin.liquidity.source, 'impact prices only');
  assert.equal(newcoin.liquidity.impact, null);
  assert.equal(Number(newcoin.liquidity.spreadBps!.toFixed(2)), 20);
  assert.match(newcoin.liquidity.scope, /executable depth and impact at \$1K\/\$10K notionals are unavailable/);
  assert.equal(newcoin.settledFunding, null);
  assert.ok(newcoin.risks.some(risk => /High leverage is a risk attribute/.test(risk)));

  const refused = listingsView(listingsInput({ datasets: [{ datasetId: 'hyperliquid:instruments:mkts:v1', namespace: 'mkts',
    coverage: coverage({ replayRefused: true, unavailable: true, stale: true }) }], instruments: [], replayRefusals: ['venue:native'] })).data;
  assert.equal(refused.rows.length, 0);
  assert.deepEqual(refused.methodology.replayRefusals, ['venue:native']);
  assert.equal(refused.namespaces.find(row => row.namespace === '')!.covered, false);
});
