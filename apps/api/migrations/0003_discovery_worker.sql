insert into sources (id, name, url, license) values
  ('hyperliquid', 'Hyperliquid', 'https://hyperliquid.gitbook.io/hyperliquid-docs/', 'Provider terms apply'),
  ('geckoterminal', 'GeckoTerminal', 'https://apiguide.geckoterminal.com/', 'Provider terms apply');

-- Preserve the request discriminator for POST APIs and the exact response bytes.
-- Existing payload hashes remain valid; their original text cannot be reconstructed.
alter table source_payloads add column request_body jsonb;
alter table source_payloads add column raw_body text;

create table worker_provider_limits (
  provider_id text primary key references sources(id),
  units_per_minute integer not null check (units_per_minute > 0),
  bucket_capacity integer not null check (bucket_capacity > 0),
  requests_per_month integer not null check (requests_per_month > 0),
  budget_version text not null
);
create table worker_provider_state (
  provider_id text primary key references worker_provider_limits(provider_id),
  tokens numeric not null default 0 check (tokens >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  blocked_until timestamptz
);
create table worker_monthly_usage (
  provider_id text not null references worker_provider_limits(provider_id),
  month date not null,
  requests integer not null default 0 check (requests >= 0),
  primary key (provider_id, month)
);
create table discovery_datasets (
  id text primary key,
  source_id text not null references sources(id),
  kind text not null check (kind in ('protocols','namespaces','instruments','pools')),
  scope text not null,
  interval_seconds integer not null check (interval_seconds > 0),
  membership text not null check (membership in ('catalog','sample')),
  methodology_version text not null,
  unique (id, source_id)
);
create trigger discovery_datasets_immutable before update or delete or truncate
  on discovery_datasets for each statement execute function reject_archive_mutation();

create table worker_jobs (
  id text primary key references discovery_datasets(id),
  provider_id text not null references worker_provider_limits(provider_id),
  interval_seconds integer not null check (interval_seconds > 0),
  next_run_at timestamptz not null,
  enabled boolean not null default true
);
create table worker_runs (
  id bigint generated always as identity primary key,
  job_id text not null references worker_jobs(id),
  scheduled_at timestamptz not null,
  available_at timestamptz not null default clock_timestamp(),
  status text not null default 'queued' check (status in ('queued','running','retry','succeeded','failed','missed')),
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  unique (job_id, scheduled_at)
);
create index worker_runs_queue on worker_runs(available_at, id) where status in ('queued','retry','running');
create table worker_gaps (
  id bigint generated always as identity primary key,
  job_id text not null references worker_jobs(id),
  first_missing_at timestamptz not null,
  last_missing_at timestamptz not null check (last_missing_at >= first_missing_at),
  missing_intervals integer not null check (missing_intervals > 0),
  detected_at timestamptz not null default clock_timestamp(),
  reason text not null
);
create trigger worker_gaps_immutable before update or delete or truncate
  on worker_gaps for each statement execute function reject_archive_mutation();
create table worker_requests (
  id bigint generated always as identity primary key,
  provider_id text not null references worker_provider_limits(provider_id),
  run_id bigint not null references worker_runs(id),
  weight integer not null check (weight > 0),
  requested_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  http_status integer,
  error text,
  payload_id bigint references source_payloads(id)
);
create index worker_requests_provider_time on worker_requests(provider_id, requested_at);

create table discovery_snapshots (
  id bigint generated always as identity primary key,
  dataset_id text not null,
  source_id text not null,
  payload_id bigint not null,
  run_id bigint not null unique references worker_runs(id),
  observed_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  baseline boolean not null,
  coverage_notes jsonb not null,
  foreign key (dataset_id, source_id) references discovery_datasets(id, source_id),
  foreign key (payload_id, source_id) references source_payloads(id, source_id),
  unique (id, dataset_id)
);
create index discovery_snapshots_lookup on discovery_snapshots(dataset_id, recorded_at desc, id desc);
create table discovery_members (
  snapshot_id bigint not null,
  dataset_id text not null,
  entity_key text not null,
  status text not null check (status in ('observed','active','delisted')),
  data jsonb not null,
  primary key (snapshot_id, entity_key),
  foreign key (snapshot_id, dataset_id) references discovery_snapshots(id, dataset_id)
);
create index discovery_members_history on discovery_members(dataset_id, entity_key, snapshot_id desc);
create table discovery_first_seen (
  dataset_id text not null,
  entity_key text not null,
  snapshot_id bigint not null,
  observed_at timestamptz not null,
  primary key (dataset_id, entity_key),
  foreign key (snapshot_id, dataset_id) references discovery_snapshots(id, dataset_id)
);
create table discovery_events (
  snapshot_id bigint not null,
  dataset_id text not null,
  entity_key text not null,
  event_type text not null check (event_type in ('baseline','first_observed','delisted','relisted','catalog_absent','returned')),
  primary key (snapshot_id, entity_key),
  foreign key (snapshot_id, dataset_id) references discovery_snapshots(id, dataset_id)
);
create table discovery_replay_coverage (
  dataset_id text primary key references discovery_datasets(id),
  starts_at timestamptz not null default clock_timestamp()
);
create trigger discovery_snapshots_immutable before update or delete or truncate
  on discovery_snapshots for each statement execute function reject_archive_mutation();
create trigger discovery_members_immutable before update or delete or truncate
  on discovery_members for each statement execute function reject_archive_mutation();
create trigger discovery_first_seen_immutable before update or delete or truncate
  on discovery_first_seen for each statement execute function reject_archive_mutation();
create trigger discovery_events_immutable before update or delete or truncate
  on discovery_events for each statement execute function reject_archive_mutation();
create trigger discovery_replay_coverage_immutable before update or delete or truncate
  on discovery_replay_coverage for each statement execute function reject_archive_mutation();
