import type { DiscoveryJob, DiscoverySample } from '../discovery/providers.js';

export const capitalSeriesId = 'defillama:usd-pegged:stablecoin_supply_usd:daily:v1';
export const capitalHistoryId = 'defillama:usd-pegged:daily-history:v1';
export const capitalCatalogId = 'defillama:usd-pegged:catalog:v1';
export const capitalScope = 'covered_usd_pegged_stablecoins';
const DAY = 86400000;

function amount(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid stablecoin amount');
  return value;
}

export function parseCapitalHistory(payload: unknown, receivedAt = new Date().toISOString()): DiscoverySample {
  if (!Array.isArray(payload) || !payload.length || payload.length > 10000 || !Number.isFinite(Date.parse(receivedAt))) throw new Error('Invalid stablecoin history');
  const midnight = Math.floor(Date.parse(receivedAt) / DAY) * DAY;
  let previous = -Infinity;
  const points = payload.flatMap(row => {
    const time = (typeof row?.date === 'string' && /^\d+$/.test(row.date) || typeof row?.date === 'number') ? Number(row.date) * 1000 : NaN;
    if (!Number.isSafeInteger(time) || time < 0 || time <= previous || time > Date.parse(receivedAt) || time % DAY) throw new Error('Invalid stablecoin daily timestamp');
    previous = time;
    // Do not sum non-USD pegs, minted/bridged totals, or replace a missing field with zero.
    const value = amount(row.totalCirculatingUSD?.peggedUSD);
    return time < midnight ? [{ observedAt: new Date(time).toISOString(), value }] : [];
  });
  if (!points.some(p => p.value !== null)) throw new Error('No completed USD-pegged supply values');
  return { members: [], series: [{ definition: { id: capitalSeriesId, assetId: null, metricCode: 'stablecoin_supply_usd',
    sourceId: 'defillama', unit: 'USD', scope: capitalScope, intervalSeconds: 86400, methodologyVersion: 'stablecoin-supply:v1' }, points }],
    notes: { field: 'totalCirculatingUSD.peggedUSD', scope: 'DefiLlama covered USD-pegged assets across chains',
      membership: 'Provider aggregate with changing coverage; historical constituents are unavailable. Current catalog is separate evidence.',
      timestamp: 'Provider UTC daily label, live day excluded; publication time unknown',
      interpretation: 'Circulating USD-valued supply proxy; changes include coverage and valuation effects, not measured capital inflows',
      history: 'Historical reconstruction; revisions retained from acquisition onward', attribution: 'DefiLlama; provider terms apply' } };
}

export function parseCapitalCatalog(payload: unknown): DiscoverySample {
  const rows = (payload as { peggedAssets?: unknown[] } | null)?.peggedAssets;
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000) throw new Error('Invalid stablecoin catalog');
  const ids = new Set<string>();
  const members = rows.flatMap((row: any) => {
    if (!row || !['string', 'number'].includes(typeof row.id) || !/^\d+$/.test(String(row.id)) || typeof row.pegType !== 'string') throw new Error('Invalid stablecoin identity or peg');
    const id = String(row.id);
    if (ids.has(id)) throw new Error('Duplicate stablecoin identity');
    ids.add(id);
    if (row.pegType !== 'peggedUSD') return [];
    if (typeof row.name !== 'string' || !row.name.trim() || typeof row.symbol !== 'string' || !row.symbol.trim() || !Array.isArray(row.chains) || row.chains.some((c: unknown) => typeof c !== 'string')) throw new Error('Invalid stablecoin coverage');
    return [{ key: JSON.stringify(['defillama', id]), status: 'observed' as const, data: { id, name: row.name, symbol: row.symbol,
      pegType: row.pegType, chains: row.chains, circulatingNative: amount(row.circulating?.peggedUSD), priceUsd: amount(row.price) } }];
  });
  if (!members.length) throw new Error('No USD-pegged catalog members');
  return { members, notes: { returnedAssets: rows.length, coveredUsdPeggedAssets: members.length,
    membership: 'Current provider catalog filtered to pegType=peggedUSD; not historical membership or an exact reconciliation to the separately sampled history',
    publicationTime: 'unknown', scope: 'Includes provider-covered assets with zero or unknown supply; no blanket peg stability or reserve assurance' } };
}

export const capitalJobs: DiscoveryJob[] = [
  { id: capitalHistoryId, provider: 'defillama', kind: 'history', scope: capitalScope, intervalSeconds: 86400, offsetSeconds: 3600,
    membership: 'sample', weight: 1, methodologyVersion: 'stablecoin-supply:v1', endpoint: 'https://stablecoins.llama.fi/stablecoincharts/all', parse: parseCapitalHistory },
  { id: capitalCatalogId, provider: 'defillama', kind: 'enrichment', scope: 'Current DefiLlama USD-pegged stablecoin catalog', intervalSeconds: 86400,
    membership: 'sample', weight: 1, methodologyVersion: 'stablecoin-catalog:v1', endpoint: 'https://stablecoins.llama.fi/stablecoins?includePrices=true', parse: parseCapitalCatalog },
];
