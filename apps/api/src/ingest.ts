import { marketData, priorityAssetIds, assetDetails } from "./market.js";
import { fundamentals } from "./fundamentals.js";
import { closeDatabase } from "./db.js";

try {
  await marketData();
  for (const assetId of priorityAssetIds) { await assetDetails(assetId); await fundamentals(assetId); }
  console.log(`Stored market snapshots and OHLC history for ${priorityAssetIds.join(", ")}.`);
} finally { await closeDatabase(); }
