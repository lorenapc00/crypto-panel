-- Preserve the original values, timestamps and false interval labels for inspection.
-- Do not reinterpret four-day bars or sampled rolling volume as daily OHLCV.
alter table candles rename to legacy_candles;
alter table legacy_candles add column quarantined_at timestamptz not null default clock_timestamp();
alter table legacy_candles add column quarantine_reason text not null default
  'Unverified legacy interval and rolling-volume semantics; excluded from research';

create function reject_archive_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is immutable; append a revision instead', TG_TABLE_NAME;
end;
$$;
create trigger legacy_candles_immutable before insert or update or delete or truncate
  on legacy_candles for each statement execute function reject_archive_mutation();

create table source_payloads (
  id bigint generated always as identity primary key,
  source_id text not null references sources(id),
  endpoint text not null,
  requested_at timestamptz not null,
  received_at timestamptz not null check (received_at >= requested_at),
  recorded_at timestamptz not null default clock_timestamp(),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  unique (id, source_id)
);
create trigger source_payloads_immutable before update or delete or truncate
  on source_payloads for each statement execute function reject_archive_mutation();

create table data_series (
  id text primary key,
  asset_id text not null references assets(id),
  metric_code text not null references metric_definitions(code),
  source_id text not null references sources(id),
  unit text not null, scope text not null,
  interval_seconds integer not null check (interval_seconds > 0),
  methodology_version text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (id, source_id)
);
create trigger data_series_immutable before update or delete or truncate
  on data_series for each statement execute function reject_archive_mutation();

create table series_observations (
  id bigint generated always as identity primary key,
  series_id text not null,
  source_id text not null,
  payload_id bigint not null,
  observed_at timestamptz not null,
  published_at timestamptz,
  recorded_at timestamptz not null default clock_timestamp(),
  value numeric,
  foreign key (series_id, source_id) references data_series(id, source_id),
  foreign key (payload_id, source_id) references source_payloads(id, source_id),
  unique (series_id, observed_at, payload_id),
  check (value is null or value not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))
);
create index series_observations_lookup on series_observations(series_id, observed_at, recorded_at desc, id desc);
create trigger series_observations_immutable before update or delete or truncate
  on series_observations for each statement execute function reject_archive_mutation();

-- A one-off backfill does not automatically start point-in-time production coverage.
create table replay_coverage (
  series_id text primary key references data_series(id),
  starts_at timestamptz not null default clock_timestamp(),
  recorded_at timestamptz not null default clock_timestamp()
);
create trigger replay_coverage_immutable before update or delete or truncate
  on replay_coverage for each statement execute function reject_archive_mutation();
