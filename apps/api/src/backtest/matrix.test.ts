import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dcaMatrixFromSignals, cellDeepDive, ENTRY_GUARDS, EXIT_TRIGGERS } from './matrix.js';
import type { Signal } from './portfolio.js';

const DAY = 86400000;
const start = Date.parse('2015-01-01T00:00:00.000Z');
const iso = (i: number) => new Date(start + i * DAY).toISOString();

function signals(n: number, close: (i: number) => number, regime: (i: number) => string = () => 'bullish'): Signal[] {
  return Array.from({ length: n }, (_, i) => ({
    observedAt: iso(i), close: close(i), regime: regime(i),
    mayer: close(i) / 100, sma200: 100, mvrv: 2, weeklyRsi: 50, fearGreed: 50,
  }));
}

// A longer, oscillating fixture (2015-01-01 -> ~2026, past both halving boundaries) for
// the sensitivity/robustness/adaptive sections: mayer swings roughly 1..3 and mvrv
// roughly 0.2..1.8, so both the fixed and adaptive combos actually find entries and
// exits rather than sitting permanently idle.
function longSignals(n = 4200): Signal[] {
  return Array.from({ length: n }, (_, i) => ({
    observedAt: iso(i), close: 100 * (1 + i / 2000), regime: 'bullish',
    mayer: 2 + 1.5 * Math.sin(i / 300), sma200: 100, mvrv: 1 + 0.8 * Math.sin(i / 250 + 1), weeklyRsi: 50, fearGreed: 50,
  }));
}

test('dcaMatrixFromSignals: one cell per entry guard x exit trigger pair, none skipped', () => {
  const m = dcaMatrixFromSignals(signals(1500, i => 100 * (1 + i / 1000)));
  assert.equal(m.cells.length, ENTRY_GUARDS.length * EXIT_TRIGGERS.length);
  for (const entry of ENTRY_GUARDS) for (const exit of EXIT_TRIGGERS)
    assert.ok(m.cells.some(c => c.entryKey === entry.key && c.exitKey === exit.key), `missing cell ${entry.key}/${exit.key}`);
});

test('dcaMatrixFromSignals: a cell never carries both a result and an error', () => {
  const m = dcaMatrixFromSignals(signals(1500, i => 100 * (1 + i / 1000)));
  for (const cell of m.cells) {
    if (cell.error) assert.equal(cell.moneyWeightedReturnPct, undefined);
    else assert.ok(typeof cell.moneyWeightedReturnPct === 'number' || cell.moneyWeightedReturnPct === null);
  }
});

test('dcaMatrixFromSignals: too short a window to backtest fails that cell only, not the whole matrix', () => {
  const m = dcaMatrixFromSignals(signals(5, i => 100 + i));
  assert.equal(m.cells.length, ENTRY_GUARDS.length * EXIT_TRIGGERS.length);
  assert.ok(m.cells.every(c => c.error));
});

test('dcaMatrixFromSignals: a pure uptrend never triggers a guard-gated strategy to sit out entirely -- the no-guard cell stays invested', () => {
  const m = dcaMatrixFromSignals(signals(1500, i => 100 * (1 + i / 1000)));
  const noGuardHold = m.cells.find(c => c.entryKey === 'none' && c.exitKey === 'none')!;
  assert.ok(noGuardHold.timeInMarketPct! >= 99, `expected near-full exposure, got ${noGuardHold.timeInMarketPct}`);
});

test('cellDeepDive: an unknown entry or exit key is rejected', () => {
  const sig = longSignals();
  assert.throws(() => cellDeepDive(sig, 'not-a-key', 'none'));
  assert.throws(() => cellDeepDive(sig, 'none', 'not-a-key'));
});

test('cellDeepDive: MVRV entry / Mayer exit -- two sweeps, robustness, and adaptive all present', () => {
  const d = cellDeepDive(longSignals(), 'mvrv-lte1', 'mayer-gte2.4');
  assert.equal(d.sweeps.length, 2);
  assert.deepEqual(d.sweeps.map(s => s.side).sort(), ['entry', 'exit']);
  const entrySweep = d.sweeps.find(s => s.side === 'entry')!;
  assert.equal(entrySweep.metric, 'mvrv');
  assert.equal(entrySweep.thresholds.length, 29); // 0.2 .. 3.0 step 0.1
  assert.equal(entrySweep.thresholds[0], 0.2);
  const exitSweep = d.sweeps.find(s => s.side === 'exit')!;
  assert.equal(exitSweep.metric, 'mayer');
  assert.equal(exitSweep.thresholds.length, 36); // 0.5 .. 4.0 step 0.1
  assert.deepEqual(d.robustness.segments.map(s => s.label), ['Pre-2020 halving', '2020 halving cycle', '2024 halving cycle (current, incomplete)']);
  assert.ok(d.adaptive);
  assert.equal(d.adaptive!.rows.length, 4);
});

test('cellDeepDive: Mayer entry / MVRV exit (the swapped arrangement) also gets an adaptive comparison', () => {
  const d = cellDeepDive(longSignals(), 'mayer-lte1', 'mvrv-gte3');
  assert.ok(d.adaptive);
});

test('cellDeepDive: a non-threshold side contributes no sweep, but robustness always runs', () => {
  const d = cellDeepDive(longSignals(), 'regime-bull', 'mayer-gte2.4');
  assert.equal(d.sweeps.length, 1);
  assert.equal(d.sweeps[0].side, 'exit');
  assert.equal(d.sweeps[0].metric, 'mayer');
  assert.equal(d.adaptive, null); // entry isn't mvrv, so no percentile pairing
  assert.ok(d.robustness);
});

test('cellDeepDive: two non-threshold sides get zero sweeps and no adaptive section, but still a robustness check', () => {
  const d = cellDeepDive(longSignals(), 'regime-bull', 'new-ath');
  assert.equal(d.sweeps.length, 0);
  assert.equal(d.adaptive, null);
  assert.ok(d.robustness.segments.length === 3);
});

test('cellDeepDive: a Drawdown/RSI pairing sweeps both sides but never gets an adaptive section', () => {
  const d = cellDeepDive(longSignals(), 'dd20', 'rsi-gte70');
  assert.equal(d.sweeps.length, 2);
  const dd = d.sweeps.find(s => s.metric === 'drawdown-from-ath')!;
  assert.equal(dd.thresholds.length, 12); // 5 .. 60 step 5
  const rsi = d.sweeps.find(s => s.metric === 'weekly-rsi')!;
  assert.equal(rsi.thresholds.length, 17); // 10 .. 90 step 5
  assert.equal(d.adaptive, null);
});

test('cellDeepDive: each sweep never carries a null thresholds array, and trade counts are never negative', () => {
  const d = cellDeepDive(longSignals(), 'fg-lte25', 'fg-gte75');
  for (const sweep of d.sweeps) for (const t of sweep.trades) assert.ok(t === null || t >= 0);
});
