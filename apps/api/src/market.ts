import { databaseReady, storeAsset, storeObservation, storedAssetSnapshots } from "./db.js";
import { dailyHistory } from "./daily-history.js";
import { indicators, returns } from "./indicators.js";

export const priorityAssetIds = ["bitcoin", "ethereum", "solana", "hyperliquid"] as const;
const marketUrl = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h,7d,30d";
const sourceId = "coingecko";
const coverage = "CoinGecko market data; USD spot prices";

export type Asset = { id:string; symbol:string; name:string; rank:number; priceUsd:number; marketCapUsd:number; fullyDilutedValuationUsd:number | null; volume24hUsd:number; circulatingSupply:number | null; totalSupply:number | null; maxSupply:number | null; change24h:number; change7d:number | null; change30d:number | null; observedAt:string };
type CoinGeckoMarket = { id:string; symbol:string; name:string; market_cap_rank:number|null; current_price:number|null; market_cap:number|null; fully_diluted_valuation:number|null; total_volume:number|null; circulating_supply:number|null; total_supply:number|null; max_supply:number|null; price_change_percentage_24h:number|null; price_change_percentage_7d_in_currency?:number|null; price_change_percentage_30d_in_currency?:number|null; last_updated:string|null };
type MarketSnapshot = { observedAt: string; assets: Asset[]; stale: boolean };
let cache: MarketSnapshot | undefined;

function assetFromMarket(asset: CoinGeckoMarket, index: number, observedAt: string): Asset {
  return { id: asset.id, symbol: asset.symbol.toUpperCase(), name: asset.name, rank: asset.market_cap_rank ?? index + 1,
    priceUsd: asset.current_price ?? 0, marketCapUsd: asset.market_cap ?? 0, fullyDilutedValuationUsd: asset.fully_diluted_valuation,
    volume24hUsd: asset.total_volume ?? 0, circulatingSupply: asset.circulating_supply, totalSupply: asset.total_supply, maxSupply: asset.max_supply,
    change24h: asset.price_change_percentage_24h ?? 0, change7d: asset.price_change_percentage_7d_in_currency ?? null,
    change30d: asset.price_change_percentage_30d_in_currency ?? null, observedAt: asset.last_updated ?? observedAt };
}
async function persistAsset(asset: Asset) {
  if (!await databaseReady()) return;
  await storeAsset({ id: asset.id, symbol: asset.symbol, name: asset.name, category: null });
  const values: [string, number | null, string][] = [["price_usd", asset.priceUsd, "USD"], ["market_cap_usd", asset.marketCapUsd, "USD"], ["fully_diluted_valuation_usd", asset.fullyDilutedValuationUsd, "USD"], ["volume_24h_usd", asset.volume24hUsd, "USD"], ["circulating_supply", asset.circulatingSupply, "tokens"], ["total_supply", asset.totalSupply, "tokens"], ["max_supply", asset.maxSupply, "tokens"]];
  await Promise.all(values.filter(([, value]) => value !== null).map(([metricCode, value, unit]) => storeObservation({ assetId: asset.id, metricCode, value: value!, unit, observedAt: asset.observedAt, sourceId, coverage, granularity: "snapshot", quality: "fresh" })));
}
export async function marketData() {
  if (cache && Date.now() - Date.parse(cache.observedAt) < 5 * 60_000) return cache;
  try {
    const response = await fetch(marketUrl, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`CoinGecko market request failed: ${response.status}`);
    const data = await response.json() as CoinGeckoMarket[];
    if (!Array.isArray(data)) throw new Error("CoinGecko market response was invalid.");
    const observedAt = new Date().toISOString(); const assets = data.map((asset, index) => assetFromMarket(asset, index, observedAt));
    await Promise.all(assets.map(persistAsset)); cache = { observedAt, assets, stale: false }; return cache;
  } catch (error) {
    const rows = await storedAssetSnapshots().catch(() => []);
    if (!rows.length) throw error;
    const assets = rows.map((row, index) => ({ id: row.id, symbol: row.symbol, name: row.name, rank: index + 1, priceUsd: Number(row.price_usd), marketCapUsd: Number(row.market_cap_usd ?? 0), fullyDilutedValuationUsd: row.fully_diluted_valuation_usd === null ? null : Number(row.fully_diluted_valuation_usd), volume24hUsd: Number(row.volume_24h_usd ?? 0), circulatingSupply: row.circulating_supply === null ? null : Number(row.circulating_supply), totalSupply: row.total_supply === null ? null : Number(row.total_supply), maxSupply: row.max_supply === null ? null : Number(row.max_supply), change24h: 0, change7d: null, change30d: null, observedAt: row.observed_at.toISOString() }));
    cache = { observedAt: assets[0].observedAt, assets, stale: true }; return cache;
  }
}
export async function assetDetails(assetId: string) {
  const market = await marketData(); let asset = market.assets.find(candidate => candidate.id === assetId);
  if (!asset) {
    const response = await fetch(`${marketUrl}&ids=${encodeURIComponent(assetId)}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`CoinGecko asset request failed: ${response.status}`);
    const data = await response.json() as CoinGeckoMarket[]; if (!data[0]) return null;
    asset = assetFromMarket(data[0], 0, new Date().toISOString()); await persistAsset(asset);
  }
  const priceHistory = await dailyHistory(asset.id);
  // Keep the legacy response field empty; sampled prices are not OHLC candles.
  return { asset, candles: [], priceHistory, stale: market.stale, returns: returns(priceHistory.points), indicators: indicators(priceHistory.points) };
}
export const metadata = (observationTime: string | null, stale = false) => ({ source: "CoinGecko", observedAt: observationTime, coverage, stale });
