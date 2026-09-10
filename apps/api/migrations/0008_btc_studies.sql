insert into metric_definitions (code,name,unit,formula,scope) values
  ('mvrv','Coin Metrics MVRV','ratio','Coin Metrics CapMrktCurUSD / CapRealUSD; current-supply convention','asset');

create table signal_studies (
  id uuid primary key,
  created_at timestamptz not null default clock_timestamp(),
  methodology_version text not null,
  input_hash text not null,
  input jsonb not null,
  result jsonb not null
);
create trigger signal_studies_immutable before update or delete or truncate
  on signal_studies for each statement execute function reject_archive_mutation();
