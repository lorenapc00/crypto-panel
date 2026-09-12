import type { Pool } from 'pg';
import { loadRegimeInputs } from './archive.js';
import { portfolioBacktest, type Signal } from './portfolio.js';
import type { Condition } from './strategy-spec.js';

export const MATRIX_METHOD = 'dca-matrix:v1';

type NamedCondition = { key: string; label: string; condition: Condition };

/** Every entry guard and exit trigger crossed pairwise into the matrix. This is the same
 *  grid that produced the "fixed thresholds don't survive cross-cycle validation"
 *  finding (docs/data/PLANS_MACRO_AND_ML.md, Stage B context) -- kept here as a live,
 *  re-runnable view rather than a frozen one-off script result. */
export const ENTRY_GUARDS: NamedCondition[] = [
  { key: 'none', label: 'No guard (pure monthly DCA)', condition: { type: 'none' } },
  { key: 'regime-bull', label: 'Regime: bullish only', condition: { type: 'regime-in', regimes: ['bullish'] } },
  { key: 'regime-bull-trans', label: 'Regime: bullish or transitional', condition: { type: 'regime-in', regimes: ['bullish', 'transitional'] } },
  { key: 'dd20', label: 'Drawdown from ATH >= 20%', condition: { type: 'drawdown-from-ath', op: 'gte', pct: 20 } },
  { key: 'mayer-lte1', label: 'Mayer <= 1.0', condition: { type: 'mayer', op: 'lte', value: 1.0 } },
  { key: 'below-sma200', label: 'Price below 200D SMA', condition: { type: 'price-vs-sma200', side: 'below' } },
  { key: 'rsi-lte30', label: 'Weekly RSI <= 30', condition: { type: 'weekly-rsi', op: 'lte', value: 30 } },
  { key: 'mvrv-lte1', label: 'MVRV <= 1.0', condition: { type: 'mvrv', op: 'lte', value: 1.0 } },
  { key: 'fg-lte25', label: 'Fear & Greed <= 25', condition: { type: 'fear-greed', op: 'lte', value: 25 } },
];
export const EXIT_TRIGGERS: NamedCondition[] = [
  { key: 'none', label: 'Never sell (hold)', condition: { type: 'none' } },
  { key: 'regime-leave', label: 'Regime leaves bullish', condition: { type: 'regime-leave', regimes: ['bullish'] } },
  { key: 'new-ath', label: 'Every new ATH', condition: { type: 'new-ath' } },
  { key: 'dd20', label: 'Drawdown from ATH >= 20%', condition: { type: 'drawdown-from-ath', op: 'gte', pct: 20 } },
  { key: 'mayer-gte2.4', label: 'Mayer >= 2.4', condition: { type: 'mayer', op: 'gte', value: 2.4 } },
  { key: 'below-sma200', label: 'Price crosses below 200D SMA', condition: { type: 'price-vs-sma200', side: 'below' } },
  { key: 'rsi-gte70', label: 'Weekly RSI >= 70', condition: { type: 'weekly-rsi', op: 'gte', value: 70 } },
  { key: 'mvrv-gte3', label: 'MVRV >= 3.0', condition: { type: 'mvrv', op: 'gte', value: 3.0 } },
  { key: 'fg-gte75', label: 'Fear & Greed >= 75', condition: { type: 'fear-greed', op: 'gte', value: 75 } },
];

const FROM = '2018-01-01';
const COST_BPS = 25;
const HOLDOUT_PCT = 30;

/** Runs every entry x exit combination over an already-loaded signal series and returns
 *  only the summary a matrix cell needs -- not the full `portfolioBacktest` payload
 *  (equity curves, ledgers), which would be ~80x too heavy for a table of this size.
 *  Pure function (no DB), same split as `portfolioBacktest` itself, so the grid logic is
 *  unit-testable against a fixture series. */
export function dcaMatrixFromSignals(signals: Signal[]) {
  const cells = [];
  for (const entry of ENTRY_GUARDS) {
    for (const exit of EXIT_TRIGGERS) {
      const spec = {
        startCapitalUsd: 0,
        contribution: { amountUsd: 1000, cadence: 'monthly' as const, day: 1 },
        entry: { trigger: 'monthly' as const, day: 1, guard: entry.condition, size: { type: 'all-cash' as const }, redeploy: 'immediate' as const },
        exit: { trigger: exit.condition, size: { type: 'all' as const } },
        costBps: COST_BPS, from: FROM, to: null, holdoutPct: HOLDOUT_PCT,
      };
      try {
        const r = portfolioBacktest({ signals, spec });
        cells.push({
          entryKey: entry.key, entryLabel: entry.label, exitKey: exit.key, exitLabel: exit.label,
          moneyWeightedReturnPct: r.strategy.metrics.moneyWeightedReturnPct,
          endingEquityUsd: r.strategy.metrics.endingEquityUsd,
          profitPct: r.strategy.metrics.profitPct,
          maxDrawdownPct: r.strategy.metrics.maxDrawdownPct,
          timeInMarketPct: r.strategy.timeInMarketPct,
          trades: r.strategy.trades.total,
          dcaHold: { moneyWeightedReturnPct: r.benchmarks.dcaHold.metrics.moneyWeightedReturnPct, maxDrawdownPct: r.benchmarks.dcaHold.metrics.maxDrawdownPct },
          lumpSum: { moneyWeightedReturnPct: r.benchmarks.lumpSum.metrics.moneyWeightedReturnPct, maxDrawdownPct: r.benchmarks.lumpSum.metrics.maxDrawdownPct },
          outOfSample: { moneyWeightedReturnPct: r.holdout.outOfSample.strategy.moneyWeightedReturnPct, maxDrawdownPct: r.holdout.outOfSample.strategy.maxDrawdownPct },
          window: r.window,
          error: null as string | null,
        });
      } catch (error) {
        cells.push({ entryKey: entry.key, entryLabel: entry.label, exitKey: exit.key, exitLabel: exit.label, error: error instanceof Error ? error.message : 'Backtest failed' });
      }
    }
  }
  return {
    methodologyVersion: MATRIX_METHOD,
    classification: 'historical-reconstruction' as const,
    params: { from: FROM, costBps: COST_BPS, holdoutPct: HOLDOUT_PCT, contributionUsd: 1000 },
    cells,
    note: 'Every cell is a full portfolio backtest (monthly $1,000 DCA, 25bps cost, 30% holdout) '
      + 'over the same guard and trigger grid that produced the cross-cycle finding in '
      + 'docs/data/PLANS_MACRO_AND_ML.md: fixed technical thresholds (Mayer, MVRV, drawdown) '
      + 'generally do not survive out-of-sample validation once they fit one cycle too closely. '
      + 'Read the out-of-sample column, not the headline return, before trusting any single cell.',
  };
}

/** DB-backed wrapper: loads the current archive (or its state as of `asOf`, for replay)
 *  and runs the matrix over it. */
export async function dcaMatrix(database: Pool, asOf?: string) {
  const inputs = await loadRegimeInputs(database, asOf);
  return { ...dcaMatrixFromSignals(inputs.signals), dataset: inputs.dataset };
}
