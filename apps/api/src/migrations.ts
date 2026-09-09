import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";

export type Migration = { version: number; name: string; sql: string; checksum: string };

export async function loadMigrations(): Promise<Migration[]> {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory)).filter(name => name.endsWith(".sql")).sort();
  return Promise.all(names.map(async name => {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    if (!match) throw new Error(`Invalid migration filename: ${name}`);
    const sql = await readFile(new URL(name, directory), "utf8");
    return { version: Number(match[1]), name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

export async function migrate(database: Pool, migrations?: Migration[]) {
  const files = migrations ?? await loadMigrations();
  if (!files.length || files.some((file, index) => file.version !== index + 1)) throw new Error("Migrations must be consecutive, starting at version 1");
  const client = await database.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '15s'");
    // Transaction lock serializes first-time ledger creation too; rollback releases it.
    await client.query("select pg_advisory_xact_lock(hashtext(current_schema()), hashtext('crypto-panel:migrations'))");
    await client.query(`create table if not exists schema_migrations (
      version integer primary key, name text not null, checksum text not null,
      applied_at timestamptz not null default clock_timestamp()
    )`);
    const applied = await client.query<{ version: number; name: string; checksum: string }>("select version, name, checksum from schema_migrations order by version");
    for (const [index, row] of applied.rows.entries()) {
      const file = files[index];
      if (!file || row.version !== file.version || row.name !== file.name || row.checksum !== file.checksum) throw new Error(`Migration history differs at version ${row.version}; restore the applied file and add a new migration`);
    }
    const pending = files.slice(applied.rows.length);
    for (const file of pending) {
      await client.query(file.sql);
      await client.query("insert into schema_migrations (version, name, checksum) values ($1, $2, $3)", [file.version, file.name, file.checksum]);
    }
    await client.query("commit");
    return pending.map(file => file.name);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
