import type { DiscoveryJob, DiscoverySample } from '../discovery/providers.js';

const macroScope = 'macro_indicator';
const DAY = 86400000;

export function macroSeriesId(code: string): string {
  return `fred:${code.toLowerCase()}:daily:v1`;
}

const metricByCode: Record<string, { metricCode: string; unit: string }> = {
  DFII10: { metricCode: 'real_yield_10y', unit: 'pct' },
  DTWEXBGS: { metricCode: 'broad_usd_index', unit: 'index' },
  SP500: { metricCode: 'sp500_index', unit: 'index' },
  NASDAQCOM: { metricCode: 'nasdaq_composite_index', unit: 'index' },
};

/** FRED `series/observations` rows are `{date:"YYYY-MM-DD", value:"1.87"}`;
 *  `"."` marks a missing publication day and is skipped, never forward-filled. */
export function parseFred(code: string, payload: unknown, receivedAt = new Date().toISOString()): DiscoverySample {
  const meta = metricByCode[code];
  if (!meta) throw new Error(`Unknown FRED series code: ${code}`);
  const rows = (payload as { observations?: unknown } | null)?.observations;
  if (!Array.isArray(rows) || !rows.length || rows.length > 20000 || !Number.isFinite(Date.parse(receivedAt)))
    throw new Error('Invalid FRED observations');
  const today = Math.floor(Date.parse(receivedAt) / DAY) * DAY;
  let previous = -Infinity;
  const points = rows.flatMap((row: any) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(row?.date));
    if (!match) throw new Error('Invalid FRED observation date');
    const [, yyyy, mm, dd] = match;
    const time = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd));
    if (!Number.isFinite(time)) throw new Error('Invalid FRED observation date');
    if (time <= previous) throw new Error('Non-increasing FRED observation date');
    previous = time;
    if (time >= today) return [];
    if (row?.value === '.') return []; // not published for this date, not forward-filled
    const value = Number(row?.value);
    if (!Number.isFinite(value)) throw new Error('Invalid FRED observation value');
    return [{ observedAt: new Date(time).toISOString(), value }];
  });
  if (!points.length) throw new Error('No completed FRED observations');
  return { members: [], series: [{ definition: { id: macroSeriesId(code), assetId: null, metricCode: meta.metricCode,
    sourceId: 'fred', unit: meta.unit, scope: macroScope, intervalSeconds: 86400, methodologyVersion: 'fred-observations:v1' }, points }],
    notes: { field: 'observations[].value', scope: `FRED series ${code}`,
      timestamp: '"." (not yet published) skipped, never forward-filled; live/incomplete day excluded',
      attribution: 'Federal Reserve Bank of St. Louis (FRED); series-specific terms, verify before use' } };
}

export const macroJobs: DiscoveryJob[] = Object.keys(metricByCode).map(code => ({
  id: macroSeriesId(code), provider: 'fred', kind: 'history', scope: macroScope, intervalSeconds: 86400, offsetSeconds: 7200,
  membership: 'sample', weight: 1, methodologyVersion: 'fred-observations:v1',
  // No api_key here: the worker appends it only to the URL it actually fetches, never
  // to job.endpoint, since job.endpoint is what gets archived (append-only tables).
  endpoint: `https://api.stlouisfed.org/fred/series/observations?series_id=${code}&file_type=json&observation_start=2010-01-01`,
  parse: (p, t) => parseFred(code, p, t),
}));
