import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portfolioBacktest, irr, type Signal } from './portfolio.js';
import type { StrategySpec } from './strategy-spec.js';

const DAY = 86400000;
const start = Date.parse('2020-01-01T00:00:00.000Z');
const iso = (i: number) => new Date(start + i * DAY).toISOString();

function signals(n: number, close: (i: number) => number, regime: (i: number) => string = () => 'bullish'): Signal[] {
  return Array.from({ length: n }, (_, i) => ({
    observedAt: iso(i), close: close(i), regime: regime(i),
    mayer: close(i) / 100, sma200: 100, mvrv: 2, weeklyRsi: 50,
  }));
}

const spec = (o: Partial<StrategySpec> = {}): StrategySpec => ({
  startCapitalUsd: 0,
  contribution: { amountUsd: 0, cadence: 'monthly', day: 1 },
  entry: { trigger: 'on-contribution', day: 1, guard: { type: 'none' }, size: { type: 'all-cash' }, redeploy: 'immediate' },
  exit: { trigger: { type: 'none' }, size: { type: 'all' } },
  costBps: 25, from: null, to: null, holdoutPct: 30,
  ...o,
});
const dcaHold = (o: Partial<StrategySpec> = {}) => spec({ contribution: { amountUsd: 500, cadence: 'monthly', day: 1 }, ...o });

test('irr: a single outflow then an inflow recovers the compound rate', () => {
  // -100 at t=0, +200 at t=2 years -> (2)^(1/2) - 1 ~= 0.4142
  const r = irr([{ t: 0, amount: -100 }, { t: 2, amount: 200 }]);
  assert.ok(Math.abs(r! - (Math.SQRT2 - 1)) < 1e-4);
});

test('irr: flows that never change sign have no solution', () => {
  assert.equal(irr([{ t: 0, amount: -100 }, { t: 1, amount: -100 }]), null);
});

test('contribution accounting sums external cash including the starting capital', () => {
  const r = portfolioBacktest({ signals: signals(400, () => 100), spec: dcaHold({ startCapitalUsd: 1000 }) });
  // 1000 seed + one $500 per calendar month touched by the window (Jan 2020 .. ~Feb 2021)
  assert.ok(r.strategy.metrics.totalContributedUsd! >= 1000 + 500 * 13);
  assert.equal(r.strategy.metrics.totalContributedUsd, r.equity.contributed.at(-1));
});

test('a buy pays the per-side cost in units acquired', () => {
  const free = portfolioBacktest({ signals: signals(40, () => 100), spec: spec({ startCapitalUsd: 10000, costBps: 0, entry: { trigger: 'weekly', day: 3, guard: { type: 'none' }, size: { type: 'all-cash' }, redeploy: 'scheduled' } }) });
  const charged = portfolioBacktest({ signals: signals(40, () => 100), spec: spec({ startCapitalUsd: 10000, costBps: 100, entry: { trigger: 'weekly', day: 3, guard: { type: 'none' }, size: { type: 'all-cash' }, redeploy: 'scheduled' } }) });
  assert.ok(charged.strategy.metrics.endingEquityUsd! < free.strategy.metrics.endingEquityUsd!);
});

test('a guard blocks entry so cash accumulates through a bearish stretch', () => {
  const r = portfolioBacktest({
    signals: signals(120, () => 100, i => (i < 60 ? 'bearish' : 'bullish')),
    spec: dcaHold({ entry: { trigger: 'monthly', day: 1, guard: { type: 'regime-in', regimes: ['bullish'] }, size: { type: 'all-cash' }, redeploy: 'scheduled' } }),
  });
  // First buy only appears once the regime turns bullish.
  assert.ok(r.ledger.entries.length > 0);
  assert.ok(r.ledger.entries.every(e => e.date >= iso(60).slice(0, 10)));
});

test('redeploy immediate deploys on the regime turn instead of waiting for the schedule', () => {
  const build = (redeploy: 'immediate' | 'scheduled') => portfolioBacktest({
    signals: signals(200, i => 100 + i, i => (i < 45 ? 'bearish' : 'bullish')),
    spec: dcaHold({ entry: { trigger: 'monthly', day: 28, guard: { type: 'regime-in', regimes: ['bullish'] }, size: { type: 'all-cash' }, redeploy } }),
  });
  const immediate = build('immediate');
  const scheduled = build('scheduled');
  assert.ok(immediate.ledger.entries[0].date < scheduled.ledger.entries[0].date);
});

test('a new-ATH exit fires on every fresh high, not just the first', () => {
  // Rises to new highs on many days.
  const r = portfolioBacktest({
    signals: signals(60, i => 100 + i * 2),
    spec: spec({ startCapitalUsd: 10000, entry: { trigger: 'weekly', day: 1, guard: { type: 'none' }, size: { type: 'all-cash' }, redeploy: 'scheduled' }, exit: { trigger: { type: 'new-ath' }, size: { type: 'all' } } }),
  });
  assert.ok(r.ledger.sells >= 2);
});

test('a drawdown-from-ATH exit fires once when price falls past the threshold', () => {
  const closes = (i: number) => (i < 30 ? 100 + i * 3 : 190 - (i - 30) * 5);
  const r = portfolioBacktest({
    signals: signals(50, closes),
    spec: spec({ startCapitalUsd: 10000, entry: { trigger: 'weekly', day: 1, guard: { type: 'none' }, size: { type: 'all-cash' }, redeploy: 'scheduled' }, exit: { trigger: { type: 'drawdown-from-ath', op: 'gte', pct: 20 }, size: { type: 'all' } } }),
  });
  assert.equal(r.ledger.sells, 1);
});

test('the dca-hold benchmark equals the strategy for a plain buy-every-contribution spec', () => {
  const r = portfolioBacktest({ signals: signals(300, i => 100 + 20 * Math.sin(i / 15)), spec: dcaHold() });
  assert.equal(r.strategy.metrics.endingEquityUsd, r.benchmarks.dcaHold.metrics.endingEquityUsd);
});

test('the lump-sum benchmark holds a single position bought on day one', () => {
  const r = portfolioBacktest({ signals: signals(300, i => 100 + i), spec: dcaHold() });
  const ls = r.benchmarks.lumpSum.metrics;
  // day-1 price 101, final price 399, minus a one-off cost -> roughly 3.9x the contributed total
  assert.ok(ls.endingEquityUsd! / ls.totalContributedUsd! > 3.5 && ls.endingEquityUsd! / ls.totalContributedUsd! < 4);
});

test('no look-ahead: shifting the regime labels by a day changes the outcome', () => {
  const s = dcaHold({ entry: { trigger: 'monthly', day: 1, guard: { type: 'regime-in', regimes: ['bullish'] }, size: { type: 'all-cash' }, redeploy: 'immediate' }, exit: { trigger: { type: 'regime-leave', regimes: ['bullish'] }, size: { type: 'all' } } });
  const a = portfolioBacktest({ signals: signals(200, i => 100 + 10 * Math.sin(i / 7), i => (i % 20 < 10 ? 'bullish' : 'bearish')), spec: s });
  const b = portfolioBacktest({ signals: signals(200, i => 100 + 10 * Math.sin(i / 7), i => ((i + 1) % 20 < 10 ? 'bullish' : 'bearish')), spec: s });
  assert.notDeepEqual(a.strategy.metrics, b.strategy.metrics);
});

test('reproducibility: identical inputs produce a deeply equal result', () => {
  const build = () => portfolioBacktest({ signals: signals(250, i => 100 + i + 5 * Math.sin(i / 6)), spec: dcaHold() });
  assert.deepEqual(build(), build());
});

test('holdout splits the window and reports both segments', () => {
  const r = portfolioBacktest({ signals: signals(300, i => 100 + i), spec: dcaHold({ holdoutPct: 40 }) });
  assert.ok(r.holdout.splitDate > r.window.from && r.holdout.splitDate < r.window.to);
  assert.equal(r.holdout.holdoutPct, 40);
  assert.ok(r.holdout.outOfSample.strategy.endingEquityUsd! > 0);
});

test('the three worked examples all produce a finite result and a ledger', () => {
  const s = signals(500, i => 20000 + 8000 * Math.sin(i / 40), i => (Math.sin(i / 40) > 0 ? 'bullish' : 'bearish'));
  const examples: StrategySpec[] = [
    dcaHold(),
    dcaHold({ entry: { trigger: 'monthly', day: 1, guard: { type: 'regime-in', regimes: ['bullish'] }, size: { type: 'all-cash' }, redeploy: 'immediate' }, exit: { trigger: { type: 'regime-leave', regimes: ['bullish'] }, size: { type: 'all' } } }),
    dcaHold({ exit: { trigger: { type: 'new-ath' }, size: { type: 'all' } } }),
  ];
  for (const spec of examples) {
    const r = portfolioBacktest({ signals: s, spec });
    assert.ok(Number.isFinite(r.strategy.metrics.profitUsd!));
    assert.ok(r.ledger.entries.length > 0);
    assert.equal(r.costSensitivity.length, 3);
  }
});

test('too few completed prices is rejected', () => {
  assert.throws(() => portfolioBacktest({ signals: signals(5, () => 100), spec: dcaHold() }), /at least ten/);
});
