import type { Pool } from 'pg';
import type { DiscoveryJob, DiscoverySample } from '../discovery/providers.js';

export const cdiSeriesId = 'bcb:sgs:12:cdi-daily-rate:v1';
export const ptaxSeriesId = 'bcb:sgs:1:usd-brl-ptax-sell:v1';
const macroScope = 'macro_indicator';
const DAY = 86400000;
// BCB SGS caps a single request to a 10-year window (probed: a 2010-2026 request
// returns 406 naming this limit). Stay comfortably under it.
const CHUNK_MS = 3640 * DAY;
const RECENT_WINDOW_DAYS = 400;
const SGS_START = Date.UTC(2010, 0, 1);

function formatBr(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** BCB SGS rows are `{data:"DD/MM/AAAA", valor:"0.051660"}`, business days only
 *  (weekends and Brazilian holidays are simply absent, never forward-filled).
 *  `metricCode`/`unit` select which of the two series (CDI or PTAX) this call parses. */
export function parseSgs(seriesId: string, metricCode: string, unit: string, payload: unknown, receivedAt = new Date().toISOString()): DiscoverySample {
  if (!Array.isArray(payload) || !payload.length || payload.length > 10000 || !Number.isFinite(Date.parse(receivedAt)))
    throw new Error('Invalid BCB SGS history');
  const today = Math.floor(Date.parse(receivedAt) / DAY) * DAY;
  const parsedRows = payload.map((row: any) => {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(row?.data));
    if (!match) throw new Error('Invalid BCB SGS date');
    const [, dd, mm, yyyy] = match;
    const time = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd));
    if (!Number.isFinite(time)) throw new Error('Invalid BCB SGS date');
    const value = Number(String(row?.valor).replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid BCB SGS value');
    return { time, value };
  }).sort((a, b) => a.time - b.time);
  let previous = -Infinity;
  const points = parsedRows.flatMap(({ time, value }) => {
    if (time <= previous) throw new Error('Non-increasing BCB SGS timestamp');
    previous = time;
    return time < today ? [{ observedAt: new Date(time).toISOString(), value }] : [];
  });
  if (!points.length) throw new Error('No completed BCB SGS values');
  return { members: [], series: [{ definition: { id: seriesId, assetId: null, metricCode, sourceId: 'bcb',
    unit, scope: macroScope, intervalSeconds: 86400, methodologyVersion: 'bcb-sgs:v1' }, points }],
    notes: { field: 'valor', scope: 'BCB SGS (Sistema Gerenciador de Séries Temporais)',
      timestamp: 'Business-day label as published by BCB, live/incomplete day excluded',
      attribution: 'Banco Central do Brasil; public data' } };
}

/** Finds how far back this series' archive already reaches (via the DB clock, not
 *  Date.now()) and returns the next window to request: the oldest missing <=10-year
 *  chunk while backfilling to 2010-01-01, otherwise a 400-day recent window. */
async function sgsWindow(database: Pool, seriesId: string): Promise<{ dataInicial: string; dataFinal: string }> {
  const now = (await database.query('select extract(epoch from clock_timestamp())::float8*1000 as now')).rows[0].now;
  const earliest = (await database.query('select min(observed_at) as first from series_observations where series_id=$1', [seriesId])).rows[0].first;
  const earliestMs = earliest ? Date.parse(earliest) : null;
  if (earliestMs === null || earliestMs > SGS_START) {
    const chunkEnd = earliestMs !== null ? earliestMs - DAY : Math.floor(now / DAY) * DAY;
    const chunkStart = Math.max(SGS_START, chunkEnd - CHUNK_MS + DAY);
    return { dataInicial: formatBr(chunkStart), dataFinal: formatBr(chunkEnd) };
  }
  return { dataInicial: formatBr(Math.floor(now) - RECENT_WINDOW_DAYS * DAY), dataFinal: formatBr(Math.floor(now)) };
}

export const bcbJobs: DiscoveryJob[] = [
  { id: cdiSeriesId, provider: 'bcb', kind: 'history', scope: macroScope, intervalSeconds: 86400, offsetSeconds: 1800,
    membership: 'sample', weight: 1, methodologyVersion: 'bcb-sgs:v1',
    endpoint: 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json',
    request: async database => { const w = await sgsWindow(database, cdiSeriesId);
      return { endpoint: `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json&dataInicial=${w.dataInicial}&dataFinal=${w.dataFinal}` }; },
    parse: (p, t) => parseSgs(cdiSeriesId, 'cdi_daily_rate', 'pct_per_business_day', p, t) },
  { id: ptaxSeriesId, provider: 'bcb', kind: 'history', scope: macroScope, intervalSeconds: 86400, offsetSeconds: 3600,
    membership: 'sample', weight: 1, methodologyVersion: 'bcb-sgs:v1',
    endpoint: 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados?formato=json',
    request: async database => { const w = await sgsWindow(database, ptaxSeriesId);
      return { endpoint: `https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados?formato=json&dataInicial=${w.dataInicial}&dataFinal=${w.dataFinal}` }; },
    parse: (p, t) => parseSgs(ptaxSeriesId, 'usd_brl_ptax_sell', 'brl_per_usd', p, t) },
];
