import { calendarReturnPct, relativeReturnPct, type Point } from '../overview.js';

export const PERP_PROJECTS_METHOD = 'perp-projects:v1';
export const PERP_LISTINGS_METHOD = 'perp-listings:v1';
export const DAY = 86400000;

export type Member = { key: string; status: string; data: Record<string, any>; first_observed_at: string | Date | null };
export type Event = { entity_key: string; event_type: string };
export type Series = { points: Point[]; metadata: Record<string, unknown> } | null;
export type Coverage = { source: string | null; scope: string | null; observedAt: string | null; recordedAt: string | null;
  snapshotId: string | null; payloadId: string | null; replayCoverageStart: string | null; intervalSeconds: number | null;
  methodologyVersion: string | null; unavailable: boolean; stale: boolean; degraded: boolean; error: string | null;
  replayRefused: boolean; classification: string };
export type Snapshot = { members: Member[]; events: Event[]; coverage: Coverage; notes: Record<string, unknown> | null } | null;

export const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
export const iso = (value: string | Date | null | undefined) => value == null ? null : typeof value === 'string' ? value : value.toISOString();

/** Sum of exactly `period` contiguous completed daily values ending `offset` windows back.
 *  A gap or an absent value makes the window unavailable rather than shorter. */
export function trailingSum(points: Point[], period: number, offset = 0): number | null {
  if (!Number.isSafeInteger(period) || period < 1 || points.length < period * (offset + 1)) return null;
  const end = points.length - period * offset;
  const window = points.slice(end - period, end);
  let expected = Date.parse(window[0].observedAt), sum = 0;
  for (const point of window) {
    if (Date.parse(point.observedAt) !== expected || point.value === null) return null;
    sum += point.value;
    expected += DAY;
  }
  return sum;
}

/** Growth of one contiguous trailing window over the contiguous window before it. */
export function windowGrowthPct(points: Point[], period: number): number | null {
  const current = trailingSum(points, period), previous = trailingSum(points, period, 1);
  return current === null || previous === null || previous <= 0 ? null : (current / previous - 1) * 100;
}

/** Percentage change between two archived endpoint values. A non-positive base stays unavailable. */
export function endpointChangePct(value: number | null, comparison: number | null): number | null {
  return value === null || comparison === null || comparison <= 0 ? null : (value / comparison - 1) * 100;
}

export function sharePct(value: number | null, total: number | null): number | null {
  return value === null || total === null || total <= 0 ? null : value / total * 100;
}

export function daysSince(from: string | null, now: number): number | null {
  if (!from || !Number.isFinite(Date.parse(from))) return null;
  return Math.floor((now - Date.parse(from)) / DAY);
}

/** Mark against the venue's own oracle price, from one context observation. */
export function premiumBps(mark: number | null, oracle: number | null): number | null {
  return mark === null || oracle === null || oracle <= 0 ? null : (mark / oracle - 1) * 10000;
}

/** A funding rate is per settlement interval. Annualizing is presentation, not a realized return. */
export function annualizedFundingPct(rate: number | null, intervalSeconds: number | null): number | null {
  return rate === null || !intervalSeconds || intervalSeconds <= 0 ? null : rate * (365 * DAY / 1000 / intervalSeconds) * 100;
}

export const PERP_UNIVERSE_SCOPE = 'DefiLlama `Derivatives` catalog category together with every protocol in the covered open-interest universe. `Derivatives` is a provider category, not a verified perp-DEX taxonomy: it includes non-perpetual derivatives and may omit perp venues the provider files elsewhere.';
export const VOLUME_GATE = 'Reported and normalized perp volume — and therefore volume market share and its 30D change — stay unavailable: the free endpoints returned HTTP 402.';

export type ProjectsInput = {
  now: string; asOf?: string;
  catalog: Snapshot; openInterest: Snapshot; aggregate: Series;
  fundamentals: { assetId: string; metricCode: string; series: Series }[];
  fundamentalLinks: { key: string; assetId: string; evidence: string }[];
  venueLinks: { protocolId: string; protocolSlug: string; venue: string; namespace: string; evidence: string; methodologyVersion: string }[];
  venueActivity: { venue: string; namespace: string; instruments: number; active: number; openInterestNative: number | null;
    estimatedOpenInterestQuote: number | null; reported24hNotionalVolume: number | null; observedAt: string | null }[];
  tokens: { id: string; symbol: string; name: string; priceUsd: number | null; marketCapUsd: number | null }[];
  replayRefusals: string[];
  filters: { window: 'all' | 'early'; venue?: string | null; stage?: string | null; search?: string | null; limit: number };
};

export function projectsView(input: ProjectsInput) {
  const now = Date.parse(input.now);
  const openInterest = new Map((input.openInterest?.members ?? []).map(member => [member.key, member]));
  const catalog = new Map((input.catalog?.members ?? []).map(member => [member.key, member]));
  const events = new Map<string, string[]>();
  for (const event of [...(input.catalog?.events ?? []), ...(input.openInterest?.events ?? [])])
    events.set(event.entity_key, [...events.get(event.entity_key) ?? [], event.event_type]);
  const venueLinks = new Map(input.venueLinks.map(link => [link.protocolId, link]));
  const activity = new Map(input.venueActivity.map(row => [`${row.venue}:${row.namespace}`, row]));
  const tokens = new Map(input.tokens.map(token => [token.id, token]));
  const points = (assetId: string, metricCode: string) =>
    input.fundamentals.find(row => row.assetId === assetId && row.metricCode === metricCode)?.series?.points ?? null;

  const coveredTotal = [...openInterest.values()].reduce((sum, member) => sum + (numeric(member.data.openInterestUsd) ?? 0), 0) || null;
  const keys = new Set([...openInterest.keys(),
    ...[...catalog.entries()].filter(([, member]) => member.data.category === 'Derivatives').map(([key]) => key)]);

  const rows = [...keys].map(key => {
    const listed = catalog.get(key) ?? null, covered = openInterest.get(key) ?? null;
    const data = { ...covered?.data, ...listed?.data };
    const protocolId = String(data.protocolId ?? JSON.parse(key)[1] ?? '');
    const slug = typeof data.slug === 'string' ? data.slug : null;
    const parentProtocol = typeof covered?.data.parentProtocol === 'string' ? covered.data.parentProtocol : null;
    const firstObservedAt = iso(listed?.first_observed_at ?? covered?.first_observed_at ?? null);
    const geckoId = typeof listed?.data.geckoId === 'string' ? listed.data.geckoId : null;
    const token = geckoId ? tokens.get(geckoId) ?? null : null;
    // A provider token link is not verified token status, and its absence is not proof of a pre-token protocol.
    const stage = token ? 'live-token' : geckoId ? 'provider-linked-token' : 'unknown';
    const link = venueLinks.get(protocolId) ?? null;
    const venue = link ? { venue: link.venue, namespace: link.namespace, evidence: link.evidence,
      methodologyVersion: link.methodologyVersion, ...activity.get(`${link.venue}:${link.namespace}`) ?? {} } : null;

    const oiUsd = numeric(covered?.data.openInterestUsd);
    const adoption = { covered: !!covered, openInterestUsd: oiUsd, tvlUsd: numeric(listed?.data.tvlUsd),
      openInterest7DaysAgoUsd: numeric(covered?.data.openInterest7DaysAgoUsd),
      openInterest30DaysAgoUsd: numeric(covered?.data.openInterest30DaysAgoUsd),
      openInterestChange7dPct: endpointChangePct(oiUsd, numeric(covered?.data.openInterest7DaysAgoUsd)),
      openInterestChange30dPct: endpointChangePct(oiUsd, numeric(covered?.data.openInterest30DaysAgoUsd)),
      providerChangePct1d: numeric(covered?.data.providerChangePct1d),
      providerChangePct7d: numeric(covered?.data.providerChangePct7d),
      openInterestShareOfCoveredPct: sharePct(oiUsd, coveredTotal),
      convention: covered?.data.convention ?? null,
      reportedVolumeUsd: null, normalizedVolumeUsd: null, volumeSharePct: null, volumeGate: VOLUME_GATE };

    const fundamental = input.fundamentalLinks.find(row => row.key === slug || parentProtocol === `parent#${row.key}`) ?? null;
    const scopeMatch = !fundamental ? null : fundamental.key === slug ? 'protocol' : 'parent';
    const fees = fundamental ? points(fundamental.assetId, 'fees_24h_usd') : null;
    const revenue = fundamental ? points(fundamental.assetId, 'revenue_24h_usd') : null;
    const holder = fundamental ? points(fundamental.assetId, 'holder_revenue_24h_usd') : null;
    const tvl = fundamental ? points(fundamental.assetId, 'tvl_usd') : null;
    const fees30d = trailingSum(fees ?? [], 30), revenue30d = trailingSum(revenue ?? [], 30);
    const economics = { archived: !!(fees || revenue || holder || tvl), scopeMatch,
      linkedAssetId: fundamental?.assetId ?? null, linkEvidence: fundamental?.evidence ?? null,
      fees30dUsd: fees30d, feesGrowth30dPct: windowGrowthPct(fees ?? [], 30),
      revenue30dUsd: revenue30d, revenueGrowth30dPct: windowGrowthPct(revenue ?? [], 30),
      holderRevenue30dUsd: trailingSum(holder ?? [], 30), holderRevenueGrowth30dPct: windowGrowthPct(holder ?? [], 30),
      retainedFeeSharePct: fees30d !== null && revenue30d !== null && fees30d > 0 ? revenue30d / fees30d * 100 : null,
      archivedTvlUsd: (tvl ?? []).at(-1)?.value ?? null, effectiveFeeRate: null,
      coverage: 'Only individually verified DefiLlama protocol histories are archived in this workspace; every other protocol has none.',
      definitions: 'Provider-defined fees, revenue and holder revenue. Retained fee share is revenue divided by fees over the same contiguous 30 days. The fee rate per unit of volume stays unavailable while volume is gated, and recipients and mechanisms are not verified here.' };

    const milestones = [
      ...firstObservedAt ? [{ type: 'first-observed', observedAt: firstObservedAt,
        evidence: 'First archived observation in this workspace. A detection time, not a protocol or token launch date.' }] : [],
      ...(events.get(key) ?? []).filter(type => !['baseline', 'first_observed'].includes(type)).map(type => ({ type: type.replaceAll('_', '-'),
        observedAt: input.catalog?.coverage.observedAt ?? input.openInterest?.coverage.observedAt ?? null,
        evidence: 'Catalog membership change within the archived snapshot; not a launch, a shutdown or a delisting.' })),
    ];
    const lifecycle = { firstObservedAt, daysSinceFirstObserved: daysSince(firstObservedAt, now),
      verifiedProtocolLaunchAt: null, verifiedTokenLaunchAt: null, verifiedMilestoneAt: null,
      launchDates: 'unknown', baseline: (events.get(key) ?? []).includes('baseline') };

    const risks = [
      'Launch dates are unverified: the protocol catalog carries no protocol or token launch date, so this entry is undated rather than new.',
      covered ? 'Open interest follows the provider convention that counts both sides of each contract, so it is not comparable with venue-native open interest without explicit normalization.'
        : 'Absent from the covered open-interest universe, so its open interest is unavailable rather than zero.',
      ...listed ? [] : ['Present in the covered open-interest universe but absent from the archived protocol catalog snapshot.'],
      ...parentProtocol ? [`Reported under ${parentProtocol}; sibling modules may double count when summed.`] : [],
      ...scopeMatch === 'parent' ? [`Archived fundamentals are scoped to ${parentProtocol}, not to this module alone.`] : [],
      ...economics.archived ? [] : ['No individually verified fee, revenue or TVL history is archived for this protocol.'],
      ...geckoId && !token ? ['A provider token link exists but no archived market snapshot covers that asset, so token status stays unverified.'] : [],
      ...listed?.data.category === 'Derivatives' ? [] : ['Classified outside the provider `Derivatives` category; included because the covered open-interest universe lists it.'],
      'Volume, market share, incentive programmes, insurance coverage, bad debt, oracle dependencies, withdrawal restrictions and incident history are not archived by any connected free feed.',
    ];
    const whyWatch = [
      ...adoption.openInterestChange30dPct !== null ? [`Covered open interest ${adoption.openInterestChange30dPct >= 0 ? 'rose' : 'fell'} ${Math.abs(adoption.openInterestChange30dPct).toFixed(1)}% against its value 30 days earlier.`] : [],
      ...adoption.openInterestShareOfCoveredPct !== null ? [`Holds ${adoption.openInterestShareOfCoveredPct.toFixed(2)}% of the covered open-interest universe.`] : [],
      ...economics.revenueGrowth30dPct !== null ? [`Archived 30-day revenue changed ${economics.revenueGrowth30dPct >= 0 ? '+' : ''}${economics.revenueGrowth30dPct.toFixed(1)}% against the preceding 30 days.`] : [],
      ...venue ? [`Linked to the ${venue.venue} \`${venue.namespace || 'native'}\` namespace this archive also reads directly.`] : [],
    ];
    const contradictions = [
      ...adoption.openInterestChange30dPct !== null && economics.revenueGrowth30dPct !== null
        && Math.sign(adoption.openInterestChange30dPct) !== Math.sign(economics.revenueGrowth30dPct)
        ? ['Open-interest growth and archived revenue growth point in opposite directions.'] : [],
      ...adoption.tvlUsd !== null && oiUsd !== null && adoption.tvlUsd > 0 && oiUsd / adoption.tvlUsd > 20
        ? ['Covered open interest exceeds catalog TVL more than twentyfold. The two measure different things and this is not a solvency comparison.'] : [],
      ...stage === 'live-token' ? [] : ['No verified tradable token, so token performance and value capture are unavailable rather than zero.'],
    ];

    return { key, protocolId, slug, name: typeof data.name === 'string' ? data.name : null,
      category: listed?.data.category ?? covered?.data.category ?? null,
      chains: Array.isArray(data.chains) ? data.chains : [], parentProtocol,
      methodologyUrl: covered?.data.methodologyUrl ?? null, stage, tokenLink: geckoId,
      token: token ? { assetId: token.id, symbol: token.symbol, name: token.name, priceUsd: token.priceUsd,
        marketCapUsd: token.marketCapUsd, verifiedTerms: false, circulatingSupply: null, fdvUsd: null,
        unlocks: 'unavailable', valueCapture: 'unavailable: no verified mechanism-level data is connected' } : null,
      venue, adoption, economics, milestones, lifecycle, risks, whyWatch, contradictions };
  });

  const search = input.filters.search?.toLowerCase() ?? null;
  const filtered = rows.filter(row => {
    if (input.filters.window === 'early' && row.lifecycle.verifiedMilestoneAt === null) return false;
    if (input.filters.venue && row.venue?.venue !== input.filters.venue) return false;
    if (input.filters.stage && row.stage !== input.filters.stage) return false;
    return !search || [row.name, row.slug, row.protocolId].some(value => String(value ?? '').toLowerCase().includes(search));
  }).sort((a, b) => Date.parse(b.lifecycle.verifiedMilestoneAt ?? '') - Date.parse(a.lifecycle.verifiedMilestoneAt ?? '')
    || Date.parse(b.lifecycle.firstObservedAt ?? '') - Date.parse(a.lifecycle.firstObservedAt ?? '')
    || a.protocolId.localeCompare(b.protocolId));

  const series = input.aggregate?.points ?? [];
  const aggregate = { points: series, latest: series.at(-1) ?? null,
    change7dPct: calendarReturnPct(series, 7), change30dPct: calendarReturnPct(series, 30),
    values: series.filter(point => point.value !== null).length,
    first: series.find(point => point.value !== null)?.observedAt ?? null,
    seriesId: (input.aggregate?.metadata.seriesId as string | null) ?? null,
    replayCoverageStart: (input.aggregate?.metadata.replayCoverageStart as string | null) ?? null,
    replayRefused: input.replayRefusals.includes('perp-open-interest'),
    scope: 'DefiLlama covered perp open interest across its covered protocols, in USD, on completed UTC days.',
    formula: 'Archived `totalDataChart` values; 7D and 30D changes need both exact calendar endpoint days.',
    limitations: 'Covered membership changes over time and historical constituents are unavailable, so this is not a fixed-universe index. The provider convention counts both sides of each contract.' };

  return { data: {
    rows: filtered.slice(0, input.filters.limit), aggregate,
    universe: { scope: PERP_UNIVERSE_SCOPE, matched: rows.length, filtered: filtered.length,
      returned: Math.min(filtered.length, input.filters.limit),
      catalogProtocols: catalog.size, catalogDerivatives: [...catalog.values()].filter(member => member.data.category === 'Derivatives').length,
      coveredOpenInterestProtocols: openInterest.size, withVenueLink: rows.filter(row => row.venue).length,
      withArchivedFundamentals: rows.filter(row => row.economics.archived).length,
      withVerifiedMilestone: rows.filter(row => row.lifecycle.verifiedMilestoneAt !== null).length,
      withCoveredOpenInterest: rows.filter(row => row.adoption.openInterestUsd !== null).length },
    earlyFilter: { window: input.filters.window, defaultWindowDays: 180,
      eligible: rows.filter(row => row.lifecycle.verifiedMilestoneAt !== null).length,
      explanation: 'The 180-day early-project filter needs verified protocol or token launch dates. No connected free feed publishes them, so no protocol qualifies and the default view ranks the covered universe by first observation in this archive instead.' },
    sorting: { applied: 'verified-milestone', fallback: 'first-observed', tieBreak: 'protocol id',
      disabled: ['30D volume market-share change', 'reported volume growth'],
      reason: 'Volume sorting stays disabled until comparable free volume windows and a consistent covered-universe denominator exist.' },
    coverage: { catalog: input.catalog?.coverage ?? null, openInterest: input.openInterest?.coverage ?? null,
      openInterestNotes: input.openInterest?.notes ?? null },
    methodology: { version: PERP_PROJECTS_METHOD, classification: input.asOf ? 'point-in-time' : 'forward tracking',
      snapshotAsOf: input.asOf ?? null, universe: PERP_UNIVERSE_SCOPE,
      openInterest: 'Per-protocol values and their 7-day and 30-day comparisons come from one archived provider snapshot. Changes are recomputed from the archived endpoint values; the provider percentages travel alongside them.',
      fundamentals: 'Trailing 30-day sums over contiguous completed daily values, compared with the preceding contiguous 30 days. A gap makes the window unavailable rather than shorter.',
      lifecycle: 'Protocol launch, token launch and first observation are separate fields. Only first observation is populated; the others need an individually verified source.',
      tokens: 'A provider token link is not verified token status. Token terms, unlocks and value capture stay unavailable until an individually verified source is connected.',
      volume: VOLUME_GATE,
      replay: 'A cutoff selects the snapshots and revisions archived by then. A feed whose coverage starts later is refused for its own block instead of being reconstructed.',
      replayRefusals: input.replayRefusals,
      sources: ['https://api-docs.defillama.com/', 'https://docs.llama.fi/analysts/data-definitions',
        'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals'] } },
    metadata: { source: 'DefiLlama / Hyperliquid',
      observedAt: input.openInterest?.coverage.observedAt ?? input.catalog?.coverage.observedAt ?? null,
      coverage: 'Perp DEX projects composed from the archived protocol catalog, covered open interest and individually verified fundamentals',
      stale: (input.catalog?.coverage.stale ?? true) || (input.openInterest?.coverage.stale ?? true),
      unavailable: !rows.length } };
}

export type InstrumentRow = Member & { dataset_id: string; namespace: string; event_types: string[];
  latest_event_type: string | null; in_latest_snapshot: boolean; observed_at: string | Date | null;
  prior_data: Record<string, any> | null; prior_observed_at: string | Date | null;
  day_prior_data: Record<string, any> | null; day_prior_observed_at: string | Date | null };

/** The most recent lifecycle event decides what a market is now; the full event history
 *  still records that it entered the archive as a baseline. */
export function listingClassification(latest: string | null, types: string[]) {
  const event = latest ?? types.at(-1) ?? null;
  if (event === 'first_observed') return 'venue-new-to-archive';
  if (event === 'relisted') return 'relisted';
  if (event === 'returned') return 'returned-to-catalog';
  if (event === 'delisted') return 'delisted';
  if (event === 'catalog_absent') return 'catalog-absent';
  if (event === 'baseline') return 'archive-baseline';
  return 'tracked';
}
/** Events that make a market newly tradable in the covered universe. A baseline never does. */
export const LISTING_EVENTS = ['venue-new-to-archive', 'relisted', 'returned-to-catalog'];

export type ListingsInput = {
  now: string; asOf?: string;
  namespaces: Snapshot;
  datasets: { datasetId: string; namespace: string; coverage: Coverage }[];
  instruments: InstrumentRow[];
  books: { entityKey: string; data: Record<string, any>; observedAt: string | null; datasetId: string }[];
  settledFunding: { entityKey: string; data: Record<string, any>; observedAt: string | null; datasetId: string }[];
  underlyingLinks: { venue: string; namespace: string; instrument: string; assetId: string; assetClass: string; evidence: string }[];
  histories: { assetId: string; points: Point[] }[];
  replayRefusals: string[];
  filters: { screen: 'new' | 'all'; windowDays: number; namespace?: string | null; underlying: 'verified' | 'all'; search?: string | null; limit: number };
};

const LISTING_SCOPE = 'Hyperliquid perpetual markets across the eleven budgeted namespaces. The first archived catalog is a baseline, not a burst of new listings, and a namespace absent from this budget is uncovered rather than empty.';
const UNDERLYING_SCOPE = 'Asset class is only known where a curated, immutable underlying link exists. Every other instrument stays unresolved: the venue publishes no asset-class or pre-market field in the archived metadata, and an unverified check never becomes a passing result.';

export function listingsView(input: ListingsInput) {
  const now = Date.parse(input.now);
  const links = new Map(input.underlyingLinks.map(link => [`${link.venue}|${link.namespace}|${link.instrument}`, link]));
  const books = new Map(input.books.map(row => [row.entityKey, row]));
  const benchmark = input.histories.find(history => history.assetId === 'bitcoin')?.points ?? [];
  const benchmarkReturns = { d1: calendarReturnPct(benchmark, 1), d7: calendarReturnPct(benchmark, 7), d30: calendarReturnPct(benchmark, 30) };
  // The latest settled funding event per instrument; overlapping acquisitions deduplicate by identity.
  const settled = new Map<string, { data: Record<string, any>; observedAt: string | null }>();
  for (const row of input.settledFunding) {
    const identity = JSON.parse(row.entityKey) as string[];
    const key = `${identity[0]}|${identity[1] ?? ''}|${identity[2]}`;
    const at = typeof row.data.observedAt === 'string' ? row.data.observedAt : row.observedAt;
    const current = settled.get(key);
    if (!current || Date.parse(String(current.data.observedAt ?? current.observedAt ?? 0)) <= Date.parse(String(at ?? 0))) settled.set(key, { data: row.data, observedAt: at });
  }
  // One underlying listed in several namespaces is a related event, not an independent sample.
  const earliest = new Map<string, { observedAt: string | null; namespaces: string[] }>();
  for (const row of input.instruments) {
    const base = String(row.data.name ?? '').split(':').pop() ?? '';
    const at = iso(row.first_observed_at);
    const current = earliest.get(base) ?? { observedAt: at, namespaces: [] };
    earliest.set(base, { observedAt: current.observedAt === null || (at !== null && Date.parse(at) < Date.parse(current.observedAt)) ? at : current.observedAt,
      namespaces: [...current.namespaces, row.namespace] });
  }

  const rows = input.instruments.map(row => {
    const data = row.data, namespace = row.namespace, name = String(data.name ?? '');
    const base = name.split(':').pop() ?? name;
    const link = links.get(`hyperliquid|${namespace}|${base}`) ?? null;
    const firstObservedAt = iso(row.first_observed_at);
    const classification = listingClassification(row.latest_event_type, row.event_types);
    const shared = earliest.get(base) ?? { observedAt: firstObservedAt, namespaces: [namespace] };
    const listing = { classification, firstObservedAt, daysSinceFirstObserved: daysSince(firstObservedAt, now),
      verifiedTradingStartAt: null, announcedAt: null, suspendedAt: null, delistedAt: null,
      baseline: row.event_types.includes('baseline'), status: row.status,
      inLatestCatalog: row.in_latest_snapshot, lastObservedAt: iso(row.observed_at),
      firstObservedAnywhereAt: shared.observedAt,
      firstObservedAnywhere: shared.observedAt === null || shared.observedAt === firstObservedAt,
      alsoListedInNamespaces: [...new Set(shared.namespaces.filter(other => other !== namespace))].sort(),
      evidence: 'Time since listing uses this archive’s first observation. The venue metadata carries no trading-start, announcement or delisting timestamp, so those stay unavailable.' };

    const oi = numeric(data.openInterestNative), mark = numeric(data.markPrice);
    const oracle = numeric(data.context?.oraclePx == null ? null : Number(data.context.oraclePx));
    const priorOi = numeric(row.prior_data?.openInterestNative), dayOi = numeric(row.day_prior_data?.openInterestNative);
    const market = { openInterestNative: oi, openInterestUnit: data.openInterestUnit ?? null,
      estimatedOpenInterestQuote: numeric(data.estimatedOpenInterestQuote), quoteCurrency: data.quoteCurrency ?? null,
      notionalMethod: data.notionalMethod ?? null, markPrice: mark, oraclePrice: oracle,
      premiumBps: premiumBps(mark, oracle),
      providerPremium: data.context?.premium == null ? null : Number(data.context.premium),
      fundingRate: numeric(data.fundingRate), fundingIntervalSeconds: numeric(data.fundingIntervalSeconds),
      annualizedFundingPct: annualizedFundingPct(numeric(data.fundingRate), numeric(data.fundingIntervalSeconds)),
      reported24hNotionalVolume: numeric(data.reported24hNotionalVolume),
      maxLeverage: numeric(data.contract?.maxLeverage), marginMode: data.contract?.marginMode ?? null,
      onlyIsolated: data.contract?.onlyIsolated ?? null,
      openInterestChange24h: { windowHours: 24, comparisonAt: iso(row.day_prior_observed_at), comparisonValue: dayOi,
        changePct: endpointChangePct(oi, dayOi) },
      openInterestChangeLatestInterval: { comparisonAt: iso(row.prior_observed_at), comparisonValue: priorOi,
        changePct: endpointChangePct(oi, priorOi) },
      definitions: 'Open interest stays in the venue’s documented underlying units. Estimated quote notional is native open interest times mark price in the venue’s quote units, with no USD peg conversion and no double counting of both sides.' };

    const book = books.get(row.key) ?? null;
    const impactPrices = Array.isArray(data.impactPrices) ? data.impactPrices.map(numeric) : null;
    const liquidity = book ? { source: 'archived order book', observedAt: book.data.observedAt ?? book.observedAt,
      spreadBps: numeric(book.data.spreadBps), depthQuote: book.data.depthQuote ?? null, impact: book.data.impact ?? null,
      quoteCurrency: book.data.quoteCurrency ?? null, levels: Array.isArray(book.data.levels) ? book.data.levels.map((side: unknown[]) => side.length) : null,
      scope: 'Top visible levels per side at one archived instant; instantaneous estimates, not guaranteed fills.' }
      : { source: 'impact prices only', observedAt: input.datasets.find(set => set.datasetId === row.dataset_id)?.coverage.observedAt ?? null,
        spreadBps: impactPrices && impactPrices[0] !== null && impactPrices[1] !== null && mark ? (impactPrices[1]! - impactPrices[0]!) / mark * 10000 : null,
        depthQuote: null, impact: null, quoteCurrency: data.quoteCurrency ?? null, levels: null,
        scope: 'No order book is archived for this market, so executable depth and impact at $1K/$10K notionals are unavailable. The provider impact prices are a venue sample, not measured depth.' };

    const history = link ? input.histories.find(entry => entry.assetId === link.assetId)?.points ?? [] : [];
    const usd = { d1: calendarReturnPct(history, 1), d7: calendarReturnPct(history, 7), d30: calendarReturnPct(history, 30) };
    const underlying = { assetId: link?.assetId ?? null, assetClass: link?.assetClass ?? 'unknown',
      linkEvidence: link?.evidence ?? null, preMarket: 'unknown',
      spot: link ? { observedAt: history.at(-1)?.observedAt ?? null, samples: history.filter(point => point.value !== null).length,
        usd, relativeToBtc: { d1: relativeReturnPct(usd.d1, benchmarkReturns.d1), d7: relativeReturnPct(usd.d7, benchmarkReturns.d7),
          d30: relativeReturnPct(usd.d30, benchmarkReturns.d30) },
        scope: 'Underlying spot returns from archived CoinGecko daily samples, compounded against BTC over identical windows. These are spot outcomes, never funded perpetual profit and loss.' } : null };

    const funding = settled.get(`hyperliquid|${namespace}|${base}`) ?? null;
    const risks = [
      ...listing.baseline ? ['First catalog ingestion: this market existed before archiving began, so it is a baseline, not a new listing.'] : [],
      ...listing.inLatestCatalog ? [] : ['Absent from the latest archived catalog. Its last archived observation is retained and is not evidence of a settlement, a delisting announcement or a closure.'],
      ...underlying.assetClass === 'crypto' ? [] : ['Underlying asset and asset class are unresolved, so this market is outside the default crypto screen and its spot comparison is unavailable.'],
      ...market.openInterestChange24h.changePct === null ? ['No archived snapshot sits 24 hours before the latest one, so the open-interest change over that window is unavailable rather than zero.'] : [],
      ...liquidity.source === 'archived order book' ? [] : ['No archived order book: spread, executable depth and estimated impact are unavailable for this market.'],
      ...market.maxLeverage !== null && market.maxLeverage >= 20 ? [`Venue permits up to ${market.maxLeverage}× leverage. High leverage is a risk attribute, not a positive investment signal.`] : [],
      ...listing.alsoListedInNamespaces.length ? [`The same underlying symbol also appears in namespace ${listing.alsoListedInNamespaces.map(value => value || 'native').join(', ')}; treat these as related events, not independent samples.`] : [],
      'Incentives, rebates, oracle dependencies, settlement terms and announcement history are not archived by any connected free feed.',
    ];
    const whyWatch = [
      ...market.openInterestChangeLatestInterval.changePct !== null ? [`Open interest moved ${market.openInterestChangeLatestInterval.changePct >= 0 ? '+' : ''}${market.openInterestChangeLatestInterval.changePct.toFixed(2)}% since the previous archived snapshot.`] : [],
      ...market.annualizedFundingPct !== null ? [`Current funding ${market.annualizedFundingPct >= 0 ? 'favours shorts' : 'favours longs'} at ${Math.abs(market.annualizedFundingPct).toFixed(1)}% annualized from the hourly rate.`] : [],
      ...underlying.spot?.relativeToBtc.d7 !== null && underlying.spot ? [`Underlying spot ${underlying.spot.relativeToBtc.d7! >= 0 ? 'outperformed' : 'underperformed'} BTC by ${Math.abs(underlying.spot.relativeToBtc.d7!).toFixed(2)}% over seven days.`] : [],
    ];

    return { key: row.key, datasetId: row.dataset_id, venue: 'hyperliquid', namespace, instrument: name, baseSymbol: base,
      index: numeric(data.index), listing, underlying, market, liquidity,
      settledFunding: funding ? { rate: numeric(funding.data.fundingRate), premium: numeric(funding.data.premium),
        intervalSeconds: numeric(funding.data.intervalSeconds), observedAt: funding.observedAt,
        definition: funding.data.definition ?? null } : null,
      risks, whyWatch };
  });

  const eligible = (row: typeof rows[number]) => {
    if (input.filters.underlying === 'verified' && row.underlying.assetClass !== 'crypto' && row.namespace !== '') return false;
    if (input.filters.namespace !== undefined && input.filters.namespace !== null && row.namespace !== input.filters.namespace) return false;
    const search = input.filters.search?.toLowerCase();
    if (search && !row.instrument.toLowerCase().includes(search)) return false;
    if (input.filters.screen === 'all') return true;
    return LISTING_EVENTS.includes(row.listing.classification) && row.listing.inLatestCatalog
      && (row.listing.daysSinceFirstObserved === null || row.listing.daysSinceFirstObserved <= input.filters.windowDays);
  };
  const selected = rows.filter(eligible).sort((a, b) =>
    Date.parse(b.listing.verifiedTradingStartAt ?? '') - Date.parse(a.listing.verifiedTradingStartAt ?? '')
    || Date.parse(b.listing.firstObservedAt ?? '') - Date.parse(a.listing.firstObservedAt ?? '')
    || a.namespace.localeCompare(b.namespace) || a.instrument.localeCompare(b.instrument));

  const count = (predicate: (row: typeof rows[number]) => boolean) => rows.filter(predicate).length;
  const namespaces = (input.namespaces?.members ?? []).map(member => {
    const namespace = String(member.data.namespace ?? '');
    const dataset = input.datasets.find(set => set.namespace === namespace) ?? null;
    return { namespace, label: member.data.metadata?.fullName ?? (namespace || 'native'),
      deployer: member.data.metadata?.deployer ?? null, feeRecipient: member.data.metadata?.feeRecipient ?? null,
      oracleUpdater: member.data.metadata?.oracleUpdater ?? null, firstObservedAt: iso(member.first_observed_at),
      instruments: count(row => row.namespace === namespace),
      active: count(row => row.namespace === namespace && row.listing.status === 'active' && row.listing.inLatestCatalog),
      covered: !!dataset && !dataset.coverage.unavailable, coverage: dataset?.coverage ?? null,
      verifiedUnderlyings: count(row => row.namespace === namespace && row.underlying.assetClass === 'crypto') };
  }).sort((a, b) => b.instruments - a.instruments || a.namespace.localeCompare(b.namespace));

  return { data: {
    rows: selected.slice(0, input.filters.limit),
    screen: { applied: input.filters.screen, windowDays: input.filters.windowDays,
      underlying: input.filters.underlying, matched: rows.length, selected: selected.length,
      returned: Math.min(selected.length, input.filters.limit),
      excluded: { baseline: count(row => row.listing.baseline),
        unresolvedUnderlying: count(row => row.underlying.assetClass !== 'crypto'),
        unresolvedUnderlyingOutsideNative: count(row => row.underlying.assetClass !== 'crypto' && row.namespace !== ''),
        delisted: count(row => row.listing.status === 'delisted'),
        absentFromLatestCatalog: count(row => !row.listing.inLatestCatalog) },
      rule: 'The default screen shows markets this archive first observed inside the window, relisted, or returned to the catalog, with a verified crypto underlying or the venue’s native namespace, and still present in the latest archived catalog. Baseline markets, delisted markets, markets absent from the latest catalog and unresolved non-native underlyings are excluded and counted, never deleted.' },
    lifecycle: { baselineInstruments: count(row => row.listing.baseline),
      newListings: count(row => row.listing.classification === 'venue-new-to-archive'),
      relistings: count(row => ['relisted', 'returned-to-catalog'].includes(row.listing.classification)),
      delistings: count(row => row.listing.classification === 'delisted'),
      venueDelistedMarkets: count(row => row.listing.status === 'delisted'),
      absentFromLatestCatalog: count(row => !row.listing.inLatestCatalog),
      verifiedUnderlyings: count(row => row.underlying.assetClass === 'crypto'),
      withOrderBook: count(row => row.liquidity.source === 'archived order book'),
      evidence: 'Listing, relisting and delisting events come from the immutable archived event log. The first ingestion of each namespace is recorded as a baseline so existing markets never raise listing alerts. A market already carrying the venue delisting flag at that baseline is counted as a delisted market, not as a delisting event this archive observed.' },
    namespaces,
    coverage: { namespaceCatalog: input.namespaces?.coverage ?? null, datasets: input.datasets },
    methodology: { version: PERP_LISTINGS_METHOD, classification: input.asOf ? 'point-in-time' : 'forward tracking',
      snapshotAsOf: input.asOf ?? null, scope: LISTING_SCOPE, underlying: UNDERLYING_SCOPE,
      openInterest: 'Native units with an estimated quote notional from mark price. The 24-hour change needs an archived snapshot at that offset; the previous archived snapshot is reported separately with its own time.',
      funding: 'The context funding rate is a current sample for its stated hourly interval. Settled hourly funding is separate archived evidence and is never treated as account cash flow.',
      liquidity: 'Spread, depth and impact at $1K and $10K notionals exist only for markets with an archived order book. Provider impact prices are labelled as venue samples.',
      spot: 'Underlying spot returns versus BTC come from archived daily samples for curated, verified links only. They are kept strictly separate from perpetual profit and loss, which would require fills, fees, funding cash flows, margin rules and delisting settlement.',
      sorting: 'Verified trading start first, then this archive’s first observation as an explicit fallback, then namespace and instrument identity.',
      replay: 'Each namespace dataset is read under its own replay coverage; a namespace whose coverage starts after the cutoff is refused for itself and does not remove the others.',
      replayRefusals: input.replayRefusals,
      sources: ['https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals'] } },
    metadata: { source: 'Hyperliquid', observedAt: input.datasets[0]?.coverage.observedAt ?? null,
      coverage: 'Archived Hyperliquid perpetual catalogs, contexts, order books and settled funding across the budgeted namespaces',
      stale: input.datasets.some(set => set.coverage.stale) || !input.datasets.length,
      unavailable: !rows.length } };
}
