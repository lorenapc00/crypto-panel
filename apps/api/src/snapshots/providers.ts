import type { DiscoveryJob, DiscoverySample } from '../discovery/providers.js';

export type Asset = {
  id: string; symbol: string; name: string; rank: number | null;
  priceUsd: number | null; marketCapUsd: number | null; fullyDilutedValuationUsd: number | null;
  volume24hUsd: number | null; circulatingSupply: number | null; totalSupply: number | null; maxSupply: number | null;
  change24h: number | null; change7d: number | null; change30d: number | null; observedAt: string | null;
};
export const marketDataset = 'coingecko:market:top100:v1';
export const globalDataset = 'coingecko:global:v1';
export type MetricCode = 'tvl_usd' | 'fees_24h_usd' | 'revenue_24h_usd';
export type FundamentalValue = { assetId: string; code: MetricCode; value: number | null; scope: 'chain' | 'protocol'; coverage: string; observedAt: string | null };
export const fundamentalDataset = (asset: string, code: MetricCode) => `defillama:${asset}:${code}:snapshot:v1`;
export const issuanceDataset = (asset: string) => asset === 'bitcoin' ? 'mempool:bitcoin:tip:v1' : 'solana-rpc:solana:inflation:v1';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected provider object');
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing provider identity');
  return value;
}
function numeric(value: unknown, signed = false): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || (!signed && value < 0)) throw new Error('Invalid provider number');
  return value;
}
function integer(value: unknown): number | null {
  const number = numeric(value);
  if (number !== null && !Number.isSafeInteger(number)) throw new Error('Invalid provider integer');
  return number;
}
function timestamp(value: unknown, receivedAt: string, seconds = false): string | null {
  if (value == null) return null;
  const time = seconds ? (numeric(value) ?? NaN) * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time < 0 || time > Date.parse(receivedAt)) throw new Error('Invalid provider timestamp');
  return new Date(time).toISOString();
}
function single(key: string, data: Record<string, unknown>, notes: Record<string, unknown> = {}): DiscoverySample {
  return { members: [{ key, status: 'observed', data }], notes };
}

export function parseMarkets(payload: unknown, receivedAt = new Date().toISOString()): DiscoverySample {
  if (!Array.isArray(payload) || !payload.length || payload.length > 100) throw new Error('Invalid top-100 market page');
  const members = payload.map(value => {
    const row = object(value);
    if (!('current_price' in row) || !('market_cap' in row)) throw new Error('Missing market metrics');
    const data: Asset = {
      id: identity(row.id), symbol: identity(row.symbol).toUpperCase(), name: identity(row.name), rank: integer(row.market_cap_rank),
      priceUsd: numeric(row.current_price), marketCapUsd: numeric(row.market_cap), fullyDilutedValuationUsd: numeric(row.fully_diluted_valuation),
      volume24hUsd: numeric(row.total_volume), circulatingSupply: numeric(row.circulating_supply),
      totalSupply: numeric(row.total_supply), maxSupply: numeric(row.max_supply),
      change24h: numeric(row.price_change_percentage_24h, true), change7d: numeric(row.price_change_percentage_7d_in_currency, true),
      change30d: numeric(row.price_change_percentage_30d_in_currency, true), observedAt: timestamp(row.last_updated, receivedAt),
    };
    if (data.rank === 0) throw new Error('Invalid market rank');
    return { key: data.id, status: 'observed' as const, data };
  });
  if (new Set(members.map(row => row.key)).size !== members.length) throw new Error('Duplicate market identity');
  return { members, notes: { requestedPage: 1, requestedPageSize: 100, returnedAssets: members.length,
    completePage: members.length === 100, scope: 'CoinGecko rank-selected first page, up to 100 assets; not global',
    timestampMeaning: 'Asset observedAt is provider last_updated; snapshot observedAt is acquisition receipt',
    missingValues: 'Unknown values remain null; absence from this page is not delisting' } };
}

export function parseGlobal(payload: unknown, receivedAt = new Date().toISOString()): DiscoverySample {
  const row = object(object(payload).data);
  const cap = object(row.total_market_cap), volume = object(row.total_volume), dominance = object(row.market_cap_percentage);
  if (!('usd' in cap) || !('usd' in volume)) throw new Error('Missing global USD metrics');
  const percent = (value: unknown) => {
    const result = numeric(value);
    if (result !== null && result > 100) throw new Error('Invalid dominance');
    return result;
  };
  return single('global', { globalMarketCapUsd: numeric(cap.usd), volume24hUsd: numeric(volume.usd),
    btcDominance: percent(dominance.btc), ethDominance: percent(dominance.eth),
    observedAt: timestamp(row.updated_at, receivedAt, true) }, { scope: 'CoinGecko provider global coverage; USD',
    definition: 'Provider total market cap, reported rolling 24h volume and provider market-cap percentages' });
}

// Only the individually probed ETH/SOL chain feeds and Hyperliquid protocol
// feeds are enabled. A taxonomy label is not proof of fundamental coverage.
export const fundamentalProfiles = [
  { asset: 'ethereum', scope: 'chain' as const, name: 'Ethereum' },
  { asset: 'solana', scope: 'chain' as const, name: 'Solana' },
  { asset: 'hyperliquid', scope: 'protocol' as const, name: 'hyperliquid' },
];
export function parseFundamental(payload: unknown, profile: typeof fundamentalProfiles[number], code: MetricCode, receivedAt = new Date().toISOString()): DiscoverySample {
  let value: number | null, observedAt: string | null = null;
  if (code === 'tvl_usd') {
    const rows = profile.scope === 'chain' ? payload : object(payload).tvl;
    if (!Array.isArray(rows) || !rows.length) throw new Error('Missing TVL history');
    let previous = -Infinity;
    const points = rows.map(value => {
      const row = object(value), time = timestamp(row.date, receivedAt, true);
      if (!time || Date.parse(time) <= previous) throw new Error('Invalid TVL history order');
      previous = Date.parse(time);
      const field = profile.scope === 'chain' ? 'tvl' : 'totalLiquidityUSD';
      if (!(field in row)) throw new Error('Missing TVL value');
      return { value: numeric(row[field]), time };
    });
    const last = points.at(-1)!;
    value = last.value; observedAt = last.time;
  } else {
    const row = object(payload);
    if (!('total24h' in row) || 'error' in row) throw new Error('Missing fundamental summary');
    value = numeric(row.total24h);
    // total24h has no verified publication timestamp. Receipt is retained
    // independently instead of being passed off as a provider observation.
  }
  const coverage = profile.scope === 'chain'
    ? `DefiLlama protocols on ${profile.name}; chain-scoped activity, not native-token revenue or base-chain transaction fees`
    : 'DefiLlama Hyperliquid protocol; retained revenue is not automatically token-holder income';
  return single(`${profile.asset}:${code}`, { assetId: profile.asset, code, value, scope: profile.scope, coverage, observedAt },
    { definition: code === 'tvl_usd' ? 'Latest provider TVL observation; not net flows' : 'Provider total24h summary; publication time unknown',
      history: 'Raw provider history retained as provenance; normalized fundamental histories remain pending' });
}

export function parseBitcoinTip(payload: unknown): DiscoverySample {
  const height = integer(payload);
  if (height === null) throw new Error('Missing Bitcoin tip height');
  const era = Math.floor(height / 210000);
  // Bitcoin subsidy is an integer number of satoshis, halved by a right shift.
  const subsidySatoshis = era >= 64 ? 0n : 5000000000n >> BigInt(era);
  return single('bitcoin', { height, era, subsidyBtc: Number(subsidySatoshis) / 1e8, nextHalvingBlock: (era + 1) * 210000 },
    { definition: 'Subsidy era derived from observed tip height; not realized net issuance' });
}
export function parseSolanaInflation(payload: unknown): DiscoverySample {
  const row = object(payload);
  if (row.jsonrpc !== '2.0' || row.id !== 1 || row.error != null) throw new Error('Invalid Solana RPC result');
  const result = object(row.result), total = numeric(result.total), epoch = integer(result.epoch);
  if (total === null || epoch === null) throw new Error('Missing Solana inflation parameter');
  return single('solana', { total, epoch }, { definition: 'Observed annualized protocol inflation parameter; not realized net issuance' });
}

export const snapshotJobs: DiscoveryJob[] = [
  { id: marketDataset, provider: 'coingecko', kind: 'market', scope: 'CoinGecko first 100 rank-selected assets; USD',
    intervalSeconds: 3600, membership: 'catalog', weight: 1, methodologyVersion: 'market-snapshot:v1',
    endpoint: 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h,7d,30d', parse: parseMarkets },
  { id: globalDataset, provider: 'coingecko', kind: 'global', scope: 'CoinGecko provider global coverage; USD',
    intervalSeconds: 3600, membership: 'sample', weight: 1, methodologyVersion: 'global-snapshot:v1',
    endpoint: 'https://api.coingecko.com/api/v3/global', parse: parseGlobal },
  ...fundamentalProfiles.flatMap(profile => (['tvl_usd', 'fees_24h_usd', ...(profile.scope === 'protocol' ? ['revenue_24h_usd'] : [])] as MetricCode[]).map(code => {
    const path = code === 'tvl_usd'
      ? profile.scope === 'chain' ? `/v2/historicalChainTvl/${profile.name}` : `/protocol/${profile.name}`
      : `/${profile.scope === 'chain' ? 'overview' : 'summary'}/fees/${profile.name}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true${code === 'revenue_24h_usd' ? '&dataType=dailyRevenue' : ''}`;
    return { id: fundamentalDataset(profile.asset, code), provider: 'defillama', kind: 'fundamental' as const,
      scope: `${profile.scope}:${profile.name}:${code}`, intervalSeconds: 86400, membership: 'sample' as const, weight: 1,
      methodologyVersion: 'fundamental-snapshot:v1', endpoint: `https://api.llama.fi${path}`,
      parse: (payload: unknown, receivedAt?: string) => parseFundamental(payload, profile, code, receivedAt) };
  })),
  { id: issuanceDataset('bitcoin'), provider: 'mempool', kind: 'issuance', scope: 'Bitcoin observed tip and subsidy era',
    intervalSeconds: 3600, membership: 'sample', weight: 1, methodologyVersion: 'issuance-snapshot:v1',
    endpoint: 'https://mempool.space/api/blocks/tip/height', parse: parseBitcoinTip },
  { id: issuanceDataset('solana'), provider: 'solana-rpc', kind: 'issuance', scope: 'Solana observed inflation parameter',
    intervalSeconds: 3600, membership: 'sample', weight: 1, methodologyVersion: 'issuance-snapshot:v1',
    endpoint: 'https://api.mainnet-beta.solana.com', body: { jsonrpc: '2.0', id: 1, method: 'getInflationRate', params: [] }, parse: parseSolanaInflation },
];
