import type { Pool } from 'pg';
import { readSeries, ReplayCoverageError } from '../archive.js';
import { guardDiscoveryReplay } from '../discovery/archive.js';
import { cdiSeriesId, ptaxSeriesId } from '../feeds/bcb.js';
import { macroSeriesId } from '../feeds/macro.js';
import { fomcCalendarJob, RELEASES, releaseDatasetId } from '../feeds/calendar.js';

const DAY = 86400000;

/** Mirrors backtest/archive.ts's block(): one section's ReplayCoverageError refuses
 *  only that section, never the whole response. A future cutoff still propagates. */
async function block<T>(name: string, read: () => Promise<T>) {
  try { return { name, refused: false as const, data: await read() }; }
  catch (error) {
    if (error instanceof ReplayCoverageError) return { name, refused: true as const, message: error.message };
    if (error instanceof Error && error.message === 'Replay cutoff cannot be in the future') throw error;
    return { name, refused: true as const, message: error instanceof Error ? error.message : 'unavailable' };
  }
}

type SeriesEntry = Awaited<ReturnType<typeof block<Awaited<ReturnType<typeof readSeries>>>>>;

function shapeSeries(entry: SeriesEntry) {
  if (entry.refused) return { refused: true, unavailable: false, message: entry.message, points: [] as { observedAt: string; value: number | null }[], latest: null as { observedAt: string; value: number | null } | null, coverage: null };
  const series = entry.data;
  const points = series?.points ?? [];
  const valid = points.filter(p => p.value !== null);
  const latest = valid.at(-1) ?? null;
  return {
    refused: false, unavailable: !series, points, latest,
    coverage: series ? {
      seriesId: series.metadata.seriesId, source: series.metadata.source,
      first: valid[0]?.observedAt ?? null, last: latest?.observedAt ?? null,
      values: valid.length, missing: points.length - valid.length,
      replayCoverageStart: series.metadata.replayCoverageStart, classification: series.metadata.classification,
    } : null,
  };
}

function annualizeCdi(points: { observedAt: string; value: number | null }[]) {
  return points.map(p => ({ observedAt: p.observedAt, value: p.value === null ? null : Math.pow(1 + p.value / 100, 252) - 1 }));
}

/** Checks a discovery dataset exists before reading its calendar snapshots, so a
 *  feed this installation never configured (e.g. FRED releases with no key) is
 *  `unavailable`, distinct from `refused` (configured, but asOf predates coverage) —
 *  same distinction altcoin/archive.ts's configured()/attempt() draws for datasets. */
async function calendarBlock(database: Pool, datasetId: string, asOf: string | undefined) {
  const configured = !!(await database.query('select 1 from discovery_datasets where id=$1', [datasetId])).rowCount;
  if (!configured) return { unavailable: true, refused: false, message: null as string | null, recordedAt: null as string | null, events: [] as unknown[] };
  try { await guardDiscoveryReplay(database, datasetId, asOf); }
  catch (error) {
    if (error instanceof ReplayCoverageError) return { unavailable: false, refused: true, message: error.message, recordedAt: null, events: [] };
    throw error;
  }
  const snapshot = (await database.query(`select id, recorded_at::text as recorded_at from macro_calendar_snapshots
    where dataset_id=$1 and recorded_at <= coalesce($2::timestamptz, clock_timestamp()) order by recorded_at desc, id desc limit 1`,
  [datasetId, asOf ?? null])).rows[0];
  if (!snapshot) return { unavailable: true, refused: false, message: null, recordedAt: null, events: [] };
  const cutoffDate = (asOf ? new Date(asOf) : new Date()).toISOString().slice(0, 10);
  const events = (await database.query(`select event_type as "eventType", title, starts_on::text as "startsOn",
    ends_on::text as "endsOn", sep, source_url as "sourceUrl", methodology_version as "methodologyVersion"
    from macro_calendar_events where snapshot_id=$1 and ends_on >= $2::date order by starts_on asc`,
  [snapshot.id, cutoffDate])).rows;
  return { unavailable: false, refused: false, message: null, recordedAt: snapshot.recorded_at, events };
}

export async function macroView(database: Pool, asOf?: string) {
  const [cdi, ptax, dfii10, dtwexbgs, sp500, nasdaqcom] = await Promise.all([
    block('brazil.cdi', () => readSeries(cdiSeriesId, { asOf, limit: 10000 }, database)),
    block('brazil.ptax', () => readSeries(ptaxSeriesId, { asOf, limit: 10000 }, database)),
    block('usMacro.dfii10', () => readSeries(macroSeriesId('DFII10'), { asOf, limit: 10000 }, database)),
    block('usMacro.dtwexbgs', () => readSeries(macroSeriesId('DTWEXBGS'), { asOf, limit: 10000 }, database)),
    block('usMacro.sp500', () => readSeries(macroSeriesId('SP500'), { asOf, limit: 10000 }, database)),
    block('usMacro.nasdaqcom', () => readSeries(macroSeriesId('NASDAQCOM'), { asOf, limit: 10000 }, database)),
  ]);
  const cdiShape = shapeSeries(cdi);
  const [fomc, cpi, employment, gdp, pce] = await Promise.all([
    calendarBlock(database, fomcCalendarJob.id, asOf),
    calendarBlock(database, releaseDatasetId('cpi'), asOf),
    calendarBlock(database, releaseDatasetId('employment'), asOf),
    calendarBlock(database, releaseDatasetId('gdp'), asOf),
    calendarBlock(database, releaseDatasetId('pce'), asOf),
  ]);
  const calendar = { fomc, cpi, employment, gdp, pce,
    copom: { unavailable: true, refused: false, message: null, recordedAt: null, events: [], note: 'Not yet sourced' } };

  const seriesBlocks = [cdi, ptax, dfii10, dtwexbgs, sp500, nasdaqcom];
  const refusals = [
    ...seriesBlocks.filter(b => b.refused).map(b => ({ block: b.name, message: (b as { message: string }).message })),
    ...Object.entries(calendar).filter(([, v]) => v.refused).map(([name, v]) => ({ block: `calendar.${name}`, message: v.message! })),
  ];
  const latestObservedAt = seriesBlocks.map(b => shapeSeries(b).latest?.observedAt).filter((v): v is string => !!v).sort().at(-1) ?? null;

  return {
    data: {
      brazil: {
        cdi: { ...cdiShape, annualized: annualizeCdi(cdiShape.points) },
        ptax: shapeSeries(ptax),
      },
      usMacro: {
        dfii10: shapeSeries(dfii10), dtwexbgs: shapeSeries(dtwexbgs), sp500: shapeSeries(sp500), nasdaqcom: shapeSeries(nasdaqcom),
      },
      calendar,
      refusals,
      methodology: {
        cdi: 'BCB SGS série 12; percent per business day. Annualized = (1+d/100)^252-1. Weekends/holidays are absent, never forward-filled or compounded over calendar days.',
        ptax: 'BCB SGS série 1; PTAX sell rate, business days only.',
        usMacro: 'FRED DFII10/DTWEXBGS/SP500/NASDAQCOM. Gated on FRED_API_KEY. DTWEXBGS publishes weekly, not daily. SP500 history is a rolling 10-year provider window (first value 2016-09-12), display-only, not a feature input elsewhere in this app.',
        calendar: 'FOMC dates scraped from the official Federal Reserve calendar page (no RSS/ICS feed exists), archived as append-only snapshots. CPI/Employment/GDP/PCE release dates from FRED release/dates, gated on FRED_API_KEY. Copom (Brazil) dates are not yet sourced. A historical replay cutoff before a block was ever configured is reported as refused, matching every other replay-guarded feed in this app; only the default (no-cutoff) live view distinguishes "gated, no key configured" as unavailable.',
      },
      coverage: { source: 'BCB · FRED · Federal Reserve', asOf: asOf ?? null },
    },
    metadata: {
      source: 'BCB · FRED · Federal Reserve', observedAt: latestObservedAt,
      stale: !latestObservedAt || Date.now() - Date.parse(latestObservedAt) > 4 * DAY,
      coverage: 'CDI and PTAX are always live (no key required); US macro series and FRED release dates are gated on FRED_API_KEY.',
    },
  };
}
