import assert from "node:assert/strict";
import test from "node:test";
import { deriveTokenomics } from "./fundamentals.js";

test("derives supply coverage without presenting it as an unlock forecast", () => {
  const result = deriveTokenomics({ circulatingSupply: 250, maxSupply: 1_000 });
  assert.equal(result.circulatingPercent, 25);
  assert.equal(result.nonCirculatingSupply, 750);
  assert.equal(result.unlocks.status, "unavailable");
  assert.match(result.emissions.note, /not a future issuance forecast/);
});

test("does not infer dilution when maximum supply is unavailable", () => {
  const result = deriveTokenomics({ circulatingSupply: 1_000, maxSupply: null });
  assert.equal(result.circulatingPercent, null);
  assert.equal(result.nonCirculatingSupply, null);
});
