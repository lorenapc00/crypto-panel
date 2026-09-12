// Stage B data bridge (docs/data/PLANS_MACRO_AND_ML.md). The only new TS code in this
// phase: no migration, no job, no route. Reads the Stage A/6 archive through the same
// readSeries/loadRegimeInputs the production app uses and writes two dated CSVs for the
// isolated Python project. Raw observations only -- no filling, no wide join, no lags:
// Python applies publication lags and as-of joins, never Postgres.
import { writeFileSync, mkdirSync } from 'node:fs';
import { closeDatabase, pool } from '../src/db.js';
import { loadRegimeInputs } from '../src/backtest/archive.js';
import { readSeries } from '../src/archive.js';
import { cdiSeriesId, ptaxSeriesId } from '../src/feeds/bcb.js';
import { macroSeriesId } from '../src/feeds/macro.js';

const outDir = new URL('../../../research/btc-signal/data/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const date = new Date().toISOString().slice(0, 10);

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(path: URL, header: string[], rows: (string | number | null)[][]) {
  const lines = [header.join(','), ...rows.map(r => r.map(csvEscape).join(','))];
  writeFileSync(path, lines.join('\n') + '\n');
}

try {
  const inputs = await loadRegimeInputs(pool);
  const signalsPath = new URL(`btc_signals_${date}.csv`, outDir);
  writeCsv(signalsPath,
    ['observedAt', 'close', 'regime', 'mayer', 'sma200', 'mvrv', 'weeklyRsi', 'fearGreed'],
    inputs.signals.map(s => [s.observedAt, s.close, s.regime, s.mayer, s.sma200, s.mvrv, s.weeklyRsi, s.fearGreed]));
  console.log(`wrote ${inputs.signals.length} rows -> ${signalsPath.pathname}`);
  console.log(`coverage: ${inputs.dataset.firstObservedAt} -> ${inputs.dataset.lastObservedAt} (${inputs.dataset.classification})`);

  // Long format (series, observed_on, value): one readSeries call per macro series, raw
  // observations only. limit 10000 comfortably covers ~16y of daily/weekly history.
  const macroSeries: { name: string; seriesId: string }[] = [
    { name: 'cdi_daily_rate', seriesId: cdiSeriesId },
    { name: 'usd_brl_ptax_sell', seriesId: ptaxSeriesId },
    { name: 'real_yield_10y', seriesId: macroSeriesId('DFII10') },
    { name: 'broad_usd_index', seriesId: macroSeriesId('DTWEXBGS') },
    { name: 'sp500_index', seriesId: macroSeriesId('SP500') },
    { name: 'nasdaq_composite_index', seriesId: macroSeriesId('NASDAQCOM') },
  ];
  const rows: (string | number | null)[][] = [];
  for (const { name, seriesId } of macroSeries) {
    const series = await readSeries(seriesId, { limit: 10000 }, pool);
    if (!series) { console.log(`${name}: no data_series row yet, skipped`); continue; }
    for (const p of series.points) if (p.value !== null) rows.push([name, p.observedAt.slice(0, 10), p.value]);
    console.log(`${name}: ${series.points.length} points (${series.metadata.classification})`);
  }
  const macroPath = new URL(`macro_observations_${date}.csv`, outDir);
  writeCsv(macroPath, ['series', 'observed_on', 'value'], rows);
  console.log(`wrote ${rows.length} rows -> ${macroPath.pathname}`);
} finally {
  await closeDatabase();
}
