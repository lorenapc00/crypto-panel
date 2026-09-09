-- Adopt the unversioned prototype without changing or discarding its rows.
create table if not exists sources (
  id text primary key, name text not null, url text not null, license text, created_at timestamptz not null default now()
);
create table if not exists assets (
  id text primary key, symbol text not null, name text not null, category text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists metric_definitions (
  code text primary key, name text not null, unit text not null, formula text, scope text not null, created_at timestamptz not null default now()
);
create table if not exists observations (
  id bigint generated always as identity primary key,
  asset_id text references assets(id), metric_code text not null references metric_definitions(code),
  value numeric not null, unit text not null, observed_at timestamptz not null, recorded_at timestamptz not null default now(),
  source_id text not null references sources(id), coverage text not null, granularity text not null, quality text not null check (quality in ('fresh','stale','estimated')),
  unique (asset_id, metric_code, observed_at, source_id)
);
create index if not exists observations_lookup on observations(asset_id, metric_code, observed_at desc);
create table if not exists candles (
  asset_id text not null references assets(id), interval text not null, observed_at timestamptz not null,
  open numeric not null, high numeric not null, low numeric not null, close numeric not null, volume numeric,
  source_id text not null references sources(id), recorded_at timestamptz not null default now(),
  primary key (asset_id, interval, observed_at, source_id)
);
create index if not exists candles_lookup on candles(asset_id, interval, observed_at desc);
create table if not exists tokenomics_events (
  id text primary key, asset_id text not null references assets(id),
  event_type text not null check (event_type in ('unlock','emission','burn','buyback')),
  amount numeric not null check (amount >= 0), unit text not null,
  effective_at timestamptz not null, published_at timestamptz not null,
  source_id text not null references sources(id), coverage text not null,
  verification text not null check (verification in ('verified','reported')),
  recorded_at timestamptz not null default now(),
  unique (asset_id, event_type, effective_at, source_id)
);
create index if not exists tokenomics_events_lookup on tokenomics_events(asset_id, effective_at asc);

insert into sources (id, name, url, license) values
  ('coingecko', 'CoinGecko', 'https://www.coingecko.com/en/api', 'Provider terms apply'),
  ('defillama', 'DefiLlama', 'https://defillama.com/docs/api', 'Provider terms apply')
on conflict (id) do nothing;

insert into metric_definitions (code, name, unit, formula, scope) values
  ('price_usd', 'Price', 'USD', 'Spot price in United States dollars', 'asset'),
  ('market_cap_usd', 'Market capitalization', 'USD', 'Circulating supply multiplied by price', 'asset'),
  ('fully_diluted_valuation_usd', 'Fully diluted valuation', 'USD', 'Reported fully diluted valuation', 'asset'),
  ('volume_24h_usd', '24 hour volume', 'USD', 'Reported rolling 24 hour spot volume', 'asset'),
  ('circulating_supply', 'Circulating supply', 'tokens', 'Tokens currently circulating', 'asset'),
  ('total_supply', 'Total supply', 'tokens', 'Reported total token supply', 'asset'),
  ('max_supply', 'Maximum supply', 'tokens', 'Maximum token supply where defined', 'asset'),
  ('tvl_usd', 'Total value locked', 'USD', 'Value held in protocol smart contracts; not a token balance-sheet metric', 'chain_or_protocol'),
  ('fees_24h_usd', 'Fees, 24 hour', 'USD', 'Gross user fees reported by the source for a chain or protocol', 'chain_or_protocol'),
  ('revenue_24h_usd', 'Revenue, 24 hour', 'USD', 'Protocol revenue retained by treasury or token holders when reported by the source', 'protocol')
on conflict (code) do nothing;
