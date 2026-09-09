import assert from "node:assert/strict";
import test from "node:test";
import { DAY_MS, expectedDailyTime, parseDailyChart } from "./daily-history.js";

const midnight = Date.parse("2026-09-09T00:00:00Z");
const now = midnight + 12 * 3600000;

test("daily chart drops the live tail and keeps rolling volume as a separate series", () => {
  const data = parseDailyChart({ prices: [[midnight - DAY_MS, 100], [midnight, 110], [now, 120]], total_volumes: [[midnight - DAY_MS, 500], [midnight, 0], [now, 800]] }, now);
  assert.equal(data.prices.length, 2);
  assert.deepEqual(data.prices.at(-1), { observedAt: new Date(midnight).toISOString(), value: 110 });
  assert.deepEqual(data.volumes.at(-1), { observedAt: new Date(midnight).toISOString(), value: 0 });
  assert.equal("volume" in data.prices[0], false);
});

test("daily chart rejects four-day spacing, hourly points, duplicates, and invalid values", () => {
  for (const prices of [
    [[midnight - 8 * DAY_MS, 100], [midnight - 4 * DAY_MS, 110], [midnight, 120]],
    [[midnight - DAY_MS, 100], [midnight - DAY_MS + 3600000, 101]],
    [[midnight, 100], [midnight, 101]],
    [[midnight, "100"]],
    [[midnight, Infinity]],
  ]) assert.throws(() => parseDailyChart({ prices, total_volumes: [] }, now));
});

test("daily chart preserves missing points and gaps instead of zero-filling", () => {
  const prices = [[midnight - 4 * DAY_MS, 100], [midnight - 3 * DAY_MS, null], [midnight, 110]];
  const data = parseDailyChart({ prices, total_volumes: [] }, now);
  assert.equal(data.prices.length, 3);
  assert.equal(data.prices[1].value, null);
  assert.deepEqual(data.volumes, []);
});

test("freshness changes at the provider publication boundary even for populated history", () => {
  const populatedLastPoint = midnight - DAY_MS;
  assert.equal(expectedDailyTime(midnight + 9 * 60000), populatedLastPoint);
  assert.equal(expectedDailyTime(midnight + 10 * 60000), midnight);
  assert.ok(populatedLastPoint < expectedDailyTime(now));
});
