import type { DiscoveryJob, DiscoverySample, Member } from '../discovery/providers.js';

export const perpOpenInterestDataset = 'defillama:perp-open-interest:v1';
export const perpOpenInterestSeriesId = 'defillama:covered-perp-open-interest:perp_open_interest_usd:daily:v1';
export const perpOpenInterestScope = 'covered_perp_open_interest';
/** The provider counts both sides of a contract and names its current value `total24h`.
 *  Neither fact is obvious from the field name, so both travel with every figure. */
export const OI_CONVENTION = 'DefiLlama open-interest dimension. The documented provider convention counts both sides of each contract; `total24h` is the dimension field holding the current open-interest value, not a 24-hour flow.';
const DAY = 86400000;

function amount(value: unknown, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid open-interest ${field}`);
  return value;
}
function change(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid open-interest change');
  return value;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing open-interest ${field}`);
  return value;
}
function optionalText(value: unknown, field: string): string | null {
  return value == null || value === '' ? null : text(value, field);
}

/** Per-protocol covered open interest plus the provider's own covered-universe aggregate
 *  history. Protocol identity uses the same DefiLlama id space as the protocol catalog so
 *  the two archived feeds join without name matching. */
export function parsePerpOpenInterest(payload: unknown, receivedAt = new Date().toISOString()): DiscoverySample {
  const response = payload as any;
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Expected an open-interest overview object');
  if (!Array.isArray(response.protocols) || !response.protocols.length) throw new Error('Empty covered open-interest universe requires verification');
  if (!Array.isArray(response.totalDataChart) || !response.totalDataChart.length) throw new Error('Missing covered open-interest history');
  if (!Number.isFinite(Date.parse(receivedAt))) throw new Error('Invalid receipt time');
  const midnight = Math.floor(Date.parse(receivedAt) / DAY) * DAY;
  const keys = new Set<string>();
  const members: Member[] = response.protocols.map((value: any) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an open-interest protocol object');
    const protocolId = String(value.defillamaId ?? value.id ?? '');
    if (!/^[\w#.-]+$/.test(protocolId)) throw new Error('Missing open-interest protocol identity');
    const key = JSON.stringify(['defillama', protocolId]);
    if (keys.has(key)) throw new Error('Duplicate open-interest protocol identity');
    keys.add(key);
    const chains = value.chains == null ? [] : value.chains;
    if (!Array.isArray(chains) || chains.some((chain: unknown) => typeof chain !== 'string')) throw new Error('Invalid open-interest chain coverage');
    return { key, status: 'observed', data: {
      protocolId, slug: text(value.slug, 'slug'), name: text(value.name, 'name'),
      displayName: optionalText(value.displayName, 'display name'), category: optionalText(value.category, 'category'),
      chains, parentProtocol: optionalText(value.parentProtocol, 'parent'), module: optionalText(value.module, 'module'),
      methodologyUrl: optionalText(value.methodologyURL, 'methodology URL'),
      openInterestUsd: amount(value.total24h, 'value'),
      openInterest7DaysAgoUsd: amount(value.total7DaysAgo, '7-day comparison'),
      openInterest30DaysAgoUsd: amount(value.total30DaysAgo, '30-day comparison'),
      providerChangePct1d: change(value.change_1d), providerChangePct7d: change(value.change_7d),
      providerChangePct30d: change(value.change_1m),
      unit: 'USD', convention: OI_CONVENTION, venueNormalized: false,
      reportedVolume: 'unavailable: free perp volume and normalized volume returned HTTP 402',
    } };
  });
  let previous = -Infinity;
  const points = response.totalDataChart.flatMap((row: any) => {
    if (!Array.isArray(row) || row.length !== 2) throw new Error('Invalid open-interest history row');
    const time = typeof row[0] === 'number' || typeof row[0] === 'string' && /^\d+$/.test(row[0]) ? Number(row[0]) * 1000 : NaN;
    if (!Number.isSafeInteger(time) || time <= previous || time < 0 || time > Date.parse(receivedAt) || time % DAY) throw new Error('Invalid open-interest history timestamp');
    previous = time;
    return time < midnight ? [{ observedAt: new Date(time).toISOString(), value: amount(row[1], 'history value') }] : [];
  });
  if (!points.some((point: { value: number | null }) => point.value !== null)) throw new Error('No completed covered open-interest values');
  return { members, series: [{ definition: { id: perpOpenInterestSeriesId, assetId: null, metricCode: 'perp_open_interest_usd',
    sourceId: 'defillama', unit: 'USD', scope: perpOpenInterestScope, intervalSeconds: 86400, methodologyVersion: 'perp-open-interest:v1' }, points }],
    notes: { coveredProtocols: members.length, aggregateUsd: amount(response.total24h, 'aggregate'),
      convention: OI_CONVENTION, membership: 'Provider-covered protocols only; coverage changes over time and historical constituents are unavailable',
      scope: 'DefiLlama open-interest dimension across its covered perp protocols; not every protocol in the catalog is covered and not every covered protocol is a perp DEX',
      volumeGate: 'Reported and normalized perp volume remain gated: /overview/derivatives and /summary/derivatives/hyperliquid returned HTTP 402',
      venueComparability: 'Never merged with venue-native open interest, which this archive keeps in underlying units',
      timestamp: 'Provider UTC daily label, live day excluded; publication time unknown',
      attribution: 'DefiLlama; provider terms apply' } };
}

export const perpJobs: DiscoveryJob[] = [
  { id: perpOpenInterestDataset, provider: 'defillama', kind: 'openinterest', membership: 'catalog',
    scope: 'DefiLlama covered perp open interest by protocol and the covered-universe aggregate history',
    intervalSeconds: 86400, offsetSeconds: 5400, weight: 1, methodologyVersion: 'perp-open-interest:v1',
    endpoint: 'https://api.llama.fi/overview/open-interest?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true',
    parse: parsePerpOpenInterest },
];
