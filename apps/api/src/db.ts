import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL ?? "postgres://crypto_panel:crypto_panel_dev@127.0.0.1:5432/crypto_panel";
export const pool = new Pool({ connectionString, max: 5 });

export type StoredAsset = { id: string; symbol: string; name: string; category: string | null };
export type StoredObservation = {
  assetId: string; metricCode: string; value: number; unit: string; observedAt: string;
  sourceId: string; coverage: string; granularity: string; quality: "fresh" | "stale" | "estimated";
};

export async function databaseReady() {
  try { await pool.query("select 1 from assets limit 1"); return true; } catch { return false; }
}

export async function storeAsset(asset: StoredAsset) {
  await pool.query(`insert into assets (id, symbol, name, category)
    values ($1, $2, $3, $4)
    on conflict (id) do update set symbol = excluded.symbol, name = excluded.name, category = excluded.category, updated_at = now()`,
    [asset.id, asset.symbol, asset.name, asset.category]);
}

export async function storeObservation(observation: StoredObservation) {
  await pool.query(`insert into observations
    (asset_id, metric_code, value, unit, observed_at, source_id, coverage, granularity, quality)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict (asset_id, metric_code, observed_at, source_id) do nothing`,
    [observation.assetId, observation.metricCode, observation.value, observation.unit, observation.observedAt,
      observation.sourceId, observation.coverage, observation.granularity, observation.quality]);
}

export async function storeCandle(candle: { assetId: string; interval: string; observedAt: string; open: number; high: number; low: number; close: number; volume?: number | null; sourceId: string }) {
  await pool.query(`insert into candles (asset_id, interval, observed_at, open, high, low, close, volume, source_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict (asset_id, interval, observed_at, source_id) do update set open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`,
    [candle.assetId, candle.interval, candle.observedAt, candle.open, candle.high, candle.low, candle.close, candle.volume ?? null, candle.sourceId]);
}

export async function storedCandles(assetId: string, interval = "daily", limit = 180) {
  const result = await pool.query(`select observed_at, open, high, low, close, volume from candles
    where asset_id=$1 and interval=$2 order by observed_at desc limit $3`, [assetId, interval, limit]);
  return result.rows.reverse().map(row => ({ observedAt: row.observed_at.toISOString(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume === null ? null : Number(row.volume) }));
}

export async function storedAssetSnapshots() {
  const result = await pool.query(`select a.id, a.symbol, a.name,
    (select value from observations o where o.asset_id=a.id and o.metric_code='price_usd' order by observed_at desc limit 1) as price_usd,
    (select value from observations o where o.asset_id=a.id and o.metric_code='market_cap_usd' order by observed_at desc limit 1) as market_cap_usd,
    (select value from observations o where o.asset_id=a.id and o.metric_code='fully_diluted_valuation_usd' order by observed_at desc limit 1) as fully_diluted_valuation_usd,
    (select value from observations o where o.asset_id=a.id and o.metric_code='volume_24h_usd' order by observed_at desc limit 1) as volume_24h_usd,
    (select value from observations o where o.asset_id=a.id and o.metric_code='circulating_supply' order by observed_at desc limit 1) as circulating_supply,
    (select value from observations o where o.asset_id=a.id and o.metric_code='total_supply' order by observed_at desc limit 1) as total_supply,
    (select value from observations o where o.asset_id=a.id and o.metric_code='max_supply' order by observed_at desc limit 1) as max_supply,
    (select max(observed_at) from observations o where o.asset_id=a.id) as observed_at
    from assets a where exists (select 1 from observations o where o.asset_id=a.id and o.metric_code='price_usd')
    order by market_cap_usd desc nulls last`);
  return result.rows;
}

export async function storedFundamentals(assetId: string) {
  const result = await pool.query(`select distinct on (metric_code) metric_code, value, unit, observed_at, coverage, quality
    from observations where asset_id=$1 and metric_code = any($2)
    order by metric_code, observed_at desc`, [assetId, ["tvl_usd", "fees_24h_usd", "revenue_24h_usd"]]);
  return result.rows.map(row => ({ metricCode: row.metric_code, value: Number(row.value), unit: row.unit,
    observedAt: row.observed_at.toISOString(), coverage: row.coverage, quality: row.quality }));
}

export async function closeDatabase() { await pool.end(); }
