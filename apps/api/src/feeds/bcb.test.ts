import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSgs, cdiSeriesId } from './bcb.js';

const row = (day: number, valor: string | number = '0.051660') => ({ data: `${String(day).padStart(2, '0')}/01/2026`, valor });

test('BCB SGS feed sorts ascending, parses DD/MM/AAAA and excludes the live day', () => {
  // Provider order is not assumed ascending.
  const sample = parseSgs(cdiSeriesId, 'cdi_daily_rate', 'pct_per_business_day', [row(3), row(1), row(2)], '2026-01-04T12:00:00Z');
  assert.equal(sample.series![0].definition.assetId, null);
  assert.equal(sample.series![0].definition.metricCode, 'cdi_daily_rate');
  assert.equal(sample.series![0].definition.unit, 'pct_per_business_day');
  assert.deepEqual(sample.series![0].points.map(p => p.observedAt.slice(0, 10)), ['2026-01-01', '2026-01-02', '2026-01-03']);
});

test('the live/incomplete day is excluded', () => {
  const sample = parseSgs(cdiSeriesId, 'cdi_daily_rate', 'pct_per_business_day', [row(1), row(4)], '2026-01-04T12:00:00Z');
  assert.equal(sample.series![0].points.length, 1);
});

test('weekends and holidays are simply absent from the payload, not a parse error', () => {
  // 2026-01-02 (Fri) then 2026-01-05 (Mon): a normal business-day gap, no synthetic fill.
  const sample = parseSgs(cdiSeriesId, 'cdi_daily_rate', 'pct_per_business_day', [
    { data: '02/01/2026', valor: '0.05' }, { data: '05/01/2026', valor: '0.05' },
  ], '2026-01-06T12:00:00Z');
  assert.deepEqual(sample.series![0].points.map(p => p.observedAt.slice(0, 10)), ['2026-01-02', '2026-01-05']);
});

test('a non-positive, non-finite or malformed value/date is rejected', () => {
  for (const valor of [0, -1, NaN, 'x']) assert.throws(() => parseSgs(cdiSeriesId, 'cdi_daily_rate', 'pct_per_business_day', [row(1, valor)], '2026-01-04'), /value/);
  assert.throws(() => parseSgs(cdiSeriesId, 'cdi_daily_rate', 'pct_per_business_day', [{ data: '2026-01-01', valor: '0.05' }], '2026-01-04'), /date/);
});

test('non-increasing timestamps and empty coverage are rejected', () => {
  assert.throws(() => parseSgs(cdiSeriesId, 'cdi_daily_rate', 'pct_per_business_day', [row(1), row(1)], '2026-01-04'), /increasing/);
  assert.throws(() => parseSgs(cdiSeriesId, 'cdi_daily_rate', 'pct_per_business_day', [], '2026-01-04'), /Invalid/);
  assert.throws(() => parseSgs(cdiSeriesId, 'cdi_daily_rate', 'pct_per_business_day', [row(4)], '2026-01-04T12:00:00Z'), /No completed/);
});

test('the annualized CDI rate formula matches (1+d/100)^252-1', () => {
  const dailyPct = 0.051660;
  const annualized = Math.pow(1 + dailyPct / 100, 252) - 1;
  assert.ok(Math.abs(annualized - 0.139) < 0.001, `expected ~13.9%, got ${(annualized * 100).toFixed(2)}%`);
});
