import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL ?? "postgres://crypto_panel:crypto_panel_dev@127.0.0.1:5432/crypto_panel";
export const pool = new Pool({ connectionString, max: 5 });

export type TokenomicsEvent = { id: string; type: "unlock" | "emission" | "burn" | "buyback"; amount: number; unit: string; effectiveAt: string; publishedAt: string; sourceId: string; coverage: string; verification: "verified" | "reported" };
export async function storedTokenomicsEvents(assetId: string, database: Pool = pool) {
  const result = await database.query(`select id, event_type, amount, unit, effective_at, published_at, source_id, coverage, verification
    from tokenomics_events where asset_id=$1 order by effective_at asc`, [assetId]);
  return result.rows.map(row => ({ id: row.id, type: row.event_type, amount: Number(row.amount), unit: row.unit,
    effectiveAt: row.effective_at.toISOString(), publishedAt: row.published_at.toISOString(), sourceId: row.source_id,
    coverage: row.coverage, verification: row.verification } as TokenomicsEvent));
}

export async function closeDatabase() { await pool.end(); }
