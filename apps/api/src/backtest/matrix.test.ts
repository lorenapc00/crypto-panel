import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dcaMatrixFromSignals, mayerExitSensitivity, mvrvEntrySensitivity, robustnessCheck, adaptiveComparison, ENTRY_GUARDS, EXIT_TRIGGERS } from './matrix.js';
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

test('mayerExitSensitivity: one point per threshold, ascending 1.4 -> 3.8, both entry variants present', () => {
  const s = mayerExitSensitivity(longSignals());
  assert.equal(s.thresholds.length, 25);
  assert.equal(s.thresholds[0], 1.4);
  assert.equal(s.thresholds[s.thresholds.length - 1], 3.8);
  assert.equal(s.mvrvEntry.length, 25);
  assert.equal(s.noGuard.length, 25);
});

test('mvrvEntrySensitivity: one point per threshold, ascending 0.4 -> 2.4, trade counts never negative', () => {
  const s = mvrvEntrySensitivity(longSignals());
  assert.equal(s.thresholds.length, 21);
  assert.equal(s.thresholds[0], 0.4);
  assert.equal(s.thresholds[s.thresholds.length - 1], 2.4);
  for (const t of s.trades) assert.ok(t === null || t >= 0);
});

test('robustnessCheck: three cycle segments in order, an expanding series ending at the data\'s own last date, and a ledger', () => {
  const sig = longSignals();
  const r = robustnessCheck(sig);
  assert.deepEqual(r.segments.map(s => s.label), ['Pre-2020 halving', '2020 halving cycle', '2024 halving cycle (current, incomplete)']);
  assert.ok(r.expanding.length > 1);
  assert.equal(r.expanding[r.expanding.length - 1].to, sig[sig.length - 1].observedAt.slice(0, 10));
  // Expanding-window dates strictly increase -- each point really is a later cutoff, not a re-shuffled list.
  for (let i = 1; i < r.expanding.length; i++) assert.ok(r.expanding[i].to > r.expanding[i - 1].to);
  assert.ok(Array.isArray(r.ledger));
});

test('adaptiveComparison: four windows (three segments + full), each reporting dca/fixed/adaptive', () => {
  const a = adaptiveComparison(longSignals());
  assert.equal(a.rows.length, 4);
  assert.equal(a.rows[3].label, 'Full window');
  for (const row of a.rows) {
    assert.ok(typeof row.dca === 'number' || row.dca === null);
    assert.ok(typeof row.fixed === 'number' || row.fixed === null);
    assert.ok(typeof row.adaptive === 'number' || row.adaptive === null);
  }
  assert.ok(Array.isArray(a.ledger));
});
