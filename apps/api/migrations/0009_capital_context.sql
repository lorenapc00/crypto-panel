-- A market aggregate has no asset identity; never create a tradable pseudo-asset.
alter table data_series alter column asset_id drop not null;
alter table data_series add constraint data_series_subject_scope
  check ((asset_id is null and scope='covered_usd_pegged_stablecoins') or
    (asset_id is not null and scope<>'covered_usd_pegged_stablecoins'));

insert into metric_definitions (code,name,unit,formula,scope) values
  ('stablecoin_supply_usd','Covered USD-pegged circulating supply','USD',
   'DefiLlama stablecoincharts/all totalCirculatingUSD.peggedUSD; provider coverage varies over time; not net inflows',
   'covered_usd_pegged_stablecoins');
