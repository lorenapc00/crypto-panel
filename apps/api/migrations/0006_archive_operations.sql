insert into sources (id,name,url,license) values
  ('coinmetrics','Coin Metrics Community','https://community-api.coinmetrics.io','CC BY-NC 4.0; attribution required'),
  ('dexscreener','DEX Screener','https://docs.dexscreener.com/api/reference','Provider terms apply'),
  ('fred','FRED / ALFRED','https://fred.stlouisfed.org','Series-specific terms; verify before use')
on conflict (id) do nothing;
insert into metric_definitions (code,name,unit,formula,scope) values
  ('holder_revenue_24h_usd','Provider holder revenue, 24h','USD','Provider-defined holder revenue; recipient and mechanism require review','protocol');

alter table worker_requests alter column run_id drop not null;
alter table worker_requests add column purpose text not null default 'scheduled';
alter table worker_requests add column endpoint text;
alter table worker_runs drop constraint worker_runs_status_check;
alter table worker_runs add constraint worker_runs_status_check check
  (status in ('queued','running','retry','succeeded','failed','missed','skipped'));
alter table discovery_datasets drop constraint discovery_datasets_kind_check;
alter table discovery_datasets add constraint discovery_datasets_kind_check check
  (kind in ('protocols','namespaces','instruments','pools','market','global','fundamental','issuance','history','book','funding','enrichment'));

create table series_acquisitions (
  series_id text not null references data_series(id),
  payload_id bigint not null references source_payloads(id),
  dataset_id text references discovery_datasets(id),
  recorded_at timestamptz not null default clock_timestamp(),
  first_observed_at timestamptz,
  last_observed_at timestamptz,
  points integer not null,
  detected_interval_seconds double precision,
  irregular_intervals integer not null,
  primary key(series_id,payload_id)
);
create trigger series_acquisitions_immutable before update or delete or truncate
  on series_acquisitions for each statement execute function reject_archive_mutation();
create table series_gaps (
  series_id text not null references data_series(id),
  missing_at timestamptz not null,
  detected_at timestamptz not null default clock_timestamp(),
  primary key(series_id,missing_at)
);
create trigger series_gaps_immutable before update or delete or truncate
  on series_gaps for each statement execute function reject_archive_mutation();
create table worker_heartbeats (
  id uuid primary key,
  started_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  stopped_at timestamptz
);
create table archive_backups (
  id uuid primary key,
  completed_at timestamptz not null default clock_timestamp(),
  filename text not null,
  bytes bigint not null check (bytes > 0),
  sha256 text not null,
  restore_verified_at timestamptz
);
