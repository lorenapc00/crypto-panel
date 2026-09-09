import assert from "node:assert/strict";
import test from "node:test";
import { indicators, type Candle } from "./indicators.js";

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
