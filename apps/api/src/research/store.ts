import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../discovery/queue.js';
import { InputError, object, text, id, uuid, finite, version, filters } from './validation.js';

async function requireAsset(database: Pool, assetId: string) {
  if (!(await database.query('select 1 from assets where id=$1', [id(assetId)])).rowCount) throw new InputError('Asset not found', 404);
}
export async function workspace(database: Pool) {
  const [watchlist, screens, preferences, alerts] = await Promise.all([
    database.query('select asset_id,created_at from research_watchlist order by created_at,asset_id'),
    database.query('select * from research_screens order by updated_at desc,id'),
    database.query('select key,value from research_preferences'),
    database.query('select count(*)::int as unread from research_alerts where read_at is null'),
  ]);
  return { mode:'personal', persistence:'PostgreSQL', watchlist:watchlist.rows, screens:screens.rows,
    preferences:Object.fromEntries(preferences.rows.map(row => [row.key,row.value])), unreadAlerts:alerts.rows[0].unread };
}
export async function watch(database: Pool, assetId: string, add: boolean) {
  await requireAsset(database, assetId);
  if (add) await database.query('insert into research_watchlist (asset_id) values ($1) on conflict do nothing', [assetId]);
  else await database.query('delete from research_watchlist where asset_id=$1', [assetId]);
}
export async function saveScreen(database: Pool, input: unknown, screenId?: string) {
  const row = object(input), name = text(row.name,'Screen name'), selection = filters(row.filters);
  if (!screenId) return (await database.query('insert into research_screens (id,name,filters) values ($1,$2,$3) returning *', [randomUUID(),name,selection])).rows[0];
  const result = await database.query(`update research_screens set name=$2,filters=$3,version=version+1,updated_at=clock_timestamp()
    where id=$1 and version=$4 returning *`, [uuid(screenId),name,selection,version(row.version)]);
  if (!result.rowCount) throw new InputError('Screen changed or was removed; reload before saving',409);
  return result.rows[0];
}
export async function saveNote(database: Pool, input: unknown, noteId?: string) {
  const row = object(input), assetId = id(row.assetId), content = text(row.body,'Thesis note',10000);
  await requireAsset(database,assetId);
  return transaction(database, async client => {
    const result = noteId ? await client.query(`update research_notes set body=$2,version=version+1,updated_at=clock_timestamp()
      where id=$1 and version=$3 and asset_id=$4 returning *`, [uuid(noteId),content,version(row.version),assetId])
      : await client.query('insert into research_notes (id,asset_id,body) values ($1,$2,$3) returning *', [randomUUID(),assetId,content]);
    if (!result.rowCount) throw new InputError('Note changed or was removed; reload before saving',409);
    const note = result.rows[0];
    await client.query('insert into research_note_revisions (note_id,version,asset_id,body) values ($1,$2,$3,$4)', [note.id,note.version,assetId,content]);
    return note;
  });
}
export async function savePreference(database: Pool, key: string, input: unknown) {
  let value: unknown;
  if (key === 'asset-screen') value = filters(input);
  else if (key === 'price-chart' || key === 'btc-chart') {
    const row = object(input);
    if (!['30D','90D','1Y','All'].includes(String(row.range))) throw new InputError('Invalid chart range');
    if (key === 'btc-chart' && typeof row.log !== 'boolean') throw new InputError('Invalid chart scale');
    value = key === 'btc-chart' ? { range:row.range, log:row.log } : { range:row.range };
  } else throw new InputError('Unsupported preference');
  await database.query(`insert into research_preferences (key,value) values ($1,$2) on conflict (key)
    do update set value=excluded.value,updated_at=clock_timestamp()`, [key,value]);
  return value;
}
export async function createAlertRule(database: Pool, input: unknown) {
  const row = object(input), assetId = id(row.assetId);
  await requireAsset(database,assetId);
  if (!['priceUsd','marketCapUsd','change24h'].includes(String(row.metric)) || !['above','below'].includes(String(row.operator))) throw new InputError('Unsupported alert condition');
  return (await database.query(`insert into research_alert_rules (id,asset_id,name,metric,operator,threshold)
    values ($1,$2,$3,$4,$5,$6) returning *`, [randomUUID(),assetId,text(row.name,'Alert name'),row.metric,row.operator,finite(row.threshold,'Threshold')])).rows[0];
}

// Evaluate only new market snapshots. The first usable observation establishes
// a baseline. Missing/stale values preserve state and never count as a crossing.
export async function evaluateAlerts(client: PoolClient, snapshotId: string) {
  const rules = (await client.query(`select r.*,m.data,s.observed_at from research_alert_rules r
    join discovery_members m on m.snapshot_id=$1 and m.entity_key=r.asset_id
    join discovery_snapshots s on s.id=m.snapshot_id
    where r.enabled and (r.last_snapshot_id is null or r.last_snapshot_id < $1) for update of r`, [snapshotId])).rows;
  for (const rule of rules) {
    const value = rule.data[rule.metric], observedAt = rule.data.observedAt;
    if (typeof value !== 'number' || !Number.isFinite(value) || !observedAt || rule.observed_at.getTime()-Date.parse(observedAt) > 3600000) continue;
    const match = rule.operator === 'above' ? value > rule.threshold : value < rule.threshold;
    if (rule.last_match === false && match) await client.query(`insert into research_alerts (rule_id,snapshot_id,asset_id,title,evidence)
      values ($1,$2,$3,$4,$5) on conflict do nothing`, [rule.id,snapshotId,rule.asset_id,rule.name,
      { metric:rule.metric,operator:rule.operator,threshold:rule.threshold,value,observedAt,methodology:'threshold-crossing:v1' }]);
    await client.query('update research_alert_rules set last_match=$2,last_snapshot_id=$3 where id=$1', [rule.id,match,snapshotId]);
  }
}
