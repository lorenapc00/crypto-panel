-- One personal workspace. No fake sessions or invented multi-user isolation.
create table research_watchlist (
  asset_id text primary key references assets(id),
  created_at timestamptz not null default clock_timestamp()
);
create table research_screens (
  id uuid primary key,
  name text not null check (length(name) between 1 and 100),
  filters jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create table research_notes (
  id uuid primary key,
  asset_id text not null references assets(id),
  body text not null check (length(body) between 1 and 10000),
  version integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create table research_note_revisions (
  note_id uuid not null,
  version integer not null,
  asset_id text not null,
  body text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key(note_id,version)
);
create trigger research_note_revisions_immutable before update or delete or truncate
  on research_note_revisions for each statement execute function reject_archive_mutation();
create table research_preferences (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default clock_timestamp()
);
create table research_alert_rules (
  id uuid primary key,
  asset_id text not null references assets(id),
  name text not null check (length(name) between 1 and 100),
  metric text not null check (metric in ('priceUsd','marketCapUsd','change24h')),
  operator text not null check (operator in ('above','below')),
  threshold double precision not null check (threshold not in ('Infinity','-Infinity','NaN')),
  enabled boolean not null default true,
  last_match boolean,
  last_snapshot_id bigint references discovery_snapshots(id),
  created_at timestamptz not null default clock_timestamp()
);
create table research_alerts (
  id bigint generated always as identity primary key,
  rule_id uuid not null,
  snapshot_id bigint not null references discovery_snapshots(id),
  asset_id text not null,
  title text not null,
  evidence jsonb not null,
  detected_at timestamptz not null default clock_timestamp(),
  read_at timestamptz,
  unique(rule_id,snapshot_id)
);
create index research_alerts_recent on research_alerts(detected_at desc,id desc);

-- Curated classifications are explicit, versioned evidence, not an inferred
-- category for every asset or a point-in-time sector membership history.
create table asset_taxonomy (
  id bigint generated always as identity primary key,
  asset_id text not null,
  category text not null,
  source text not null,
  methodology_version text not null,
  recorded_at timestamptz not null default clock_timestamp()
);
create index asset_taxonomy_lookup on asset_taxonomy(asset_id,recorded_at desc,id desc);
create trigger asset_taxonomy_immutable before update or delete or truncate
  on asset_taxonomy for each statement execute function reject_archive_mutation();
insert into asset_taxonomy (asset_id,category,source,methodology_version)
select asset,category,'Curated prototype profile; not historical sector coverage','curated:v1'
from (values ('bitcoin','L1'),('ethereum','L1'),('solana','L1'),('hyperliquid','exchange token'),
  ('arbitrum','L2'),('optimism','L2'),('uniswap','DEX'),('aave','lending'),('usd-coin','stablecoin'),('tether','stablecoin')) t(asset,category);
update assets a set category=t.category from asset_taxonomy t where a.id=t.asset_id;
