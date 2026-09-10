import { DAY, dailyGrid, mean, type Point } from '../btc/calculations.js';

export const BACKTEST_STRATEGY_METHOD = 'btc-regime-strategy:v1';
export const ACTIVE_REGIME_SETS = { bullish: ['bullish'], 'bullish+transitional': ['bullish', 'transitional'] } as const;
export type ActiveRegimeSet = keyof typeof ACTIVE_REGIME_SETS;

export type RegimePoint = { observedAt: string; regime: string };
export type RegimeStrategyParams = {
  activeRegimes: ActiveRegimeSet;
  from: string | null;
  to: string | null;
  holdoutPct: number;
  costBps: number;
};

const round = (value: number | null, places = 4) =>
  value === null || !Number.isFinite(value) ? null : Number(value.toFixed(places));

function sampleStdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, n) => sum + (n - avg) ** 2, 0) / (values.length - 1));
}

/** Descriptive performance statistics for a sequence of period returns. Risk-free rate
 *  is zero and stated as a limitation; Sharpe and Sortino annualize the daily mean and
 *  dispersion by sqrt(periodsPerYear). */
export function equityStats(dailyReturns: number[], periodsPerYear = 365) {
  const days = dailyReturns.length;
  if (!days) return { days: 0, totalReturnPct: null, cagrPct: null, volatilityPct: null, sharpe: null, sortino: null, maxDrawdownPct: null, openDrawdown: false };
  const growth = dailyReturns.reduce((product, r) => product * (1 + r), 1);
  const totalReturn = growth - 1;
  const avg = mean(dailyReturns);
  const stdev = sampleStdDev(dailyReturns);
  const downside = Math.sqrt(mean(dailyReturns.map(r => Math.min(r, 0) ** 2)));
  let equity = 1, peak = 1, maxDrawdown = 0;
  for (const r of dailyReturns) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  return {
    days,
    totalReturnPct: round(totalReturn * 100, 2),
    cagrPct: round((growth ** (periodsPerYear / days) - 1) * 100, 2),
    volatilityPct: stdev === null ? null : round(stdev * Math.sqrt(periodsPerYear) * 100, 2),
    sharpe: stdev && stdev > 0 ? round((avg / stdev) * Math.sqrt(periodsPerYear), 3) : null,
    sortino: downside > 0 ? round((avg / downside) * Math.sqrt(periodsPerYear), 3) : null,
    maxDrawdownPct: round(maxDrawdown * 100, 2),
    openDrawdown: equity < peak,
  };
}

type Day = { time: number; date: string; close: number; regime: string };

/** BTC regime filter versus BTC buy-and-hold.
 *
 *  The signal for trading day *t* is the confirmed regime of the completed day *t-1*,
 *  so the rule never reads a close before it is used to trade. A day is dropped from
 *  both series when either endpoint close is missing — a disappeared observation is
 *  never forward-filled. The idle leg earns nothing; no cash yield is assumed. */
export function regimeStrategyBacktest(input: { prices: Point[]; regimes: RegimePoint[]; params: RegimeStrategyParams }) {
  const { params } = input;
  const active = new Set<string>(ACTIVE_REGIME_SETS[params.activeRegimes]);
  const grid = dailyGrid(input.prices);
  const regimeByDate = new Map(input.regimes.map(row => [row.observedAt.slice(0, 10), row.regime]));

  const from = params.from ? Date.parse(`${params.from}T00:00:00.000Z`) : -Infinity;
  const to = params.to ? Date.parse(`${params.to}T00:00:00.000Z`) : Infinity;

  // The usable window starts at the first day that already carries a decided regime
  // (not "insufficient-history") so the strategy is never long by default at the open.
  const rows: Day[] = [];
  let missingCloseDays = 0;
  for (const point of grid) {
    const time = Date.parse(point.observedAt);
    if (time < from || time > to) continue;
    const regime = regimeByDate.get(point.observedAt.slice(0, 10)) ?? 'insufficient-history';
    if (!rows.length && (point.value === null || regime === 'insufficient-history')) continue;
    if (point.value === null) { missingCloseDays++; continue; }
    rows.push({ time, date: point.observedAt.slice(0, 10), close: point.value, regime });
  }
  if (rows.length < 3) throw new Error('The regime backtest needs at least three completed daily prices inside the window');

  const strategyReturns: number[] = [];
  const benchmarkReturns: number[] = [];
  const equityDates: number[] = [rows[0].time / 1000];
  const strategyEquity: number[] = [100];
  const benchmarkEquity: number[] = [100];
  const positions: number[] = [];
  let entries = 0, exits = 0, exposedDays = 0, previousPosition = 0;
  const cost = params.costBps / 10_000;

  for (let i = 1; i < rows.length; i++) {
    const priorRegime = rows[i - 1].regime;
    const position = active.has(priorRegime) ? 1 : 0;
    const btcReturn = rows[i].close / rows[i - 1].close - 1;
    const switched = position !== previousPosition;
    if (switched) (position === 1 ? entries++ : exits++);
    const strategyReturn = position * btcReturn - (switched ? cost : 0);
    strategyReturns.push(strategyReturn);
    benchmarkReturns.push(btcReturn);
    positions.push(position);
    if (position === 1) exposedDays++;
    previousPosition = position;
    equityDates.push(rows[i].time / 1000);
    strategyEquity.push(strategyEquity[strategyEquity.length - 1] * (1 + strategyReturn));
    benchmarkEquity.push(benchmarkEquity[benchmarkEquity.length - 1] * (1 + btcReturn));
  }

  const years = (rows[rows.length - 1].time - rows[0].time) / (365 * DAY);
  const split = Math.max(1, Math.min(strategyReturns.length - 1, Math.round(strategyReturns.length * (1 - params.holdoutPct / 100))));
  const segment = (values: number[], part: 'in' | 'out') => part === 'in' ? values.slice(0, split) : values.slice(split);
  const costRun = (bps: number) => {
    const c = bps / 10_000;
    let prev = 0;
    const series = rows.slice(1).map((row, i) => {
      const position = active.has(rows[i].regime) ? 1 : 0;
      const switched = position !== prev;
      prev = position;
      return position * (row.close / rows[i].close - 1) - (switched ? c : 0);
    });
    const stats = equityStats(series);
    return { costBps: bps, cagrPct: stats.cagrPct, totalReturnPct: stats.totalReturnPct, sharpe: stats.sharpe, maxDrawdownPct: stats.maxDrawdownPct };
  };

  const insufficientSpanDays = rows.filter(row => row.regime === 'insufficient-history').length;
  const warnings: string[] = [];
  if (missingCloseDays) warnings.push(`${missingCloseDays} day${missingCloseDays === 1 ? '' : 's'} inside the window had no completed close and were dropped from both series rather than forward-filled.`);
  if (years < 1) warnings.push('The evaluated window is shorter than one year; annualized figures extrapolate a very short sample.');
  if (insufficientSpanDays) warnings.push(`${insufficientSpanDays} day${insufficientSpanDays === 1 ? '' : 's'} inside the window had no decided regime and were treated as idle.`);
  if (equityStats(strategyReturns).openDrawdown) warnings.push('The strategy equity ends below its running peak; the maximum drawdown is still open.');

  return {
    methodologyVersion: BACKTEST_STRATEGY_METHOD,
    classification: 'historical-reconstruction' as const,
    params,
    window: {
      from: rows[0].date,
      to: rows[rows.length - 1].date,
      tradingDays: rows.length,
      returnDays: strategyReturns.length,
      missingCloseDays,
      years: round(years, 2),
    },
    strategy: { stats: equityStats(strategyReturns) },
    benchmark: { label: 'BTC buy-and-hold', stats: equityStats(benchmarkReturns) },
    holdout: {
      splitDate: rows[split].date,
      holdoutPct: params.holdoutPct,
      note: 'The regime rule fits no parameters, so walk-forward is satisfied by construction. The holdout is still reported as an untouched final segment.',
      inSample: { strategy: equityStats(segment(strategyReturns, 'in')), benchmark: equityStats(segment(benchmarkReturns, 'in')) },
      outOfSample: { strategy: equityStats(segment(strategyReturns, 'out')), benchmark: equityStats(segment(benchmarkReturns, 'out')) },
    },
    trades: {
      entries,
      exits,
      total: entries + exits,
      turnoverPerYear: years > 0 ? round((entries + exits) / years, 2) : null,
      exposurePct: round((exposedDays / strategyReturns.length) * 100, 1),
    },
    costSensitivity: [25, 50, 100].map(costRun),
    equity: { dates: equityDates, strategy: strategyEquity.map(v => round(v, 2)!), benchmark: benchmarkEquity.map(v => round(v, 2)!) },
    warnings,
    limitations: [
      'Close-to-close historical reconstruction from archived Coin Metrics revisions. Downloading a value today does not prove it was published on that date.',
      'Execution cost is a flat per-side basis-point assumption applied on each regime switch. It models no slippage, market impact, spread or partial fills.',
      'The idle leg is held flat at a 0% return. No Treasury-bill or money-market yield is credited.',
      'About one full regime cycle is covered. This is descriptive, not a walk-forward-validated or statistically significant result.',
      'Regime changes require three confirmed daily observations, so entries and exits lag the underlying close by construction.',
    ],
  };
}
