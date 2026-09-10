import type { Pool } from 'pg';
import { ReplayCoverageError, readSeries } from './archive.js';
import { readSnapshot, readSnapshotHistory, providerStale } from './snapshots/archive.js';
import { marketDataset, globalDataset, type Asset } from './snapshots/providers.js';
import { marketBreadth } from './market.js';
import { btcMetrics, btcSeriesId } from './feeds/bitcoin.js';
import { capitalSeriesId, capitalScope } from './feeds/capital.js';
import { dailySeriesId } from './daily-history.js';
import { btcView } from './btc/routes.js';
import { DAY } from './btc/calculations.js';

export const OVERVIEW_METHOD = 'market-overview:v1';
export const RELATIVE_BENCHMARK = 'bitcoin';
export type Point = { observedAt: string; value: number | null };
type Snapshot = Awaited<ReturnType<typeof readSnapshot>> | null;
type SnapshotRow = Awaited<ReturnType<typeof readSnapshotHistory>>[number];
type Series = Awaited<ReturnType<typeof readSeries>>;
type BtcView = ReturnType<typeof btcView>;

const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Trailing mean of exactly `period` contiguous completed daily values ending at the last
 *  observation. A gap or an absent value makes the average unavailable rather than shorter. */
export function trailingAverage(points: Point[], period: number): number | null {
  if (!Number.isSafeInteger(period) || period < 1 || points.length < period) return null;
  const window = points.slice(-period);
  let expected = Date.parse(window[0].observedAt), sum = 0;
  for (const point of window) {
    if (Date.parse(point.observedAt) !== expected || point.value === null || !(point.value > 0)) return null;
    sum += point.value;
    expected += DAY;
  }
  return sum / period;
}

/** Calendar returns need both exact endpoint dates, even when intermediate days are missing. */
export function calendarReturnPct(points: Point[], days: number): number | null {
  const last = points.at(-1);
  if (!last || last.value === null || !(last.value > 0)) return null;
  const start = new Map(points.map(point => [Date.parse(point.observedAt), point.value])).get(Date.parse(last.observedAt) - days * DAY);
  return start == null || !(start > 0) ? null : (last.value / start - 1) * 100;
}

/** Compounded excess return over the benchmark, not a subtraction of percentages. */
export function relativeReturnPct(assetPct: number | null, benchmarkPct: number | null): number | null {
  return assetPct === null || benchmarkPct === null || benchmarkPct <= -100 ? null : ((1 + assetPct / 100) / (1 + benchmarkPct / 100) - 1) * 100;
}

/** Share of covered assets trading above their own trailing averages. Assets without a
 *  complete window are counted as uncovered instead of being treated as below. */
export function averageBreadth(assets: { assetId: string; symbol: string; name: string; points: Point[] }[]) {
  const rows = assets.map(asset => {
    const last = asset.points.at(-1) ?? null;
    const close = last?.value ?? null, sma50 = trailingAverage(asset.points, 50), sma200 = trailingAverage(asset.points, 200);
    return { assetId: asset.assetId, symbol: asset.symbol, name: asset.name, observedAt: last?.observedAt ?? null,
      samples: asset.points.filter(point => point.value !== null).length, closeUsd: close, sma50, sma200,
      above50d: close === null || sma50 === null ? null : close > sma50,
      above200d: close === null || sma200 === null ? null : close > sma200 };
  });
  const share = (field: 'above50d' | 'above200d') => {
    const covered = rows.filter(row => row[field] !== null);
    return { above: covered.filter(row => row[field]).length, covered: covered.length,
      percent: covered.length ? covered.filter(row => row[field]).length / covered.length * 100 : null };
  };
  return { assets: rows, sma50: share('above50d'), sma200: share('above200d') };
}

/** Exact 30-day calendar endpoints; an absent or non-positive comparison value keeps the change unavailable. */
export function supplyChange(points: Point[], now: number, days = 30) {
  const completed = points.filter(point => Date.parse(point.observedAt) < Math.floor(now / DAY) * DAY);
  const last = completed.at(-1) ?? null;
  const comparisonAt = last ? Date.parse(last.observedAt) - days * DAY : null;
  const comparisonValue = comparisonAt === null ? null : new Map(completed.map(point => [Date.parse(point.observedAt), point.value])).get(comparisonAt) ?? null;
  const value = last?.value ?? null;
  return { observedAt: last?.observedAt ?? null, value,
    comparisonAt: comparisonAt === null ? null : new Date(comparisonAt).toISOString(), comparisonValue,
    changePct: value !== null && comparisonValue !== null && comparisonValue > 0 ? (value / comparisonValue - 1) * 100 : null,
    changeUsd: value !== null && comparisonValue !== null ? value - comparisonValue : null,
    values: completed.filter(point => point.value !== null).length,
    first: completed.find(point => point.value !== null)?.observedAt ?? null };
}

/** Sampled provider aggregates. A comparison uses the archived sample nearest the requested
 *  offset within one expected interval; a missed acquisition leaves the change unavailable. */
export function sampledChange(points: { observedAt: string; value: number | null }[], hours: number, toleranceSeconds: number) {
  const last = points.at(-1);
  if (!last || last.value === null || !(last.value > 0)) return { changePct: null, comparisonAt: null, comparisonValue: null };
  const target = Date.parse(last.observedAt) - hours * 3600_000;
  let nearest: { observedAt: string; value: number | null } | null = null;
  for (const point of points.slice(0, -1)) {
    if (point.value === null || !(point.value > 0) || Math.abs(Date.parse(point.observedAt) - target) > toleranceSeconds * 1000) continue;
    if (!nearest || Math.abs(Date.parse(point.observedAt) - target) < Math.abs(Date.parse(nearest.observedAt) - target)) nearest = point;
  }
  return { changePct: nearest ? (last.value / nearest.value! - 1) * 100 : null,
    comparisonAt: nearest?.observedAt ?? null, comparisonValue: nearest?.value ?? null };
}

/** Confirmed displayed-regime transitions only; an initial baseline is not a change. */
export function regimeChanges(points: { observedAt: string; regime: string }[], sinceDays = 365) {
  const cutoff = points.length ? Date.parse(points.at(-1)!.observedAt) - sinceDays * DAY : 0;
  return points.flatMap((point, index) => index > 0 && point.regime !== points[index - 1].regime
    && points[index - 1].regime !== 'insufficient-history' && Date.parse(point.observedAt) >= cutoff
    ? [{ observedAt: point.observedAt, from: points[index - 1].regime, to: point.regime }] : []);
}

function evidence(snapshot: Snapshot, observedAt: string | null, present: boolean, now: number, intervalSeconds: number, replayRefused = false) {
  const degraded = snapshot?.metadata.degraded ?? false;
  return { source: snapshot?.metadata.source ?? null, scope: snapshot?.metadata.coverage ?? null,
    observedAt, acquiredAt: snapshot?.metadata.observedAt ?? null, recordedAt: snapshot?.metadata.recordedAt ?? null,
    snapshotId: snapshot?.metadata.snapshotId ?? null, payloadId: snapshot?.metadata.payloadId ?? null,
    replayCoverageStart: snapshot?.metadata.replayCoverageStart ?? null, intervalSeconds,
    methodologyVersion: snapshot?.metadata.methodologyVersion ?? null,
    degraded, error: snapshot?.metadata.error ?? null, replayRefused,
    // A degraded acquisition marks its own block stale even when the last stored value looks recent.
    unavailable: !present, stale: providerStale(observedAt, now, intervalSeconds) || degraded,
    classification: snapshot?.metadata.classification ?? 'forward tracking' };
}

export type OverviewInput = {
  now: string; asOf?: string;
  market: Snapshot; global: Snapshot; globalHistory: SnapshotRow[];
  btc: BtcView | null; capital: Series;
  histories: { assetId: string; symbol: string; name: string; series: Series }[];
  replayRefusals?: string[];
  categories: { id: string; category: string | null }[];
  alerts: { id: string; asset_id: string; title: string; detected_at: string; evidence: Record<string, unknown> }[];
};

export function overviewView(input: OverviewInput) {
  const now = Date.parse(input.now);
  // A cutoff before a feed's own coverage refuses that feed explicitly instead of
  // reconstructing a value that nobody could have read on that date.
  const refused = (feed: string) => (input.replayRefusals ?? []).includes(feed);
  const assets = (input.market?.members ?? []).map(member => member.data as Asset)
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.id.localeCompare(b.id));
  const marketEvidence = { ...evidence(input.market, input.market?.metadata.observedAt ?? null, assets.length > 0, now, 3600, refused('tracked-market')),
    scope: 'CoinGecko rank-selected first page, up to 100 assets; not a global universe' };

  const globalValue = input.global?.members[0]?.data as Record<string, unknown> | undefined;
  const globalObservedAt = typeof globalValue?.observedAt === 'string' ? globalValue.observedAt : null;
  const global = { marketCapUsd: numeric(globalValue?.globalMarketCapUsd), volume24hUsd: numeric(globalValue?.volume24hUsd),
    btcDominance: numeric(globalValue?.btcDominance), ethDominance: numeric(globalValue?.ethDominance),
    evidence: { ...evidence(input.global, globalObservedAt, !!globalValue, now, 3600, refused('provider-global')),
      scope: 'CoinGecko provider-global coverage; USD' },
    formula: 'Provider global totals and market-cap percentages, archived hourly and read from storage. These are the provider aggregates, not a sum of the tracked page.',
    limitations: 'Provider coverage and its own asset universe are not published per snapshot; dominance follows the provider definition. Publication time is unknown and acquisition receipt is retained separately.' };

  const sampled = input.globalHistory.map(row => ({ observedAt: typeof row.data.observedAt === 'string' ? row.data.observedAt : row.acquiredAt,
    acquiredAt: row.acquiredAt, marketCapUsd: numeric(row.data.globalMarketCapUsd), volume24hUsd: numeric(row.data.volume24hUsd),
    btcDominance: numeric(row.data.btcDominance) }))
    .filter(row => Number.isFinite(Date.parse(row.observedAt)))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const volumePoints = sampled.map(row => ({ observedAt: row.observedAt, value: row.volume24hUsd }));
  const reportedVolume = { points: sampled, latest: sampled.at(-1) ?? null,
    change24h: sampledChange(volumePoints, 24, 5400), change7d: sampledChange(volumePoints, 168, 5400),
    coverage: { ...evidence(input.global, sampled.at(-1)?.observedAt ?? null, sampled.length > 0, now, 3600, refused('provider-global')),
      samples: sampled.length, first: sampled[0]?.observedAt ?? null, last: sampled.at(-1)?.observedAt ?? null,
      scope: 'CoinGecko provider-global reported 24h volume, sampled hourly from this archive onward' },
    formula: 'Each point is one archived hourly snapshot of the provider’s rolling 24-hour reported volume. Changes compare the latest sample with the archived sample nearest 24 hours or 7 days earlier, within 90 minutes; otherwise they stay unavailable.',
    interpretation: 'A trend in reported turnover. Overlapping rolling windows mean consecutive samples are not independent daily volumes.',
    limitations: 'Reported venue volume is not verified traded volume. History begins when this archive began sampling; missed acquisitions appear as absent samples, never as interpolated values.' };

  const breadth = { ...marketBreadth(assets), scope: marketEvidence.scope, evidence: marketEvidence,
    formula: 'Advancing and declining counts use provider 24-hour percentage changes for the exact membership of the latest archived snapshot. Unknown values stay unknown.',
    limitations: 'Tracked-page breadth, not market-wide breadth. Membership changes between snapshots change the denominator; absence from the page is not a delisting.' };

  const covered = averageBreadth(input.histories.map(history => ({ assetId: history.assetId, symbol: history.symbol,
    name: history.name, points: history.series?.points ?? [] })));
  const averages = { ...covered, tracked: assets.length,
    scope: `${covered.sma200.covered} of ${assets.length} tracked assets have 200 contiguous completed daily samples; ${covered.sma50.covered} have 50`,
    formula: 'Percentage of covered assets whose latest completed daily sample exceeds their own 50-day or 200-day trailing average. An asset without a complete contiguous window is uncovered, not below.',
    limitations: 'Daily price archives exist only for the priority assets acquired so far, so this is not tracked-page participation. CoinGecko daily samples are not exchange closes.' };

  const btcLatest = input.btc?.data.latest ?? null;
  const btcCoverage = input.btc?.data.coverage[0] ?? null;
  const btc = { regime: btcLatest?.regime ?? 'insufficient-history', candidate: btcLatest?.candidate ?? 'insufficient-history',
    confirmationDays: btcLatest?.confirmationDays ?? 0, observedAt: btcLatest?.observedAt ?? null,
    closeUsd: btcLatest?.value ?? null, sma200Usd: btcLatest?.sma200 ?? null, sma200Slope20d: btcLatest?.sma200Slope20d ?? null,
    mayerMultiple: btcLatest?.mayerMultiple ?? null, mvrv: btcLatest?.mvrv ?? null, drawdownPct: btcLatest?.drawdownPct ?? null,
    volatility30d: btcLatest?.volatility30d ?? null, weeklyRsi: btcLatest?.weeklyRsi ?? null,
    evidence: { source: 'Coin Metrics Community', scope: 'BTC completed UTC daily closes; CC BY-NC 4.0',
      observedAt: btcLatest?.observedAt ?? null, seriesId: btcSeriesId(), values: btcCoverage?.points ?? 0,
      replayCoverageStart: btcCoverage?.replayCoverageStart ?? null, unavailable: !btcLatest,
      replayRefused: refused('btc-history'), stale: btcCoverage?.stale ?? true, classification: 'historical-reconstruction',
      methodologyVersion: input.btc?.data.methodology.version ?? null },
    rule: input.btc?.data.methodology.regime ?? null,
    interpretation: 'Trend evidence only. Valuation (Mayer, MVRV) shares inputs with price and is displayed beside the regime rather than folded into it.',
    limitations: 'A moving-average rule is a transparent baseline, not a cycle-turning-point detector. Confirmed regimes lag by three completed days.' };

  const supply = supplyChange(input.capital?.points ?? [], now);
  const liquidity = { stablecoin: { ...supply,
    coverage: { source: 'defillama', scope: capitalScope, seriesId: capitalSeriesId,
      observedAt: supply.observedAt, first: supply.first, values: supply.values,
      replayCoverageStart: input.capital?.metadata.replayCoverageStart ?? null,
      unavailable: supply.value === null, replayRefused: refused('stablecoin-supply'),
      stale: supply.observedAt === null || Date.parse(supply.observedAt) < Math.floor(now / DAY) * DAY - DAY,
      classification: 'historical-reconstruction' },
    formula: 'DefiLlama totalCirculatingUSD.peggedUSD. 30D change compares the latest completed UTC day with the value exactly 30 days earlier; an absent or non-positive comparison keeps it unavailable.',
    interpretation: 'A capital context proxy for provider-covered USD-pegged supply. Expansion is not measured net inflow into any asset.',
    limitations: 'Non-USD pegs are excluded and provider coverage changes over time; historical constituents are unavailable.' },
    reportedVolume: { latest: reportedVolume.latest?.volume24hUsd ?? null, change24hPct: reportedVolume.change24h.changePct,
      change7dPct: reportedVolume.change7d.changePct, coverage: reportedVolume.coverage } };

  const benchmark = input.histories.find(history => history.assetId === RELATIVE_BENCHMARK)?.series?.points ?? [];
  const benchmarkReturns = { d7: calendarReturnPct(benchmark, 7), d30: calendarReturnPct(benchmark, 30), d90: calendarReturnPct(benchmark, 90) };
  const performance = { benchmark: RELATIVE_BENCHMARK, benchmarkReturns,
    rows: input.histories.map(history => {
      const points = history.series?.points ?? [];
      const usd = { d7: calendarReturnPct(points, 7), d30: calendarReturnPct(points, 30), d90: calendarReturnPct(points, 90) };
      return { assetId: history.assetId, symbol: history.symbol, name: history.name,
        observedAt: points.at(-1)?.observedAt ?? null, samples: points.filter(point => point.value !== null).length, usd,
        relative: history.assetId === RELATIVE_BENCHMARK
          ? { d7: usd.d7 === null ? null : 0, d30: usd.d30 === null ? null : 0, d90: usd.d90 === null ? null : 0 }
          : { d7: relativeReturnPct(usd.d7, benchmarkReturns.d7), d30: relativeReturnPct(usd.d30, benchmarkReturns.d30),
            d90: relativeReturnPct(usd.d90, benchmarkReturns.d90) } };
    }).sort((a, b) => (b.relative.d30 ?? -Infinity) - (a.relative.d30 ?? -Infinity) || a.assetId.localeCompare(b.assetId)),
    replayRefused: refused('daily-histories'),
    unarchivedAssets: assets.filter(asset => !input.histories.some(history => history.assetId === asset.id)).map(asset => asset.id),
    scope: 'Assets with archived CoinGecko daily price samples; both the asset and the BTC benchmark use the same source and sampling time',
    formula: 'Return = last completed daily sample / the sample exactly 7, 30 or 90 days earlier − 1. BTC-relative return compounds: (1 + asset) / (1 + BTC) − 1. BTC against itself is zero.',
    limitations: 'Descriptive outcomes without costs, execution or survivorship treatment. Missing endpoint dates stay unavailable rather than being filled forward.' };

  const changeField = (asset: Asset) => asset.change24h;
  const ranked = assets.filter(asset => changeField(asset) !== null).sort((a, b) => changeField(b)! - changeField(a)!);
  // A small universe must not appear twice: an asset is a leader or a laggard, never both.
  const leaders = ranked.slice(0, 5);
  const reportedChanges = { leaders, laggards: ranked.slice(-5).reverse().filter(asset => !leaders.includes(asset)),
    scope: marketEvidence.scope, window: 'Provider-reported 24-hour percentage change',
    limitations: 'Provider-reported percentages from the tracked page, not returns computed from this archive’s daily samples.' };

  const categories = new Map(input.categories.map(row => [row.id, row.category]));
  const classified = assets.filter(asset => categories.get(asset.id));
  const grouped = new Map<string, { category: string; assets: number; marketCapUsd: number; members: string[] }>();
  for (const asset of classified) {
    const category = categories.get(asset.id)!;
    const row = grouped.get(category) ?? { category, assets: 0, marketCapUsd: 0, members: [] };
    row.assets += 1; row.marketCapUsd += asset.marketCapUsd ?? 0; row.members.push(asset.symbol);
    grouped.set(category, row);
  }
  const classifiedCap = classified.reduce((sum, asset) => sum + (asset.marketCapUsd ?? 0), 0);
  const sectors = { status: 'gated' as const, tracked: assets.length, classified: classified.length,
    unclassified: assets.length - classified.length,
    categories: [...grouped.values()].map(row => ({ ...row,
      classifiedSharePct: classifiedCap > 0 ? row.marketCapUsd / classifiedCap * 100 : null }))
      .sort((a, b) => b.marketCapUsd - a.marketCapUsd || a.category.localeCompare(b.category)),
    coverage: 'Curated prototype classifications only; shares are of classified assets, never of the market',
    limitations: 'Sector leadership stays gated until asset-sector mappings and historical membership are verified. No sector-relative returns or multiples are computed from this partial mapping.' };

  const signalChanges = [
    ...regimeChanges(input.btc?.data.points ?? [], 365).slice(-5).reverse().map(change => ({ type: 'btc-regime' as const,
      observedAt: change.observedAt, title: `BTC regime confirmed ${change.to.replaceAll('-', ' ')}`,
      detail: `Previous displayed regime: ${change.from.replaceAll('-', ' ')}. Confirmation requires three consecutive completed daily candidates.`,
      evidence: { source: 'Coin Metrics Community', methodologyVersion: input.btc?.data.methodology.version ?? null,
        classification: 'historical-reconstruction' } })),
    ...input.alerts.map(alert => ({ type: 'threshold-alert' as const, observedAt: alert.detected_at,
      title: alert.title, detail: `${alert.asset_id}: archived market snapshot crossed a saved thesis condition.`,
      evidence: { source: 'CoinGecko', ...alert.evidence, classification: 'forward tracking' } })),
    ...(input.market?.events ?? []).filter((event: { event_type: string }) => ['first_observed', 'catalog_absent', 'returned'].includes(event.event_type))
      .slice(0, 10).map((event: { entity_key: string; event_type: string }) => ({ type: 'tracked-membership' as const, observedAt: input.market?.metadata.observedAt ?? null,
        title: `${event.entity_key} ${event.event_type === 'catalog_absent' ? 'left the tracked page' : event.event_type === 'returned' ? 'returned to the tracked page' : 'first observed on the tracked page'}`,
        detail: 'Tracked-page membership change within the archived top-100 snapshot. This is not a listing, delisting or launch event.',
        evidence: { source: 'CoinGecko', snapshotId: input.market?.metadata.snapshotId ?? null, classification: 'forward tracking' } })),
  ].sort((a, b) => Date.parse(b.observedAt ?? '') - Date.parse(a.observedAt ?? '')).slice(0, 12);

  const stale = marketEvidence.stale || global.evidence.stale || btc.evidence.stale || liquidity.stablecoin.coverage.stale;
  return { data: { global, reportedVolume, breadth, averages, btc, liquidity, performance, reportedChanges, sectors, signalChanges,
    methodology: { version: OVERVIEW_METHOD, classification: input.asOf ? 'point-in-time' : 'forward tracking with reconstructed histories',
      snapshotAsOf: input.asOf ?? null,
      scope: 'Every aggregate on this page declares its own coverage. Provider-global values come from the provider; breadth, sectors and reported changes describe the archived tracked page only.',
      degradation: 'Each block reads its own archived feed. One unavailable feed leaves that block unavailable and does not remove the others.',
      replayRefusals: input.replayRefusals ?? [],
      replay: 'A cutoff selects the revisions archived by then. Feeds whose production coverage starts after the cutoff are refused explicitly for their own block; they are never reconstructed.',
      sources: ['https://docs.coingecko.com/reference/coins-markets', 'https://docs.coingecko.com/reference/crypto-global',
        'https://raw.githubusercontent.com/coinmetrics/docs-website/master/asset-metrics/market/priceusd.md', 'https://api-docs.defillama.com/'] } },
    metadata: { source: 'CoinGecko / Coin Metrics / DefiLlama', observedAt: input.market?.metadata.observedAt ?? input.now,
      coverage: 'Composed market overview; provider-global aggregates and archived tracked-page evidence are labeled separately',
      stale, unavailable: !assets.length && !globalValue && !btcLatest } };
}

export async function marketOverviewArchive(database: Pool, asOf?: string) {
  const client = await database.connect();
  const refusals: string[] = [];
  // One refused feed must not hide the feeds whose coverage does reach this cutoff.
  const attempt = async <T>(feed: string, read: () => Promise<T>) => {
    try { return await read(); } catch (error) {
      if (!(error instanceof ReplayCoverageError)) throw error;
      if (!refusals.includes(feed)) refusals.push(feed);
      return null;
    }
  };
  try {
    await client.query('begin isolation level repeatable read read only');
    const now = (await client.query('select clock_timestamp()::text as time')).rows[0].time as string;
    const market = await attempt('tracked-market', () => readSnapshot(client, marketDataset, asOf));
    const global = await attempt('provider-global', () => readSnapshot(client, globalDataset, asOf));
    const globalHistory = await attempt('provider-global', () => readSnapshotHistory(client, globalDataset, 'global', { asOf, limit: 720 })) ?? [];
    const btcSeries: Series[] = [];
    for (const metric of btcMetrics) btcSeries.push(await attempt('btc-history', () => readSeries(btcSeriesId(metric.code), { asOf, limit: 10000 }, client)));
    const btc = btcSeries[0] ? btcView({ acquiredAt: now, series: btcSeries }, asOf) : null;
    const capital = await attempt('stablecoin-supply', () => readSeries(capitalSeriesId, { asOf, limit: 400 }, client));
    // Only assets whose daily price series is already archived enter the covered universe.
    const identities = (await client.query(`select a.id,a.symbol,a.name from data_series s join assets a on a.id=s.asset_id
      where s.metric_code='price_usd' and s.source_id='coingecko' and s.interval_seconds=86400 and s.id=$1||a.id||$2
      order by a.id`, ['coingecko:', ':price_usd:daily-sample:v1'])).rows;
    const histories = [];
    for (const identity of identities) {
      const series = await attempt('daily-histories', () => readSeries(dailySeriesId(identity.id), { asOf, limit: 400 }, client));
      if (series) histories.push({ assetId: identity.id as string, symbol: identity.symbol as string, name: identity.name as string, series });
    }
    const categories = (await client.query('select id,category from assets where category is not null order by id')).rows;
    const alerts = (await client.query(`select id::text,asset_id,title,detected_at,evidence from research_alerts
      where detected_at <= coalesce($1::timestamptz,clock_timestamp()) order by detected_at desc,id desc limit 5`, [asOf ?? null])).rows;
    if (refusals.length && !market && !global && !btc && !capital && !histories.length)
      throw new ReplayCoverageError('Market overview replay predates production coverage for every archived feed');
    const result = overviewView({ now: asOf ?? now, asOf, market, global, globalHistory, btc, capital, histories, replayRefusals: refusals,
      categories, alerts: alerts.map(row => ({ ...row, detected_at: (row.detected_at as Date).toISOString() })) });
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
