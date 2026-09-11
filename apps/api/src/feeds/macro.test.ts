import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFred, macroSeriesId } from './macro.js';

const obs = (day: number, value: string = '1.87') => ({ date: `2026-01-${String(day).padStart(2, '0')}`, value });

test('FRED feed parses observations and skips "." without forward-filling', () => {
  const sample = parseFred('DFII10', { observations: [obs(1, '1.80'), obs(2, '.'), obs(3, '1.85')] }, '2026-01-04T12:00:00Z');
  assert.equal(sample.series![0].definition.id, macroSeriesId('DFII10'));
  assert.equal(sample.series![0].definition.metricCode, 'real_yield_10y');
  assert.equal(sample.series![0].definition.sourceId, 'fred');
  assert.deepEqual(sample.series![0].points.map(p => p.value), [1.8, 1.85]);
  assert.deepEqual(sample.series![0].points.map(p => p.observedAt.slice(0, 10)), ['2026-01-01', '2026-01-03']);
});

test('the live/incomplete day is excluded', () => {
  const sample = parseFred('SP500', { observations: [obs(1), obs(4)] }, '2026-01-04T12:00:00Z');
  assert.equal(sample.series![0].points.length, 1);
});

test('an unknown series code is rejected', () => {
  assert.throws(() => parseFred('BOGUS', { observations: [obs(1)] }, '2026-01-04'), /Unknown FRED series/);
});

test('a malformed date or non-numeric value (other than ".") is rejected', () => {
  assert.throws(() => parseFred('DFII10', { observations: [{ date: '2026/01/01', value: '1.8' }] }, '2026-01-04'), /date/);
  assert.throws(() => parseFred('DFII10', { observations: [obs(1, 'nope')] }, '2026-01-04'), /value/);
});

test('non-increasing dates and empty coverage are rejected', () => {
  assert.throws(() => parseFred('DFII10', { observations: [obs(1), obs(1)] }, '2026-01-04'), /increasing/);
  assert.throws(() => parseFred('DFII10', { observations: [] }, '2026-01-04'), /Invalid/);
  assert.throws(() => parseFred('DFII10', { observations: [obs(4)] }, '2026-01-04T12:00:00Z'), /No completed/);
});

test('macroSeriesId is stable and lowercase per code', () => {
  assert.equal(macroSeriesId('DTWEXBGS'), 'fred:dtwexbgs:daily:v1');
});
