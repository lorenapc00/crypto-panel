import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateBudget } from "./quota-budget.mjs";

const budget = JSON.parse(await readFile(new URL("../docs/data/quota-budget.json", import.meta.url), "utf8"));

test("the 1000-asset design leaves room for bootstrap and failures in a 31-day month", () => {
  const cg = calculateBudget(budget.providers.find(provider => provider.id === "coingecko"));
  assert.equal(cg.firstMonthCalls, 4875);
  assert.equal(cg.documentedHeadroom, 5125);
  assert.equal(cg.localHeadroom, 1125);
  for (const provider of budget.providers) assert.equal(calculateBudget(provider).withinBudget, true, provider.id);
});

test("expanding to 3000 assets or daily per-asset refetches exceeds the free budget", () => {
  const cg = structuredClone(budget.providers.find(provider => provider.id === "coingecko"));
  cg.jobs.find(job => job.id === "market-pages").requestsPerCycle = 12;
  cg.bootstrapRequests = 3000;
  assert.equal(calculateBudget(cg).firstMonthCalls, 12827);
  assert.equal(calculateBudget(cg).withinBudget, false);
  cg.jobs.push({ id: "per-asset-history", requestsPerCycle: 1000, cyclesPerDay: 1 });
  assert.ok(calculateBudget(cg).documentedHeadroom < 0);
});

test("weighted venue calls include response-size cost and must be spread across minutes", () => {
  const hl = budget.providers.find(provider => provider.id === "hyperliquid");
  const weightPerHour = hl.jobs.reduce((sum, job) => sum + job.requestsPerCycle * job.weightPerRequest, 0);
  assert.equal(weightPerHour, 700);
  assert.ok(weightPerHour > hl.localLimit.weightPerMinute);
  assert.ok(hl.localLimit.weightPerMinute <= hl.documentedLimit.weightPerMinute);
  assert.equal(calculateBudget(hl).scheduledMonthlyCalls, 38688);
});
