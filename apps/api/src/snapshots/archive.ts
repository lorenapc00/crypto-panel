import type { Pool } from 'pg';
import { readDiscovery } from '../discovery/archive.js';

export async function readSnapshot(database: Pool, datasetId: string, asOf?: string) {
  const result = await readDiscovery(database, datasetId, asOf);
  const m = result?.metadata;
  const clock = (await database.query(`select coalesce($1::timestamptz,clock_timestamp()) as now`, [asOf ?? null])).rows[0].now as Date;
  const run = !asOf ? (await database.query(`select status,error,attempts from worker_runs where job_id=$1
    order by scheduled_at desc,id desc limit 1`, [datasetId])).rows[0] : null;
  const observedAt = m?.observedAt?.toISOString() ?? null;
  const degraded = Boolean(run && (['failed', 'missed'].includes(run.status) || (run.status === 'retry' && run.attempts > 0)));
  const stale = !observedAt || clock.getTime() - Date.parse(observedAt) > (m?.expectedIntervalSeconds ?? 0) * 1000;
  return { members: result?.members ?? [], metadata: {
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
