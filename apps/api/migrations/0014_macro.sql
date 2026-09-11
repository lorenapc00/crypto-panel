insert into sources (id,name,url,license) values
  ('bcb','Banco Central do Brasil','https://api.bcb.gov.br',
   'SGS data is public; no documented redistribution restriction for series-level data'),
  ('federalreserve','Board of Governors of the Federal Reserve System',
   'https://www.federalreserve.gov','U.S. government work; public domain');
-- fred source already exists (inserted 0006_archive_operations.sql)

insert into metric_definitions (code,name,unit,formula,scope) values
  ('cdi_daily_rate','Brazil CDI daily rate (BCB SGS série 12)','pct_per_business_day',
   'BCB SGS série 12; daily interbank rate as percent per business day. Annualized = (1+d/100)^252-1; never forward-filled, never compounded over calendar days.','macro_indicator'),
  ('usd_brl_ptax_sell','USD/BRL PTAX sell rate (BCB SGS série 1)','brl_per_usd',
   'BCB SGS série 1; PTAX sell rate, business days only.','macro_indicator'),
  ('real_yield_10y','US 10Y Treasury Inflation-Indexed Security (FRED DFII10)','pct',
   'FRED DFII10 (H.15), daily; provider "." missing values skipped, never forward-filled.','macro_indicator'),
  ('broad_usd_index','Nominal Broad U.S. Dollar Index (FRED DTWEXBGS)','index',
   'FRED DTWEXBGS (H.10); published weekly, not daily.','macro_indicator'),
  ('sp500_index','S&P 500 (FRED SP500)','index',
   'FRED SP500; provider retains only a rolling 10-year window (first value 2016-09-12).','macro_indicator'),
  ('nasdaq_composite_index','NASDAQ Composite (FRED NASDAQCOM)','index',
   'FRED NASDAQCOM; full history from 1971-02-05.','macro_indicator');

alter table data_series drop constraint data_series_subject_scope;
alter table data_series add constraint data_series_subject_scope
  check ((asset_id is null) = (scope in
    ('covered_usd_pegged_stablecoins','covered_perp_open_interest','crypto_market_sentiment','macro_indicator')));

-- Macro calendar: append-only snapshot + child events, mirroring discovery_snapshots/discovery_members.
-- Neither source provides a time of day, so `date` is used throughout, never `timestamptz`.
create table macro_calendar_snapshots (
  id bigint generated always as identity primary key,
  dataset_id text not null,
  source_id text not null,
  payload_id bigint not null,
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (dataset_id, source_id) references discovery_datasets(id, source_id),
  foreign key (payload_id, source_id) references source_payloads(id, source_id)
);
create index macro_calendar_snapshots_lookup on macro_calendar_snapshots(dataset_id, recorded_at desc, id desc);
create trigger macro_calendar_snapshots_immutable before update or delete or truncate
  on macro_calendar_snapshots for each statement execute function reject_archive_mutation();

create table macro_calendar_events (
  id bigint generated always as identity primary key,
  snapshot_id bigint not null references macro_calendar_snapshots(id),
  event_type text not null check (event_type in
    ('fomc-meeting','copom-meeting','cpi-release','employment-release','gdp-release','pce-release')),
  title text not null,
  starts_on date not null,
  ends_on date not null check (ends_on >= starts_on),
  sep boolean,
  source_url text not null,
  methodology_version text not null
);
create index macro_calendar_events_lookup on macro_calendar_events(snapshot_id, starts_on);
create trigger macro_calendar_events_immutable before update or delete or truncate
  on macro_calendar_events for each statement execute function reject_archive_mutation();
