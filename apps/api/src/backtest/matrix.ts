import type { Pool } from 'pg';
import { loadRegimeInputs } from './archive.js';
import { portfolioBacktest, type Signal } from './portfolio.js';
import type { Condition, Op, StrategySpec } from './strategy-spec.js';

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
const NONE: Condition = { type: 'none' };

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
// Per-cell deep dive: click any grid cell and stress-test its own entry/exit
// conditions -- threshold sensitivity for every threshold-bearing condition, a
// cross-cycle robustness check, and (when applicable) the adaptive-percentile
// comparison. Computed on demand (see `cellDeepDive` / `dcaMatrixCell`), not baked
// into the always-on grid report, so the grid itself stays cheap to load.

type ThresholdMetric = 'mayer' | 'mvrv' | 'drawdown-from-ath' | 'weekly-rsi' | 'fear-greed';
type ThresholdCondition = Extract<Condition, { type: ThresholdMetric }>;

const METRIC_LABEL: Record<ThresholdMetric, string> = {
  mayer: 'Mayer', mvrv: 'MVRV', 'drawdown-from-ath': 'Drawdown from ATH', 'weekly-rsi': 'Weekly RSI', 'fear-greed': 'Fear & Greed',
};
// One sweep range per metric, wide enough to make sense whether the condition is
// used as an entry guard (typically `lte`) or an exit trigger (typically `gte`).
const THRESHOLD_CONFIG: Record<ThresholdMetric, number[]> = {
  mayer: Array.from({ length: 36 }, (_, i) => Number((0.5 + i * 0.1).toFixed(1))), // 0.5 .. 4.0
  mvrv: Array.from({ length: 29 }, (_, i) => Number((0.2 + i * 0.1).toFixed(1))), // 0.2 .. 3.0
  'drawdown-from-ath': Array.from({ length: 12 }, (_, i) => 5 + i * 5), // 5 .. 60
  'weekly-rsi': Array.from({ length: 17 }, (_, i) => 10 + i * 5), // 10 .. 90
  'fear-greed': Array.from({ length: 17 }, (_, i) => 10 + i * 5), // 10 .. 90
};

function isThresholdCondition(c: Condition): c is ThresholdCondition {
  return c.type === 'mayer' || c.type === 'mvrv' || c.type === 'drawdown-from-ath' || c.type === 'weekly-rsi' || c.type === 'fear-greed';
}
function buildThresholdCondition(metric: ThresholdMetric, op: Op, threshold: number): ThresholdCondition {
  switch (metric) {
    case 'drawdown-from-ath': return { type: 'drawdown-from-ath', op, pct: threshold };
    case 'mayer': return { type: 'mayer', op, value: threshold };
    case 'mvrv': return { type: 'mvrv', op, value: threshold };
    case 'weekly-rsi': return { type: 'weekly-rsi', op, value: threshold };
    case 'fear-greed': return { type: 'fear-greed', op, value: threshold };
  }
}

/** Sweeps one side's threshold from `THRESHOLD_CONFIG[metric]`, holding the *other*
 *  side fixed two ways: at the clicked cell's actual condition ("withOther") and at
 *  neutral -- no guard for an entry sweep, never-sell for an exit sweep ("baseline")
 *  -- so the chart shows both "does this threshold matter paired with what was
 *  clicked" and "does it matter on its own." */
function thresholdSweep(signals: Signal[], side: 'entry' | 'exit', metric: ThresholdMetric, op: Op, otherCondition: Condition, otherLabel: string) {
  const thresholds = THRESHOLD_CONFIG[metric];
  const withOther: (number | null)[] = [], withOtherDd: (number | null)[] = [], trades: (number | null)[] = [];
  const baseline: (number | null)[] = [], baselineDd: (number | null)[] = [];
  for (const threshold of thresholds) {
    const swept = buildThresholdCondition(metric, op, threshold);
    const a = portfolioBacktest({ signals, spec: comboSpec(side === 'entry' ? swept : otherCondition, side === 'exit' ? swept : otherCondition, FROM, null) });
    withOther.push(a.strategy.metrics.moneyWeightedReturnPct); withOtherDd.push(a.strategy.metrics.maxDrawdownPct); trades.push(a.strategy.trades.total);
    const b = portfolioBacktest({ signals, spec: comboSpec(side === 'entry' ? swept : NONE, side === 'exit' ? swept : NONE, FROM, null) });
    baseline.push(b.strategy.metrics.moneyWeightedReturnPct); baselineDd.push(b.strategy.metrics.maxDrawdownPct);
  }
  return {
    metric, metricLabel: METRIC_LABEL[metric], side, op, thresholds, trades,
    withOther, withOtherDd, otherLabel: `${side === 'entry' ? 'Exit' : 'Entry'}: ${otherLabel}`,
    baseline, baselineDd, baselineLabel: side === 'entry' ? 'Exit: none (hold)' : 'Entry: no guard',
  };
}

// ---------------------------------------------------------------------------
// Robustness: is a cell's result a real, repeatable edge, or one lucky window? Three
// checks: judge each halving cycle on its own (not cumulatively), watch the edge over
// DCA-hold as the end date creeps forward, and show every trade the combo actually made.

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

function robustnessCheck(signals: Signal[], entry: Condition, exit: Condition, entryLabel: string, exitLabel: string) {
  const segmentBounds: { label: string; from: string; to: string | null }[] = [
    { label: 'Pre-2020 halving', from: FROM, to: dayBefore(HALVING_3) },
    { label: '2020 halving cycle', from: HALVING_3, to: dayBefore(HALVING_4) },
    { label: '2024 halving cycle (current, incomplete)', from: HALVING_4, to: null },
  ];
  const segments = segmentBounds.map(seg => {
    const r = portfolioBacktest({ signals, spec: comboSpec(entry, exit, seg.from, seg.to) });
    return {
      label: seg.label,
      strategy: r.strategy.metrics.moneyWeightedReturnPct, dca: r.benchmarks.dcaHold.metrics.moneyWeightedReturnPct,
      strategyDD: r.strategy.metrics.maxDrawdownPct, dcaDD: r.benchmarks.dcaHold.metrics.maxDrawdownPct,
      trades: r.strategy.trades.total,
    };
  });

  const lastDate = signals[signals.length - 1].observedAt.slice(0, 10);
  const expanding = expandingDates(lastDate).map(to => {
    const r = portfolioBacktest({ signals, spec: comboSpec(entry, exit, FROM, to) });
    return { to, strategy: r.strategy.metrics.moneyWeightedReturnPct, dca: r.benchmarks.dcaHold.metrics.moneyWeightedReturnPct };
  });

  const full = portfolioBacktest({ signals, spec: comboSpec(entry, exit, FROM, null) });
  return { combo: { entryLabel, exitLabel }, segments, expanding, ledger: full.ledger.entries };
}

// ---------------------------------------------------------------------------
// Adaptive: does making the thresholds cycle-relative (trailing-window percentile
// instead of a fixed number) actually help? Only meaningful for a Mayer/MVRV pairing
// (either arrangement) -- the engine's percentile conditions cover just those two
// metrics (docs/data/BACKTEST_LAB.md); Drawdown/RSI/Fear&Greed pairings skip this
// section rather than fake an equivalent that doesn't exist yet.

const ADAPTIVE_WINDOW_DAYS = 1095, ADAPTIVE_ENTRY_PCT = 10, ADAPTIVE_EXIT_PCT = 90;

function isMayer(c: Condition): c is Extract<Condition, { type: 'mayer' }> { return c.type === 'mayer'; }
function isMvrv(c: Condition): c is Extract<Condition, { type: 'mvrv' }> { return c.type === 'mvrv'; }

function adaptiveComparison(signals: Signal[], entry: Condition, exit: Condition, entryLabel: string, exitLabel: string) {
  let adaptiveEntry: Condition, adaptiveExit: Condition;
  if (isMvrv(entry) && isMayer(exit)) {
    adaptiveEntry = { type: 'mvrv-percentile', op: entry.op, percentile: ADAPTIVE_ENTRY_PCT, windowDays: ADAPTIVE_WINDOW_DAYS };
    adaptiveExit = { type: 'mayer-percentile', op: exit.op, percentile: ADAPTIVE_EXIT_PCT, windowDays: ADAPTIVE_WINDOW_DAYS };
  } else if (isMayer(entry) && isMvrv(exit)) {
    adaptiveEntry = { type: 'mayer-percentile', op: entry.op, percentile: ADAPTIVE_ENTRY_PCT, windowDays: ADAPTIVE_WINDOW_DAYS };
    adaptiveExit = { type: 'mvrv-percentile', op: exit.op, percentile: ADAPTIVE_EXIT_PCT, windowDays: ADAPTIVE_WINDOW_DAYS };
  } else {
    throw new Error('adaptiveComparison requires a Mayer/MVRV pairing');
  }

  const windows: { label: string; from: string; to: string | null }[] = [
    { label: 'Pre-2020 halving', from: FROM, to: dayBefore(HALVING_3) },
    { label: '2020 halving cycle', from: HALVING_3, to: dayBefore(HALVING_4) },
    { label: '2024 halving cycle (current, incomplete)', from: HALVING_4, to: null },
    { label: 'Full window', from: FROM, to: null },
  ];
  let fullAdaptiveLedger: LedgerEntries = [];
  const rows = windows.map(w => {
    const fixedR = portfolioBacktest({ signals, spec: comboSpec(entry, exit, w.from, w.to) });
    const adaptiveR = portfolioBacktest({ signals, spec: comboSpec(adaptiveEntry, adaptiveExit, w.from, w.to) });
    if (w.from === FROM && w.to === null) fullAdaptiveLedger = adaptiveR.ledger.entries;
    return { label: w.label, dca: fixedR.benchmarks.dcaHold.metrics.moneyWeightedReturnPct,
      fixed: fixedR.strategy.metrics.moneyWeightedReturnPct, adaptive: adaptiveR.strategy.metrics.moneyWeightedReturnPct };
  });
  return {
    windowDays: ADAPTIVE_WINDOW_DAYS, entryPercentile: ADAPTIVE_ENTRY_PCT, exitPercentile: ADAPTIVE_EXIT_PCT,
    fixedLabel: { entryLabel, exitLabel }, rows, ledger: fullAdaptiveLedger,
  };
}

// ---------------------------------------------------------------------------

/** Every stress-test section for one clicked grid cell: a threshold sweep for each
 *  side whose condition has a number to sweep (0, 1 or 2 of them), a robustness check
 *  for the exact combo (always), and an adaptive comparison when the combo pairs
 *  Mayer with MVRV. Pure function (no DB), same split as `dcaMatrixFromSignals`. */
export function cellDeepDive(signals: Signal[], entryKey: string, exitKey: string) {
  const entry = ENTRY_GUARDS.find(e => e.key === entryKey);
  const exit = EXIT_TRIGGERS.find(x => x.key === exitKey);
  if (!entry || !exit) throw new Error(`Unknown entry/exit key: ${entryKey}/${exitKey}`);

  const sweeps = [];
  if (isThresholdCondition(entry.condition)) sweeps.push(thresholdSweep(signals, 'entry', entry.condition.type, entry.condition.op, exit.condition, exit.label));
  if (isThresholdCondition(exit.condition)) sweeps.push(thresholdSweep(signals, 'exit', exit.condition.type, exit.condition.op, entry.condition, entry.label));

  const robustness = robustnessCheck(signals, entry.condition, exit.condition, entry.label, exit.label);

  const entryType = entry.condition.type, exitType = exit.condition.type;
  const adaptive = (entryType === 'mvrv' && exitType === 'mayer') || (entryType === 'mayer' && exitType === 'mvrv')
    ? adaptiveComparison(signals, entry.condition, exit.condition, entry.label, exit.label)
    : null;

  return { entryKey, exitKey, entryLabel: entry.label, exitLabel: exit.label, sweeps, robustness, adaptive };
}

// ---------------------------------------------------------------------------

/** The always-on report: just the grid. Deep-dive sections (sensitivity, robustness,
 *  adaptive) are computed per cell, on demand -- see `cellDeepDive`/`dcaMatrixCell` --
 *  rather than baked in here, so the initial load stays cheap. Pure function, no DB. */
export function fullMatrixReport(signals: Signal[]) {
  return {
    methodologyVersion: MATRIX_METHOD,
    classification: 'historical-reconstruction' as const,
    params: { from: FROM, costBps: COST_BPS, holdoutPct: HOLDOUT_PCT, contributionUsd: 1000 },
    grid: dcaMatrixFromSignals(signals),
    note: 'Every combination shares the same $1,000/month contribution, 25bps cost and '
      + '2018-01-01 start; only the entry guard and exit trigger change. This reproduces, '
      + 'live against the current archive, the sweep that produced the cross-cycle finding '
      + 'in docs/data/PLANS_MACRO_AND_ML.md: fixed technical thresholds (Mayer, MVRV, '
      + 'drawdown) generally do not survive out-of-sample validation or cross-cycle '
      + 'scrutiny once they fit one window too closely. Click any cell for its own '
      + 'threshold sensitivity and robustness check before trusting it.',
  };
}

/** DB-backed wrapper: loads the current archive (or its state as of `asOf`, for replay)
 *  and runs the grid over it. */
export async function dcaMatrix(database: Pool, asOf?: string) {
  const inputs = await loadRegimeInputs(database, asOf);
  return { ...fullMatrixReport(inputs.signals), dataset: inputs.dataset };
}

/** DB-backed wrapper for one cell's deep dive. */
export async function dcaMatrixCell(database: Pool, entryKey: string, exitKey: string, asOf?: string) {
  const inputs = await loadRegimeInputs(database, asOf);
  return { ...cellDeepDive(inputs.signals, entryKey, exitKey), dataset: inputs.dataset };
}
