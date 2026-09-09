import assert from "node:assert/strict";
import test from "node:test";
import { deriveTokenomics } from "./fundamentals.js";

test("derives supply coverage without presenting it as an unlock forecast", () => {
  const result = deriveTokenomics({
    id: "hyperliquid",
    circulatingSupply: 250,
    maxSupply: 1_000,
  });
  assert.equal(result.circulatingPercent, 25);
  assert.equal(result.nonCirculatingSupply, 750);
  assert.equal(result.unlocks.status, "unavailable");
  assert.match(result.emissions.note, /No verified live issuance source/);
});

test("does not infer dilution when maximum supply is unavailable", () => {
  const result = deriveTokenomics({
    id: "ethereum",
    circulatingSupply: 1_000,
    maxSupply: null,
  });
  assert.equal(result.circulatingPercent, null);
  assert.equal(result.nonCirculatingSupply, null);
});

test("does not hardcode a Bitcoin issuance value", () => {
  const result = deriveTokenomics({
    id: "bitcoin",
    circulatingSupply: 1,
    maxSupply: 21_000_000,
  });
  assert.equal(result.emissions.status, "unavailable");
});
