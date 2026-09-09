import { databaseReady, storeObservation, storedFundamentals } from "./db.js";
import type { Asset } from "./market.js";
import { issuance, type Issuance } from "./issuance.js";

type Category =
  | "L1"
  | "L2"
  | "DEX"
  | "lending"
  | "stablecoin"
  | "exchange token";
type Scope = "chain" | "protocol" | "unavailable";
type MetricCode = "tvl_usd" | "fees_24h_usd" | "revenue_24h_usd";
export type Fundamental = {
  code: MetricCode;
  label: string;
  value: number | null;
  unit: "USD";
  scope: Scope;
  coverage: string;
  available: boolean;
};
export type Tokenomics = {
  circulatingPercent: number | null;
  nonCirculatingSupply: number | null;
  unlocks: { events: []; status: "unavailable"; note: string };
  emissions: Issuance;
};
export type Fundamentals = {
  category: Category;
  fundamentals: Fundamental[];
  tokenomics: Tokenomics;
  observedAt: string | null;
  stale: boolean;
};

const profiles: Record<
  string,
  { category: Category; scope: Scope; chain?: string; protocol?: string }
> = {
  bitcoin: { category: "L1", scope: "unavailable" },
  ethereum: { category: "L1", scope: "chain", chain: "Ethereum" },
  solana: { category: "L1", scope: "chain", chain: "Solana" },
  hyperliquid: {
    category: "exchange token",
    scope: "protocol",
    protocol: "hyperliquid",
  },
  arbitrum: { category: "L2", scope: "chain", chain: "Arbitrum" },
  optimism: { category: "L2", scope: "chain", chain: "Optimism" },
  uniswap: { category: "DEX", scope: "protocol", protocol: "uniswap" },
  aave: { category: "lending", scope: "protocol", protocol: "aave" },
  "usd-coin": { category: "stablecoin", scope: "unavailable" },
  tether: { category: "stablecoin", scope: "unavailable" },
};
const labels: Record<MetricCode, string> = {
  tvl_usd: "TVL",
  fees_24h_usd: "Fees (24h)",
  revenue_24h_usd: "Revenue (24h)",
};
const baseUrl = "https://api.llama.fi";
const sourceId = "defillama";
let cache = new Map<string, { createdAt: number; value: Fundamentals }>();

export function deriveTokenomics(
  asset: Pick<Asset, "id" | "circulatingSupply" | "maxSupply">,
): Tokenomics {
  const circulatingPercent =
    asset.circulatingSupply !== null && asset.maxSupply && asset.maxSupply > 0
      ? (asset.circulatingSupply / asset.maxSupply) * 100
      : null;
  const nonCirculatingSupply =
    asset.circulatingSupply !== null && asset.maxSupply !== null
      ? Math.max(asset.maxSupply - asset.circulatingSupply, 0)
      : null;
  return {
    circulatingPercent,
    nonCirculatingSupply,
    unlocks: {
      events: [],
      status: "unavailable",
      note: "No verified event-level unlock schedule is connected. Unverified third-party schedules are not stored as facts.",
    },
    emissions: { status: "unavailable", observedAt: null, source: "No live issuance adapter", note: "No verified live issuance source is connected for this asset.", metrics: [] },
  };
}
function emptyFundamentals(
  profile: { category: Category; scope: Scope },
  asset: Asset,
  note: string,
): Fundamentals {
  return {
    category: profile.category,
    fundamentals: (
      ["tvl_usd", "fees_24h_usd", "revenue_24h_usd"] as MetricCode[]
    ).map((code) => ({
      code,
      label: labels[code],
      value: null,
      unit: "USD",
      scope: profile.scope,
      coverage: note,
      available: false,
    })),
    tokenomics: deriveTokenomics(asset),
    observedAt: null,
    stale: true,
  };
}
async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`DefiLlama request failed: ${response.status}`);
  return response.json() as Promise<T>;
}
function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function fromStored(
  asset: Asset,
  profile: { category: Category; scope: Scope },
  rows: Awaited<ReturnType<typeof storedFundamentals>>,
): Fundamentals | null {
  if (!rows.length) return null;
  const byCode = new Map(rows.map((row) => [row.metricCode, row]));
  const observedAt = rows.reduce<string | null>(
    (latest, row) =>
      !latest || row.observedAt > latest ? row.observedAt : latest,
    null,
  );
  return {
    category: profile.category,
    fundamentals: (
      ["tvl_usd", "fees_24h_usd", "revenue_24h_usd"] as MetricCode[]
    ).map((code) => {
      const row = byCode.get(code);
      return {
        code,
        label: labels[code],
        value: row?.value ?? null,
        unit: "USD",
        scope: profile.scope,
        coverage: row?.coverage ?? "No stored coverage",
        available: Boolean(row),
      };
    }),
    tokenomics: deriveTokenomics(asset),
    observedAt,
    stale: true,
  };
}
async function persist(
  assetId: string,
  data: Fundamental[],
  observedAt: string,
) {
  if (!(await databaseReady())) return;
  await Promise.all(
    data
      .filter((metric) => metric.value !== null)
      .map((metric) =>
        storeObservation({
          assetId,
          metricCode: metric.code,
          value: metric.value!,
          unit: metric.unit,
          observedAt,
          sourceId,
          coverage: metric.coverage,
          granularity: "daily_snapshot",
          quality: "fresh",
        }),
      ),
  );
}
export async function fundamentals(
  assetId: string,
  asset?: Asset,
): Promise<Fundamentals> {
  const cached = cache.get(assetId);
  if (cached && Date.now() - cached.createdAt < 5 * 60_000) return cached.value;
  if (!asset)
    return {
      category: profiles[assetId]?.category ?? "L1",
      fundamentals: [],
      tokenomics: {
        circulatingPercent: null,
        nonCirculatingSupply: null,
        unlocks: {
          events: [],
          status: "unavailable",
          note: "Asset snapshot is unavailable.",
        },
        emissions: {
          status: "unavailable",
          observedAt: null,
          source: "No live issuance adapter",
          note: "Asset snapshot is unavailable.",
          metrics: [],
        },
      },
      observedAt: null,
      stale: true,
    };
  const profile = profiles[assetId] ?? {
    category: "L1" as const,
    scope: "unavailable" as const,
  };
  if (profile.scope === "unavailable") { const value = emptyFundamentals(
      profile,
      asset,
      "No protocol or chain metric is applicable to this asset profile.",
    ); return { ...value, tokenomics: { ...value.tokenomics, emissions: await issuance(asset.id) } }; }
  const coverage =
    profile.scope === "chain"
      ? `DefiLlama chain aggregate for ${profile.chain}; chain activity, not a token revenue metric.`
      : `DefiLlama protocol aggregate for ${asset.name}; methodology is provider-defined.`;
  try {
    const feePath =
      profile.scope === "chain"
        ? `/overview/fees/${encodeURIComponent(profile.chain!)}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`
        : `/summary/fees/${encodeURIComponent(profile.protocol!)}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`;
    const [fees, revenue, tvl] = await Promise.all([
      json<{ total24h?: number }>(feePath),
      json<{ total24h?: number }>(`${feePath}&dataType=dailyRevenue`),
      profile.scope === "chain"
        ? json<{ date: number; tvl: number }[]>(
            `/v2/historicalChainTvl/${encodeURIComponent(profile.chain!)}`,
          )
        : json<{ tvl?: { totalLiquidityUSD?: number }[] }>(
            `/protocol/${encodeURIComponent(profile.protocol!)}`,
          ),
    ]);
    const tvlValue = Array.isArray(tvl)
      ? number(tvl.at(-1)?.tvl)
      : number(tvl.tvl?.at(-1)?.totalLiquidityUSD);
    const metrics: Fundamental[] = [
      {
        code: "tvl_usd",
        label: labels.tvl_usd,
        value: tvlValue,
        unit: "USD",
        scope: profile.scope,
        coverage,
        available: tvlValue !== null,
      },
      {
        code: "fees_24h_usd",
        label: labels.fees_24h_usd,
        value: number(fees.total24h),
        unit: "USD",
        scope: profile.scope,
        coverage,
        available: number(fees.total24h) !== null,
      },
      {
        code: "revenue_24h_usd",
        label: labels.revenue_24h_usd,
        value: profile.scope === "protocol" ? number(revenue.total24h) : null,
        unit: "USD",
        scope: profile.scope,
        coverage:
          profile.scope === "protocol"
            ? coverage
            : "Not applicable: chain-level fees are not token revenue.",
        available:
          profile.scope === "protocol" && number(revenue.total24h) !== null,
      },
    ];
    const observedAt = new Date().toISOString();
    await persist(assetId, metrics, observedAt);
    const value = {
      category: profile.category,
      fundamentals: metrics,
      tokenomics: { ...deriveTokenomics(asset), emissions: await issuance(asset.id) },
      observedAt,
      stale: false,
    };
    const withIssuance = { ...value, tokenomics: { ...value.tokenomics, emissions: await issuance(asset.id) } }; cache.set(assetId, { createdAt: Date.now(), value: withIssuance }); return withIssuance;
  } catch {
    const stored = await storedFundamentals(assetId).catch(() => []);
    const value =
      fromStored(asset, profile, stored) ??
      emptyFundamentals(profile, asset, coverage);
    cache.set(assetId, { createdAt: Date.now(), value });
    return value;
  }
}
