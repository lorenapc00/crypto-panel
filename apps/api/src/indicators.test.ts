import assert from "node:assert/strict";
import test from "node:test";
import { indicators, returns, type Candle } from "./indicators.js";

const candles = (closes: number[]): Candle[] => closes.map((close, index) => ({ observedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(), close }));

test("returns null indicators until enough history exists", () => {
  assert.deepEqual(indicators(candles([1, 2, 3])), { sma7: null, sma30: null, rsi14: null, macd: null });
});

test("calculates moving averages, RSI and MACD from chronological candles", () => {
  const result = indicators(candles(Array.from({ length: 35 }, (_, index) => index + 1)));
  assert.equal(result.sma7, 32);
  assert.equal(result.sma30, 20.5);
  assert.equal(result.rsi14, 100);
  assert.notEqual(result.macd, null);
});

test("Wilder RSI carries smoothed gains and losses beyond the initial window", () => {
  const result = indicators(candles([44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00]));
  assert.ok(Math.abs(result.rsi14! - 66.24961855355505) < 1e-9);
  assert.equal(indicators(candles(Array(20).fill(100))).rsi14, 50);
});

test("indicators restart after missing daily history and reject unordered timestamps", () => {
  const history = candles(Array.from({ length: 40 }, (_, i) => i + 1));
  history[34].close = null;
  assert.equal(indicators(history).sma7, null);
  assert.equal(indicators(history.filter((_, index) => index !== 34)).sma7, null);
  assert.equal(indicators([...history].reverse()).sma7, null);
});

test("returns use elapsed calendar days rather than row offsets", () => {
  const history = candles(Array.from({ length: 91 }, (_, i) => 100 + i));
  const sparse = history.filter((_, index) => [0, 60, 83, 89, 90].includes(index));
  const result = returns(sparse);
  assert.ok(Math.abs(result.day! - (190 / 189 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(result.week! - (190 / 183 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(result.month! - (190 / 160 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(result.quarter! - 90) < 1e-9);
  assert.equal(returns(history.filter((_, index) => index !== 89)).day, null);
});

test("four-day data and null or zero starting prices cannot masquerade as daily returns", () => {
  const history = candles(Array.from({ length: 33 }, (_, i) => 100 + i)).filter((_, i) => i % 4 === 0);
  assert.deepEqual(returns(history), { day: null, week: null, month: null, quarter: null });
  assert.equal(returns(candles([0, 10])).day, null);
  assert.equal(returns([{ observedAt: "2026-01-01", close: null }, { observedAt: "2026-01-02", close: 10 }]).day, null);
});
