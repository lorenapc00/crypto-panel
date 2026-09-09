import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function calculateBudget(provider, monthDays = 31) {
  const callsPerDay = provider.jobs.reduce((sum, job) => sum + job.requestsPerCycle * job.cyclesPerDay, 0);
  const scheduledMonthlyCalls = Math.ceil(callsPerDay * monthDays);
  const firstMonthCalls = scheduledMonthlyCalls + provider.bootstrapRequests;
  const localHeadroom = provider.localLimit.requestsPerMonth - firstMonthCalls;
  const documentedHeadroom = provider.documentedLimit.requestsPerMonth == null ? null : provider.documentedLimit.requestsPerMonth - firstMonthCalls;
  return { provider: provider.id, enabled: provider.enabled !== false, callsPerDay, scheduledMonthlyCalls, bootstrapRequests: provider.bootstrapRequests, firstMonthCalls, localHeadroom, documentedHeadroom, withinBudget: localHeadroom >= 0 && (documentedHeadroom === null || documentedHeadroom >= 0) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const budget = JSON.parse(await readFile(new URL("../docs/data/quota-budget.json", import.meta.url), "utf8"));
  const results = budget.providers.map(provider => calculateBudget(provider, budget.planningMonthDays));
  console.table(results);
  console.log("Planning estimates only. Disabled providers show reserved capacity. Retries must fit within headroom.");
  if (results.some(result => !result.withinBudget)) process.exitCode = 1;
}
