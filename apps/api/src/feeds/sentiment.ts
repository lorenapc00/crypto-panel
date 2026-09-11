import type { DiscoveryJob, DiscoverySample } from '../discovery/providers.js';

export const fearGreedSeriesId = 'alternative-me:fear-greed:index:daily:v1';
export const fearGreedScope = 'crypto_market_sentiment';
const DAY = 86400000;

/** `limit=0` returns the provider's entire published history in one call, newest
 *  first. We resend the whole thing daily; appendSeries dedupes unchanged values,
 *  so this costs one request and no extra writes once a day's value is settled. */
export function parseFearGreed(payload: unknown, receivedAt = new Date().toISOString()): DiscoverySample {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000 || !Number.isFinite(Date.parse(receivedAt)))
    throw new Error('Invalid Fear & Greed history');
  const midnight = Math.floor(Date.parse(receivedAt) / DAY) * DAY;
  const sorted = [...rows].sort((a: any, b: any) => Number(a?.timestamp) - Number(b?.timestamp));
  let previous = -Infinity;
  const points = sorted.flatMap((row: any) => {
    const time = /^\d+$/.test(String(row?.timestamp)) ? Number(row.timestamp) * 1000 : NaN;
    if (!Number.isSafeInteger(time) || time < 0 || time <= previous || time > Date.parse(receivedAt) || time % DAY)
      throw new Error('Invalid Fear & Greed daily timestamp');
    previous = time;
    if (row?.value === null || row?.value === undefined || (typeof row.value !== 'number' && typeof row.value !== 'string'))
      throw new Error('Invalid Fear & Greed value');
    const value = Number(row.value);
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Invalid Fear & Greed value');
    return time < midnight ? [{ observedAt: new Date(time).toISOString(), value }] : [];
  });
  if (!points.length) throw new Error('No completed Fear & Greed values');
  return { members: [], series: [{ definition: { id: fearGreedSeriesId, assetId: null, metricCode: 'fear_greed_index',
    sourceId: 'alternative-me', unit: 'index', scope: fearGreedScope, intervalSeconds: 86400, methodologyVersion: 'fear-greed-index:v1' }, points }],
    notes: { field: 'data[].value', scope: 'Alternative.me composite crypto Fear & Greed Index (0-100)',
      methodology: 'Provider-published composite; the weighting across volatility, momentum/volume, social media, dominance and trends inputs is not independently verified here.',
      timestamp: 'Provider UTC daily label, live/incomplete day excluded; publication time unknown',
      attribution: 'Alternative.me; attribution required next to displayed values' } };
}

export const sentimentJobs: DiscoveryJob[] = [
  { id: fearGreedSeriesId, provider: 'alternative-me', kind: 'history', scope: fearGreedScope, intervalSeconds: 86400, offsetSeconds: 5400,
    membership: 'sample', weight: 1, methodologyVersion: 'fear-greed-index:v1',
    endpoint: 'https://api.alternative.me/fng/?limit=0&format=json', parse: parseFearGreed },
];
