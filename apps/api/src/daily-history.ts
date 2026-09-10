import type { Pool } from "pg";
import { pool } from "./db.js";
import { archivePayload, readSeries, type SeriesDefinition, type SeriesPoint } from "./archive.js";
import { meteredFetch } from './requests.js';

export const DAY_MS = 86_400_000;
export const dailySeriesId = (assetId: string, metricCode = "price_usd") => `coingecko:${assetId}:${metricCode}:daily-sample:v1`;

// CoinGecko publishes the last completed UTC close ten minutes after midnight.
export function expectedDailyTime(now = Date.now()) {
  const midnight = Math.floor(now / DAY_MS) * DAY_MS;
  return now - midnight < 10 * 60_000 ? midnight - DAY_MS : midnight;
}

export function parseDailyChart(payload: unknown, now = Date.now()) {
  if (!payload || typeof payload !== "object") throw new Error("Invalid daily chart response");
  const chart = payload as { prices?: unknown; total_volumes?: unknown };
  const parse = (rows: unknown): SeriesPoint[] => {
    if (!Array.isArray(rows)) throw new Error("Missing daily chart series");
    let previous = -Infinity;
    const result: SeriesPoint[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < 0 || row[0] <= previous || row[0] > now) throw new Error("Invalid or unordered chart timestamp");
      const [time, value] = row;
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error("Invalid daily chart value");
      previous = time;
      if (time > expectedDailyTime(now)) continue; // Live tail is not a completed daily point.
      if (time % DAY_MS !== 0) throw new Error("Chart spacing is not daily UTC; refusing to relabel it");
      result.push({ observedAt: new Date(time).toISOString(), value });
    }
    if (result.length > 1 && !result.some((point, index) => index > 0 && Date.parse(point.observedAt) - Date.parse(result[index - 1].observedAt) === DAY_MS)) throw new Error("Daily granularity could not be verified");
    return result;
  };
  const prices = parse(chart.prices);
  if (!prices.some(point => point.value !== null)) throw new Error("No completed daily prices in response");
  return { prices, volumes: parse(chart.total_volumes) };
}

export async function dailyHistory(assetId: string, now = Date.now(), database: Pool = pool) {
  const series = await readSeries(dailySeriesId(assetId), {}, database);
  return describeDailyHistory(series, now);
}

// Profiles can still show snapshots when the archive is offline. Ingestion keeps
// using the strict reader above so database failures never trigger a backfill.
export async function profileDailyHistory(assetId: string, now = Date.now(), database: Pool = pool) {
  try {
    return await dailyHistory(assetId, now, database);
  } catch (error) {
    console.error(`Daily price archive unavailable for ${assetId}:`, error);
    return describeDailyHistory(null, now, true);
  }
}

function describeDailyHistory(series: Awaited<ReturnType<typeof readSeries>>, now: number, unavailable = false) {
  const points = series?.points ?? [];
  const usable = points.filter(point => point.value !== null);
  const last = usable.at(-1)?.observedAt ?? null;
  let missingIntervals = points.filter(point => point.value === null).length;
  for (let i = 1; i < points.length; i++) missingIntervals += Math.max(0, Math.round((Date.parse(points[i].observedAt) - Date.parse(points[i - 1].observedAt)) / DAY_MS) - 1);
  if (points.length) missingIntervals += Math.max(0, Math.floor((expectedDailyTime(now) - Date.parse(points.at(-1)!.observedAt)) / DAY_MS));
  return {
    points: points.map(point => ({ observedAt: point.observedAt, close: point.value })),
    metadata: { source: "CoinGecko", observedAt: last, coverage: unavailable ? "Stored daily price history is temporarily unavailable" : "Completed daily USD price samples; historical reconstruction", stale: last === null || Date.parse(last) < expectedDailyTime(now), unavailable, missingIntervals, intervalSeconds: DAY_MS / 1000, methodologyVersion: "daily-sample:v1", replayCoverageStart: series?.metadata.replayCoverageStart ?? null, classification: "historical-reconstruction" as const },
  };
}

export async function ingestDailyHistory(assetId: string, options: { force?: boolean; database?: Pool; fetchImpl?: typeof fetch } = {}) {
  const database = options.database ?? pool;
  const existing = await dailyHistory(assetId, Date.now(), database);
  if (!options.force && !existing.metadata.stale) return { refreshed: false, inserted: 0 };
  const endpoint = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(assetId)}/market_chart?vs_currency=usd&days=365&interval=daily`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.COINGECKO_DEMO_API_KEY) headers["x-cg-demo-api-key"] = process.env.COINGECKO_DEMO_API_KEY;
  const { response,requestedAt,requestId } = await meteredFetch('coingecko',endpoint,{headers},{database,fetchImpl:options.fetchImpl});
  if (!response.ok) throw new Error(`Daily history request failed: HTTP ${response.status}`);
  const rawPayload = await response.text();
  const receivedAt = new Date().toISOString();
  const parsed = parseDailyChart(JSON.parse(rawPayload));
  const definition = (metricCode: string): SeriesDefinition => ({ id: dailySeriesId(assetId, metricCode), assetId, metricCode, sourceId: "coingecko", scope: "asset", unit: "USD", intervalSeconds: 86400, methodologyVersion: "daily-sample:v1" });
  const result = await archivePayload({ sourceId: "coingecko", endpoint, requestedAt, receivedAt, rawPayload, series: [
    { definition: definition("price_usd"), points: parsed.prices },
    { definition: definition("volume_24h_usd"), points: parsed.volumes },
  ] }, database);
  await database.query('update worker_requests set payload_id=$2 where id=$1',[requestId,result.payloadId]);
  return { refreshed: true, inserted: result.inserted };
}
