import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { migrate, loadMigrations } from "../src/migrations.js";
import { archivePayload, readSeries, ReplayCoverageError, type ArchiveInput, type SeriesDefinition } from "../src/archive.js";
import { dailySeriesId, dailyHistory, ingestDailyHistory, expectedDailyTime, DAY_MS } from "../src/daily-history.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required");

async function isolated(run: (database: Pool) => Promise<void>) {
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const schema = `research_test_${randomUUID().replaceAll("-", "")}`;
  const database = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 3, connectionTimeoutMillis: 5000 });
  try {
    await admin.query(`create schema ${schema}`);
    await run(database);
  } finally {
    await database.end();
    // Only the random schema created by this test is removed, never public or application tables.
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
}

const definition: SeriesDefinition = { id: "cg:btc:daily:v1", assetId: "bitcoin", metricCode: "price_usd", sourceId: "coingecko", unit: "USD", scope: "asset", intervalSeconds: 86400, methodologyVersion: "daily:v1" };
function payload(value: number | null): ArchiveInput {
  return { sourceId: "coingecko", endpoint: "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?days=365", requestedAt: "2026-01-01T00:00:00Z", receivedAt: "2026-01-01T00:00:01Z", rawPayload: JSON.stringify({ value }), series: [{ definition, points: [{ observedAt: "2020-01-01T00:00:00Z", value }] }] };
}
async function ready(database: Pool) {
  await migrate(database);
  await database.query("insert into assets (id, symbol, name) values ('bitcoin', 'BTC', 'Bitcoin')");
}

test("fresh and concurrent migrations apply once, with an intact ledger on rerun", async () => isolated(async database => {
  const result = await Promise.all([migrate(database), migrate(database)]);
  const expected = (await loadMigrations()).length;
  assert.equal(result.flat().length, expected);
  assert.equal((await database.query("select count(*)::int as count from schema_migrations")).rows[0].count, expected);
  assert.deepEqual(await migrate(database), []);
  assert.equal((await database.query("select count(*)::int as count from metric_definitions")).rows[0].count, 12);
}));

test("unversioned upgrades retain original candles and block subsequent quarantine writes", async () => isolated(async database => {
  const files = await loadMigrations();
  await database.query(files[0].sql);
  await database.query("insert into assets (id, symbol, name) values ('bitcoin', 'BTC', 'Bitcoin')");
  await database.query(`insert into candles (asset_id, interval, observed_at, open, high, low, close, volume, source_id, recorded_at)
    values ('bitcoin', 'daily', '2020-01-01', 100, 110, 90, 105, 999, 'coingecko', '2026-01-01')`);
  const original = (await database.query("select * from candles")).rows[0];
  await migrate(database);
  const migrated = (await database.query("select * from legacy_candles")).rows[0];
  const { quarantined_at, quarantine_reason, ...retained } = migrated;
  assert.deepEqual(retained, original);
  assert.ok(quarantined_at);
  assert.match(quarantine_reason, /Unverified legacy/);
  assert.equal((await database.query("select to_regclass('candles') as relation")).rows[0].relation, null);
  await assert.rejects(database.query("update legacy_candles set close=1"), /immutable/);
  await assert.rejects(database.query("delete from legacy_candles"), /immutable/);
  await assert.rejects(database.query("truncate legacy_candles"), /immutable/);
}));

test("failed schema changes roll back and applied-file drift is rejected", async () => isolated(async database => {
  const files = await loadMigrations();
  await migrate(database, files.slice(0, 1));
  const bad = { ...files[1], sql: "alter table assets add column should_rollback text; select * from absent_migration_table", checksum: "fixture-failure" };
  await assert.rejects(migrate(database, [files[0], bad]), /absent_migration_table/);
  assert.equal((await database.query("select count(*)::int as count from schema_migrations")).rows[0].count, 1);
  const column = await database.query("select 1 from information_schema.columns where table_schema=current_schema() and table_name='assets' and column_name='should_rollback'");
  assert.equal(column.rows.length, 0);
  await migrate(database);
  await assert.rejects(migrate(database, [{ ...files[0], checksum: "changed" }, files[1]]), /history differs/);
  await assert.rejects(migrate(database, files.slice(0, 1)), /history differs/);
}));

test("later observations, null corrections and revisions do not alter an earlier replay", async () => isolated(async database => {
  await ready(database);
  await archivePayload(payload(100), database);
  await database.query("insert into replay_coverage (series_id) values ($1)", [definition.id]);
  const cutoff = (await database.query("select clock_timestamp()::text as cutoff")).rows[0].cutoff;
  const before = await readSeries(definition.id, { asOf: cutoff }, database);
  const revised = payload(80);
  revised.series[0].points.push({ observedAt: "2020-01-02T00:00:00Z", value: 120 });
  await archivePayload(revised, database);
  await archivePayload(payload(null), database);
  assert.deepEqual(await readSeries(definition.id, { asOf: cutoff }, database), before);
  const latest = await readSeries(definition.id, {}, database);
  assert.equal(latest!.points[0].value, null);
  assert.equal(latest!.points[1].value, 120);
  assert.equal((await database.query("select count(*)::int as count from series_observations")).rows[0].count, 4);
}));

test("repeated payloads retain provenance without duplicate metric versions", async () => isolated(async database => {
  await ready(database);
  assert.equal((await archivePayload(payload(100), database)).inserted, 1);
  assert.equal((await archivePayload(payload(100), database)).inserted, 0);
  const raw = await database.query("select sha256, endpoint from source_payloads");
  assert.equal(raw.rows.length, 2);
  assert.equal(raw.rows[0].sha256, createHash("sha256").update(payload(100).rawPayload).digest("hex"));
  await assert.rejects(database.query("update source_payloads set endpoint='changed'"), /immutable/);
  await assert.rejects(database.query("delete from series_observations"), /immutable/);
}));

test("backfills do not invent replay coverage or expose unpublished revisions", async () => isolated(async database => {
  await ready(database);
  await archivePayload(payload(100), database);
  assert.equal((await readSeries(definition.id, {}, database))!.metadata.replayCoverageStart, null);
  await assert.rejects(readSeries(definition.id, { asOf: "2025-01-01" }, database), ReplayCoverageError);
  await database.query("insert into replay_coverage (series_id) values ($1)", [definition.id]);
  await assert.rejects(readSeries(definition.id, { asOf: "2025-01-01" }, database), ReplayCoverageError);
  await assert.rejects(readSeries(definition.id, { asOf: "2999-01-01" }, database), /cannot be in the future/);
  const future = payload(999);
  future.series[0].points[0].publishedAt = "2999-01-01T00:00:00Z";
  future.series[0].points.push({ observedAt: "2999-01-01T00:00:00Z", value: 999 });
  await archivePayload(future, database);
  const current = await readSeries(definition.id, {}, database);
  assert.equal(current!.points.length, 1);
  assert.equal(current!.points[0].value, 100);
}));

test("scope or provenance mismatches fail atomically and cannot rewrite a series", async () => isolated(async database => {
  await ready(database);
  await archivePayload(payload(100), database);
  const incompatible = payload(200);
  incompatible.series[0].definition = { ...definition, scope: "chain" };
  await assert.rejects(archivePayload(incompatible, database), /Incompatible metric scope/);
  const wrongSource = payload(200);
  wrongSource.series[0].definition = { ...definition, sourceId: "defillama" };
  await assert.rejects(archivePayload(wrongSource, database), /Invalid series source/);
  assert.equal((await database.query("select count(*)::int as count from source_payloads")).rows[0].count, 1);
  assert.equal((await readSeries(definition.id, {}, database))!.points[0].value, 100);
  await assert.rejects(database.query("update data_series set unit='EUR'"), /immutable/);
}));

test("populated stale daily history refreshes once and subsequent reads use the archive", async () => isolated(async database => {
  await ready(database);
  const target = expectedDailyTime();
  const old = payload(100);
  old.series[0].definition = { ...definition, id: dailySeriesId("bitcoin"), methodologyVersion: "daily-sample:v1" };
  old.series[0].points[0].observedAt = new Date(target - 2 * DAY_MS).toISOString();
  await archivePayload(old, database);
  assert.equal((await dailyHistory("bitcoin", Date.now(), database)).metadata.stale, true);
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ prices: [[target - DAY_MS, 105], [target, 110]], total_volumes: [[target - DAY_MS, 900], [target, 1000]] }));
  };
  assert.equal((await ingestDailyHistory("bitcoin", { database, fetchImpl })).refreshed, true);
  assert.equal((await ingestDailyHistory("bitcoin", { database, fetchImpl })).refreshed, false);
  assert.equal(calls, 1);
  const history = await dailyHistory("bitcoin", Date.now(), database);
  assert.equal(history.metadata.stale, false);
  assert.equal(history.metadata.missingIntervals, 0);
  assert.deepEqual(history.points.map(point => point.close), [100, 105, 110]);
}));
