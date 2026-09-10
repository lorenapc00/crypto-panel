import type { Pool } from 'pg';
import { pool } from './db.js';
import type { Asset } from './market.js';
import { issuance, unavailableIssuance, type Issuance } from './issuance.js';
import { readSnapshot, providerStale } from './snapshots/archive.js';
import { fundamentalDataset, fundamentalProfiles, type FundamentalValue, type MetricCode } from './snapshots/providers.js';

type Category = 'L1' | 'L2' | 'DEX' | 'lending' | 'stablecoin' | 'exchange token' | 'unknown';
export type Fundamental = {
  code: MetricCode; label: string; value: number | null; unit: 'USD'; scope: 'chain' | 'protocol' | 'unavailable';
  coverage: string; available: boolean; observedAt: string | null; acquiredAt: string | null; stale: boolean;
};
export type Tokenomics = {
  circulatingPercent: number | null; nonCirculatingSupply: number | null;
  unlocks: { events: []; status: 'unavailable'; note: string }; emissions: Issuance;
};
export type Fundamentals = {
  category: Category; fundamentals: Fundamental[]; tokenomics: Tokenomics; observedAt: string | null; stale: boolean;
};
const labels: Record<MetricCode, string> = { tvl_usd: 'TVL', fees_24h_usd: 'Fees (24h)', revenue_24h_usd: 'Revenue (24h)' };

export function deriveTokenomics(asset: Pick<Asset, 'id' | 'circulatingSupply' | 'maxSupply'>): Tokenomics {
  return {
    circulatingPercent: asset.circulatingSupply !== null && asset.maxSupply !== null && asset.maxSupply > 0
      ? asset.circulatingSupply / asset.maxSupply * 100 : null,
    nonCirculatingSupply: asset.circulatingSupply !== null && asset.maxSupply !== null
      ? Math.max(asset.maxSupply - asset.circulatingSupply, 0) : null,
    unlocks: { events: [], status: 'unavailable', note: 'No verified event-level unlock schedule is connected. Unverified third-party schedules are not stored as facts.' },
    emissions: unavailableIssuance(),
  };
}

export async function fundamentals(assetId: string, asset?: Asset, database: Pool = pool): Promise<Fundamentals> {
  const classification = (await database.query('select category from asset_taxonomy where asset_id=$1 order by recorded_at desc,id desc limit 1',[assetId])).rows[0];
  const profile = fundamentalProfiles.find(profile => profile.asset === assetId);
  const metrics = await Promise.all((Object.keys(labels) as MetricCode[]).map(async code => {
    const applicable = profile && (code !== 'revenue_24h_usd' || profile.scope === 'protocol');
    const snapshot = applicable ? await readSnapshot(database, fundamentalDataset(assetId, code)) : null;
    const data = snapshot?.members[0]?.data as FundamentalValue | undefined;
    return { code, label: labels[code], value: data?.value ?? null, unit: 'USD' as const,
      scope: profile?.scope ?? 'unavailable' as const, coverage: data?.coverage ?? (applicable
        ? 'No successful snapshot archived for this verified feed'
        : code === 'revenue_24h_usd' && profile?.scope === 'chain' ? 'Not applicable: chain-scoped fees are not token revenue'
        : 'No individually verified fundamental feed is scheduled for this asset'),
      applicable: Boolean(applicable), available: data?.value != null, observedAt: data?.observedAt ?? null, acquiredAt: snapshot?.metadata.observedAt ?? null,
      stale: !data || snapshot!.metadata.stale || providerStale(data.observedAt, snapshot!.now, 86400, code === 'tvl_usd') };
  }));
  const times = metrics.map(metric => metric.acquiredAt).filter((value): value is string => value !== null).sort();
  return { category: classification?.category ?? 'unknown', fundamentals: metrics,
    tokenomics: { ...deriveTokenomics(asset ?? { id: assetId, circulatingSupply: null, maxSupply: null }), emissions: await issuance(assetId, database) },
    observedAt: times[0] ?? null, stale: metrics.some(metric => metric.applicable && metric.stale) };
}
