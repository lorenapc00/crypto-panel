import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { InputError, id } from "./research/validation.js";
import { send, authorize, cutoff } from "./http.js";
import { researchRoute } from "./research/routes.js";
import { btcRoute } from "./btc/routes.js";
import { readSeries } from "./archive.js";
import { assetDetails, marketData, marketOverview } from "./market.js";
import { fundamentals } from "./fundamentals.js";
import { pool, storedTokenomicsEvents } from "./db.js";
import { dataHealth, readDiscovery } from "./discovery/archive.js";
import { ReplayCoverageError } from "./archive.js";

const port = Number(process.env.PORT ?? 3100);
export function apiServer(database: Pool = pool) {
return createServer({requestTimeout:15000,headersTimeout:10000},async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    authorize(req);
    if (url.pathname === '/api/v1/auth/dev-session') return send(res,410,{error:'Development sessions have been removed; this is one persistent personal workspace'});
    if (!url.pathname.startsWith('/api/v1/')) return send(res,404,{error:'Not found'});
    if (await researchRoute(database,req,res,url)) return;
    if (await btcRoute(database,req,res,url)) return;
    if (req.method !== 'GET') return send(res,405,{error:'Method not allowed'});
    if (url.pathname === '/api/v1/series') {
      const assetId=url.searchParams.get('asset'),metric=url.searchParams.get('metric'),interval=url.searchParams.get('interval');
      if (!assetId||!metric) throw new InputError('Asset and metric are required');
      id(assetId);id(metric);
      if(interval!==null&&(!/^\d+$/.test(interval)||Number(interval)<1||Number(interval)>2147483647))throw new InputError("Invalid interval");
      const seriesId=url.searchParams.get('seriesId');
      const definitions=(await database.query(`select id from data_series where asset_id=$1 and metric_code=$2
        and ($3::text is null or interval_seconds=$3::integer) and ($4::text is null or id=$4) order by id`,[assetId,metric,interval,seriesId])).rows;
      const options={from:cutoff(url.searchParams.get('from')),to:cutoff(url.searchParams.get('to')),
        asOf:cutoff(url.searchParams.get('asOf')),limit:10000};
      if(options.from&&options.to&&Date.parse(options.from)>Date.parse(options.to))throw new InputError('Invalid series date range');
      return send(res,200,{data:await Promise.all(definitions.map(row=>readSeries(row.id,options,database)))});
    }
    if (req.method === "GET" && url.pathname === "/api/v1/data-health") return send(res, 200, { data: await dataHealth(database) });
    if (req.method === "GET" && url.pathname === "/api/v1/discovery/archive") {
      const dataset = url.searchParams.get("dataset");
      if (!dataset) return send(res, 400, { error: "A dataset identifier is required" });
      const asOf = cutoff(url.searchParams.get("asOf"));
      if (asOf !== undefined && (!asOf || !Number.isFinite(Date.parse(asOf)))) return send(res, 400, { error: "Invalid replay cutoff" });
      try {
        const data = await readDiscovery(database, dataset, asOf);
        return send(res, data ? 200 : 404, data ?? { error: "Dataset not found" });
      } catch (error) {
        if (error instanceof ReplayCoverageError) return send(res, 409, { error: error.message });
        if (error instanceof Error && error.message === "Replay cutoff cannot be in the future") return send(res, 400, { error: error.message });
        throw error;
      }
    }
    const asOf = cutoff(url.searchParams.get("asOf"));
    if (asOf !== undefined && (!asOf || !Number.isFinite(Date.parse(asOf)))) return send(res, 400, { error: "Invalid replay cutoff" });
    if (asOf && !["/api/v1/assets", "/api/v1/overview"].includes(url.pathname)) return send(res, 400, { error: "Replay is not supported on this route" });
    if (url.pathname === "/api/v1/overview") return send(res, 200, await marketOverview(database, asOf));
    if (url.pathname === "/api/v1/assets") { const snapshot = await marketData(database, asOf); return send(res, 200, { data: snapshot.assets, metadata: snapshot.metadata }); }
    const detail = url.pathname.match(/^\/api\/v1\/assets\/([^/]+)$/);
    if (detail) { const result = await assetDetails(decodeURIComponent(detail[1]), database); if (!result) return send(res, 404, { error: "Asset not found" }); const data = { ...result, fundamentals: await fundamentals(result.asset.id, result.asset, database), tokenomicsEvents: await storedTokenomicsEvents(result.asset.id, database).catch(() => []) }; return send(res, 200, { data, metadata: result.metadata }); }
    if (url.pathname === '/api/v1/watchlist') {
      const rows=(await database.query(`select a.*,m.data from research_watchlist w join assets a on a.id=w.asset_id
        left join lateral (select data from discovery_members where dataset_id='coingecko:market:top100:v1' and entity_key=w.asset_id order by snapshot_id desc limit 1) m on true
        order by w.created_at,w.asset_id`)).rows;
      const snapshot=await marketData(database);
      return send(res,200,{data:rows.map(row=>row.data??{id:row.id,symbol:row.symbol,name:row.name,rank:null,priceUsd:null,marketCapUsd:null,fullyDilutedValuationUsd:null,
        volume24hUsd:null,circulatingSupply:null,totalSupply:null,maxSupply:null,change24h:null,change7d:null,change30d:null,observedAt:null}),
        metadata:{...snapshot.metadata,coverage:'Persistent personal watchlist; former tracked assets retain their last archived observation',
          stale:snapshot.stale||rows.some(row=>!row.data?.observedAt||Date.now()-Date.parse(row.data.observedAt)>3600000)}});
    }
    if (url.pathname.startsWith("/api/v1/analytics/")) {
      const details = { derivatives: ["Binance public futures API", "Binance-supported perpetual pairs only; not market-wide"], chains: ["DefiLlama", "Chain-level TVL, stablecoin market cap and DEX volume; not token-level facts"], "etf-flows": ["Published BTC/ETH ETF-flow table", "BTC/ETH daily flows; last successful value retained as stale"] }[url.pathname.split("/").pop() ?? ""];
      return send(res, 200, { data: [], metadata: { source: details?.[0], coverage: details?.[1], observedAt: null, stale: true, unavailable: true } });
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof InputError) return send(res,error.status,{error:error.message});
    if (error instanceof ReplayCoverageError) return send(res, 409, { error: error.message });
    if (error instanceof Error && error.message === "Replay cutoff cannot be in the future") return send(res, 400, { error: error.message });
    console.error(error); return send(res, 503, { error: "Market data is temporarily unavailable." }); }
});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  apiServer().listen(port, process.env.API_HOST ?? "127.0.0.1", () => console.log(`Crypto Panel API on :${port}`));
}
