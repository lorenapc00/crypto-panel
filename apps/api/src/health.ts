import type { Pool } from 'pg';

const expected = `case when s.source_id='coingecko' and s.methodology_version='daily-sample:v1'
  then date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'
    - case when (clock_timestamp() at time zone 'UTC')::time < time '00:10' then interval '1 day' else interval '0' end
  else (date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC') - interval '1 day' end`;

export async function recordSeriesGaps(database:Pool) {
  await database.query(`insert into series_gaps (series_id,missing_at)
    select s.id,grid.time from data_series s
    join lateral (select min(observed_at) as first_at from series_observations where series_id=s.id) first on first.first_at is not null
    cross join lateral generate_series(greatest(first.first_at,clock_timestamp()-interval '10000 days'),${expected},s.interval_seconds*interval '1 second') grid(time)
    left join lateral (select value from series_observations where series_id=s.id and observed_at=grid.time order by recorded_at desc,id desc limit 1) point on true
    where s.interval_seconds=86400 and point.value is null
      and not (s.source_id in ('bcb','fred') and extract(dow from grid.time at time zone 'UTC') in (0,6))
    on conflict do nothing`);
}
export async function seriesHealth(database:Pool) {
  return (await database.query(`select s.id,s.asset_id,a.symbol,s.metric_code,s.source_id,s.scope,s.unit,s.interval_seconds,s.methodology_version,
    c.starts_at as replay_coverage_start,ac.recorded_at as last_success_at,ac.detected_interval_seconds,ac.irregular_intervals,
    ac.points as last_response_points,ac.dataset_id,last.observed_at as last_observation_at,last.value::float8 as last_value,
    extract(epoch from clock_timestamp()-ac.recorded_at)::float8 as seconds_since_success,
    ${expected} as expected_latest_at,coalesce(g.missing,0)::int as missing_intervals,coalesce(g.resolved,0)::int as resolved_gaps,
    g.last_detected_at,g.maximum_detection_latency_seconds,
    case when last.observed_at is null then 'unavailable' when last.value is null then 'unavailable'
      when ac.irregular_intervals>0 then 'irregular' when last.observed_at < ${expected} then 'stale'
      when coalesce(g.missing,0)>0 then 'gaps' else 'healthy' end as state
    from data_series s left join assets a on a.id=s.asset_id
    left join replay_coverage c on c.series_id=s.id
    left join lateral (select * from series_acquisitions where series_id=s.id order by recorded_at desc,payload_id desc limit 1) ac on true
    left join lateral (select observed_at,value from series_observations where series_id=s.id and observed_at<=clock_timestamp()
      order by observed_at desc,recorded_at desc,id desc limit 1) last on true
    left join lateral (select count(*) filter(where p.value is null) as missing,count(*) filter(where p.value is not null) as resolved,
      max(g.detected_at) as last_detected_at,max(extract(epoch from g.detected_at-g.missing_at))::float8 as maximum_detection_latency_seconds
      from series_gaps g left join lateral(select value from series_observations where series_id=g.series_id and observed_at=g.missing_at
        order by recorded_at desc,id desc limit 1) p on true where g.series_id=s.id) g on true order by s.asset_id,s.source_id,s.metric_code`)).rows;
}
export async function operationHealth(database:Pool) {
  const [workers,backup,storage]=await Promise.all([
    database.query(`select id,started_at,last_seen_at,stopped_at,extract(epoch from clock_timestamp()-last_seen_at)::float8 as seconds_since_heartbeat,
      stopped_at is null and last_seen_at>clock_timestamp()-interval '90 seconds' as running from worker_heartbeats order by last_seen_at desc limit 10`),
    database.query('select * from archive_backups order by completed_at desc limit 1'),
    database.query(`select pg_database_size(current_database())::text as database_bytes,
      (select count(*)::int from source_payloads) as payloads,(select count(*)::int from discovery_snapshots) as snapshots`),
  ]);
  return {workers:workers.rows,lastBackup:backup.rows[0]??null,storage:storage.rows[0],retention:'Archive rows are retained indefinitely. Backups retain 7 daily copies; no automatic archive pruning.'};
}
