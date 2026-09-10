import assert from 'node:assert/strict';
import test from 'node:test';
import { contextView } from './context.js';
const now = '2026-02-02T12:00:00Z';
const snapshot = (members: any[], observedAt = '2026-02-02T11:45:00Z'): any => ({ members, metadata: { observedAt, source: 'hyperliquid' } });
const native = (data: any, name = 'BTC', namespace = '') => ({ key: JSON.stringify(['hyperliquid', namespace, name]), status: 'active', data });
const empty = { sample: null, funding: null, capital: null, catalog: null, now };

test('BTC venue context resolves native identity, counts OI once and separates signed funding rates', () => {
  const sample = snapshot([native({ openInterestNative: 999 }, 'xyz:BTC', 'xyz'), native({ openInterestNative: 2, markPrice: 10, fundingRate: -0.0001, fundingIntervalSeconds: 3600 })]);
  const funding = snapshot([{ data: { venue: 'hyperliquid', namespace: '', coin: 'BTC', observedAt: '2026-02-02T11:00:00.005Z', intervalSeconds: 3600, fundingRate: 0.0002 } }]);
  const view = contextView({ ...empty, sample, funding }).data.venue;
  assert.equal(view.openInterest.value, 2); assert.equal(view.estimatedNotional.value, 20);
  assert.equal(view.estimatedNotional.unit, 'USDT price units'); assert.equal(view.sampledFunding.value, -0.0001);
  assert.equal(view.settledFunding.value, 0.0002); assert.equal(view.settledFunding.observedAt, '2026-02-02T11:00:00.005Z');
});
test('venue fields degrade independently and unknown intervals or absent native markets stay unavailable', () => {
  const sample = snapshot([native({ openInterestNative: 0, markPrice: null, fundingRate: 0, fundingIntervalSeconds: 28800 })], '2026-02-01');
  const view = contextView({ ...empty, sample }).data;
  assert.equal(view.venue.openInterest.value, 0); assert.equal(view.venue.openInterest.stale, true);
  assert.equal(view.venue.estimatedNotional.unavailable, true); assert.equal(view.venue.sampledFunding.unavailable, true);
  assert.equal(view.venue.settledFunding.unavailable, true); assert.equal(view.capital.latest, null);
  assert.equal(contextView({ ...empty, sample: snapshot([native({ openInterestNative: 100 }, 'xyz:BTC', 'xyz')]) }).data.venue.openInterest.value, null);
});
test('capital changes use exact calendar endpoints, keep missing days and null corrections visible', () => {
  const capital: any = { points: [{ observedAt: '2026-01-01T00:00:00Z', value: 100 }, { observedAt: '2026-01-31T00:00:00Z', value: 110 }, { observedAt: '2026-02-01T00:00:00Z', value: 120 }], metadata: {} };
  let view = contextView({ ...empty, capital }).data.capital;
  assert.equal(view.points.length, 32); assert.equal(view.points[1].value, null);
  assert.ok(Math.abs(view.points[30].change30dPct! - 10) < 1e-10);
  assert.equal(view.latest!.change30dPct, null); assert.equal(view.coverage.stale, false);
  capital.points[0].value = 0;
  assert.equal(contextView({ ...empty, capital }).data.capital.points[30].change30dPct, null);
  capital.points[2].value = null;
  view = contextView({ ...empty, capital }).data.capital;
  assert.equal(view.latest!.value, null); assert.equal(view.coverage.unavailable, true);
  assert.equal(view.coverage.last, '2026-01-31T00:00:00Z');
});
