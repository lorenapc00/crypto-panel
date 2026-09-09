import assert from "node:assert/strict";
import test from "node:test";
import { probe, seriesSummary, summarize } from "./probe-capabilities.mjs";

test("detects four-day candles and an incomplete trailing daily point", () => {
  const candles = seriesSummary([[0, 1], [345600000, 2], [691200000, 3]], { time: 0, unit: "ms", metrics: ["1"] });
  assert.equal(candles.intervalSeconds, 345600);
  const daily = seriesSummary([[0, 1], [86400000, 2], [100000000, 3]], { time: 0, unit: "ms", metrics: ["1"] });
  assert.equal(daily.regular, false);
  assert.equal(daily.intervalSeconds, null);
});

test("keeps missing metrics, duplicates, and invalid dates visible", () => {
  const summary = seriesSummary([
    { date: "2020-01-01", value: "" }, { date: "2020-01-01", value: null },
    { date: "bad-date", value: 5 }, { date: "2020-01-02", value: "0" },
    { date: "2020-01-04", value: "NaN" },
  ], { time: "date", unit: "iso", metrics: ["value"] });
  assert.equal(summary.duplicateTimestamps, 1);
  assert.equal(summary.invalidTimestamps, 1);
  assert.equal(summary.regular, false);
  assert.deepEqual(summary.metrics.value, { numericRows: 1, missingRows: 4, first: "2020-01-02T00:00:00.000Z", last: "2020-01-02T00:00:00.000Z" });
});

test("CSV history starts at the first populated metric, not the first date", () => {
  const summary = summarize("time,PriceUSD\n2009-01-03,\n2010-07-18,0.05\n", { kind: "csv", metrics: ["PriceUSD", "SOPR"] });
  assert.equal(summary.first, "2009-01-03T00:00:00.000Z");
  assert.equal(summary.metrics.PriceUSD.first, "2010-07-18T00:00:00.000Z");
  assert.equal(summary.metrics.SOPR.numericRows, 0);
});

test("namespace catalogs distinguish native from named DEXes and reject malformed entries", () => {
  assert.deepEqual(summarize([null, { name: "xyz" }], { kind: "namespaces" }).namespaces, [{ index: 0, name: "" }, { index: 1, name: "xyz" }]);
  assert.throws(() => summarize([null, {}], { kind: "namespaces" }));
  assert.throws(() => summarize([{ universe: [{ name: "BTC" }] }, []], { kind: "contexts" }));
});

test("empty collections and missing depth do not become fabricated observations", () => {
  assert.equal(summarize([], { kind: "rows", path: [] }).rows, 0);
  const summary = summarize({ coin: "BTC", time: 0, levels: [[], []] }, { kind: "book" });
  assert.equal(summary.bestBid, null);
  assert.equal(summary.bestAsk, null);
});

const spec = { id: "fixture", provider: "fred", url: "https://api.stlouisfed.org/fred/series/observations?series_id=DFII10", summary: { kind: "series", path: ["observations"], time: "date", unit: "iso", metrics: ["value"] } };

test("HTTP success with an API error or an unexpected schema is a failed probe", async () => {
  for (const payload of [{ error: "invalid request" }, { observations: "not an array" }]) {
    const result = await probe(spec, { env: {}, fetchImpl: async () => new Response(JSON.stringify(payload)) });
    assert.equal(result.outcome, "invalid-payload");
  }
});

test("reports pagination without claiming a complete history", async () => {
  const result = await probe(spec, { env: {}, fetchImpl: async () => new Response(JSON.stringify({ observations: [{ date: "2020-01-01", value: 1 }], next_page_token: "next" })) });
  assert.equal(result.outcome, "sample-received");
  assert.equal(result.paginationRemaining, true);
});

test("credential-bearing requests do not write keys or echoed error bodies into evidence", async () => {
  const secret = "fixture-secret-do-not-record";
  const result = await probe(spec, { env: { FRED_API_KEY: secret }, fetchImpl: async url => {
    assert.equal(url.searchParams.get("api_key"), secret);
    return new Response(`Error for ${url}`, { status: 400 });
  } });
  assert.equal(result.outcome, "http-error");
  assert.equal(JSON.stringify(result).includes(secret), false);
  const cg = await probe({ ...spec, provider: "coingecko", url: "https://api.coingecko.com/api/v3/global" }, { env: { COINGECKO_DEMO_API_KEY: secret }, fetchImpl: async (url, init) => {
    assert.equal(init.headers["x-cg-demo-api-key"], secret);
    throw new Error(`Could not fetch ${secret}`);
  } });
  assert.equal(cg.outcome, "network-error");
  assert.equal(JSON.stringify(cg).includes(secret), false);
});

test("rate limiting records Retry-After without retrying or misclassifying paid access", async () => {
  let calls = 0;
  const result = await probe(spec, { env: {}, fetchImpl: async () => { calls++; return new Response("slow down", { status: 429, headers: { "retry-after": "60" } }); } });
  assert.equal(calls, 1);
  assert.equal(result.outcome, "rate-limited");
  assert.equal(result.responseHeaders["retry-after"], "60");
});
