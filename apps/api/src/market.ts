import type { Pool } from 'pg';
import { pool } from './db.js';
import { profileDailyHistory } from './daily-history.js';
import { indicators, returns } from './indicators.js';
import { readSnapshot, providerStale } from './snapshots/archive.js';
import { marketDataset, globalDataset, type Asset } from './snapshots/providers.js';

export type { Asset } from './snapshots/providers.js';
export const priorityAssetIds = ['bitcoin', 'ethereum', 'solana', 'hyperliquid'] as const;

export async function marketData(database: Pool = pool, asOf?: string) {
  const snapshot = await readSnapshot(database, marketDataset, asOf);
  const assets = snapshot.members.map(member => member.data as Asset).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.id.localeCompare(b.id));
  const staleAssets = assets.filter(asset => providerStale(asset.observedAt, snapshot.now, 3600)).length;
  const metadata = { ...snapshot.metadata, source: 'CoinGecko', stale: snapshot.metadata.stale || staleAssets > 0,
    staleAssets, memberCount: assets.length, coverage: 'CoinGecko rank-selected first page, up to 100 assets; USD spot snapshots' };
  return { assets, observedAt: metadata.observedAt, stale: metadata.stale, metadata };
}

export function marketBreadth(assets: Asset[]) {
  return { advancing: assets.filter(asset => asset.change24h !== null && asset.change24h > 0).length,
    declining: assets.filter(asset => asset.change24h !== null && asset.change24h < 0).length,
    unchanged: assets.filter(asset => asset.change24h === 0).length,
    unknown: assets.filter(asset => asset.change24h === null).length, total: assets.length };
}

export async function marketOverview(database: Pool = pool, asOf?: string) {
  const [market, global] = await Promise.all([marketData(database, asOf), readSnapshot(database, globalDataset, asOf)]);
  const value = global.members[0]?.data;
  const globalMetadata = { ...global.metadata, source: 'CoinGecko', observedAt: value?.observedAt ?? null,
    acquiredAt: global.metadata.observedAt,
    stale: global.metadata.stale || providerStale(value?.observedAt ?? null, global.now, 3600),
    coverage: 'CoinGecko provider global market coverage; USD' };
  return { data: { globalMarketCapUsd: value?.globalMarketCapUsd ?? null, volume24hUsd: value?.volume24hUsd ?? null,
    btcDominance: value?.btcDominance ?? null, ethDominance: value?.ethDominance ?? null,
    movers: market.assets.slice(0, 10), marketBreadth: { ...marketBreadth(market.assets),
      scope: market.metadata.coverage, metadata: market.metadata }, globalMetadata }, metadata: market.metadata };
}

export async function assetDetails(assetId: string, database: Pool = pool) {
  const market = await marketData(database);
  let asset = market.assets.find(candidate => candidate.id === assetId);
  let assetMetadata = market.metadata;
  if (!asset) {
    // A former universe member stays researchable with its original snapshot
    // time, but is never reintroduced into current breadth.
    const previous = (await database.query(`select m.data,s.observed_at,s.recorded_at,s.id,s.payload_id
      from discovery_members m join discovery_snapshots s on s.id=m.snapshot_id
      where m.dataset_id=$1 and m.entity_key=$2 order by s.recorded_at desc,s.id desc limit 1`, [marketDataset, assetId])).rows[0];
    if (!previous) return null;
    asset = previous.data as Asset;
    assetMetadata = { ...market.metadata, observedAt: previous.observed_at.toISOString(), recordedAt: previous.recorded_at.toISOString(),
      snapshotId: previous.id, payloadId: previous.payload_id, stale: true, unavailable: false,
      coverage: 'Last archived CoinGecko snapshot; asset absent from the current tracked page' };
  }
  const priceHistory = await profileDailyHistory(asset.id, Date.now(), database);
  return { asset, candles: [], priceHistory, stale: assetMetadata.stale, metadata: assetMetadata,
    returns: returns(priceHistory.points), indicators: indicators(priceHistory.points) };
}
