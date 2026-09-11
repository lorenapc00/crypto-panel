import type { Pool } from 'pg';
import { ReplayCoverageError, readSeries } from '../archive.js';
import { btcArchive, btcView } from '../btc/routes.js';
import { btcSeriesId } from '../feeds/bitcoin.js';
import { fearGreedSeriesId } from '../feeds/sentiment.js';
import { marketOverviewArchive } from '../overview.js';
import { emergingArchive, launchesArchive } from '../altcoin/archive.js';
import { perpProjectsArchive, perpListingsArchive } from '../perp/archive.js';
import type { Point } from '../btc/calculations.js';
import type { RegimePoint } from './calculations.js';

/** The BTC daily price series and the regime derived from it, both frozen at `asOf`.
 *  This is the one fully backfillable dataset, so it is the only strategy input in stage 6. */
export async function loadRegimeInputs(database: Pool, asOf?: string) {
  const view = btcView(await btcArchive(database, asOf), asOf);
  const points = view.data.points as {
    observedAt: string; value: number | null; regime: string;
    mayerMultiple: number | null; sma200: number | null; mvrv: number | null; weeklyRsi: number | null;
  }[];
  const prices: Point[] = points.filter(p => p.value !== null).map(p => ({ observedAt: p.observedAt, value: p.value }));
  const regimes: RegimePoint[] = points.map(p => ({ observedAt: p.observedAt, regime: p.regime }));
  // Independent feed: an unconfigured or not-yet-covered sentiment series must not break
  // the BTC-only regime filter or any custom strategy that doesn't reference it.
  let fearGreedByDate = new Map<string, number>();
  try {
    const fearGreed = await readSeries(fearGreedSeriesId, { asOf, limit: 10000 }, database);
    fearGreedByDate = new Map((fearGreed?.points ?? []).filter(p => p.value !== null).map(p => [p.observedAt.slice(0, 10), p.value as number]));
  } catch (error) { if (!(error instanceof ReplayCoverageError)) throw error; }
  // Per-day inputs for the custom portfolio engine; every field is already on the trend point.
  const signals = points.map(p => ({
    observedAt: p.observedAt, close: p.value, regime: p.regime,
    mayer: p.mayerMultiple ?? null, sma200: p.sma200 ?? null, mvrv: p.mvrv ?? null, weeklyRsi: p.weeklyRsi ?? null,
    fearGreed: fearGreedByDate.get(p.observedAt.slice(0, 10)) ?? null,
  }));
  const priceCoverage = view.data.coverage.find(c => c.metric === 'price_usd') ?? view.data.coverage[0];
  return {
    prices,
    regimes,
    signals,
    dataset: {
      seriesId: btcSeriesId('price_usd'),
      source: 'Coin Metrics Community',
      replayCoverageStart: priceCoverage?.replayCoverageStart ?? null,
      firstObservedAt: priceCoverage?.first ?? null,
      lastObservedAt: priceCoverage?.last ?? null,
      completedPrices: prices.length,
      methodologyVersion: view.data.methodology.version,
      classification: view.data.methodology.classification,
    },
  };
}

/** Every dataset a replay cutoff can actually select, with the date its point-in-time
 *  coverage begins. Feeds without a coverage row are backfilled reconstruction only. */
export async function backtestCoverage(database: Pool) {
  const series = (await database.query(`select s.id, s.source_id, s.metric_code, c.starts_at
    from data_series s left join replay_coverage c on c.series_id = s.id order by s.id`)).rows;
  const datasets = (await database.query(`select d.id, d.source_id, c.starts_at
    from discovery_datasets d left join discovery_replay_coverage c on c.dataset_id = d.id order by d.id`)).rows;
  return {
    note: 'Historical replay works only for dates after this system began archiving each dataset. A request before a dataset’s coverage start is refused, not reconstructed.',
    series: series.map(row => ({ id: row.id as string, source: row.source_id as string, metric: row.metric_code as string,
      replayCoverageStart: row.starts_at ? (row.starts_at as Date).toISOString() : null,
      classification: row.starts_at ? 'forward-tracking-with-reconstruction' : 'historical-reconstruction' })),
    datasets: datasets.map(row => ({ id: row.id as string, provider: row.source_id as string,
      replayCoverageStart: row.starts_at ? (row.starts_at as Date).toISOString() : null,
      classification: row.starts_at ? 'forward tracking' : 'not yet covered' })),
  };
}

async function block<T>(name: string, read: () => Promise<T>) {
  try {
    return { name, refused: false as const, data: await read() };
  } catch (error) {
    if (error instanceof ReplayCoverageError) return { name, refused: true as const, message: error.message };
    if (error instanceof Error && error.message === 'Replay cutoff cannot be in the future') throw error;
    return { name, refused: true as const, message: error instanceof Error ? error.message : 'unavailable' };
  }
}

/** Historical replay mode: the eligible universe, regime and discovery counts exactly as
 *  they were archived at `asOf`. Each workspace refuses independently when the cutoff
 *  predates its coverage; a refusal of one does not blank the page. */
export async function replayComposition(database: Pool, asOf: string) {
  const [overview, emerging, launches, perpProjects, perpListings] = await Promise.all([
    block('market-overview', () => marketOverviewArchive(database, asOf)),
    block('emerging-projects', () => emergingArchive(database, asOf)),
    block('spot-launches', () => launchesArchive(database, asOf)),
    block('perp-projects', () => perpProjectsArchive(database, asOf)),
    block('perp-listings', () => perpListingsArchive(database, asOf)),
  ]);

  const view = (entry: { refused: boolean; data?: unknown }): any => (entry.refused ? null : (entry.data as any).data);
  const overviewData = view(overview);
  const emergingData = view(emerging);
  const launchesData = view(launches);
  const perpProjectsData = view(perpProjects);
  const perpListingsData = view(perpListings);
  const refusals = [overview, emerging, launches, perpProjects, perpListings]
    .filter((b): b is { name: string; refused: true; message: string } => b.refused)
    .map(b => ({ workspace: b.name, message: b.message }));

  return {
    asOf,
    classification: 'point-in-time',
    marketOverview: overviewData ? {
      regime: overviewData.btc?.regime ?? null,
      trackedAssets: overviewData.breadth?.total ?? null,
    } : null,
    emerging: emergingData ? { tracked: emergingData.universe?.tracked ?? null, eligible: emergingData.universe?.eligible ?? null } : null,
    spotLaunches: launchesData ? { tokens: launchesData.universe?.tokens ?? null, shortlisted: launchesData.universe?.shortlisted ?? null } : null,
    perpProjects: perpProjectsData ? { matched: perpProjectsData.universe?.matched ?? null, coveredOpenInterestProtocols: perpProjectsData.universe?.coveredOpenInterestProtocols ?? null } : null,
    perpListings: perpListingsData ? { matched: perpListingsData.screen?.matched ?? null } : null,
    refusals,
    // The market overview reads the BTC price series, the earliest-covered dataset.
    // A cutoff before its coverage predates every replayable workspace.
    everyWorkspaceRefused: refusals.some(r => r.workspace === 'market-overview') || refusals.length === 5,
    note: 'Replay reads the snapshots and revisions archived by the cutoff. Adding a later snapshot never changes an earlier point-in-time answer.',
  };
}
