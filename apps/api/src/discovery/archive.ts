import type { Pool } from 'pg';
import { ReplayCoverageError, appendSeries } from '../archive.js';
import { lockRun, transaction, type Run } from './queue.js';
import type { DiscoveryJob, DiscoverySample } from './providers.js';
import { evaluateAlerts } from '../research/store.js';
import { seriesHealth, operationHealth } from '../health.js';

export async function archiveDiscovery(database: Pool, run: Run, job: DiscoveryJob, payloadId: string, sample: DiscoverySample) {
  if (run.job_id !== job.id) throw new Error('Run does not belong to this dataset');
  return transaction(database, async client => {
    await lockRun(client, run);
    await client.query('select pg_advisory_xact_lock(hashtext(current_schema()),hashtext($1))', [`discovery:${job.id}`]);
    const previous = (await client.query('select id from discovery_snapshots where dataset_id=$1 order by recorded_at desc,id desc limit 1', [job.id])).rows[0];
    // Only a payload actually acquired by this leased run can start coverage.
    const payload = await client.query(`select p.received_at from source_payloads p join worker_requests r on r.payload_id=p.id
      where p.id=$1 and p.source_id=$2 and r.run_id=$3 and r.http_status between 200 and 299`, [payloadId, job.provider, run.id]);
    if (!payload.rowCount) throw new Error('Payload does not belong to this successful worker request');
    const snapshot = (await client.query(`insert into discovery_snapshots
      (dataset_id,source_id,payload_id,run_id,observed_at,baseline,coverage_notes) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [job.id, job.provider, payloadId, run.id, payload.rows[0].received_at, !previous, JSON.stringify(sample.notes)])).rows[0];
    const id = snapshot.id;
    if (sample.assets?.length) await client.query(`insert into assets (id,symbol,name)
      select id,symbol,name from jsonb_to_recordset($1::jsonb) as a(id text,symbol text,name text) on conflict do nothing`,[JSON.stringify(sample.assets)]);
    if (sample.series?.length) await appendSeries(client,payloadId,job.provider,sample.series,job.id);
    if (job.kind === 'market') await client.query(`insert into assets (id,symbol,name)
      select m.data->>'id',m.data->>'symbol',m.data->>'name'
      from jsonb_to_recordset($1::jsonb) as m(data jsonb)
      on conflict (id) do update set symbol=excluded.symbol,name=excluded.name,updated_at=clock_timestamp()`, [JSON.stringify(sample.members)]);
    if (job.kind === 'market') await client.query(`update assets a set category=t.category from
      (select distinct on (asset_id) asset_id,category from asset_taxonomy order by asset_id,recorded_at desc,id desc) t
      where a.id=t.asset_id and a.category is distinct from t.category`);
    await client.query(`insert into discovery_members (snapshot_id,dataset_id,entity_key,status,data)
      select $1,$2,m.key,m.status,m.data from jsonb_to_recordset($3::jsonb) as m(key text,status text,data jsonb)`, [id, job.id, JSON.stringify(sample.members)]);
    if (job.kind === 'market') await evaluateAlerts(client,id);
    await client.query(`insert into discovery_first_seen (dataset_id,entity_key,snapshot_id,observed_at)
      select dataset_id,entity_key,snapshot_id,$2 from discovery_members where snapshot_id=$1 on conflict do nothing`, [id, payload.rows[0].received_at]);
    if (['protocols','namespaces','instruments','pools','market'].includes(job.kind)) await client.query(`insert into discovery_events (snapshot_id,dataset_id,entity_key,event_type)
      select $1,$2,m.entity_key,event.kind from discovery_members m
      join discovery_first_seen f on f.dataset_id=m.dataset_id and f.entity_key=m.entity_key
      left join lateral (select status from discovery_members h where h.dataset_id=$2 and h.entity_key=m.entity_key
        and h.snapshot_id < $1 order by h.snapshot_id desc limit 1) prior on true
      cross join lateral (select case
        when $3::boolean then 'baseline'
        when f.snapshot_id=$1 then 'first_observed'
        when $4='instruments' and m.status='delisted' and prior.status='active' then 'delisted'
        when $4='instruments' and m.status='active' and prior.status='delisted' then 'relisted'
        when $5='catalog' and not exists (select 1 from discovery_members p where p.snapshot_id=$6 and p.entity_key=m.entity_key) then 'returned'
        else null end as kind) event
      where m.snapshot_id=$1 and event.kind is not null`, [id, job.id, !previous, job.kind, job.membership, previous?.id ?? null]);
    if (previous && job.membership === 'catalog') await client.query(`insert into discovery_events (snapshot_id,dataset_id,entity_key,event_type)
      select $1,$2,p.entity_key,'catalog_absent' from discovery_members p where p.snapshot_id=$3
      and not exists (select 1 from discovery_members m where m.snapshot_id=$1 and m.entity_key=p.entity_key)`, [id, job.id, previous.id]);
    await client.query('insert into discovery_replay_coverage (dataset_id) values ($1) on conflict do nothing', [job.id]);
    // Lease is checked again after large catalog inserts, before committing.
    await lockRun(client, run);
    await client.query(`update worker_runs set status='succeeded', finished_at=clock_timestamp(), error=null,
      lease_token=null,lease_until=null where id=$1`, [run.id]);
    return { snapshotId: id, members: sample.members.length, baseline: !previous };
  });
}

export async function readDiscovery(database: Pool, datasetId: string, asOf?: string) {
  if (asOf && !Number.isFinite(Date.parse(asOf))) throw new Error('Invalid replay cutoff');
  const definition = (await database.query(`select d.*,c.starts_at from discovery_datasets d
    left join discovery_replay_coverage c on c.dataset_id=d.id where d.id=$1`, [datasetId])).rows[0];
  if (asOf) {
    const check = (await database.query(`select $2::timestamptz > clock_timestamp() as future,
      exists(select 1 from discovery_replay_coverage where dataset_id=$1 and starts_at <= $2::timestamptz) as covered`, [datasetId, asOf])).rows[0];
    if (check.future) throw new Error('Replay cutoff cannot be in the future');
    if (!check.covered) throw new ReplayCoverageError('Discovery replay predates production coverage');
  }
  if (!definition) return null;
  const snapshot = (await database.query(`select * from discovery_snapshots where dataset_id=$1
    and recorded_at <= coalesce($2::timestamptz,clock_timestamp())
    and observed_at <= coalesce($2::timestamptz,clock_timestamp()) order by recorded_at desc,id desc limit 1`, [datasetId, asOf ?? null])).rows[0];
  const members = snapshot ? (await database.query(`select m.entity_key as key,m.status,m.data,f.observed_at as first_observed_at
    from discovery_members m join discovery_first_seen f using(dataset_id,entity_key) where m.snapshot_id=$1 order by m.entity_key`, [snapshot.id])).rows : [];
  const events = snapshot ? (await database.query('select entity_key,event_type from discovery_events where snapshot_id=$1 order by entity_key', [snapshot.id])).rows : [];
  const gaps = (await database.query(`select first_missing_at,last_missing_at,missing_intervals,detected_at,reason,
    extract(epoch from detected_at-first_missing_at)::float8 as detection_latency_seconds
    from worker_gaps where job_id=$1 and detected_at <= coalesce($2::timestamptz,clock_timestamp()) order by detected_at`, [datasetId, asOf ?? null])).rows;
  return { members, events, metadata: { datasetId, source: definition.source_id, scope: definition.scope,
    methodologyVersion: definition.methodology_version, expectedIntervalSeconds: definition.interval_seconds,
    membership: definition.membership, mode: asOf ? 'point-in-time' : 'forward tracking',
    replayCoverageStart: definition.starts_at ?? null, observedAt: snapshot?.observed_at ?? null,
    recordedAt: snapshot?.recorded_at ?? null, publishedAt: null, baseline: snapshot?.baseline ?? null,
    snapshotId: snapshot?.id ?? null, payloadId: snapshot?.payload_id ?? null, coverage: snapshot?.coverage_notes ?? null, gaps } };
}

export async function dataHealth(database: Pool) {
  const [jobs, providers, gaps, clock, series, operations] = await Promise.all([
    database.query(`select j.id,j.provider_id,j.enabled,j.interval_seconds,j.next_run_at,d.scope,d.membership,c.starts_at as replay_coverage_start,
      s.observed_at as last_success_at,s.coverage_notes,s.recorded_at as last_recorded_at,
      extract(epoch from clock_timestamp()-s.observed_at)::float8 as seconds_since_success,
      extract(epoch from s.observed_at-p.observed_at)::float8 as last_observed_interval_seconds,
      r.status as last_run_status,r.error as last_run_error,r.attempts,r.available_at,r.lease_until,
      case when not j.enabled then 'disabled' when s.id is null then 'unavailable'
        when clock_timestamp()-s.observed_at > j.interval_seconds * interval '1 second' then 'stale'
        when r.status in ('failed','missed','retry') then 'degraded' else 'healthy' end as state
      from worker_jobs j join discovery_datasets d on d.id=j.id
      left join discovery_replay_coverage c on c.dataset_id=j.id
      left join lateral (select * from discovery_snapshots where dataset_id=j.id order by recorded_at desc,id desc limit 1) s on true
      left join lateral (select observed_at from discovery_snapshots where dataset_id=j.id and id<s.id order by recorded_at desc,id desc limit 1) p on true
      left join lateral (select * from worker_runs where job_id=j.id order by scheduled_at desc,id desc limit 1) r on true order by j.id`),
    database.query(`select l.*,coalesce(u.requests,0) as requests_this_month,l.requests_per_month-coalesce(u.requests,0) as remaining_requests,
      s.blocked_until,s.tokens,coalesce(e.attempts,0) as attempts_24h,coalesce(e.errors,0) as errors_24h,
      coalesce(e.unfinished,0) as unfinished_requests_24h
      from worker_provider_limits l join worker_provider_state s using(provider_id)
      left join worker_monthly_usage u on u.provider_id=l.provider_id and u.month=date_trunc('month',clock_timestamp() at time zone 'UTC')::date
      left join lateral (select count(*)::int as attempts,count(*) filter(where error is not null or http_status >= 400)::int as errors,
        count(*) filter(where finished_at is null)::int as unfinished from worker_requests
        where provider_id=l.provider_id and requested_at >= clock_timestamp()-interval '24 hours') e on true order by l.provider_id`),
    database.query(`select job_id,sum(missing_intervals)::int as missing_intervals,max(detected_at) as last_detected_at,
      max(extract(epoch from detected_at-first_missing_at))::float8 as maximum_detection_latency_seconds
      from worker_gaps group by job_id order by job_id`),
    database.query('select clock_timestamp() as now'),
    seriesHealth(database), operationHealth(database),
  ]);
  return { observedAt: clock.rows[0].now, jobs: jobs.rows, providers: providers.rows, gaps: gaps.rows,series,operations,
    quotaScope: 'All scheduled requests, manual daily history and capability probes share provider counters and backoff',
    coverage: 'Acquisition health and normalized daily-series coverage; unknown provider publication times remain unknown' };
}
