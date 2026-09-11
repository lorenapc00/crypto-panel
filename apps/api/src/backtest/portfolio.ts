import { DAY, mean } from '../btc/calculations.js';
import { equityStats } from './calculations.js';
import { PORTFOLIO_STRATEGY_METHOD, type Condition, type StrategySpec } from './strategy-spec.js';

export type Signal = {
  observedAt: string;
  close: number | null;
  regime: string;
  mayer: number | null;
  sma200: number | null;
  mvrv: number | null;
  weeklyRsi: number | null;
};

const YEAR = 365 * DAY;
const round = (value: number | null, places = 2) =>
  value === null || !Number.isFinite(value) ? null : Number(value.toFixed(places));

type Row = { time: number; date: string; close: number; regime: string; mayer: number | null; sma200: number | null; mvrv: number | null; weeklyRsi: number | null };

/** Whether a condition's state holds on a given day. `null` inputs make a threshold
 *  condition simply false — it never blocks a guard nor fires a trigger on missing data. */
function conditionHolds(cond: Condition, row: Row, athToHere: number): boolean {
  switch (cond.type) {
    case 'none': return true;
    case 'regime-in': return cond.regimes.includes(row.regime);
    case 'regime-leave': return !cond.regimes.includes(row.regime);
    case 'new-ath': return row.close >= athToHere;
    case 'drawdown-from-ath': {
      const dd = (1 - row.close / athToHere) * 100;
      return cond.op === 'gte' ? dd >= cond.pct : dd <= cond.pct;
    }
    case 'mayer': return row.mayer === null ? false : cond.op === 'gte' ? row.mayer >= cond.value : row.mayer <= cond.value;
    case 'price-vs-sma200': return row.sma200 === null ? false : cond.side === 'above' ? row.close > row.sma200 : row.close < row.sma200;
    case 'weekly-rsi': return row.weeklyRsi === null ? false : cond.op === 'gte' ? row.weeklyRsi >= cond.value : row.weeklyRsi <= cond.value;
    case 'mvrv': return row.mvrv === null ? false : cond.op === 'gte' ? row.mvrv >= cond.value : row.mvrv <= cond.value;
  }
}

/** Whether a condition produced an *event* on day `k` (used for exit triggers). A new ATH
 *  fires on every fresh high; every other condition fires on the rising edge of its state. */
function conditionFires(cond: Condition, rows: Row[], ath: number[], k: number): boolean {
  if (cond.type === 'none') return false;
  if (cond.type === 'new-ath') return k > 0 && rows[k].close > ath[k - 1];
  const now = conditionHolds(cond, rows[k], ath[k]);
  const before = k > 0 && conditionHolds(cond, rows[k - 1], ath[k - 1]);
  return now && !before;
}

/** Annualized money-weighted return (IRR). Contributions are negative cash flows at their
 *  year offset; the ending equity is a positive flow at the final offset. Returns null when
 *  the flows never change sign. */
export function irr(flows: { t: number; amount: number }[]): number | null {
  if (flows.length < 2) return null;
  const positive = flows.some(f => f.amount > 0), negative = flows.some(f => f.amount < 0);
  if (!positive || !negative) return null;
  const npv = (rate: number) => flows.reduce((sum, f) => sum + f.amount / (1 + rate) ** f.t, 0);
  let low = -0.9999, high = 100;
  if (npv(low) * npv(high) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    const value = npv(mid);
    if (Math.abs(value) < 1e-7) return mid;
    if (npv(low) * value < 0) high = mid; else low = mid;
  }
  return (low + high) / 2;
}

type Metrics = {
  endingEquityUsd: number | null;
  totalContributedUsd: number | null;
  profitUsd: number | null;
  profitPct: number | null;
  moneyWeightedReturnPct: number | null;
  cagrPct: number | null;
  volatilityPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdownPct: number | null;
};

/** Descriptive metrics for one equity path. `contribToday[i]` is the external cash added
 *  on day i (0 for a benchmark that took everything up front); the drawdown peak steps up
 *  with each contribution so it reflects market declines, not the pace of contributions. */
function metricsFor(times: number[], equity: number[], contribToday: number[], hasContributions: boolean): Metrics {
  const n = equity.length;
  if (n < 2) return { endingEquityUsd: null, totalContributedUsd: null, profitUsd: null, profitPct: null, moneyWeightedReturnPct: null, cagrPct: null, volatilityPct: null, sharpe: null, sortino: null, maxDrawdownPct: null };
  const contributed = contribToday.reduce((a, b) => a + b, 0);
  const ending = equity[n - 1];
  const start = times[0];
  const flows: { t: number; amount: number }[] = [];
  for (let i = 0; i < n; i++) if (contribToday[i] > 0) flows.push({ t: (times[i] - start) / YEAR, amount: -contribToday[i] });
  flows.push({ t: (times[n - 1] - start) / YEAR, amount: ending });
  let peak = equity[0], maxDrawdown = 0;
  const dailyReturns: number[] = [];
  for (let i = 1; i < n; i++) {
    peak = Math.max(peak + contribToday[i], equity[i]);
    maxDrawdown = Math.min(maxDrawdown, equity[i] / peak - 1);
    if (!hasContributions && equity[i - 1] > 0) dailyReturns.push(equity[i] / equity[i - 1] - 1);
  }
  const stats = hasContributions ? null : equityStats(dailyReturns);
  return {
    endingEquityUsd: round(ending),
    totalContributedUsd: round(contributed),
    profitUsd: round(ending - contributed),
    profitPct: contributed > 0 ? round((ending / contributed - 1) * 100) : null,
    moneyWeightedReturnPct: round((irr(flows) ?? NaN) * 100),
    cagrPct: stats?.cagrPct ?? null,
    volatilityPct: stats?.volatilityPct ?? null,
    sharpe: stats?.sharpe ?? null,
    sortino: stats?.sortino ?? null,
    maxDrawdownPct: round(maxDrawdown * 100),
  };
}

const monthKey = (date: string) => date.slice(0, 7);
const dayOfMonth = (date: string) => Number(date.slice(8, 10));

type LedgerEntry = { date: string; kind: 'buy' | 'sell'; usd: number; units: number; price: number };

/** One deterministic run of the strategy over `rows` at a given cost. Returns the daily
 *  equity path, the external cash added each day, and the trade ledger. */
function simulate(rows: Row[], ath: number[], spec: StrategySpec, costBps: number) {
  const cost = costBps / 10_000;
  let cash = 0, units = 0;
  const equity: number[] = [];
  const contribToday: number[] = [];
  const ledger: LedgerEntry[] = [];
  let seededStart = false;
  const contributionMonths = new Set<string>();
  const entryMonths = new Set<string>();
  let exposedDays = 0;
  const cashFraction: number[] = [];
  const investedFraction: number[] = [];
  // Cash that has arrived but not yet been deployed by an entry. An `on-contribution`
  // trigger fires while this is positive, so the day-0 seed and a contribution that
  // lands before the first tradable day are still deployed on the next day.
  let pending = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let added = 0;

    // 1. External cash. The starting capital arrives on day 0 and is deployed on day 1
    //    like any other contribution.
    if (!seededStart) { added += spec.startCapitalUsd; seededStart = true; }
    if (spec.contribution.amountUsd > 0) {
      if (spec.contribution.cadence === 'monthly') {
        if (!contributionMonths.has(monthKey(row.date)) && dayOfMonth(row.date) >= spec.contribution.day) {
          contributionMonths.add(monthKey(row.date)); added += spec.contribution.amountUsd;
        }
      } else if (new Date(row.time).getUTCDay() === spec.contribution.day) {
        added += spec.contribution.amountUsd;
      }
    }
    cash += added;
    pending += added;
    contribToday.push(added);

    if (i > 0) {
      // 2. Exit — the event is read from the completed prior day, executed at today's close.
      if (units > 0 && conditionFires(spec.exit.trigger, rows, ath, i - 1)) {
        const sellUnits = spec.exit.size.type === 'all' ? units : units * (spec.exit.size.value / 100);
        const proceeds = sellUnits * row.close * (1 - cost);
        cash += proceeds; units -= sellUnits;
        ledger.push({ date: row.date, kind: 'sell', usd: round(proceeds)!, units: round(sellUnits, 8)!, price: round(row.close)! });
      }

      // 3. Entry — a trigger fires and the guard (read from the prior day) allows it.
      const guardNow = conditionHolds(spec.entry.guard, rows[i - 1], ath[i - 1]);
      const guardBefore = i > 1 && conditionHolds(spec.entry.guard, rows[i - 2], ath[i - 2]);
      let triggered = false;
      if (spec.entry.trigger === 'on-contribution') triggered = pending > 0;
      else if (spec.entry.trigger === 'monthly') {
        if (!entryMonths.has(monthKey(row.date)) && dayOfMonth(row.date) >= spec.entry.day) { entryMonths.add(monthKey(row.date)); triggered = true; }
      } else if (new Date(row.time).getUTCDay() === spec.entry.day) triggered = true;
      const redeployed = spec.entry.redeploy === 'immediate' && guardNow && !guardBefore;

      if (cash > 0 && guardNow && (triggered || redeployed)) {
        const buyUsd = spec.entry.size.type === 'all-cash' ? cash
          : spec.entry.size.type === 'fixed' ? Math.min(cash, spec.entry.size.value)
            : cash * (spec.entry.size.value / 100);
        if (buyUsd > 0) {
          const bought = (buyUsd / row.close) * (1 - cost);
          units += bought; cash -= buyUsd; pending = 0;
          ledger.push({ date: row.date, kind: 'buy', usd: round(buyUsd)!, units: round(bought, 8)!, price: round(row.close)! });
        }
      }
    }

    const value = cash + units * row.close;
    equity.push(value);
    if (units * row.close > 0.005 * Math.max(value, 1)) exposedDays++;
    cashFraction.push(value > 0 ? cash / value : 0);
    investedFraction.push(value > 0 ? (units * row.close) / value : 0);
  }
  return { equity, contribToday, ledger, exposedDays, cashFraction, investedFraction };
}

const PLAIN_ENTRY: StrategySpec['entry'] = { trigger: 'on-contribution', day: 1, guard: { type: 'none' }, size: { type: 'all-cash' }, redeploy: 'immediate' };
const NO_EXIT: StrategySpec['exit'] = { trigger: { type: 'none' }, size: { type: 'all' } };

/** Buy every dollar of capital and every contribution as soon as it is deployable, and
 *  never sell — the same contribution schedule as the strategy, without any timing rule. */
function dcaHoldRun(rows: Row[], ath: number[], spec: StrategySpec) {
  return simulate(rows, ath, { ...spec, entry: PLAIN_ENTRY, exit: NO_EXIT }, spec.costBps);
}

/** Every dollar the strategy will ever contribute, assumed available on day one and held. */
function lumpSumRun(rows: Row[], ath: number[], spec: StrategySpec) {
  const contributions = simulate(rows, ath, spec, spec.costBps).contribToday.reduce((a, b) => a + b, 0);
  const lumpSpec: StrategySpec = { ...spec, startCapitalUsd: contributions, contribution: { ...spec.contribution, amountUsd: 0 }, entry: PLAIN_ENTRY, exit: NO_EXIT };
  return simulate(rows, ath, lumpSpec, spec.costBps);
}

export function portfolioBacktest(input: { signals: Signal[]; spec: StrategySpec }) {
  const { spec } = input;
  const from = spec.from ? Date.parse(`${spec.from}T00:00:00.000Z`) : -Infinity;
  const to = spec.to ? Date.parse(`${spec.to}T00:00:00.000Z`) : Infinity;

  const rows: Row[] = [];
  let missingCloseDays = 0;
  for (const signal of input.signals) {
    const time = Date.parse(signal.observedAt);
    if (time < from || time > to) continue;
    if (!rows.length && (signal.close === null || signal.regime === 'insufficient-history')) continue;
    if (signal.close === null) { missingCloseDays++; continue; }
    rows.push({ time, date: signal.observedAt.slice(0, 10), close: signal.close, regime: signal.regime, mayer: signal.mayer, sma200: signal.sma200, mvrv: signal.mvrv, weeklyRsi: signal.weeklyRsi });
  }
  if (rows.length < 10) throw new Error('The strategy backtest needs at least ten completed daily prices inside the window');

  const ath: number[] = [];
  for (let i = 0; i < rows.length; i++) ath.push(Math.max(rows[i].close, i > 0 ? ath[i - 1] : rows[i].close));

  const times = rows.map(r => r.time);
  const hasContributions = spec.contribution.amountUsd > 0;
  const run = simulate(rows, ath, spec, spec.costBps);
  const dca = dcaHoldRun(rows, ath, spec);
  const lump = lumpSumRun(rows, ath, spec);

  const years = (times[times.length - 1] - times[0]) / YEAR;
  const split = Math.max(1, Math.min(rows.length - 1, Math.round(rows.length * (1 - spec.holdoutPct / 100))));
  const segment = (arr: number[], part: 'in' | 'out') => part === 'in' ? arr.slice(0, split + 1) : arr.slice(split);

  const buys = run.ledger.filter(e => e.kind === 'buy').length;
  const sells = run.ledger.filter(e => e.kind === 'sell').length;

  const segMetrics = (equity: number[], contrib: number[], part: 'in' | 'out') =>
    metricsFor(segment(times, part), segment(equity, part), segment(contrib, part), hasContributions);

  const warnings: string[] = [];
  if (missingCloseDays) warnings.push(`${missingCloseDays} day${missingCloseDays === 1 ? '' : 's'} inside the window had no completed close and were skipped rather than forward-filled.`);
  if (years < 1) warnings.push('The evaluated window is shorter than one year; annualized figures extrapolate a very short sample.');
  if (run.equity[run.equity.length - 1] < Math.max(...run.equity)) warnings.push('The strategy equity ends below its running peak; the maximum drawdown is still open.');
  if (hasContributions) warnings.push('This strategy adds external cash over time, so the headline figure is the money-weighted return (IRR); a simple CAGR is not defined.');

  return {
    methodologyVersion: PORTFOLIO_STRATEGY_METHOD,
    classification: 'historical-reconstruction' as const,
    spec,
    hasContributions,
    window: { from: rows[0].date, to: rows[rows.length - 1].date, tradingDays: rows.length, missingCloseDays, years: round(years) },
    strategy: {
      metrics: metricsFor(times, run.equity, run.contribToday, hasContributions),
      timeInMarketPct: round((run.exposedDays / rows.length) * 100, 1),
      avgInvestedPct: round(mean(run.investedFraction) * 100, 1),
      avgCashDragPct: round(mean(run.cashFraction) * 100, 1),
      trades: { buys, sells, total: buys + sells, turnoverPerYear: years > 0 ? round((buys + sells) / years) : null },
    },
    benchmarks: {
      dcaHold: { label: 'Every dollar buys BTC immediately, never sells', metrics: metricsFor(times, dca.equity, dca.contribToday, hasContributions) },
      lumpSum: { label: 'All capital and every future contribution invested on day one, held', metrics: metricsFor(times, lump.equity, lump.contribToday, false) },
    },
    holdout: {
      splitDate: rows[split].date,
      holdoutPct: spec.holdoutPct,
      note: 'The equity path is split chronologically; the holdout is an untouched final segment. Custom rules with fitted thresholds are only descriptive here — the split does not re-fit them.',
      inSample: { strategy: segMetrics(run.equity, run.contribToday, 'in'), dcaHold: segMetrics(dca.equity, dca.contribToday, 'in'), lumpSum: segMetrics(lump.equity, lump.contribToday, 'in') },
      outOfSample: { strategy: segMetrics(run.equity, run.contribToday, 'out'), dcaHold: segMetrics(dca.equity, dca.contribToday, 'out'), lumpSum: segMetrics(lump.equity, lump.contribToday, 'out') },
    },
    costSensitivity: [25, 50, 100].map(bps => {
      const alt = simulate(rows, ath, spec, bps);
      const m = metricsFor(times, alt.equity, alt.contribToday, hasContributions);
      return { costBps: bps, moneyWeightedReturnPct: m.moneyWeightedReturnPct, profitPct: m.profitPct, maxDrawdownPct: m.maxDrawdownPct };
    }),
    equity: {
      dates: times.map(t => t / 1000),
      strategy: run.equity.map(v => round(v)!),
      dcaHold: dca.equity.map(v => round(v)!),
      lumpSum: lump.equity.map(v => round(v)!),
      contributed: run.contribToday.reduce<number[]>((acc, add) => { acc.push((acc[acc.length - 1] ?? 0) + add); return acc; }, []).map(v => round(v)!),
    },
    ledger: { entries: run.ledger.slice(-250), buys, sells },
    warnings,
    limitations: [
      'Close-to-close historical reconstruction from archived Coin Metrics revisions. Downloading a value today does not prove it was published on that date.',
      'Execution cost is a flat per-side basis-point assumption applied to every buy and sell. It models no slippage, market impact, spread or partial fills.',
      'Uninvested cash earns nothing; no Treasury-bill or money-market yield is credited.',
      'Money-weighted return (IRR) rewards well-timed contributions; it is not comparable to a buy-and-hold CAGR without care.',
      'Maximum drawdown is measured against a peak that steps up with each contribution, isolating market declines from the pace of contributions.',
      'The lump-sum benchmark assumes every future contribution was available on day one — hindsight capital, shown for contrast only.',
      'About one BTC cycle is covered. This is descriptive, not a walk-forward-validated or statistically significant result.',
      'Regime changes require three confirmed daily observations and all signals act on the completed prior day, so entries and exits lag the close.',
    ],
  };
}
