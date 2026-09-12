import type { Pool } from 'pg';
import { loadRegimeInputs } from './archive.js';
import { portfolioBacktest, type Signal } from './portfolio.js';
import type { Condition, StrategySpec } from './strategy-spec.js';

export const MATRIX_METHOD = 'dca-matrix:v1';

type NamedCondition = { key: string; label: string; condition: Condition };
type BacktestResult = ReturnType<typeof portfolioBacktest>;
type LedgerEntries = BacktestResult['ledger']['entries'];

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
const FIXED_ENTRY = ENTRY_GUARDS.find(e => e.key === 'mvrv-lte1')!.condition;
const FIXED_EXIT = EXIT_TRIGGERS.find(x => x.key === 'mayer-gte2.4')!.condition;
const NONE_GUARD: Condition = { type: 'none' };

const FROM = '2018-01-01';
const COST_BPS = 25;
const HOLDOUT_PCT = 30;

function comboSpec(entry: Condition, exit: Condition, from: string | null, to: string | null): StrategySpec {
  return {
    startCapitalUsd: 0,
    contribution: { amountUsd: 1000, cadence: 'monthly', day: 1 },
    entry: { trigger: 'monthly', day: 1, guard: entry, size: { type: 'all-cash' }, redeploy: 'immediate' },
    exit: { trigger: exit, size: { type: 'all' } },
    costBps: COST_BPS, from, to, holdoutPct: HOLDOUT_PCT,
  };
}

/** Runs every entry x exit combination over an already-loaded signal series and returns
 *  only the summary a matrix cell needs -- not the full `portfolioBacktest` payload
 *  (equity curves, ledgers), which would be ~80x too heavy for a table of this size.
 *  Pure function (no DB), same split as `portfolioBacktest` itself, so the grid logic is
 *  unit-testable against a fixture series. */
export function dcaMatrixFromSignals(signals: Signal[]) {
  const cells = [];
  for (const entry of ENTRY_GUARDS) {
    for (const exit of EXIT_TRIGGERS) {
      try {
        const r = portfolioBacktest({ signals, spec: comboSpec(entry.condition, exit.condition, FROM, null) });
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
  return { cells };
}

// ---------------------------------------------------------------------------
// Threshold sensitivity: "is the chosen number special, or arbitrary?" Sweeps one
// threshold at a time, holding everything else -- including the other rule -- fixed,
// over the same full window as the grid.

const MAYER_THRESHOLDS = Array.from({ length: 25 }, (_, i) => Number((1.4 + i * 0.1).toFixed(1))); // 1.4 .. 3.8
const MVRV_THRESHOLDS = Array.from({ length: 21 }, (_, i) => Number((0.4 + i * 0.1).toFixed(1))); // 0.4 .. 2.4

/** "Is 2.4 special?" -- exit Mayer threshold swept 1.4->3.8, entry fixed to MVRV<=1.0
 *  (the winning combo) and, for comparison, to no guard at all. */
export function mayerExitSensitivity(signals: Signal[]) {
  const mvrv: (number | null)[] = [], none: (number | null)[] = [], mvrvDd: (number | null)[] = [], noneDd: (number | null)[] = [];
  for (const threshold of MAYER_THRESHOLDS) {
    const exit: Condition = { type: 'mayer', op: 'gte', value: threshold };
    const a = portfolioBacktest({ signals, spec: comboSpec(FIXED_ENTRY, exit, FROM, null) });
    const b = portfolioBacktest({ signals, spec: comboSpec(NONE_GUARD, exit, FROM, null) });
    mvrv.push(a.strategy.metrics.moneyWeightedReturnPct); mvrvDd.push(a.strategy.metrics.maxDrawdownPct);
    none.push(b.strategy.metrics.moneyWeightedReturnPct); noneDd.push(b.strategy.metrics.maxDrawdownPct);
  }
  return { thresholds: MAYER_THRESHOLDS, mvrvEntry: mvrv, mvrvEntryDd: mvrvDd, noGuard: none, noGuardDd: noneDd };
}

/** "Is 1.0 special?" -- entry MVRV threshold swept 0.4->2.4, exit fixed to Mayer>=2.4
 *  and, for comparison, to no exit (hold forever). */
export function mvrvEntrySensitivity(signals: Signal[]) {
  const mayerExit: (number | null)[] = [], noExit: (number | null)[] = [], mayerExitDd: (number | null)[] = [], noExitDd: (number | null)[] = [], trades: (number | null)[] = [];
  for (const threshold of MVRV_THRESHOLDS) {
    const entry: Condition = { type: 'mvrv', op: 'lte', value: threshold };
    const a = portfolioBacktest({ signals, spec: comboSpec(entry, FIXED_EXIT, FROM, null) });
    const b = portfolioBacktest({ signals, spec: comboSpec(entry, NONE_GUARD, FROM, null) });
    mayerExit.push(a.strategy.metrics.moneyWeightedReturnPct); mayerExitDd.push(a.strategy.metrics.maxDrawdownPct);
    trades.push(a.strategy.trades.total);
    noExit.push(b.strategy.metrics.moneyWeightedReturnPct); noExitDd.push(b.strategy.metrics.maxDrawdownPct);
  }
  return { thresholds: MVRV_THRESHOLDS, mayerExit, mayerExitDd, noExit, noExitDd, trades };
}

// ---------------------------------------------------------------------------
// Robustness: is the grid's best cell (MVRV<=1.0 entry, Mayer>=2.4 exit) a real,
// repeatable edge, or one lucky window? Three checks: judge each halving cycle on its
// own (not cumulatively), watch the edge over DCA-hold as the end date creeps forward,
// and show every trade the winning combo actually made.

// Public, well-known Bitcoin halving dates -- not archived data, so hardcoding them
// here (rather than reading from a provenance-tracked feed) is fine; unlike FOMC dates
// or price history, these never move.
const HALVING_3 = '2020-05-11';
const HALVING_4 = '2024-04-20';

function dayBefore(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Dec-31/Jun-30 boundaries from 2020-12-31 up to (not including) `lastDate`, then
 *  `lastDate` itself as the final point -- an expanding `from: FROM` window whose end
 *  date walks forward in roughly-semiannual steps. */
function expandingDates(lastDate: string): string[] {
  const dates: string[] = [];
  let year = 2020, half: 1 | 2 = 2;
  while (true) {
    const d = half === 1 ? `${year}-06-30` : `${year}-12-31`;
    if (d >= lastDate) break;
    dates.push(d);
    if (half === 2) { half = 1; year++; } else { half = 2; }
  }
  dates.push(lastDate);
  return dates;
}

export function robustnessCheck(signals: Signal[]) {
  const segmentBounds: { label: string; from: string; to: string | null }[] = [
    { label: 'Pre-2020 halving', from: FROM, to: dayBefore(HALVING_3) },
    { label: '2020 halving cycle', from: HALVING_3, to: dayBefore(HALVING_4) },
    { label: '2024 halving cycle (current, incomplete)', from: HALVING_4, to: null },
  ];
  const segments = segmentBounds.map(seg => {
    const r = portfolioBacktest({ signals, spec: comboSpec(FIXED_ENTRY, FIXED_EXIT, seg.from, seg.to) });
    return {
      label: seg.label,
      strategy: r.strategy.metrics.moneyWeightedReturnPct, dca: r.benchmarks.dcaHold.metrics.moneyWeightedReturnPct,
      strategyDD: r.strategy.metrics.maxDrawdownPct, dcaDD: r.benchmarks.dcaHold.metrics.maxDrawdownPct,
      trades: r.strategy.trades.total,
    };
  });

  const lastDate = signals[signals.length - 1].observedAt.slice(0, 10);
  const expanding = expandingDates(lastDate).map(to => {
    const r = portfolioBacktest({ signals, spec: comboSpec(FIXED_ENTRY, FIXED_EXIT, FROM, to) });
    return { to, strategy: r.strategy.metrics.moneyWeightedReturnPct, dca: r.benchmarks.dcaHold.metrics.moneyWeightedReturnPct };
  });

  const full = portfolioBacktest({ signals, spec: comboSpec(FIXED_ENTRY, FIXED_EXIT, FROM, null) });
  return {
    combo: { entryLabel: 'MVRV <= 1.0', exitLabel: 'Mayer >= 2.4' },
    segments, expanding,
    ledger: full.ledger.entries,
  };
}

// ---------------------------------------------------------------------------
// Adaptive: does making the thresholds cycle-relative (trailing-window percentile
// instead of a fixed number) actually help? Same combo shape, self-adjusting.

const ADAPTIVE_WINDOW_DAYS = 1095, ADAPTIVE_ENTRY_PCT = 10, ADAPTIVE_EXIT_PCT = 90;
const ADAPTIVE_ENTRY: Condition = { type: 'mvrv-percentile', op: 'lte', percentile: ADAPTIVE_ENTRY_PCT, windowDays: ADAPTIVE_WINDOW_DAYS };
const ADAPTIVE_EXIT: Condition = { type: 'mayer-percentile', op: 'gte', percentile: ADAPTIVE_EXIT_PCT, windowDays: ADAPTIVE_WINDOW_DAYS };

export function adaptiveComparison(signals: Signal[]) {
  const windows: { label: string; from: string; to: string | null }[] = [
    { label: 'Pre-2020 halving', from: FROM, to: dayBefore(HALVING_3) },
    { label: '2020 halving cycle', from: HALVING_3, to: dayBefore(HALVING_4) },
    { label: '2024 halving cycle (current, incomplete)', from: HALVING_4, to: null },
    { label: 'Full window', from: FROM, to: null },
  ];
  let fullAdaptiveLedger: LedgerEntries = [];
  const rows = windows.map(w => {
    const fixedR = portfolioBacktest({ signals, spec: comboSpec(FIXED_ENTRY, FIXED_EXIT, w.from, w.to) });
    const adaptiveR = portfolioBacktest({ signals, spec: comboSpec(ADAPTIVE_ENTRY, ADAPTIVE_EXIT, w.from, w.to) });
    if (w.from === FROM && w.to === null) fullAdaptiveLedger = adaptiveR.ledger.entries;
    return { label: w.label, dca: fixedR.benchmarks.dcaHold.metrics.moneyWeightedReturnPct,
      fixed: fixedR.strategy.metrics.moneyWeightedReturnPct, adaptive: adaptiveR.strategy.metrics.moneyWeightedReturnPct };
  });
  return { windowDays: ADAPTIVE_WINDOW_DAYS, entryPercentile: ADAPTIVE_ENTRY_PCT, exitPercentile: ADAPTIVE_EXIT_PCT, rows, ledger: fullAdaptiveLedger };
}

// ---------------------------------------------------------------------------

/** The full report: grid + both sensitivity sweeps + robustness check + adaptive
 *  comparison, all live-computed over the same signal series. Pure function, no DB --
 *  `dcaMatrix` below is the thin DB-backed wrapper. */
export function fullMatrixReport(signals: Signal[]) {
  return {
    methodologyVersion: MATRIX_METHOD,
    classification: 'historical-reconstruction' as const,
    params: { from: FROM, costBps: COST_BPS, holdoutPct: HOLDOUT_PCT, contributionUsd: 1000 },
    grid: dcaMatrixFromSignals(signals),
    mayerExitSensitivity: mayerExitSensitivity(signals),
    mvrvEntrySensitivity: mvrvEntrySensitivity(signals),
    robustness: robustnessCheck(signals),
    adaptive: adaptiveComparison(signals),
    note: 'Every combination shares the same $1,000/month contribution, 25bps cost and '
      + '2018-01-01 start; only the entry guard and exit trigger change. This reproduces, '
      + 'live against the current archive, the sweep that produced the cross-cycle finding '
      + 'in docs/data/PLANS_MACRO_AND_ML.md: fixed technical thresholds (Mayer, MVRV, '
      + 'drawdown) generally do not survive out-of-sample validation or cross-cycle '
      + 'scrutiny once they fit one window too closely. Read the sensitivity and '
      + 'robustness sections, not the grid alone, before trusting any single cell.',
  };
}

/** DB-backed wrapper: loads the current archive (or its state as of `asOf`, for replay)
 *  and runs the full report over it. */
export async function dcaMatrix(database: Pool, asOf?: string) {
  const inputs = await loadRegimeInputs(database, asOf);
  return { ...fullMatrixReport(inputs.signals), dataset: inputs.dataset };
}
