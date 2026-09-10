import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { pool } from "./db.js";

export type SeriesDefinition = {
  id: string; assetId: string; metricCode: string; sourceId: string;
  unit: string; scope: string; intervalSeconds: number; methodologyVersion: string;
};
export type SeriesPoint = { observedAt: string; value: number | null; publishedAt?: string | null };
export type ArchiveInput = {
  sourceId: string; endpoint: string; requestedAt: string; receivedAt: string; rawPayload: string;
  series: { definition: SeriesDefinition; points: SeriesPoint[] }[];
};

function checkTime(value: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Invalid archive timestamp");
}

/** One provider response and all its series are committed together. Callers cannot set recorded_at. */
export async function archivePayload(input: ArchiveInput, database: Pool = pool) {
  const endpoint = new URL(input.endpoint);
  if (endpoint.username || endpoint.password || [...endpoint.searchParams.keys()].some(key => /key|token|secret|authorization/i.test(key))) throw new Error("Archive endpoints must not contain credentials");
  checkTime(input.requestedAt);
  checkTime(input.receivedAt);
  if (Date.parse(input.receivedAt) < Date.parse(input.requestedAt)) throw new Error("Receipt precedes request");
  JSON.parse(input.rawPayload);
  if (!input.series.length) throw new Error("No series to archive");
  const sorted = [...input.series].sort((a, b) => a.definition.id.localeCompare(b.definition.id));
  for (const [index, { definition, points }] of sorted.entries()) {
    if (definition.sourceId !== input.sourceId || !Number.isSafeInteger(definition.intervalSeconds) || definition.intervalSeconds <= 0) throw new Error("Invalid series source or interval");
    if (index && sorted[index - 1].definition.id === definition.id) throw new Error("Duplicate series definition");
    const times = new Set<number>();
    for (const point of points) {
      checkTime(point.observedAt);
      if (point.publishedAt != null) checkTime(point.publishedAt);
      if (point.value !== null && !Number.isFinite(point.value)) throw new Error("Non-finite series value");
      const time = Date.parse(point.observedAt);
      if (times.has(time)) throw new Error("Duplicate observation time in payload");
      times.add(time);
    }
  }
  const client = await database.connect();
  try {
    await client.query("begin");
    const payload = await client.query<{ id: string }>(`insert into source_payloads
      (source_id, endpoint, requested_at, received_at, sha256, payload)
      values ($1, $2, $3, $4, $5, $6::jsonb) returning id`,
    [input.sourceId, input.endpoint, input.requestedAt, input.receivedAt, createHash("sha256").update(input.rawPayload).digest("hex"), input.rawPayload]);
    const inserted = await appendSeries(client,payload.rows[0].id,input.sourceId,sorted);
    await client.query("commit");
    return { payloadId: payload.rows[0].id, inserted };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function appendSeries(client: PoolClient, payloadId: string, sourceId: string,
  series: ArchiveInput['series'], datasetId: string | null = null) {
    let inserted = 0;
    for (const { definition: d, points } of series) {
      await client.query("select pg_advisory_xact_lock(hashtext(current_schema()), hashtext($1))", [`archive:${d.id}`]);
      const metric = await client.query(`select 1 from metric_definitions where code=$1 and unit=$2
        and (scope=$3 or (scope='chain_or_protocol' and $3 in ('chain', 'protocol')))`, [d.metricCode, d.unit, d.scope]);
      if (!metric.rows.length) throw new Error(`Incompatible metric scope or unit for ${d.metricCode}`);
      const fields = [d.id, d.assetId, d.metricCode, d.sourceId, d.unit, d.scope, d.intervalSeconds, d.methodologyVersion];
      await client.query(`insert into data_series (id, asset_id, metric_code, source_id, unit, scope, interval_seconds, methodology_version)
        values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing`, fields);
      const compatible = await client.query(`select 1 from data_series where id=$1 and asset_id=$2 and metric_code=$3
        and source_id=$4 and unit=$5 and scope=$6 and interval_seconds=$7 and methodology_version=$8`, fields);
      if (!compatible.rows.length) throw new Error(`Incompatible definition for series ${d.id}; use a new methodology version`);
      // Compare against the latest revision, including explicit null corrections.
      const result = await client.query(`insert into series_observations (series_id, source_id, payload_id, observed_at, published_at, value)
        select $1, $2, $3, p."observedAt", p."publishedAt", p.value
        from jsonb_to_recordset($4::jsonb) as p("observedAt" timestamptz, "publishedAt" timestamptz, value numeric)
        left join lateral (
          select id, value, published_at from series_observations
          where series_id=$1 and observed_at=p."observedAt" order by recorded_at desc, id desc limit 1
        ) previous on true
        where previous.id is null or previous.value is distinct from p.value or previous.published_at is distinct from p."publishedAt"`,
      [d.id, sourceId, payloadId, JSON.stringify(points)]);
      inserted += result.rowCount ?? 0;
      const times = points.map(point=>Date.parse(point.observedAt)).sort((a,b)=>a-b);
      const steps = times.slice(1).map((time,index)=>(time-times[index])/1000);
      const frequencies = new Map<number,number>();
      for (const step of steps) frequencies.set(step,(frequencies.get(step)??0)+1);
      const detected = [...frequencies].sort((a,b)=>b[1]-a[1] || a[0]-b[0])[0]?.[0] ?? null;
      await client.query(`insert into series_acquisitions (series_id,payload_id,dataset_id,first_observed_at,last_observed_at,points,detected_interval_seconds,irregular_intervals)
        values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
        [d.id,payloadId,datasetId,times.length ? new Date(times[0]) : null,times.length ? new Date(times.at(-1)!) : null,
          points.length,detected,steps.filter(step=>step!==d.intervalSeconds).length]);
      if (datasetId) await client.query('insert into replay_coverage (series_id) values ($1) on conflict do nothing',[d.id]);
    }
    return inserted;
}

export class ReplayCoverageError extends Error {}

export async function readSeries(seriesId: string, options: { from?: string; to?: string; asOf?: string; limit?: number } = {}, database: Pool = pool) {
  const limit = options.limit ?? 365;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("Series limit must be between 1 and 10000");
  for (const value of [options.from, options.to, options.asOf]) if (value !== undefined) checkTime(value);
  if (options.from && options.to && Date.parse(options.from) > Date.parse(options.to)) throw new Error("Invalid series date range");
  const definition = await database.query(`select s.*, c.starts_at as replay_start_at, c.recorded_at as coverage_recorded_at
    from data_series s left join replay_coverage c on c.series_id=s.id where s.id=$1`, [seriesId]);
  const d = definition.rows[0];
  if (options.asOf) {
    // Use the same clock as recorded_at, including when PostgreSQL runs in a VM.
    // Compare in SQL to preserve microsecond cutoff boundaries.
    const coverage = await database.query(`select $2::timestamptz > clock_timestamp() as future,
      exists(select 1 from replay_coverage where series_id=$1
        and starts_at <= $2::timestamptz and recorded_at <= $2::timestamptz) as covered`, [seriesId, options.asOf]);
    if (coverage.rows[0].future) throw new Error("Replay cutoff cannot be in the future");
    if (!coverage.rows[0].covered) throw new ReplayCoverageError("Replay is unavailable before this series began production archiving");
  }
  if (!d) return null;
  const result = await database.query(`select * from (
    select distinct on (observed_at) observed_at, value, published_at, recorded_at, payload_id
    from series_observations where series_id=$1
      and observed_at >= coalesce($2::timestamptz, '-infinity'::timestamptz)
      and observed_at <= coalesce($3::timestamptz, 'infinity'::timestamptz)
      and observed_at <= coalesce($4::timestamptz, clock_timestamp())
      and recorded_at <= coalesce($4::timestamptz, clock_timestamp())
      and (published_at is null or published_at <= coalesce($4::timestamptz, clock_timestamp()))
    order by observed_at desc, recorded_at desc, id desc
  ) revisions order by observed_at desc limit $5`, [seriesId, options.from ?? null, options.to ?? null, options.asOf ?? null, limit]);
  return {
    points: result.rows.reverse().map(row => ({ observedAt: row.observed_at.toISOString(), value: row.value === null ? null : Number(row.value), publishedAt: row.published_at?.toISOString() ?? null, recordedAt: row.recorded_at.toISOString(), payloadId: row.payload_id as string })),
    metadata: { seriesId, source: d.source_id as string, scope: d.scope as string, unit: d.unit as string, intervalSeconds: d.interval_seconds as number, methodologyVersion: d.methodology_version as string, replayCoverageStart: d.replay_start_at?.toISOString() ?? null, classification: options.asOf ? "point-in-time" as const : d.replay_start_at ? "forward-tracking-with-reconstruction" as const : "historical-reconstruction" as const },
  };
}
