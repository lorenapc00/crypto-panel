-- Stage 6 Backtest Lab. No new provider feed is added. The only working strategy
-- template, the BTC regime filter versus BTC buy-and-hold, reads the Coin Metrics
-- daily price series and the confirmed baseline regime already archived since
-- stage 2. Runs are queued and executed by the worker, then frozen: an identical
-- dataset and strategy version reproduces an identical result.
--
-- Attention-basket, early-launch and perp studies stay deferred until this archive
-- has accumulated the replay coverage they need; they are visible as gated
-- templates and the create route refuses them.

create table backtest_runs (
  id uuid primary key,
  created_at timestamptz not null default clock_timestamp(),
  template_key text not null,
  methodology_version text not null,
  -- sha256 over the frozen input. A succeeded run with a matching hash is returned
  -- as-is instead of recomputed, so reproducibility is observable from the API.
  input_hash text not null,
  input jsonb not null,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  lease_token text,
  lease_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  error text
);
create index backtest_runs_queued on backtest_runs (created_at) where status in ('queued','running');
create index backtest_runs_hash on backtest_runs (input_hash) where status = 'succeeded';

-- Append-only: a completed run is evidence. The executor still needs to move a row
-- queued -> running -> terminal and write the result once, so a row-level guard
-- permits exactly those transitions and freezes every terminal row and every
-- identity column.
create function reject_backtest_finalization() returns trigger language plpgsql as $$
begin
  if old.status in ('succeeded','failed') then
    raise exception 'A completed backtest run is immutable';
  end if;
  if new.id <> old.id or new.created_at <> old.created_at or new.template_key <> old.template_key
     or new.methodology_version <> old.methodology_version or new.input_hash <> old.input_hash
     or new.input is distinct from old.input then
    raise exception 'Backtest run inputs are immutable';
  end if;
  return new;
end;
$$;
create trigger backtest_runs_no_delete before delete or truncate
  on backtest_runs for each statement execute function reject_archive_mutation();
create trigger backtest_runs_guard before update
  on backtest_runs for each row execute function reject_backtest_finalization();
