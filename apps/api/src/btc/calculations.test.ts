import assert from 'node:assert/strict';
import test from 'node:test';
import { btcTrend, cycleComparisons, dailyGrid, DAY, type Point } from './calculations.js';
import { signalStudy } from './study.js';
import { parseBtcHistory } from '../feeds/bitcoin.js';

const series = (n: number, value = (i: number) => 100 + i, start = '2020-01-01'): Point[] => Array.from({ length: n }, (_, i) => ({ observedAt: new Date(Date.parse(start) + i * DAY).toISOString(), value: value(i) }));
const row = (time: string, value: unknown = '100') => ({ asset: 'btc', time, PriceUSD: value, CapMrktCurUSD: '1000', CapMVRVCur: '2', SplyCur: '10' });
test('BTC acquisition drops the unfinished UTC day, preserves null corrections and independent missing metrics', () => {
  const parsed = parseBtcHistory({ data: [row('2010-07-18', null), row('2010-07-19'), { ...row('2010-07-20'), CapMVRVCur: null }, row('2010-07-21')] }, '2010-07-21T12:00:00Z');
  assert.equal(parsed.series![0].points.length, 3); assert.equal(parsed.series![0].points[0].value, null);
  assert.equal(parsed.series![2].points.at(-1)!.value, null); assert.equal(parsed.series![0].points.at(-1)!.value, 100);
  assert.equal(parsed.series![0].points[1].publishedAt, undefined);
});
test('BTC acquisition rejects duplicate, intraday, wrong-asset, malformed numeric and paginated responses', () => {
  const now = '2020-01-05T12:00:00Z';
  for (const data of [[row('2020-01-01'), row('2020-01-01')], [row('2020-01-01T01:00:00Z')], [{ ...row('2020-01-01'), asset: 'eth' }], [row('2020-01-01', true)], [row('2020-01-01', -1)]]) assert.throws(() => parseBtcHistory({ data }, now));
  assert.throws(() => parseBtcHistory({ data: [row('2020-01-01')], next_page_token: 'more' }, now), /pagination/);
});
test('regimes require 220 contiguous prices plus three confirmations, with no future dependence', () => {
  const prices = series(250), trend = btcTrend(prices);
  assert.equal(trend[218].candidate, 'insufficient-history'); assert.equal(trend[219].candidate, 'bullish');
  assert.equal(trend[220].regime, 'insufficient-history'); assert.equal(trend[221].regime, 'bullish');
  assert.equal(trend[249].sma200, 249.5); assert.equal(trend[249].sma200Slope20d, 20);
  assert.deepEqual(btcTrend(prices.slice(0, 230)), trend.slice(0, 230));
  assert.equal(btcTrend(series(230, i => 1000 - i)).at(-1)!.regime, 'bearish');
  assert.equal(btcTrend(series(230, () => 100)).at(-1)!.regime, 'transitional');
});
test('a missing daily observation resets averages and regime confirmation rather than connecting through it', () => {
  const prices = series(460).filter((_, i) => i !== 230), trend = btcTrend(prices);
  assert.equal(trend[230].value, null); assert.equal(trend[231].sma50, null); assert.equal(trend[449].candidate, 'insufficient-history');
  assert.equal(trend[450].confirmationDays, 1); assert.equal(trend[452].regime, 'bullish');
  assert.throws(() => dailyGrid([prices[1], prices[0]]));
});
test('weekly indicators use complete Monday–Sunday weeks and ignore an unfinished week', () => {
  const prices = series(200, () => 100, '2020-01-06');
  const trend = btcTrend(prices);
  assert.equal(trend[138].sma20w, null); assert.equal(trend[139].sma20w, 100);
  assert.equal(trend[145].ema21w, null); assert.equal(trend[146].ema21w, 100);
  assert.equal(trend[104].weeklyRsi, 50);
  prices[147].value = 10000;
  const changed = btcTrend(prices); assert.equal(changed[147].ema21w, 100);
  assert.ok(changed[147].sma50! > trend[147].sma50!);
  prices[148].value = null; assert.equal(btcTrend(prices)[153].ema21w, null);
});
test('drawdown recovery and volatility preserve coverage limitations', () => {
  const prices = series(5, i => [100, 80, 70, 90, 100][i]);
  const trend = btcTrend(prices); assert.ok(Math.abs(trend[2].drawdownPct! + 30) < 1e-10);
  assert.equal(trend[3].daysUnderwater, 3); assert.equal(trend[4].recoveryDays, 4);
  prices[2].value = null; assert.equal(btcTrend(prices)[4].recoveryDays, null);
  assert.equal(btcTrend(series(40, () => 100)).at(-1)!.volatility30d, 0);
});
test('halving comparisons require exact anchors and stop before the next cycle', () => {
  const prices = series(6, i => 100 + i, '2024-04-18');
  const cycle = cycleComparisons(prices, prices)[3];
  assert.equal(cycle.anchorPrice, 102); assert.equal(cycle.points[0].indexedPrice, 100); assert.equal(cycle.points[0].day, 0);
  assert.equal(cycleComparisons(prices.filter((_, i) => i !== 2), prices)[3].points[0].indexedPrice, null);
});
test('studies use calendar endpoints, compounded BTC-relative returns and full-path adverse movement', () => {
  const asset = series(8, i => [100, 80, 90, 100, 105, 110, 115, 120][i]);
  const benchmark = series(8, i => 100 + i * 10 / 7);
  const result = signalStudy(asset, benchmark, [asset[0].observedAt]);
  const week = result.events[0].horizons[1];
  assert.ok(Math.abs(week.returnPct! - 20) < 1e-10); assert.ok(Math.abs(week.relativeReturnPct! - (1.2 / 1.1 - 1) * 100) < 1e-10);
  assert.ok(Math.abs(week.maximumAdversePct! + 20) < 1e-10);
  asset[3].value = null; const gap = signalStudy(asset, benchmark, [asset[0].observedAt]).events[0].horizons[1];
  assert.equal(gap.returnPct, week.returnPct); assert.equal(gap.maximumAdversePct, null);
});
test('studies retain missing and immature outcomes, deduplicate events and warn on overlapping windows', () => {
  const asset = series(40), benchmark = series(40); asset[7].value = null;
  const result = signalStudy(asset, benchmark, [asset[0].observedAt, asset[1].observedAt, asset[0].observedAt]);
  assert.equal(result.events.length, 2); assert.equal(result.summaries[1].sampleCount, 1); assert.equal(result.summaries[1].missing, 1);
  assert.equal(result.summaries[1].overlappingPairs, 1); assert.equal(result.summaries[3].unmatured, 2);
  assert.equal(result.summaries[3].meanReturnPct, null); assert.equal(signalStudy([], [], []).summaries[0].sampleCount, 0);
});
