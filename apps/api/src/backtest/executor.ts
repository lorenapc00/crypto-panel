import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { regimeStrategyBacktest, type RegimeStrategyParams } from './calculations.js';
import { loadRegimeInputs } from './archive.js';

export type BacktestRun = {
  id: string;
  template_key: string;
  methodology_version: string;
  input: { templateKey: string; methodologyVersion: string; params: Record<string, unknown>; datasetCoverageStart: string | null };
};

/** One queued run, moved to `running` under a 90-second lease. Independent workers
 *  cannot both claim it; a crash lets the lease lapse and the row is reclaimed. */
export async function claimBacktest(database: Pool): Promise<BacktestRun | null> {
  const claimed = await database.query(
    `update backtest_runs set status='running', lease_token=$1,
       lease_until=clock_timestamp() + interval '90 seconds', started_at=coalesce(started_at, clock_timestamp())
     where id = (
       select id from backtest_runs
       where status='queued' or (status='running' and lease_until < clock_timestamp())
       order by created_at, id for update skip locked limit 1)
     returning id, template_key, methodology_version, input, lease_token`,
    [randomUUID()],
  );
  return claimed.rows[0] ? { ...claimed.rows[0], lease_token: claimed.rows[0].lease_token } : null;
}

async function compute(database: Pool, run: BacktestRun) {
  if (run.template_key !== 'btc-regime-filter') throw new Error(`No executor for template ${run.template_key}`);
  const params = run.input.params as unknown as RegimeStrategyParams;
  const inputs = await loadRegimeInputs(database);
  const backtest = regimeStrategyBacktest({ prices: inputs.prices, regimes: inputs.regimes, params });
  return { ...backtest, dataset: inputs.dataset, generatedAt: new Date().toISOString() };
}

export async function executeBacktest(database: Pool, run: BacktestRun) {
  try {
    const result = await compute(database, run);
    const done = await database.query(
      `update backtest_runs set status='succeeded', result=$2, finished_at=clock_timestamp(), error=null
       where id=$1 and status='running' returning id`,
      [run.id, result],
    );
    return done.rowCount ? 'succeeded' : 'lost-lease';
  } catch (error) {
    await database.query(
      `update backtest_runs set status='failed', error=$2, finished_at=clock_timestamp()
       where id=$1 and status='running'`,
      [run.id, error instanceof Error ? error.message : 'Backtest failed'],
    );
    return 'failed';
  }
}

/** Drain the queue. Called on every worker tick and once by `worker --once`. */
export async function runBacktests(database: Pool) {
  const outcomes: string[] = [];
  for (let guard = 0; guard < 50; guard++) {
    const run = await claimBacktest(database);
    if (!run) break;
    outcomes.push(`${run.id}:${await executeBacktest(database, run)}`);
  }
  return outcomes;
}
