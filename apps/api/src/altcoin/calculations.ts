import { calendarReturnPct, relativeReturnPct, type Point } from '../overview.js';
import type { Coverage, Snapshot } from '../perp/calculations.js';

export const EMERGING_METHOD = 'emerging-projects:v1';
export const LAUNCHES_METHOD = 'spot-launches:v1';
export const DAY = 86400000;
export const BENCHMARK = 'bitcoin';

export const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
export const iso = (value: string | Date | null | undefined) => value == null ? null : typeof value === 'string' ? value : value.toISOString();
export type Check = 'pass' | 'fail' | 'unknown';

/** Contiguous completed daily values ending at the last observation. A gap or an absent
 *  value makes the window unavailable rather than shorter, exactly as elsewhere. */
export function trailingWindow(points: Point[], period: number): number[] | null {
  if (!Number.isSafeInteger(period) || period < 1 || points.length < period) return null;
  const window = points.slice(-period);
  let expected = Date.parse(window[0].observedAt);
  const values: number[] = [];
  for (const point of window) {
    if (Date.parse(point.observedAt) !== expected || point.value === null) return null;
    values.push(point.value);
    expected += DAY;
  }
  return values;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Median of one contiguous trailing window of daily sampled trailing-24-hour volumes.
 *  These are instantaneous provider samples, not candle-traded volumes. */
export function trailingMedian(points: Point[], period: number): number | null {
  const window = trailingWindow(points, period);
  return window === null ? null : median(window);
}

/** Mean of the last 7 daily volume samples over the mean of the 30 samples before them.
 *  Both windows must be contiguous; a missed sampling day leaves the ratio unavailable. */
export function volumeAcceleration(points: Point[], fast = 7, slow = 30): number | null {
  const combined = trailingWindow(points, fast + slow);
  if (combined === null) return null;
  const previous = mean(combined.slice(0, slow));
  return previous > 0 ? mean(combined.slice(slow)) / previous : null;
}

/** Cross-sectional percentile within the supplied population: the share strictly below,
 *  plus half of the ties. An empty population has no percentile. */
export function percentileRank(population: number[], value: number): number | null {
  if (!population.length || !Number.isFinite(value)) return null;
  let below = 0, equal = 0;
  for (const other of population) {
    if (other < value) below += 1;
    else if (other === value) equal += 1;
  }
  return (below + equal / 2) / population.length * 100;
}

/** Log returns between consecutive completed days. A gap breaks the pair rather than
 *  spanning it, so a missing week never becomes one large one-day move. */
export function dailyLogReturns(points: Point[]): { observedAt: string; value: number }[] {
  const returns: { observedAt: string; value: number }[] = [];
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1], current = points[index];
    if (previous.value === null || current.value === null || previous.value <= 0 || current.value <= 0) continue;
    if (Date.parse(current.observedAt) - Date.parse(previous.observedAt) !== DAY) continue;
    returns.push({ observedAt: current.observedAt, value: Math.log(current.value / previous.value) });
  }
  return returns;
}

/** Annualized standard deviation of the last `days` contiguous daily log returns. */
export function realizedVolatilityPct(points: Point[], days: number): number | null {
  const window = trailingWindow(points, days + 1);
  if (window === null || window.some(value => value <= 0)) return null;
  const changes = window.slice(1).map((value, index) => Math.log(value / window[index]));
  const average = mean(changes);
  return Math.sqrt(changes.reduce((sum, value) => sum + (value - average) ** 2, 0) / (changes.length - 1)) * Math.sqrt(365) * 100;
}

/** Deepest peak-to-trough fall inside one contiguous window, and whether it recovered
 *  before the window ended. An unrecovered drawdown reports null recovery days, not zero. */
export function maxDrawdown(points: Point[], days: number) {
  const window = trailingWindow(points, days);
  if (window === null || window.some(value => value <= 0)) return { drawdownPct: null, troughIndex: null, recoveryDays: null, recovered: null };
  let peak = window[0], worst = 0, troughIndex = 0, peakIndex = 0, worstPeakIndex = 0;
  for (const [index, value] of window.entries()) {
    if (value > peak) { peak = value; peakIndex = index; }
    const fall = value / peak - 1;
    if (fall < worst) { worst = fall; troughIndex = index; worstPeakIndex = peakIndex; }
  }
  if (worst === 0) return { drawdownPct: 0, troughIndex: null, recoveryDays: null, recovered: null };
  const peakValue = window[worstPeakIndex];
  const recoveredAt = window.findIndex((value, index) => index > troughIndex && value >= peakValue);
  return { drawdownPct: worst * 100, troughIndex,
    recoveryDays: recoveredAt === -1 ? null : recoveredAt - troughIndex, recovered: recoveredAt !== -1 };
}

/** Pearson correlation and ordinary-least-squares beta against the benchmark, over the
 *  daily returns both series actually share. Unshared dates are dropped, never filled. */
export function correlationBeta(asset: Point[], benchmark: Point[], days: number) {
  const benchmarkByDate = new Map(dailyLogReturns(benchmark).map(point => [point.observedAt, point.value]));
  const paired = dailyLogReturns(asset).flatMap(point => {
    const other = benchmarkByDate.get(point.observedAt);
    return other === undefined ? [] : [[point.value, other] as const];
  }).slice(-days);
  if (paired.length < Math.min(days, 30)) return { correlation: null, beta: null, samples: paired.length };
  const assetMean = mean(paired.map(pair => pair[0])), benchmarkMean = mean(paired.map(pair => pair[1]));
  let covariance = 0, assetVariance = 0, benchmarkVariance = 0;
  for (const [a, b] of paired) {
    covariance += (a - assetMean) * (b - benchmarkMean);
    assetVariance += (a - assetMean) ** 2;
    benchmarkVariance += (b - benchmarkMean) ** 2;
  }
  return { samples: paired.length,
    correlation: assetVariance > 0 && benchmarkVariance > 0 ? covariance / Math.sqrt(assetVariance * benchmarkVariance) : null,
    beta: benchmarkVariance > 0 ? covariance / benchmarkVariance : null };
}

/** Contiguous completed daily samples ending at the newest observation. This is the
 *  history an asset actually has here, not the age of the project. */
export function contiguousDays(points: Point[]): number {
  let count = 0, expected: number | null = null;
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index];
    if (point.value === null) break;
    const time = Date.parse(point.observedAt);
    if (expected !== null && time !== expected) break;
    count += 1;
    expected = time - DAY;
  }
  return count;
}

export const EMERGING_SCOPE = 'The archived CoinGecko tracked page, which is the provider’s first rank-selected 100 assets. The budgeted 1,000-asset acquisition universe stays gated on verified Demo access, so this is the tail of the top 100, not the $10M–$2B market-cap band.';
export const ATTENTION_CAVEAT = 'Attention is an unvalidated v0 placeholder, not expected investment return. Its three components are heavily correlated — the 90D and 30D excess returns share most of their window and volume acceleration is itself momentum-adjacent — so it behaves closer to a single momentum factor than to three independent votes. No signal study has yet tested it against an equal-weight eligible-universe benchmark, so it is deliberately not the primary ranking on this page.';

export type Attention = { ranked: boolean; score: number | null; missingInputs: string[]; reason: string | null;
  percentiles: { excess90d: number; excess30d: number; volumeAcceleration: number } | null };
/** The three ranking inputs, kept structural so the score can be defined before the row
 *  type that carries it and tested on its own. */
export type AttentionInputs = { eligibility: { eligible: boolean };
  returns: { relative: { d90: number | null; d30: number | null } }; liquidity: { volumeAcceleration: number | null } };

export type Exclusion = { assetId: string; symbol: string; reason: string; canonicalAssetId: string | null; evidence: string; methodologyVersion: string };
export type AlertRule = { assetId: string; title: string; metric: string; comparator: string; threshold: number };

export type EmergingFilters = { screen: 'eligible' | 'all'; minMarketCapUsd: number; maxMarketCapUsd: number;
  minMedianVolumeUsd: number; minHistoryDays: number; search: string | null; limit: number };
export type EmergingInput = {
  now: string; asOf?: string;
  market: Snapshot;
  prices: { assetId: string; points: Point[] }[];
  volumes: { assetId: string; points: Point[] }[];
  pegSymbols: { symbol: string; name: string }[];
  pegCoverage: Coverage | null;
  exclusions: Exclusion[];
  categories: { assetId: string; category: string }[];
  alertRules: AlertRule[];
  replayRefusals: string[];
  filters: EmergingFilters;
};

export function emergingView(input: EmergingInput) {
  const now = Date.parse(input.now);
  const refused = (feed: string) => input.replayRefusals.includes(feed);
  const priceOf = new Map(input.prices.map(row => [row.assetId, row.points]));
  const volumeOf = new Map(input.volumes.map(row => [row.assetId, row.points]));
  const excluded = new Map(input.exclusions.map(row => [row.assetId, row]));
  const pegSymbols = new Map(input.pegSymbols.map(row => [row.symbol.toUpperCase(), row]));
  const categories = new Map(input.categories.map(row => [row.assetId, row.category]));
  const rulesFor = (assetId: string) => input.alertRules.filter(rule => rule.assetId === assetId);
  const benchmark = priceOf.get(BENCHMARK) ?? [];
  const benchmarkReturns = { d7: calendarReturnPct(benchmark, 7), d30: calendarReturnPct(benchmark, 30), d90: calendarReturnPct(benchmark, 90) };
  const { minMarketCapUsd, maxMarketCapUsd, minMedianVolumeUsd, minHistoryDays } = input.filters;

  const rows = (input.market?.members ?? []).map(member => {
    const data = member.data as Record<string, unknown>;
    const assetId = String(data.id ?? '');
    const points = priceOf.get(assetId) ?? [];
    const volumePoints = volumeOf.get(assetId) ?? [];
    const marketCapUsd = numeric(data.marketCapUsd), fdvUsd = numeric(data.fullyDilutedValuationUsd);
    const circulating = numeric(data.circulatingSupply), total = numeric(data.totalSupply), max = numeric(data.maxSupply);
    const reportedVolume = numeric(data.volume24hUsd);
    const historyDays = contiguousDays(points);
    const archived = points.filter(point => point.value !== null).length;

    const usd = { d7: calendarReturnPct(points, 7), d30: calendarReturnPct(points, 30), d90: calendarReturnPct(points, 90) };
    const relative = assetId === BENCHMARK
      ? { d7: usd.d7 === null ? null : 0, d30: usd.d30 === null ? null : 0, d90: usd.d90 === null ? null : 0 }
      : { d7: relativeReturnPct(usd.d7, benchmarkReturns.d7), d30: relativeReturnPct(usd.d30, benchmarkReturns.d30),
        d90: relativeReturnPct(usd.d90, benchmarkReturns.d90) };

    const drawdown90 = maxDrawdown(points, 90);
    const correlation90 = correlationBeta(points, benchmark, 90);
    const risk = { volatility30dPct: realizedVolatilityPct(points, 30), volatility90dPct: realizedVolatilityPct(points, 90),
      maxDrawdown90dPct: drawdown90.drawdownPct, drawdownRecoveryDays: drawdown90.recoveryDays, drawdownRecovered: drawdown90.recovered,
      btcCorrelation90d: correlation90.correlation, btcBeta90d: correlation90.beta, correlationSamples: correlation90.samples,
      formula: 'Realized volatility is the annualized standard deviation of contiguous daily log returns. Maximum drawdown is the deepest peak-to-trough fall inside the trailing 90 contiguous days; recovery counts the days from that trough back to the prior peak, and stays unavailable while the drawdown is still open. Correlation and ordinary-least-squares beta use only the daily returns this asset and BTC actually share.',
      limitations: 'These describe the archived sample window only. A short or interrupted history makes each measure unavailable rather than approximate.' };

    const medianVolume30d = trailingMedian(volumePoints, 30);
    const acceleration = volumeAcceleration(volumePoints);
    const liquidity = { reportedVolume24hUsd: reportedVolume, medianVolume30dUsd: medianVolume30d,
      volumeAcceleration: acceleration, volumeSamples: volumePoints.filter(point => point.value !== null).length,
      turnoverPct: reportedVolume !== null && marketCapUsd !== null && marketCapUsd > 0 ? reportedVolume / marketCapUsd * 100 : null,
      formula: 'Reported turnover is the provider trailing-24-hour volume from the archived snapshot divided by its market cap. The 30-day median and the 7-over-30 acceleration use archived daily volume samples taken at a consistent daily boundary.',
      limitations: 'Reported venue volume is not verified traded volume, and these are instantaneous samples of a rolling window rather than traded daily volumes. Consecutive samples overlap.' };

    const dilution = { circulatingSupply: circulating, totalSupply: total, maxSupply: max, fdvUsd, marketCapUsd,
      fdvToMarketCap: fdvUsd !== null && marketCapUsd !== null && marketCapUsd > 0 ? fdvUsd / marketCapUsd : null,
      circulatingOfTotalPct: circulating !== null && total !== null && total > 0 ? circulating / total * 100 : null,
      circulatingOfMaxPct: circulating !== null && max !== null && max > 0 ? circulating / max * 100 : null,
      unlockSchedule: 'unavailable: no verified event-level tokenomics feed is connected',
      formula: 'Supply and valuation fields are read from the archived market snapshot. FDV ÷ market cap shows how much of the fully diluted valuation is not yet circulating.',
      limitations: 'A low circulating share indicates potential future dilution, not a scheduled unlock. Provider supply definitions vary by asset and are not reconciled here.' };

    // Only a curated row excludes an asset. A bare symbol collision against the peg
    // catalog is reported for review — the ticker `M` matches a stablecoin and a memecoin
    // alike — and never removes a project from the universe on its own.
    const exclusion = excluded.get(assetId) ?? null;
    const symbol = String(data.symbol ?? '').toUpperCase();
    const pegMatch = !exclusion && pegSymbols.has(symbol) ? pegSymbols.get(symbol)! : null;
    const identity = { excluded: !!exclusion, reason: exclusion?.reason ?? null,
      canonicalAssetId: exclusion?.canonicalAssetId ?? null, evidence: exclusion?.evidence ?? null,
      pegSymbolMatch: pegMatch ? pegMatch.name : null,
      pegSymbolNote: pegMatch
        ? `Symbol ${symbol} also names ${pegMatch.name} in the archived DefiLlama USD-pegged catalog. A symbol is not an identity, so this is flagged for review and does not exclude the asset; only a curated row does that.`
        : null };

    const capCheck: Check = marketCapUsd === null ? 'unknown' : marketCapUsd >= minMarketCapUsd && marketCapUsd <= maxMarketCapUsd ? 'pass' : 'fail';
    const historyCheck: Check = archived === 0 ? 'unknown' : historyDays >= minHistoryDays ? 'pass' : 'fail';
    const volumeCheck: Check = medianVolume30d === null ? 'unknown' : medianVolume30d >= minMedianVolumeUsd ? 'pass' : 'fail';
    const identityCheck: Check = identity.excluded ? 'fail' : 'pass';
    const checks = { marketCap: capCheck, history: historyCheck, medianVolume: volumeCheck, identity: identityCheck };
    const eligibility = { ...checks, eligible: Object.values(checks).every(check => check === 'pass'),
      blockedBy: Object.entries(checks).filter(([, check]) => check !== 'pass').map(([name, check]) => `${name}:${check}`),
      contiguousHistoryDays: historyDays, archivedPriceSamples: archived,
      rule: `Editable research defaults, not validated investment thresholds: market cap between $${(minMarketCapUsd / 1e6).toFixed(0)}M and $${(maxMarketCapUsd / 1e9).toFixed(1)}B, at least ${minHistoryDays} contiguous archived daily samples, a 30-day median of daily sampled trailing-24-hour volume of at least $${(minMedianVolumeUsd / 1e6).toFixed(0)}M, and no curated stablecoin, tokenized-fund, commodity-backed or wrapped-duplicate identity.` };

    return { assetId, symbol, name: String(data.name ?? ''), rank: numeric(data.rank),
      priceUsd: numeric(data.priceUsd), marketCapUsd, category: categories.get(assetId) ?? null,
      observedAt: points.at(-1)?.observedAt ?? null,
      providerChanges: { d1: numeric(data.change24h), d7: numeric(data.change7d), d30: numeric(data.change30d) },
      returns: { usd, relative, benchmark: BENCHMARK,
        formula: 'Return = last completed archived daily sample ÷ the sample exactly 7, 30 or 90 days earlier − 1. The BTC-relative figure compounds: (1 + asset) ÷ (1 + BTC) − 1.',
        limitations: 'Archive-computed returns need both exact endpoint days. They are separate evidence from the provider-reported percentage changes, which travel alongside them.' },
      risk, liquidity, dilution, identity, eligibility,
      savedConditions: rulesFor(assetId), attention: null as Attention | null,
      valueCapture: { status: 'gated' as const,
        note: 'Whether this token captures economic value needs provider-defined holder revenue with its recipient and mechanism. Only individually verified Ethereum, Solana and Hyperliquid feeds are archived here, so value capture is unavailable rather than absent.' },
      peers: { status: 'gated' as const, category: categories.get(assetId) ?? null,
        note: 'Adoption and revenue against sector peers needs verified asset-sector mappings and per-asset fundamental coverage. Ten curated prototype classifications exist and no sector-relative figure is computed from them.' } };
  }).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.assetId.localeCompare(b.assetId));

  // Percentiles are computed inside the eligible universe on this date, exactly as the
  // ranking is defined. A row missing any component is unranked, never partially scored.
  const eligible = rows.filter(row => row.eligibility.eligible);
  const population = (pick: (row: typeof rows[number]) => number | null) =>
    eligible.map(pick).filter((value): value is number => value !== null);
  const excess90 = population(row => row.returns.relative.d90);
  const excess30 = population(row => row.returns.relative.d30);
  const acceleration = population(row => row.liquidity.volumeAcceleration);
  const scoreOf = (row: AttentionInputs): Attention => {
    const inputs = { excess90d: row.returns.relative.d90, excess30d: row.returns.relative.d30,
      volumeAcceleration: row.liquidity.volumeAcceleration };
    const missing = Object.entries(inputs).filter(([, value]) => value === null).map(([name]) => name);
    if (missing.length || !row.eligibility.eligible)
      return { ranked: false, score: null, percentiles: null, missingInputs: missing,
        reason: row.eligibility.eligible ? 'Required inputs are not archived for this asset yet.' : 'Outside the eligible universe on this date.' };
    const percentiles = { excess90d: percentileRank(excess90, inputs.excess90d!)!,
      excess30d: percentileRank(excess30, inputs.excess30d!)!, volumeAcceleration: percentileRank(acceleration, inputs.volumeAcceleration!)! };
    return { ranked: true, missingInputs: [], reason: null,
      score: percentiles.excess90d * 0.4 + percentiles.excess30d * 0.3 + percentiles.volumeAcceleration * 0.3, percentiles };
  };
  for (const row of rows) row.attention = scoreOf(row);

  const withEvidence = rows.map(row => {
    const whyAppeared = [
      ...row.returns.relative.d90 !== null ? [`Archived 90-day return is ${row.returns.relative.d90 >= 0 ? '+' : ''}${row.returns.relative.d90.toFixed(1)}% against BTC over the same days.`] : [],
      ...row.returns.relative.d30 !== null ? [`Archived 30-day return is ${row.returns.relative.d30 >= 0 ? '+' : ''}${row.returns.relative.d30.toFixed(1)}% against BTC over the same days.`] : [],
      ...row.liquidity.volumeAcceleration !== null ? [`Sampled 24-hour volume over the last 7 days is ${row.liquidity.volumeAcceleration.toFixed(2)}× the preceding 30 days.`] : [],
      ...row.attention?.ranked ? [`Attention percentile score ${row.attention.score!.toFixed(1)} within ${eligible.length} eligible assets. ${ATTENTION_CAVEAT}`] : [],
    ];
    const gaps = [
      ...row.eligibility.archivedPriceSamples === 0 ? ['No daily price history is archived for this asset, so every archive-computed return and risk measure is unavailable.'] : [],
      ...row.eligibility.archivedPriceSamples > 0 && row.eligibility.contiguousHistoryDays < 90 ? [`Only ${row.eligibility.contiguousHistoryDays} contiguous archived daily samples exist, short of the ${minHistoryDays}-day default.`] : [],
      ...row.liquidity.medianVolume30dUsd === null ? ['No contiguous 30-day window of daily volume samples exists yet, so the median-volume screen is unknown rather than failed.'] : [],
      'Holder concentration, deployer holdings and contract powers have no connected free feed for listed assets.',
      'Event-level tokenomics stays gated, so unlock schedules are unavailable and no unlock date is inferred from supply ratios.',
    ];
    const contradictions = [
      ...row.returns.relative.d90 !== null && row.returns.relative.d30 !== null
        && Math.sign(row.returns.relative.d90) !== Math.sign(row.returns.relative.d30)
        ? ['The 90-day and 30-day BTC-relative returns point in opposite directions.'] : [],
      ...row.risk.btcCorrelation90d !== null && row.risk.btcCorrelation90d > 0.8
        ? [`Daily returns correlate ${row.risk.btcCorrelation90d.toFixed(2)} with BTC, so most of this move is shared market exposure rather than an asset-specific outcome.`] : [],
      ...row.dilution.fdvToMarketCap !== null && row.dilution.fdvToMarketCap > 2
        ? [`Fully diluted valuation is ${row.dilution.fdvToMarketCap.toFixed(1)}× market cap, so future supply could offset business growth.`] : [],
      ...row.providerChanges.d30 !== null && row.returns.usd.d30 !== null
        && Math.sign(row.providerChanges.d30) !== Math.sign(row.returns.usd.d30)
        ? ['The provider-reported 30-day change and this archive’s computed 30-day return disagree in direction; they use different endpoints and sampling times.'] : [],
      ...row.identity.excluded ? [`Excluded from the eligible universe as ${row.identity.reason}. ${row.identity.evidence}`] : [],
      ...row.identity.pegSymbolNote ? [row.identity.pegSymbolNote] : [],
    ];
    return { ...row, evidence: { whyAppeared, firstTriggeredAt: row.observedAt, gaps, contradictions,
      savedConditions: row.savedConditions,
      historicalOutcomes: 'gated: comparable historical signals need replay coverage that starts when this archive started. Use the BTC Cycles signal study for the horizons that do have reconstructed history.' } };
  });

  const search = input.filters.search?.toLowerCase() ?? null;
  const filtered = withEvidence.filter(row => {
    if (input.filters.screen === 'eligible' && !row.eligibility.eligible) return false;
    return !search || [row.name, row.symbol, row.assetId].some(value => value.toLowerCase().includes(search));
  }).sort((a, b) => (b.returns.relative.d30 ?? -Infinity) - (a.returns.relative.d30 ?? -Infinity)
    || (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.assetId.localeCompare(b.assetId));

  const countCheck = (name: keyof typeof rows[number]['eligibility'], value: Check) =>
    rows.filter(row => row.eligibility[name] === value).length;
  const universe = { scope: EMERGING_SCOPE, tracked: rows.length, eligible: eligible.length,
    filtered: filtered.length, returned: Math.min(filtered.length, input.filters.limit),
    withArchivedPrices: rows.filter(row => row.eligibility.archivedPriceSamples > 0).length,
    withNinetyDayHistory: rows.filter(row => row.eligibility.contiguousHistoryDays >= 90).length,
    withMedianVolume: rows.filter(row => row.liquidity.medianVolume30dUsd !== null).length,
    curatedExclusions: rows.filter(row => row.identity.excluded).length,
    pegSymbolMatches: rows.filter(row => row.identity.pegSymbolMatch).length,
    unknownChecks: { marketCap: countCheck('marketCap', 'unknown'), history: countCheck('history', 'unknown'),
      medianVolume: countCheck('medianVolume', 'unknown') },
    failedChecks: { marketCap: countCheck('marketCap', 'fail'), history: countCheck('history', 'fail'),
      medianVolume: countCheck('medianVolume', 'fail'), identity: countCheck('identity', 'fail') },
    expansion: 'The budgeted expansion to 1,000 rank-selected assets stays gated on verified CoinGecko Demo access. Until it is enabled, the eligible universe is the tail of the archived tracked page and is not a survey of the $10M–$2B band.',
    youngProjects: 'A young-projects filter needs verified asset launch dates. No connected free feed publishes them for listed spot assets, so the filter is not offered and no asset is labelled newly launched from its archived history alone. Overlooked older projects stay fully discoverable through the all-tracked-assets screen.' };

  const attention = { label: 'Attention', prime: false as const, weights: { excess90d: 0.4, excess30d: 0.3, volumeAcceleration: 0.3 },
    ranked: withEvidence.filter(row => row.attention?.ranked).length, unranked: withEvidence.filter(row => !row.attention?.ranked).length,
    population: { excess90d: excess90.length, excess30d: excess30.length, volumeAcceleration: acceleration.length },
    formula: 'Within the eligible universe on this date: 40% cross-sectional percentile of the 90-day BTC-relative return, 30% of the 30-day BTC-relative return, and 30% of the ratio of mean sampled 24-hour volume over the last 7 days to the preceding 30 days. A missing component leaves the asset unranked rather than partially scored.',
    caveat: ATTENTION_CAVEAT,
    firstStudy: 'The first signal study to run against this ranking is whether it beats an equal-weight eligible-universe benchmark at all. That study needs replay coverage this archive has not yet accumulated.' };

  const marketCoverage = input.market?.coverage ?? null;
  return { data: { rows: filtered.slice(0, input.filters.limit), universe, attention,
    benchmark: { assetId: BENCHMARK, returns: benchmarkReturns,
      archivedSamples: benchmark.filter(point => point.value !== null).length,
      replayRefused: refused('daily-histories') },
    filters: input.filters,
    coverage: { market: marketCoverage, pegCatalog: input.pegCoverage,
      dailyHistories: { assets: input.prices.length, replayRefused: refused('daily-histories'),
        scope: 'Only the priority assets whose daily price and volume series are already archived carry archive-computed returns, risk and volume screens.' } },
    sectors: { status: 'gated' as const, classified: rows.filter(row => row.category).length, tracked: rows.length,
      note: 'Sector comparison stays gated at curated classification coverage. No sector-relative return, multiple or peer ranking is computed from ten prototype mappings.' },
    methodology: { version: EMERGING_METHOD, classification: input.asOf ? 'point-in-time' : 'forward tracking',
      snapshotAsOf: input.asOf ?? null, universe: EMERGING_SCOPE,
      eligibility: rows[0]?.eligibility.rule ?? 'No archived tracked-page snapshot reaches this cutoff.',
      identity: 'Stablecoins, tokenized funds, commodity-backed tokens and wrapped duplicates are excluded through curated, immutable, versioned rows that each carry their own evidence. A symbol match against the archived DefiLlama USD-pegged catalog is flagged for review only: symbols collide across unrelated assets, so a match never excludes anything by itself.',
      attention: attention.formula, attentionCaveat: ATTENTION_CAVEAT,
      risk: 'Realized volatility, maximum drawdown with recovery, BTC correlation and beta are computed from contiguous archived daily samples. Every one of them is unavailable rather than approximate when the window is incomplete.',
      valueCapture: 'Token value capture and sector-peer comparison stay gated on verified holder-revenue and asset-sector coverage.',
      launchDates: 'No connected free feed publishes verified asset launch dates, so the young-projects filter is not offered and an asset is never labelled newly launched from its archived price history alone.',
      replay: 'A cutoff selects the snapshots and revisions archived by then. A feed whose coverage starts later is refused for its own block instead of being reconstructed.',
      replayRefusals: input.replayRefusals,
      sources: ['https://docs.coingecko.com/reference/coins-markets', 'https://docs.coingecko.com/demo/reference/coins-id-market-chart',
        'https://api-docs.defillama.com/'] } },
    metadata: { source: 'CoinGecko / DefiLlama', observedAt: marketCoverage?.observedAt ?? null,
      coverage: 'Emerging Projects composed from the archived tracked page, archived daily price and volume samples and curated universe exclusions',
      stale: marketCoverage?.stale ?? true, unavailable: !rows.length } };
}

export const LAUNCH_SCOPE = 'A sampled radar, not a claim to capture every launch. The archive reads the first page of each chain’s new-pool feed — at most 20 pools — every five minutes, so a pool that appears and leaves between two samples is never observed at all.';

export type PoolRow = {
  chain: 'solana' | 'base'; datasetId: string; entityKey: string;
  baseTokenAddress: string | null; firstObservedAt: string | Date | null;
  data: Record<string, any> | null; observedAt: string | Date | null; inLatestSnapshot: boolean;
  priorData: Record<string, any> | null; priorObservedAt: string | Date | null;
};
export type EnrichmentRow = { chain: 'solana' | 'base'; datasetId: string; token: string; data: Record<string, any>; observedAt: string | Date | null };
export type QuoteToken = { chain: string; tokenAddress: string; symbol: string; kind: string; evidence: string };
export type LaunchFilters = { screen: 'new' | 'all'; windowDays: number; chain: 'solana' | 'base' | null;
  minLiquidityUsd: number; includeUnknownLiquidity: boolean; search: string | null; limit: number };
export type LaunchesInput = {
  now: string; asOf?: string;
  pools: PoolRow[];
  pairs: EnrichmentRow[];
  orders: EnrichmentRow[];
  quoteTokens: QuoteToken[];
  chains: { chain: 'solana' | 'base'; datasetId: string; coverage: Coverage; notes: Record<string, unknown> | null }[];
  replayRefusals: string[];
  filters: LaunchFilters;
};

const sumKnown = (values: (number | null)[]) =>
  values.some(value => value !== null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
const earliest = (values: (string | null)[]) =>
  values.filter((value): value is string => !!value).sort()[0] ?? null;

/** Buy-versus-sell transaction imbalance over one reported window, as a share of all
 *  transactions. Transaction counts are not distinct traders and are trivially inflatable. */
export function transactionImbalance(transactions: unknown, window = 'h24') {
  const row = (transactions as Record<string, any> | null)?.[window];
  const buys = numeric(row?.buys), sells = numeric(row?.sells);
  if (buys === null || sells === null || buys + sells === 0) return { buys, sells, imbalancePct: null };
  return { buys, sells, imbalancePct: (buys - sells) / (buys + sells) * 100 };
}

export function launchesView(input: LaunchesInput) {
  const now = Date.parse(input.now);
  const quotes = new Map(input.quoteTokens.map(row => [`${row.chain}:${row.tokenAddress.toLowerCase()}`, row]));
  const pairsByToken = new Map<string, EnrichmentRow[]>();
  for (const row of input.pairs) {
    const key = `${row.chain}:${row.token}`;
    pairsByToken.set(key, [...pairsByToken.get(key) ?? [], row]);
  }
  const ordersByToken = new Map(input.orders.map(row => [`${row.chain}:${row.token}`, row]));

  // One token, however many pools it has been sampled in. A pool created today for a token
  // this archive first saw last month keeps that earlier first observation.
  const grouped = new Map<string, PoolRow[]>();
  for (const pool of input.pools) {
    if (!pool.baseTokenAddress) continue;
    const key = `${pool.chain}:${pool.baseTokenAddress}`;
    grouped.set(key, [...grouped.get(key) ?? [], pool]);
  }

  const rows = [...grouped.entries()].map(([key, pools]) => {
    const chain = pools[0].chain, tokenAddress = pools[0].baseTokenAddress!;
    const firstObservedAt = earliest(pools.map(pool => iso(pool.firstObservedAt)));
    const newestPoolFirstObservedAt = pools.map(pool => iso(pool.firstObservedAt))
      .filter((value): value is string => !!value).sort().at(-1) ?? null;
    const current = pools.filter(pool => pool.inLatestSnapshot && pool.data);
    const observed = current.length ? current : pools.filter(pool => pool.data);
    const liquidityValues = observed.map(pool => numeric(pool.data!.liquidityUsd));
    const unknownLiquidityPools = liquidityValues.filter(value => value === null).length;
    const liquidityUsd = sumKnown(liquidityValues);
    const volumeUsd = sumKnown(observed.map(pool => numeric(pool.data!.reported24hVolumeUsd)));

    // A change is only stated when every pool in the current sum has its own earlier
    // observation. A partial sum would silently change its own pool membership. The
    // elapsed time is reported rather than assumed, because the sampled feed rotates
    // pools out long before a fixed 24-hour window closes.
    const comparable = observed.length > 0 && observed.every(pool => pool.priorData && numeric(pool.priorData.liquidityUsd) !== null);
    const priorLiquidity = comparable ? sumKnown(observed.map(pool => numeric(pool.priorData!.liquidityUsd))) : null;
    const comparisonAt = comparable ? earliest(observed.map(pool => iso(pool.priorObservedAt))) : null;
    const latestAt = earliest(observed.map(pool => iso(pool.observedAt)));
    const liquidityChange = { comparisonAt, comparisonValue: priorLiquidity,
      elapsedHours: comparisonAt && latestAt ? (Date.parse(latestAt) - Date.parse(comparisonAt)) / 3600000 : null,
      changePct: liquidityUsd !== null && priorLiquidity !== null && priorLiquidity > 0 ? (liquidityUsd / priorLiquidity - 1) * 100 : null,
      covered: comparable, poolsCompared: comparable ? observed.length : 0,
      window: 'the previous archived observation of every contributing pool, whose actual elapsed time is reported rather than assumed',
      reason: comparable ? null : 'At least one pool in the current total has no earlier archived observation, so a change would compare different pool memberships.' };

    const totals = observed.reduce((sum, pool) => {
      const window = transactionImbalance(pool.data!.transactions);
      return { buys: window.buys === null ? sum.buys : (sum.buys ?? 0) + window.buys,
        sells: window.sells === null ? sum.sells : (sum.sells ?? 0) + window.sells };
    }, { buys: null as number | null, sells: null as number | null });
    const imbalancePct = totals.buys !== null && totals.sells !== null && totals.buys + totals.sells > 0
      ? (totals.buys - totals.sells) / (totals.buys + totals.sells) * 100 : null;

    const quoteAddresses = [...new Set(observed.map(pool => String(pool.data!.quoteTokenAddress ?? '').toLowerCase()))];
    const resolvedQuotes = quoteAddresses.map(address => quotes.get(`${chain}:${address}`) ?? null);
    const verifiedQuote = resolvedQuotes.some(quote => quote !== null);

    const enrichment = pairsByToken.get(key) ?? [];
    const latestPair = enrichment.map(row => row.data).at(-1) ?? null;
    const promotion = ordersByToken.get(key) ?? null;
    const boosts = enrichment.some(row => row.data.boosts != null) || (promotion?.data.boosts as unknown[] | undefined)?.length
      ? 'present' : enrichment.length || promotion ? 'none reported' : 'unchecked';

    const daysSinceFirstObserved = firstObservedAt === null ? null : Math.floor((now - Date.parse(firstObservedAt)) / DAY);
    const providerPoolCreatedAt = earliest(observed.map(pool => {
      const value = pool.data!.providerPoolCreatedAt;
      return typeof value === 'string' ? value : null;
    }));

    const risk = { contract: 'unknown' as const, sellRestrictions: 'unknown' as const,
      mintOrFreezeAuthority: 'unknown' as const, deployerHoldings: 'unknown' as const, holderConcentration: 'unknown' as const,
      liquidityWithdrawal: 'unknown' as const,
      flags: [
        ...liquidityUsd === null ? ['Pool liquidity is not reported for this token on this chain, so it stays unknown and never counts as meeting the minimum.'] : [],
        ...unknownLiquidityPools ? [`${unknownLiquidityPools} of ${observed.length} sampled pools report no liquidity value.`] : [],
        ...liquidityUsd !== null && liquidityUsd < input.filters.minLiquidityUsd ? [`Observed pool liquidity is below the $${(input.filters.minLiquidityUsd / 1000).toFixed(0)}K research default.`] : [],
        ...verifiedQuote ? [] : ['No curated quote-token identity matches this pool’s quote side, so the USD reference is unverified.'],
        ...observed.some(pool => pool.data!.pairIdentityKind === 'pool-id') ? ['At least one pool is identified by a Uniswap v4 pool ID rather than a contract address; the two identifier spaces are kept distinct.'] : [],
        ...boosts === 'present' ? ['Paid promotion is reported for this token. Boosts and paid orders are promotion, not organic demand.'] : [],
        ...current.length === 0 ? ['This token is absent from the newest archived sample; its last observation is retained rather than treated as a closure.'] : [],
        ...pools.length === 1 ? ['Observed in a single sampled pool, so its liquidity and volume are not a market-wide view of the token.'] : [],
        'Contract powers, mint and freeze authority, sell restrictions, deployer holdings and holder concentration have no verified free check connected; every one of them stays unknown and none becomes a passing result.',
      ],
      // Nothing here can be a resolved critical flag while no contract check is verified.
      criticalFlags: [] as string[],
      status: 'unknown' as const,
      note: 'Risk status is reported separately from attention. An unverified check is unknown, never a pass, and a token is never described as safe here.' };

    const attention = { reported24hVolumeUsd: volumeUsd,
      turnoverPct: volumeUsd !== null && liquidityUsd !== null && liquidityUsd > 0 ? volumeUsd / liquidityUsd * 100 : null,
      transactions24h: totals, buySellImbalancePct: imbalancePct,
      priceUsd: numeric(latestPair?.priceUsd), pools: pools.length, sampledPoolsNow: current.length,
      note: 'Attention describes observed activity in the sampled pools only. High turnover or a buy-heavy imbalance is not a positive investment signal and transaction counts are not distinct traders.' };

    const whyAttracting = [
      ...daysSinceFirstObserved !== null ? [`First observed in this archive ${daysSinceFirstObserved === 0 ? 'today' : `${daysSinceFirstObserved} day${daysSinceFirstObserved === 1 ? '' : 's'} ago`}.`] : [],
      ...liquidityUsd !== null ? [`Observed pool liquidity totals $${liquidityUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })} across ${observed.length} sampled pool${observed.length === 1 ? '' : 's'}.`] : [],
      ...attention.turnoverPct !== null ? [`Reported 24-hour volume is ${attention.turnoverPct.toFixed(0)}% of observed liquidity.`] : [],
      ...imbalancePct !== null ? [`Reported 24-hour transactions are ${imbalancePct >= 0 ? 'buy' : 'sell'}-weighted by ${Math.abs(imbalancePct).toFixed(0)}%.`] : [],
      ...boosts === 'present' ? ['Paid promotion is reported for this token, which is why it may be visible rather than why it is being traded.'] : [],
    ];

    const eligibleLiquidity: Check = liquidityUsd === null ? 'unknown' : liquidityUsd >= input.filters.minLiquidityUsd ? 'pass' : 'fail';
    const withinWindow = daysSinceFirstObserved !== null && daysSinceFirstObserved <= input.filters.windowDays;
    // The pool feed labels a pool, not a token: "TICKER / QUOTE". The base side is shown
    // as a provider label, never as a verified token symbol, and the address stays the identity.
    const poolLabel = earliest(observed.map(pool => typeof pool.data!.name === 'string' ? pool.data!.name : null));
    const baseLabel = poolLabel?.split(' / ')[0]?.trim() || null;
    return { key, chain, tokenAddress, poolLabel, baseLabel,
      labelEvidence: 'Provider pool label. The base side is not a verified token symbol and unrelated tokens reuse the same ticker; the contract address is the identity used everywhere here.',
      lifecycle: { firstObservedAt, daysSinceFirstObserved, newestPoolFirstObservedAt,
        hasNewerPools: !!(firstObservedAt && newestPoolFirstObservedAt && newestPoolFirstObservedAt !== firstObservedAt),
        withinWindow, providerPoolCreatedAt, tokenLaunchAt: null,
        lastObservedAt: earliest(observed.map(pool => iso(pool.observedAt))),
        inLatestSample: current.length > 0,
        evidence: 'First observation is this archive’s detection time for the token, taken as the earliest first observation across every pool it has ever been sampled in. A pool created later never resets it, and neither a pool creation time nor a first observation is a verified token launch date.' },
      liquidity: { liquidityUsd, unknownLiquidityPools, poolsObserved: observed.length, poolsEverSampled: pools.length,
        changeSincePrior: liquidityChange, quoteTokens: quoteAddresses.map((address, index) => ({ address,
          symbol: resolvedQuotes[index]?.symbol ?? null, kind: resolvedQuotes[index]?.kind ?? 'unrecognised',
          evidence: resolvedQuotes[index]?.evidence ?? 'No curated quote-token identity matches this address.' })),
        verifiedQuote,
        formula: 'Pool liquidity and reported 24-hour volume are summed across the sampled pools of this token in the newest archived snapshot that contains it. A pool reporting no liquidity keeps the total partial and is counted separately.',
        limitations: 'Observed pool liquidity is not executable depth and can be withdrawn at any time. Base pools frequently report no liquidity value; that stays unknown and is never read as zero.' },
      attention, risk, promotion: { boosts, orders: promotion?.data.orders ?? null,
        classification: 'Paid promotion is reported separately from trading data and is never treated as demand.',
        observedAt: iso(promotion?.observedAt ?? null) },
      enrichment: { pairs: enrichment.length, observedAt: iso(enrichment.at(-1)?.observedAt ?? null),
        scope: 'DEX Screener pair-level enrichment for the sampled base tokens; at most one token per hourly slot per chain.' },
      screen: { liquidity: eligibleLiquidity, window: withinWindow ? 'pass' as Check : 'fail' as Check,
        shortlisted: withinWindow && (eligibleLiquidity === 'pass' || (input.filters.includeUnknownLiquidity && eligibleLiquidity === 'unknown')) },
      whyAttracting };
  });

  const search = input.filters.search?.toLowerCase() ?? null;
  const filtered = rows.filter(row => {
    if (input.filters.chain && row.chain !== input.filters.chain) return false;
    if (input.filters.screen === 'new' && !row.screen.shortlisted) return false;
    return !search || [row.tokenAddress, row.poolLabel ?? '', row.baseLabel ?? ''].some(value => value.toLowerCase().includes(search));
  }).sort((a, b) => Date.parse(b.lifecycle.firstObservedAt ?? '') - Date.parse(a.lifecycle.firstObservedAt ?? '')
    || (b.liquidity.liquidityUsd ?? -Infinity) - (a.liquidity.liquidityUsd ?? -Infinity)
    || a.key.localeCompare(b.key));

  const perChain = input.chains.map(entry => {
    const chainRows = rows.filter(row => row.chain === entry.chain);
    return { chain: entry.chain, datasetId: entry.datasetId, coverage: entry.coverage, notes: entry.notes,
      tokens: chainRows.length, shortlisted: chainRows.filter(row => row.screen.shortlisted).length,
      unknownLiquidity: chainRows.filter(row => row.liquidity.liquidityUsd === null).length,
      pools: input.pools.filter(pool => pool.chain === entry.chain).length };
  });

  return { data: { rows: filtered.slice(0, input.filters.limit),
    universe: { scope: LAUNCH_SCOPE, tokens: rows.length, filtered: filtered.length,
      returned: Math.min(filtered.length, input.filters.limit),
      poolsEverSampled: input.pools.length, withinWindow: rows.filter(row => row.lifecycle.withinWindow).length,
      shortlisted: rows.filter(row => row.screen.shortlisted).length,
      unknownLiquidity: rows.filter(row => row.liquidity.liquidityUsd === null).length,
      belowMinimumLiquidity: rows.filter(row => row.screen.liquidity === 'fail').length,
      multiPoolTokens: rows.filter(row => row.liquidity.poolsEverSampled > 1).length,
      tokensWithLaterPools: rows.filter(row => row.lifecycle.hasNewerPools).length,
      withEnrichment: rows.filter(row => row.enrichment.pairs > 0).length,
      withPromotion: rows.filter(row => row.promotion.boosts === 'present').length },
    chains: perChain,
    riskGate: { verifiedChecks: 0, criticalFlagsResolved: 0,
      excludedForCriticalFlags: rows.filter(row => row.risk.criticalFlags.length).length,
      rule: 'The default shortlist excludes known sell restrictions and unresolved critical risk flags. No free contract check is connected, so no token currently carries a resolved critical flag and this exclusion removes nothing. That is a coverage gap, not a clean bill of health for any token here.' },
    filters: input.filters,
    methodology: { version: LAUNCHES_METHOD, classification: input.asOf ? 'point-in-time' : 'forward tracking',
      snapshotAsOf: input.asOf ?? null, scope: LAUNCH_SCOPE,
      identity: 'Tokens are deduplicated by chain and base-token contract address across every pool ever sampled, so a newly created pool for an already-observed token does not make that token new. Base addresses are lower-cased; Uniswap v4 pool IDs are bytes32 identifiers and are never treated as contract addresses.',
      liquidity: 'Observed pool liquidity and reported volume are summed across a token’s sampled pools in the newest snapshot containing it. A change requires every contributing pool to have its own earlier archived observation, and reports the elapsed time it actually covers instead of assuming a 24-hour window.',
      promotion: 'DEX Screener paid orders and boosts are archived as promotion and reported separately from trading data.',
      risk: 'Every contract-level check is unknown. An unknown check never becomes a passing result, and risk status is kept separate from observed attention.',
      launchDates: 'No connected free feed publishes a verified token launch date. Pool creation times come from the provider and describe the pool, not the token.',
      replay: 'A cutoff selects the snapshots archived by then. A chain whose sampling coverage starts later is refused for its own block instead of being reconstructed.',
      replayRefusals: input.replayRefusals,
      sources: ['https://api.geckoterminal.com/docs/index.html', 'https://docs.dexscreener.com/api/reference'] } },
    metadata: { source: 'GeckoTerminal / DEX Screener',
      observedAt: perChain.map(entry => entry.coverage?.observedAt ?? null).filter(Boolean).sort().at(-1) ?? null,
      coverage: 'Sampled Solana and Base new-pool discovery with DEX Screener pair and promotion enrichment',
      stale: perChain.every(entry => entry.coverage?.stale ?? true), unavailable: !rows.length } };
}
