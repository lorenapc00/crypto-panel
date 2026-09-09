export type Issuance = { status: "live" | "unavailable"; observedAt: string | null; source: string; note: string; metrics: { label: string; value: string }[] };

export async function issuance(assetId: string): Promise<Issuance> {
  if (assetId === "bitcoin") return bitcoinIssuance();
  if (assetId === "solana") return solanaIssuance();
  return { status: "unavailable", observedAt: null, source: "No live issuance adapter", note: "No verified live issuance source is connected for this asset.", metrics: [] };
}
async function bitcoinIssuance(): Promise<Issuance> {
  try { const response = await fetch("https://mempool.space/api/blocks/tip/height"); const height = Number(await response.text()); if (!response.ok || !Number.isInteger(height)) throw new Error(); const era = Math.floor(height / 210_000); return { status: "live", observedAt: new Date().toISOString(), source: "mempool.space", note: "Calculated from observed tip height.", metrics: [{ label: "Tip height", value: height.toLocaleString("en-US") }, { label: "Block subsidy", value: `${50 / 2 ** era} BTC` }, { label: "Next halving block", value: ((era + 1) * 210_000).toLocaleString("en-US") }] }; } catch { return { status: "unavailable", observedAt: null, source: "mempool.space", note: "Bitcoin tip height is temporarily unavailable.", metrics: [] }; }
}
async function solanaIssuance(): Promise<Issuance> {
  try { const response = await fetch("https://api.mainnet-beta.solana.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getInflationRate", params: [] }) }); const payload = await response.json() as { result?: { epoch?: number; total?: number } }; if (!response.ok || typeof payload.result?.total !== "number") throw new Error(); return { status: "live", observedAt: new Date().toISOString(), source: "Solana mainnet RPC", note: "Live annual inflation rate reported by the chain.", metrics: [{ label: "Epoch", value: String(payload.result.epoch ?? "—") }, { label: "Annual inflation", value: `${(payload.result.total * 100).toFixed(2)}%` }] }; } catch { return { status: "unavailable", observedAt: null, source: "Solana mainnet RPC", note: "Solana inflation rate is temporarily unavailable.", metrics: [] }; }
}
