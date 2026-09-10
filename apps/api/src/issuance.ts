import type { Pool } from 'pg';
import { pool } from './db.js';
import { readSnapshot } from './snapshots/archive.js';
import { issuanceDataset } from './snapshots/providers.js';

export type Issuance = { status: 'stored' | 'stale' | 'unavailable'; observedAt: string | null;
  source: string; note: string; metrics: { label: string; value: string }[] };
export const unavailableIssuance = (): Issuance => ({ status: 'unavailable', observedAt: null,
  source: 'No verified issuance snapshot', note: 'No verified live issuance source is connected for this asset.', metrics: [] });

export async function issuance(assetId: string, database: Pool = pool): Promise<Issuance> {
  if (!['bitcoin', 'solana'].includes(assetId)) return unavailableIssuance();
  const snapshot = await readSnapshot(database, issuanceDataset(assetId));
  const data = snapshot.members[0]?.data;
  const source = assetId === 'bitcoin' ? 'mempool.space' : 'Solana mainnet RPC';
  if (!data) return { ...unavailableIssuance(), source, note: 'No successful issuance snapshot has been archived yet.' };
  return { status: snapshot.metadata.stale ? 'stale' : 'stored', observedAt: snapshot.metadata.observedAt, source,
    note: assetId === 'bitcoin' ? 'Subsidy era calculated from archived tip height; not realized net issuance.'
      : 'Archived annualized protocol inflation parameter; not realized net issuance.',
    metrics: assetId === 'bitcoin'
      ? [{ label: 'Tip height', value: data.height.toLocaleString('en-US') },
        { label: 'Block subsidy', value: `${data.subsidyBtc} BTC` },
        { label: 'Next halving block', value: data.nextHalvingBlock.toLocaleString('en-US') }]
      : [{ label: 'Epoch', value: String(data.epoch) }, { label: 'Annual inflation', value: `${(data.total * 100).toFixed(2)}%` }] };
}
