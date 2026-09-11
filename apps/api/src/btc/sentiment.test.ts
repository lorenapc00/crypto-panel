import assert from 'node:assert/strict';
import test from 'node:test';
import { sentimentCycles } from './sentiment.js';
import { halvings } from './calculations.js';

const DAY = 86400000;
const iso = (ms: number) => new Date(ms).toISOString();

test('points are segmented by halving date, indexed by days since that halving', () => {
  const secondHalving = Date.parse(halvings[1].date);
  const points = [
    { observedAt: iso(secondHalving), value: 40 },
    { observedAt: iso(secondHalving + 5 * DAY), value: 60 },
  ];
  const cycles = sentimentCycles(points);
  assert.equal(cycles[1].points.length, 2);
  assert.deepEqual(cycles[1].points.map(p => p.day), [0, 5]);
  assert.deepEqual(cycles[1].points.map(p => p.value), [40, 60]);
  assert.equal(cycles[0].points.length, 0);
});

test('a point before the first halving is excluded from every cycle', () => {
  const point = { observedAt: iso(Date.parse(halvings[0].date) - 10 * DAY), value: 30 };
  const cycles = sentimentCycles([point]);
  assert.ok(cycles.every(c => c.points.length === 0));
});

test('null values pass through the segmentation unindexed by value', () => {
  const start = Date.parse(halvings[2].date);
  const cycles = sentimentCycles([{ observedAt: iso(start + DAY), value: null }]);
  assert.equal(cycles[2].points[0].value, null);
  assert.equal(cycles[2].points[0].day, 1);
});
