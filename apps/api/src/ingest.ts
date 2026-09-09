import { marketData, priorityAssetIds, assetDetails } from "./market.js";
import { closeDatabase } from "./db.js";

try {
  await marketData();
  for (const assetId of priorityAssetIds) await assetDetails(assetId);
  console.log(`Stored market snapshots and OHLC history for ${priorityAssetIds.join(", ")}.`);
} finally { await closeDatabase(); }
