import type { Pool } from 'pg';
import { readDiscovery, guardDiscoveryReplay } from '../discovery/archive.js';

export async function readSnapshot(database: Pick<Pool, 'query'>, datasetId: string, asOf?: string) {
  const result = await readDiscovery(database, datasetId, asOf);
  const m = result?.metadata;
  const clock = (await database.query(`select coalesce($1::timestamptz,clock_timestamp()) as now`, [asOf ?? null])).rows[0].now as Date;
  const run = !asOf ? (await database.query(`select status,error,attempts from worker_runs where job_id=$1
    order by scheduled_at desc,id desc limit 1`, [datasetId])).rows[0] : null;
  const observedAt = m?.observedAt?.toISOString() ?? null;
  const degraded = Boolean(run && (['failed', 'missed'].includes(run.status) || (run.status === 'retry' && run.attempts > 0)));
  const stale = !observedAt || clock.getTime() - Date.parse(observedAt) > (m?.expectedIntervalSeconds ?? 0) * 1000;
  return { members: result?.members ?? [], events: result?.events ?? [], metadata: {
    datasetId, source: m?.source ?? datasetId.split(':')[0], observedAt,
    recordedAt: m?.recordedAt?.toISOString() ?? null, publishedAt: null,
    coverage: m?.scope ?? 'No scheduled snapshot has been archived', coverageNotes: m?.coverage ?? null,
    intervalSeconds: m?.expectedIntervalSeconds ?? null, methodologyVersion: m?.methodologyVersion ?? null,
    replayCoverageStart: m?.replayCoverageStart?.toISOString() ?? null, snapshotId: m?.snapshotId ?? null,
    payloadId: m?.payloadId ?? null, classification: asOf ? 'point-in-time' : 'forward tracking',
    stale: stale || degraded, degraded, unavailable: !m?.snapshotId, error: degraded ? run.error : null,
  }, now: clock.getTime() };
}

export function providerStale(observedAt: string | null, now: number, intervalSeconds: number, unknownIsStale = true) {
  return observedAt === null ? unknownIsStale : now - Date.parse(observedAt) > intervalSeconds * 1000;
}

/** Successive archived snapshots of one entity, oldest first. Acquisition times are
 *  kept separate from the provider's own observation timestamps inside `data`. */
export async function readSnapshotHistory(database: Pick<Pool, 'query'>, datasetId: string, entityKey: string,
  options: { asOf?: string; limit?: number } = {}) {
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error('Snapshot history limit must be between 1 and 5000');
  await guardDiscoveryReplay(database, datasetId, options.asOf);
  const rows = (await database.query(`select s.id,s.observed_at,s.recorded_at,s.payload_id,m.data from discovery_snapshots s
    join discovery_members m on m.snapshot_id=s.id and m.entity_key=$2
    where s.dataset_id=$1 and s.recorded_at <= coalesce($3::timestamptz,clock_timestamp())
      and s.observed_at <= coalesce($3::timestamptz,clock_timestamp())
    order by s.observed_at desc,s.recorded_at desc,s.id desc limit $4`, [datasetId, entityKey, options.asOf ?? null, limit])).rows;
  return rows.reverse().map(row => ({ snapshotId: row.id as string, payloadId: row.payload_id as string,
    acquiredAt: (row.observed_at as Date).toISOString(), recordedAt: (row.recorded_at as Date).toISOString(),
    data: row.data as Record<string, unknown> }));
}
