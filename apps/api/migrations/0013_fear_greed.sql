-- Crypto Fear & Greed Index (alternative.me). No new tables: this reuses
-- data_series / series_observations / replay_coverage exactly like the
-- DefiLlama stablecoin-supply feed. One daily job resends the full published
-- history each time; appendSeries dedupes unchanged values.

insert into sources (id,name,url,license) values
  ('alternative-me','Alternative.me Fear & Greed Index','https://alternative.me/crypto/fear-and-greed-index/',
   'Attribution required next to displayed data; commercial use allowed with attribution');

-- The index has no asset identity, exactly like stablecoin supply and covered open interest.
alter table data_series drop constraint data_series_subject_scope;
alter table data_series add constraint data_series_subject_scope
  check ((asset_id is null) = (scope in ('covered_usd_pegged_stablecoins','covered_perp_open_interest','crypto_market_sentiment')));

insert into metric_definitions (code,name,unit,formula,scope) values
  ('fear_greed_index','Crypto Fear & Greed Index','index',
   'Alternative.me composite sentiment index (0=extreme fear,100=extreme greed); provider composite methodology not independently verified',
   'crypto_market_sentiment');
