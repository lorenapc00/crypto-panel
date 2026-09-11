import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFearGreed } from './sentiment.js';

const row = (day: number, value: unknown = 50) => ({ value, value_classification: 'Neutral', timestamp: String(Date.UTC(2026, 0, day) / 1000) });

test('Fear & Greed feed sorts ascending, keeps integer values and excludes the live day', () => {
  // Provider order is newest-first; the parser must not assume that.
  const sample = parseFearGreed({ data: [row(3, 70), row(1, 10), row(2, 40)] }, '2026-01-04T12:00:00Z');
  assert.equal(sample.series![0].definition.assetId, null);
  assert.equal(sample.series![0].definition.metricCode, 'fear_greed_index');
  assert.deepEqual(sample.series![0].points.map(p => p.value), [10, 40, 70]);
  assert.deepEqual(sample.series![0].points.map(p => p.observedAt.slice(0, 10)), ['2026-01-01', '2026-01-02', '2026-01-03']);
});

test('the live/incomplete day is excluded', () => {
  const sample = parseFearGreed({ data: [row(1, 10), row(4, 20)] }, '2026-01-04T12:00:00Z');
  assert.deepEqual(sample.series![0].points.map(p => p.value), [10]);
});

test('an out-of-range, non-integer or missing value is refused; the provider\'s numeric-string value is accepted', () => {
  for (const value of [-1, 101, 50.5, null, NaN, 'fifty']) assert.throws(() => parseFearGreed({ data: [row(1, value)] }, '2026-01-04'), /value/);
  const { value: _omit, ...withoutValue } = row(1);
  assert.throws(() => parseFearGreed({ data: [withoutValue] }, '2026-01-04'), /value/);
  assert.equal(parseFearGreed({ data: [row(1, '50')] }, '2026-01-04').series![0].points[0].value, 50);
});

test('duplicate, decreasing or irregular timestamps are refused, and empty coverage is refused', () => {
  assert.throws(() => parseFearGreed({ data: [row(1), row(1)] }, '2026-01-04'), /timestamp/);
  assert.throws(() => parseFearGreed({ data: [{ ...row(1), timestamp: String(Date.UTC(2026, 0, 1) / 1000 + 1) }] }, '2026-01-04'), /timestamp/);
  assert.throws(() => parseFearGreed({ data: [] }, '2026-01-04'), /Invalid/);
  assert.throws(() => parseFearGreed({ data: [row(4)] }, '2026-01-04T12:00:00Z'), /No completed/);
});
