import type { DiscoveryJob, DiscoverySample } from '../discovery/providers.js';

export const btcMetrics = [
  { field: 'PriceUSD', code: 'price_usd', unit: 'USD' },
  { field: 'CapMrktCurUSD', code: 'market_cap_usd', unit: 'USD' },
  { field: 'CapMVRVCur', code: 'mvrv', unit: 'ratio' },
  { field: 'SplyCur', code: 'circulating_supply', unit: 'tokens' },
] as const;
export const btcSeriesId = (code = 'price_usd') => `coinmetrics:bitcoin:${code}:daily:v1`;
export const btcHistoryJob: DiscoveryJob = {
  id: 'coinmetrics:bitcoin:daily-history:v1', provider: 'coinmetrics', kind: 'history',
  scope: 'BTC Coin Metrics completed UTC daily price, current-supply market cap, MVRV and supply',
  intervalSeconds: 86400, offsetSeconds: 7200, membership: 'sample', weight: 1,
  methodologyVersion: 'coinmetrics-daily:v1',
  endpoint: `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=${btcMetrics.map(m => m.field).join(',')}&frequency=1d&start_time=2010-01-01&page_size=10000`,
  parse: parseBtcHistory,
};

export function parseBtcHistory(payload: unknown, receivedAt = new Date().toISOString()): DiscoverySample {
  const data = payload as { data?: Record<string, unknown>[]; next_page_token?: unknown; next_page_url?: unknown } | null;
  if (!Number.isFinite(Date.parse(receivedAt)) || !data || !Array.isArray(data.data) || !data.data.length || data.data.length > 10000) throw new Error('Missing or oversized BTC history');
  // The verified full batch fits one page. Refuse partial coverage if that contract changes.
  if (data.next_page_token || data.next_page_url) throw new Error('BTC history pagination requires an acquisition and quota review');
  const series: NonNullable<DiscoverySample['series']> = btcMetrics.map(metric => ({
    definition: { id: btcSeriesId(metric.code), assetId: 'bitcoin', metricCode: metric.code,
      sourceId: 'coinmetrics', unit: metric.unit, scope: 'asset', intervalSeconds: 86400, methodologyVersion: 'coinmetrics-daily:v1' }, points: [],
  }));
  let previous = -Infinity;
  const midnight = Math.floor(Date.parse(receivedAt) / 86400000) * 86400000;
  for (const row of data.data) {
    const time = typeof row?.time === 'string' ? Date.parse(row.time) : NaN;
    if (row?.asset !== 'btc' || !Number.isFinite(time) || time < 0 || time % 86400000 || time <= previous || time > Date.parse(receivedAt)) throw new Error('Invalid BTC daily identity or timestamp');
    previous = time;
    for (const [i, metric] of btcMetrics.entries()) {
      const raw = row[metric.field];
      let value: number | null = null;
      if (raw !== null && raw !== undefined && raw !== '') {
        if (!['string', 'number'].includes(typeof raw) || typeof raw === 'string' && !raw.trim() || !Number.isFinite(Number(raw)) || Number(raw) <= 0) throw new Error(`Invalid BTC ${metric.field}`);
        value = Number(raw);
      }
      // Preserve the provider's date label. PriceUSD denotes the END of this UTC day.
      // Publication time is unknown; never substitute this label for availability.
      const inception = Date.parse(metric.field === 'SplyCur' ? '2010-01-01' : '2010-07-18');
      if (time < midnight && time >= inception) series[i].points.push({ observedAt: new Date(time).toISOString(), value });
    }
  }
  if (!series[0].points.some(p => p.value !== null)) throw new Error('No completed BTC prices');
  return { members: [], assets: [{ id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' }], series,
    notes: { history: 'Historical reconstruction before acquisition; revisions retained from ingestion onward',
      timestamp: 'UTC day label; PriceUSD is end-of-day close. Provider publication time unknown.',
      attribution: 'Coin Metrics Community, CC BY-NC 4.0', valuation: 'MVRV and derived realized price share inputs; not independent evidence' } };
}
