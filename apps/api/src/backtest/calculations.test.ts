import { test } from 'node:test';
import assert from 'node:assert/strict';
import { equityStats, regimeStrategyBacktest, type RegimeStrategyParams } from './calculations.js';

const DAY = 86400000;
const start = Date.parse('2020-01-01T00:00:00.000Z');
const iso = (i: number) => new Date(start + i * DAY).toISOString();

/** Build an aligned price path and regime label per day. `regime` maps day index -> label. */
function scenario(closes: (number | null)[], regime: (i: number) => string) {
  const prices = closes.map((value, i) => ({ observedAt: iso(i), value })).filter(p => p.value !== null) as { observedAt: string; value: number }[];
  const regimes = closes.map((_, i) => ({ observedAt: iso(i), regime: regime(i) }));
  return { prices, regimes };
}
const opts = (overrides: Partial<RegimeStrategyParams> = {}): RegimeStrategyParams =>
  ({ activeRegimes: 'bullish', from: null, to: null, holdoutPct: 30, costBps: 25, ...overrides });

test('equityStats: flat returns produce zero growth and no drawdown', () => {
  const stats = equityStats(new Array(50).fill(0));
  assert.equal(stats.totalReturnPct, 0);
  assert.equal(stats.cagrPct, 0);
  assert.equal(stats.maxDrawdownPct, 0);
  assert.equal(stats.sharpe, null);
});

test('equityStats: compounds a known return path', () => {
  const stats = equityStats([0.1, -0.1, 0.1]);
  assert.equal(stats.totalReturnPct, 8.9); // 1.1 * 0.9 * 1.1 - 1
  assert.ok(stats.maxDrawdownPct! < 0);
});

test('equityStats: an all-loss path has a negative Sortino and full drawdown path', () => {
  const stats = equityStats([-0.01, -0.02, -0.01, -0.03]);
  assert.ok(stats.sortino! < 0);
  assert.ok(stats.maxDrawdownPct! < 0);
});

test('regime strategy sits flat through a bearish stretch and beats buy-and-hold', () => {
  // Rises for 10 days (bullish), then falls for 20 (bearish).
  const closes = Array.from({ length: 31 }, (_, i) => (i <= 10 ? 100 + i * 2 : 120 - (i - 10) * 3));
  const { prices, regimes } = scenario(closes, i => (i <= 10 ? 'bullish' : 'bearish'));
  const result = regimeStrategyBacktest({ prices, regimes, params: opts() });
  assert.ok(result.strategy.stats.totalReturnPct! > result.benchmark.stats.totalReturnPct!);
  assert.ok(result.benchmark.stats.totalReturnPct! < 0);
});

test('an execution cost is charged on each regime switch', () => {
  // Two-day return window; the strategy enters on day 1 (prior day bullish).
  const closes = [100, 110, 121];
  const { prices, regimes } = scenario(closes, () => 'bullish');
  const free = regimeStrategyBacktest({ prices, regimes, params: opts({ costBps: 0, holdoutPct: 34 }) });
  const charged = regimeStrategyBacktest({ prices, regimes, params: opts({ costBps: 100, holdoutPct: 34 }) });
  assert.ok(charged.strategy.stats.totalReturnPct! < free.strategy.stats.totalReturnPct!);
  assert.equal(charged.trades.entries, 1);
});

test('no look-ahead: shifting the regime labels by one day changes the result', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + 10 * Math.sin(i / 3));
  const a = regimeStrategyBacktest({ ...scenario(closes, i => (i % 8 < 4 ? 'bullish' : 'bearish')), params: opts() });
  const b = regimeStrategyBacktest({ ...scenario(closes, i => ((i + 1) % 8 < 4 ? 'bullish' : 'bearish')), params: opts() });
  assert.notDeepEqual(a.strategy.stats, b.strategy.stats);
});

test('reproducibility: identical inputs produce a deeply equal result', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i + 5 * Math.sin(i / 4));
  const build = () => regimeStrategyBacktest({ ...scenario(closes, i => (i < 30 ? 'bullish' : 'transitional')), params: opts() });
  assert.deepEqual(build(), build());
});

test('a missing daily close is dropped from both series, not forward-filled', () => {
  const closes: (number | null)[] = Array.from({ length: 30 }, (_, i) => 100 + i);
  closes[15] = null;
  const result = regimeStrategyBacktest({ ...scenario(closes, () => 'bullish'), params: opts() });
  assert.ok(result.window.missingCloseDays >= 1);
  assert.ok(result.limitations.some(line => line.includes('reconstruction')));
});

test('cost sensitivity is monotonic in basis points when the strategy trades', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + 20 * Math.sin(i / 5));
  const result = regimeStrategyBacktest({ ...scenario(closes, i => (Math.sin(i / 5) > 0 ? 'bullish' : 'bearish')), params: opts() });
  const [c25, c50, c100] = result.costSensitivity;
  assert.deepEqual([c25.costBps, c50.costBps, c100.costBps], [25, 50, 100]);
  assert.ok(c25.cagrPct! >= c50.cagrPct! && c50.cagrPct! >= c100.cagrPct!);
  assert.ok(result.trades.total > 0);
});

test('bullish+transitional holds at least as many days as bullish alone', () => {
  const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
  const label = (i: number) => (i % 3 === 0 ? 'transitional' : i % 3 === 1 ? 'bullish' : 'bearish');
  const narrow = regimeStrategyBacktest({ ...scenario(closes, label), params: opts({ activeRegimes: 'bullish' }) });
  const wide = regimeStrategyBacktest({ ...scenario(closes, label), params: opts({ activeRegimes: 'bullish+transitional' }) });
  assert.ok(wide.trades.exposurePct! >= narrow.trades.exposurePct!);
});

test('too few completed prices is rejected', () => {
  const { prices, regimes } = scenario([100, 101], () => 'bullish');
  assert.throws(() => regimeStrategyBacktest({ prices, regimes, params: opts() }), /at least three/);
});
