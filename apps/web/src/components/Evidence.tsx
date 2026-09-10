export type Evidence = { observedAt?: string | null; acquiredAt?: string | null; recordedAt?: string | null;
  stale?: boolean; unavailable?: boolean; degraded?: boolean; error?: string | null; replayRefused?: boolean;
  source?: string | null; scope?: string | null; payloadId?: string | null; snapshotId?: string | null;
  seriesId?: string | null; replayCoverageStart?: string | null; intervalSeconds?: number | null;
  methodologyVersion?: string | null; classification?: string | null };

export const evidenceDate = (value: string | null | undefined) =>
  value ? `${value.replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '')} UTC` : 'Unavailable';
export const status = (evidence: Evidence) => evidence.replayRefused ? 'Replay refused'
  : evidence.unavailable ? 'Unavailable' : evidence.degraded ? 'Degraded' : evidence.stale ? 'Stale' : 'Current';

/** One number with its own freshness, formula and provenance. Nothing is shown without them. */
export function MetricCard({ title, metric, value, formula, defaultSource = 'Archive', children }: {
  title: string; metric: Evidence; value: string; formula: string; defaultSource?: string; children?: React.ReactNode;
}) {
  return <div className="context-metric"><span>{title}</span><strong>{value}</strong>
    <small>{status(metric)} · {evidenceDate(metric.observedAt)}</small>
    <details><summary>{title} evidence</summary><p>{formula}</p>
      {metric.scope && <p>Scope: {metric.scope}</p>}
      <p>Source: {metric.source ?? defaultSource} · Acquired: {evidenceDate(metric.acquiredAt)} · Replay starts: {evidenceDate(metric.replayCoverageStart)}</p>
      {metric.classification && <p>Classification: {metric.classification}{metric.methodologyVersion ? ` · ${metric.methodologyVersion}` : ''}</p>}
      {metric.error && <p role="alert">Last acquisition error: {metric.error}</p>}
      {metric.replayRefused && <p>This cutoff precedes the feed’s production coverage, so no value is reconstructed for it.</p>}
      {metric.payloadId && <p>Archived payload: {metric.payloadId}{metric.snapshotId ? ` · Snapshot: ${metric.snapshotId}` : ''}</p>}
      {metric.seriesId && <p>Series: {metric.seriesId}</p>}
      {children}
    </details></div>;
}
