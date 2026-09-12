import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dcaMatrixFromSignals, ENTRY_GUARDS, EXIT_TRIGGERS } from './matrix.js';
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
