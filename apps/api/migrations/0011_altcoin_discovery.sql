-- Stage 5 broader altcoin research. No new provider feed is added: Emerging Projects
-- compose the archived market snapshots and daily price/volume series, and the spot
-- launch screen composes the sampled pool and pair archives that have been running
-- since stage 1. The 1,000-asset acquisition universe stays gated on the stage 0 budget.

-- Curated, immutable, versioned universe exclusions. "Exclude stablecoins and duplicate
-- wrapped representations" is a judgement about an asset's identity, not something that
-- can be inferred from a price feed at read time. Each row records its own evidence, and
-- a wrapped representation names the canonical asset it duplicates. Assets absent from
-- this table are not asserted to be independent projects; they are simply not excluded.
create table asset_universe_exclusions (
  id bigint generated always as identity primary key,
  -- The CoinGecko identity. Deliberately not a foreign key: an exclusion is recorded
  -- before that asset has ever entered the archived tracked page, and must still apply
  -- on the first snapshot that contains it.
  asset_id text not null,
  symbol text not null,
  reason text not null check (reason in ('stablecoin','wrapped-duplicate','tokenized-fund','commodity-backed')),
  canonical_asset_id text,
  evidence text not null,
  methodology_version text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  -- Only a wrapped duplicate names another asset; the other reasons stand alone.
  constraint asset_universe_exclusions_canonical check ((canonical_asset_id is not null) = (reason = 'wrapped-duplicate'))
);
create index asset_universe_exclusions_lookup on asset_universe_exclusions(asset_id,recorded_at desc,id desc);
create trigger asset_universe_exclusions_immutable before update or delete or truncate
  on asset_universe_exclusions for each statement execute function reject_archive_mutation();

insert into asset_universe_exclusions (asset_id,symbol,reason,canonical_asset_id,evidence,methodology_version) values
  ('tether','USDT','stablecoin',null,'USD-pegged stablecoin; also carried in the archived DefiLlama peggedUSD catalog','universe-exclusions:v1'),
  ('usd-coin','USDC','stablecoin',null,'USD-pegged stablecoin; also carried in the archived DefiLlama peggedUSD catalog','universe-exclusions:v1'),
  ('usds','USDS','stablecoin',null,'USD-pegged stablecoin issued by Sky; also carried in the archived DefiLlama peggedUSD catalog','universe-exclusions:v1'),
  ('dai','DAI','stablecoin',null,'USD-pegged stablecoin; also carried in the archived DefiLlama peggedUSD catalog','universe-exclusions:v1'),
  ('ethena-usde','USDE','stablecoin',null,'USD-pegged synthetic dollar; also carried in the archived DefiLlama peggedUSD catalog','universe-exclusions:v1'),
  ('usd1-wlfi','USD1','stablecoin',null,'USD-pegged stablecoin; also carried in the archived DefiLlama peggedUSD catalog','universe-exclusions:v1'),
  ('global-dollar','USDG','stablecoin',null,'USD-pegged stablecoin; also carried in the archived DefiLlama peggedUSD catalog','universe-exclusions:v1'),
  ('paypal-usd','PYUSD','stablecoin',null,'USD-pegged stablecoin; also carried in the archived DefiLlama peggedUSD catalog','universe-exclusions:v1'),
  ('ripple-usd','RLUSD','stablecoin',null,'USD-pegged stablecoin; also carried in the archived DefiLlama peggedUSD catalog','universe-exclusions:v1'),
  ('usdd','USDD','stablecoin',null,'USD-pegged stablecoin; also carried in the archived DefiLlama peggedUSD catalog','universe-exclusions:v1'),
  ('usdgo','USDGO','stablecoin',null,'USD-pegged stablecoin; also carried in the archived DefiLlama peggedUSD catalog','universe-exclusions:v1'),
  ('falcon-finance','USDF','stablecoin',null,'USD-pegged synthetic dollar; also carried in the archived DefiLlama peggedUSD catalog','universe-exclusions:v1'),
  ('bfusd','BFUSD','stablecoin',null,'USD-pegged yield-bearing dollar token','universe-exclusions:v1'),
  ('gho','GHO','stablecoin',null,'USD-pegged stablecoin issued by Aave; also carried in the archived DefiLlama peggedUSD catalog','universe-exclusions:v1'),
  ('ondo-us-dollar-yield','USDY','tokenized-fund',null,'Tokenized yield-bearing US dollar note, not an independent crypto project','universe-exclusions:v1'),
  ('hashnote-usyc','USYC','tokenized-fund',null,'Tokenized short-duration treasury fund share','universe-exclusions:v1'),
  ('blackrock-usd-institutional-digital-liquidity-fund','BUIDL','tokenized-fund',null,'Tokenized institutional liquidity fund share','universe-exclusions:v1'),
  ('superstate-short-duration-us-government-securities-fund-ustb','USTB','tokenized-fund',null,'Tokenized US government securities fund share','universe-exclusions:v1'),
  ('janus-henderson-anemoy-treasury-fund','JTRSY','tokenized-fund',null,'Tokenized treasury fund share','universe-exclusions:v1'),
  ('janus-henderson-anemoy-aaa-clo-fund','JAAA','tokenized-fund',null,'Tokenized AAA CLO fund share','universe-exclusions:v1'),
  ('spiko-amundi-overnight-swap-fund-eur','EURSAFO','tokenized-fund',null,'Tokenized EUR overnight fund share','universe-exclusions:v1'),
  ('eutbl','EUTBL','tokenized-fund',null,'Tokenized EUR treasury bill fund share','universe-exclusions:v1'),
  ('blockchain-capital','BCAP','tokenized-fund',null,'Tokenized venture fund share','universe-exclusions:v1'),
  ('figure-heloc','FIGR_HELOC','tokenized-fund',null,'Tokenized home-equity credit pool, not an independent crypto project','universe-exclusions:v1'),
  ('tether-gold','XAUT','commodity-backed',null,'Gold-backed token; its return is the metal price, not a crypto project outcome','universe-exclusions:v1'),
  ('pax-gold','PAXG','commodity-backed',null,'Gold-backed token; its return is the metal price, not a crypto project outcome','universe-exclusions:v1'),
  ('wrapped-bitcoin','WBTC','wrapped-duplicate','bitcoin','Wrapped BTC representation; its price tracks the canonical asset and would double count it','universe-exclusions:v1'),
  ('coinbase-wrapped-btc','CBBTC','wrapped-duplicate','bitcoin','Wrapped BTC representation; its price tracks the canonical asset and would double count it','universe-exclusions:v1'),
  ('weth','WETH','wrapped-duplicate','ethereum','Wrapped ETH representation; its price tracks the canonical asset and would double count it','universe-exclusions:v1'),
  ('staked-ether','STETH','wrapped-duplicate','ethereum','Liquid staking representation of ETH; its price tracks the canonical asset and would double count it','universe-exclusions:v1'),
  ('wrapped-steth','WSTETH','wrapped-duplicate','ethereum','Wrapped liquid staking representation of ETH; its price tracks the canonical asset and would double count it','universe-exclusions:v1'),
  ('binance-bridged-usdt-bnb-smart-chain','BSC-USD','stablecoin',null,'Bridged USD-pegged stablecoin representation','universe-exclusions:v1');

-- Curated, immutable quote-token identities for the sampled spot pools. A pool is priced
-- in its quote token, so a base token paired only against an unrecognised quote has no
-- verified USD reference. Recognising a quote token is not a safety or liquidity claim.
create table spot_quote_tokens (
  id bigint generated always as identity primary key,
  chain text not null check (chain in ('solana','base')),
  token_address text not null,
  symbol text not null,
  kind text not null check (kind in ('native-wrapped','stablecoin')),
  evidence text not null,
  methodology_version text not null,
  recorded_at timestamptz not null default clock_timestamp()
);
create index spot_quote_tokens_lookup on spot_quote_tokens(chain,token_address,recorded_at desc,id desc);
create trigger spot_quote_tokens_immutable before update or delete or truncate
  on spot_quote_tokens for each statement execute function reject_archive_mutation();

insert into spot_quote_tokens (chain,token_address,symbol,kind,evidence,methodology_version) values
  ('solana','So11111111111111111111111111111111111111112','WSOL','native-wrapped','Wrapped SOL, the native quote token of Solana pools','spot-quotes:v1'),
  ('solana','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','USDC','stablecoin','Circle USDC on Solana','spot-quotes:v1'),
  ('solana','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB','USDT','stablecoin','Tether USDT on Solana','spot-quotes:v1'),
  ('base','0x4200000000000000000000000000000000000006','WETH','native-wrapped','Wrapped ETH, the native quote token of Base pools','spot-quotes:v1'),
  ('base','0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','USDC','stablecoin','Circle USDC on Base','spot-quotes:v1'),
  ('base','0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca','USDBC','stablecoin','Bridged USD Base Coin on Base','spot-quotes:v1');
