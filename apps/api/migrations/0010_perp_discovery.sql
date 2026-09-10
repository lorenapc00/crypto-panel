-- Stage 4 perp discovery. The accessible DefiLlama open-interest dimension becomes
-- a fourth archived perp evidence feed; perp-volume rankings stay gated at HTTP 402.
alter table discovery_datasets drop constraint discovery_datasets_kind_check;
alter table discovery_datasets add constraint discovery_datasets_kind_check check
  (kind in ('protocols','namespaces','instruments','pools','market','global','fundamental','issuance','history','book','funding','enrichment','openinterest'));

-- A covered-universe aggregate has no asset identity, exactly like stablecoin supply.
alter table data_series drop constraint data_series_subject_scope;
alter table data_series add constraint data_series_subject_scope
  check ((asset_id is null) = (scope in ('covered_usd_pegged_stablecoins','covered_perp_open_interest')));

insert into metric_definitions (code,name,unit,formula,scope) values
  ('perp_open_interest_usd','Covered perp open interest','USD',
   'DefiLlama /overview/open-interest totalDataChart. Provider-covered protocols only; the documented provider convention counts both sides of each contract, so this is not venue-native open interest and must not be merged with it.',
   'covered_perp_open_interest');

-- Curated, immutable, versioned links. A protocol is not a venue, a venue namespace is
-- not a protocol, and a perpetual contract is not its underlying asset. Nothing here is
-- inferred from name similarity at read time; absent links stay unresolved.
create table perp_venue_links (
  id bigint generated always as identity primary key,
  protocol_id text not null,
  protocol_slug text not null,
  venue text not null,
  namespace text not null,
  relationship text not null check (relationship in ('operates-venue-namespace')),
  evidence text not null,
  methodology_version text not null,
  recorded_at timestamptz not null default clock_timestamp()
);
create index perp_venue_links_lookup on perp_venue_links(protocol_id,recorded_at desc,id desc);
create trigger perp_venue_links_immutable before update or delete or truncate
  on perp_venue_links for each statement execute function reject_archive_mutation();

create table perp_underlying_links (
  id bigint generated always as identity primary key,
  venue text not null,
  namespace text not null,
  instrument text not null,
  -- The CoinGecko identity of the underlying. It is deliberately not a foreign key:
  -- a verified link is recorded before that asset's daily history is archived, and the
  -- spot comparison stays unavailable until the series actually exists.
  asset_id text not null,
  asset_class text not null check (asset_class in ('crypto')),
  evidence text not null,
  methodology_version text not null,
  recorded_at timestamptz not null default clock_timestamp()
);
create index perp_underlying_links_lookup on perp_underlying_links(venue,namespace,instrument,recorded_at desc,id desc);
create trigger perp_underlying_links_immutable before update or delete or truncate
  on perp_underlying_links for each statement execute function reject_archive_mutation();

insert into perp_venue_links (protocol_id,protocol_slug,venue,namespace,relationship,evidence,methodology_version) values
  ('5507','hyperliquid-perps','hyperliquid','','operates-venue-namespace',
   'DefiLlama open-interest adapter hyperliquid-perp-oi reports the Hyperliquid native perpetual venue, which this archive also reads directly through the venue metadata/context adapter. The two open-interest figures keep separate units and conventions.',
   'perp-links:v1');

insert into perp_underlying_links (venue,namespace,instrument,asset_id,asset_class,evidence,methodology_version) values
  ('hyperliquid','','BTC','bitcoin','crypto','Native Hyperliquid BTC perpetual; underlying resolved to the archived CoinGecko bitcoin daily price series','perp-links:v1'),
  ('hyperliquid','','ETH','ethereum','crypto','Native Hyperliquid ETH perpetual; underlying resolved to the archived CoinGecko ethereum daily price series','perp-links:v1'),
  ('hyperliquid','','SOL','solana','crypto','Native Hyperliquid SOL perpetual; underlying resolved to the archived CoinGecko solana daily price series','perp-links:v1'),
  ('hyperliquid','','HYPE','hyperliquid','crypto','Native Hyperliquid HYPE perpetual; underlying resolved to the archived CoinGecko hyperliquid daily price series','perp-links:v1');

-- Lifecycle alert evidence already lives in the immutable discovery_events archive.
-- Only the personal read acknowledgement is mutable, and it cannot alter evidence.
create table discovery_alert_reads (
  dataset_id text not null references discovery_datasets(id),
  snapshot_id bigint not null references discovery_snapshots(id),
  entity_key text not null,
  read_at timestamptz not null default clock_timestamp(),
  primary key (dataset_id,snapshot_id,entity_key)
);
