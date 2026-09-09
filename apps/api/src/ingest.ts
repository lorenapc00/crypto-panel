import { marketData, priorityAssetIds } from "./market.js";
import { ingestDailyHistory } from "./daily-history.js";
import { fundamentals } from "./fundamentals.js";
import { closeDatabase } from "./db.js";

try {
  const snapshot = await marketData();
  for (const assetId of priorityAssetIds) {
    const asset = snapshot.assets.find(candidate => candidate.id === assetId);
    if (!asset) { console.warn(`${assetId}: no market snapshot; skipped history`); continue; }
    const result = await ingestDailyHistory(assetId, { force: process.argv.includes("--force-history") });
    await fundamentals(assetId, asset);
    console.log(`${assetId}: ${result.refreshed ? `archived ${result.inserted} new daily metric revisions` : "daily history is current"}`);
  }
} finally { await closeDatabase(); }
