import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { assetDetails, marketData, metadata } from "./market.js";

type Asset = Awaited<ReturnType<typeof marketData>>["assets"][number];
const sessions = new Map<string, { email: string; watchlist: Set<string> }>();
const guestSession = { email: "demo@cryptopanel.local", watchlist: new Set<string>() };
const port = Number(process.env.PORT ?? 3100);

function send(res: any, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}
function body(req: any): Promise<any> { return new Promise(resolve => { let value = ""; req.on("data", (chunk: Buffer) => value += chunk); req.on("end", () => { try { resolve(JSON.parse(value || "{}")); } catch { resolve({}); } }); }); }
function globalOverview(assets: Asset[]) {
  const totalCap = assets.reduce((sum, asset) => sum + asset.marketCapUsd, 0);
  const volume = assets.reduce((sum, asset) => sum + asset.volume24hUsd, 0);
  const btc = assets.find(asset => asset.id === "bitcoin"); const eth = assets.find(asset => asset.id === "ethereum");
  return { globalMarketCapUsd: totalCap, volume24hUsd: volume, btcDominance: btc ? btc.marketCapUsd / totalCap * 100 : null, ethDominance: eth ? eth.marketCapUsd / totalCap * 100 : null, movers: assets.slice(0, 10), marketBreadth: { advancing: assets.filter(asset => asset.change24h > 0).length, declining: assets.filter(asset => asset.change24h < 0).length } };
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && url.pathname === "/api/v1/auth/dev-session") {
    const requestBody = await body(req); const token = randomUUID(); sessions.set(token, { email: requestBody.email ?? "demo@cryptopanel.local", watchlist: new Set() });
    return send(res, 200, { token, expiresAt: new Date(Date.now() + 2_592e6).toISOString() });
  }
  if (!url.pathname.startsWith("/api/v1/") || url.pathname.startsWith("/api/v1/auth/")) return send(res, 404, { error: "Not found" });
  const token = req.headers.authorization?.replace("Bearer ", ""); const session = sessions.get(token ?? "") ?? guestSession;
  try {
    if (url.pathname === "/api/v1/overview") { const snapshot = await marketData(); return send(res, 200, { data: globalOverview(snapshot.assets), metadata: metadata(snapshot.observedAt, snapshot.stale) }); }
    if (url.pathname === "/api/v1/assets") { const snapshot = await marketData(); return send(res, 200, { data: snapshot.assets, metadata: metadata(snapshot.observedAt, snapshot.stale) }); }
    const detail = url.pathname.match(/^\/api\/v1\/assets\/([^/]+)$/);
    if (detail) { const result = await assetDetails(decodeURIComponent(detail[1])); return result ? send(res, 200, { data: result, metadata: metadata(result.asset.observedAt, result.stale) }) : send(res, 404, { error: "Asset not found" }); }
    if (url.pathname === "/api/v1/watchlist") { const snapshot = await marketData(); return send(res, 200, { data: snapshot.assets.filter(asset => session.watchlist.has(asset.id)), metadata: metadata(snapshot.observedAt, snapshot.stale) }); }
    const watchlist = url.pathname.match(/^\/api\/v1\/watchlist\/([^/]+)$/);
    if (watchlist) { if (req.method === "PUT") session.watchlist.add(watchlist[1]); if (req.method === "DELETE") session.watchlist.delete(watchlist[1]); return send(res, 204, {}); }
    if (url.pathname.startsWith("/api/v1/analytics/")) {
      const details = { derivatives: ["Binance public futures API", "Binance-supported perpetual pairs only; not market-wide"], chains: ["DefiLlama", "Chain-level TVL, stablecoin market cap and DEX volume; not token-level facts"], "etf-flows": ["Published BTC/ETH ETF-flow table", "BTC/ETH daily flows; last successful value retained as stale"] }[url.pathname.split("/").pop() ?? ""];
      return send(res, 200, { data: [], metadata: { source: details?.[0], coverage: details?.[1], observedAt: null, stale: true, unavailable: true } });
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) { console.error(error); return send(res, 503, { error: "Market data is temporarily unavailable." }); }
}).listen(port, "127.0.0.1", () => console.log(`Crypto Panel API on :${port}`));
