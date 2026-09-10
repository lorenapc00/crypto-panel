-- Reuse the leased, quota-controlled snapshot archive for the remaining reads.
-- Existing dataset definitions and payloads remain immutable.
alter table discovery_datasets drop constraint discovery_datasets_kind_check;
alter table discovery_datasets add constraint discovery_datasets_kind_check
  check (kind in ('protocols','namespaces','instruments','pools','market','global','fundamental','issuance'));

insert into sources (id, name, url, license) values
  ('mempool', 'mempool.space', 'https://mempool.space/docs/api/rest', 'Provider terms apply'),
  ('solana-rpc', 'Solana mainnet RPC', 'https://solana.com/docs/rpc', 'Provider terms apply')
on conflict (id) do nothing;

-- Legacy snapshot rows have no payload or membership provenance. Preserve them
-- for inspection, but prevent new writes and never use them as replay evidence.
create trigger legacy_observations_immutable before insert or update or delete or truncate
  on observations for each statement execute function reject_archive_mutation();
