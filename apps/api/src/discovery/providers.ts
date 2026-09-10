import type { ArchiveInput } from '../archive.js';
export type Member = { key: string; status: 'observed' | 'active' | 'delisted'; data: Record<string, unknown> };
export type DiscoverySample = { members: Member[]; notes: Record<string, unknown>; series?: ArchiveInput['series']; assets?: {id:string;symbol:string;name:string}[] };
export type DiscoveryJob = {
  id: string; provider: string; kind: 'protocols' | 'namespaces' | 'instruments' | 'pools' | 'market' | 'global' | 'fundamental' | 'issuance' | 'history' | 'book' | 'funding' | 'enrichment';
  scope: string; intervalSeconds: number; membership: 'catalog' | 'sample';
  endpoint: string; body?: Record<string, unknown>; weight: number;
  methodologyVersion?: string;
  offsetSeconds?: number;
  request?: (database: import('pg').Pool) => Promise<{endpoint:string;body?:Record<string,unknown>;parse?:DiscoveryJob['parse']} | null>;
  parse: (payload: unknown, receivedAt?: string) => DiscoverySample;
};

// The stage 0 budget covers these eleven namespaces. New ones are archived in
// the catalog and reported as uncovered until the acquisition budget is reviewed.
export const coveredNamespaces = ['', 'xyz', 'flx', 'vntl', 'hyna', 'km', 'abcd', 'cash', 'para', 'mkts', 'io'];
const key = (...parts: string[]) => JSON.stringify(parts);
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected provider object');
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing provider identity');
  return value;
}
function optionalString(value: unknown) { return value == null || value === '' ? null : string(value); }
function numeric(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value))) throw new Error('Invalid provider number');
  return Number(value);
}
function array(value: unknown): any[] {
  if (!Array.isArray(value)) throw new Error('Expected provider array');
  return value;
}
function sample(members: Member[], notes: Record<string, unknown>): DiscoverySample {
  if (new Set(members.map(member => member.key)).size !== members.length) throw new Error('Duplicate provider identity');
  return { members, notes };
}

export function parseNamespaces(payload: unknown): DiscoverySample {
  const rows = array(payload);
  if (rows[0] !== null || rows.slice(1).some(row => row == null)) throw new Error('Invalid native namespace marker');
  const names = rows.map((row, index) => index === 0 ? '' : string(object(row).name));
  return sample(names.map((name, index) => ({ key: key('hyperliquid', name), status: 'observed', data: { venue: 'hyperliquid', namespace: name, index, metadata: rows[index] } })), {
    coveredNamespaces, uncoveredNamespaces: names.filter(name => !coveredNamespaces.includes(name)),
    missingConfiguredNamespaces: coveredNamespaces.filter(name => !names.includes(name)),
    lifecycle: 'Catalog observation is not a venue launch date',
  });
}

export function parseInstruments(payload: unknown, namespace: string): DiscoverySample {
  const response = array(payload);
  if (response.length !== 2) throw new Error('Invalid metadata/context response');
  const metadata = object(response[0]);
  const universe = array(metadata.universe);
  const contexts = array(response[1]);
  if (universe.length !== contexts.length) throw new Error('Metadata/context arrays do not align');
  return sample(universe.map((value, index) => {
    const instrument = object(value), context = object(contexts[index]);
    const name = string(instrument.name);
    if (namespace ? !name.startsWith(`${namespace}:`) : name.includes(':')) throw new Error('Instrument namespace mismatch');
    if (instrument.isDelisted != null && typeof instrument.isDelisted !== 'boolean') throw new Error('Invalid delisting flag');
    const oi = numeric(context.openInterest), mark = numeric(context.markPx);
    if (oi != null && oi < 0 || mark != null && mark < 0) throw new Error('Negative OI or price');
    const impact = context.impactPxs == null ? null : array(context.impactPxs).map(numeric);
    if (impact && impact.length !== 2) throw new Error('Invalid impact prices');
    return { key: key('hyperliquid', namespace, name), status: instrument.isDelisted ? 'delisted' : 'active', data: {
      venue: 'hyperliquid', namespace, name, index, contract: instrument,
      collateralTokenIndex: numeric(metadata.collateralToken), underlyingAssetId: null, assetClass: 'unknown',
      openInterestNative: oi, openInterestUnit: 'underlying units', markPrice: mark,
      estimatedOpenInterestQuote: oi == null || mark == null ? null : numeric(oi * mark),
      quoteCurrency: 'unresolved', notionalMethod: 'native OI × mark price; no USD conversion',
      fundingRate: numeric(context.funding), fundingIntervalSeconds: 3600,
      reported24hNotionalVolume: numeric(context.dayNtlVlm), impactPrices: impact,
      orderBook: null, tradingStartedAt: null, context,
    } };
  }), { venue: 'hyperliquid', namespace, membership: 'Returned catalog only; absence is not proof of delisting',
    publicationTime: 'unknown', funding: 'Current rate sample; not settled funding history',
    liquidity: 'Impact prices are provider samples, not executable depth', marginTables: metadata.marginTables ?? null });
}

export function parseProtocols(payload: unknown): DiscoverySample {
  const rows = array(payload);
  if (!rows.length) throw new Error('Empty protocol catalog requires verification');
  return sample(rows.map(value => {
    const row = object(value), id = string(row.id), slug = string(row.slug);
    return { key: key('defillama', id), status: 'observed', data: {
      protocolId: id, slug, name: string(row.name), category: optionalString(row.category),
      chains: array(row.chains).map(string), geckoId: optionalString(row.gecko_id),
      tokenStage: 'unknown', tokenLaunchAt: null, tvlUsd: numeric(row.tvl),
      tvlScope: 'Provider protocol catalog; no inference of token value capture',
    } };
  }), { coverage: 'DefiLlama returned protocol catalog', tokenLinks: 'Missing gecko_id does not establish pre-token status' });
}

export function parsePools(payload: unknown, chain: 'solana' | 'base'): DiscoverySample {
  const rows = array(object(payload).data);
  if (rows.length > 20) throw new Error('Pool page exceeds the verified 20-pool sample');
  const canonical = (address: string) => chain === 'base' ? address.toLowerCase() : address;
  const tokenAddress = (relation: unknown) => {
    const id = string(object(object(relation).data).id);
    if (!id.startsWith(`${chain}_`)) throw new Error('Token chain mismatch');
    return canonical(string(id.slice(chain.length + 1)));
  };
  return sample(rows.map(value => {
    const row = object(value), attrs = object(row.attributes), relations = object(row.relationships);
    const address = canonical(string(attrs.address));
    if (canonical(string(row.id)) !== `${chain}_${address}`) throw new Error('Pool identity mismatch');
    const createdAt = optionalString(attrs.pool_created_at);
    if (createdAt && !Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid pool creation time');
    return { key: key(chain, address), status: 'observed', data: {
      chain, poolAddress: address, baseTokenAddress: tokenAddress(relations.base_token),
      quoteTokenAddress: tokenAddress(relations.quote_token), name: optionalString(attrs.name),
      providerPoolCreatedAt: createdAt, tokenLaunchAt: null, liquidityUsd: numeric(attrs.reserve_in_usd),
      reported24hVolumeUsd: numeric(attrs.volume_usd?.h24), transactions: attrs.transactions ?? null,
      contractRisk: 'unknown', tokenAge: 'unknown',
    } };
  }), { chain, page: 1, maximumPools: 20, exhaustive: false,
    lifecycle: 'Pool creation does not establish token launch; sample disappearance is not closure' });
}

export const discoveryJobs: DiscoveryJob[] = [
  { id: 'defillama:protocols:v1', provider: 'defillama', kind: 'protocols', scope: 'DefiLlama protocol catalog', intervalSeconds: 86400, membership: 'catalog', endpoint: 'https://api.llama.fi/protocols', weight: 1, parse: parseProtocols },
  { id: 'hyperliquid:namespaces:v1', provider: 'hyperliquid', kind: 'namespaces', scope: 'Hyperliquid perp DEX namespaces', intervalSeconds: 3600, membership: 'catalog', endpoint: 'https://api.hyperliquid.xyz/info', body: { type: 'perpDexs' }, weight: 20, parse: parseNamespaces },
  ...coveredNamespaces.map(namespace => ({ id: `hyperliquid:instruments:${namespace || 'native'}:v1`, provider: 'hyperliquid', kind: 'instruments' as const, scope: `Hyperliquid namespace ${JSON.stringify(namespace)}`, intervalSeconds: 3600, membership: 'catalog' as const, endpoint: 'https://api.hyperliquid.xyz/info', body: { type: 'metaAndAssetCtxs', dex: namespace }, weight: 20, parse: (payload: unknown) => parseInstruments(payload, namespace) })),
  ...(['solana', 'base'] as const).map(chain => ({ id: `geckoterminal:pools:${chain}:v1`, provider: 'geckoterminal', kind: 'pools' as const, scope: `First 20 new pools on ${chain}`, intervalSeconds: 300, membership: 'sample' as const, endpoint: `https://api.geckoterminal.com/api/v2/networks/${chain}/new_pools?page=1`, weight: 1, parse: (payload: unknown) => parsePools(payload, chain) })),
];
