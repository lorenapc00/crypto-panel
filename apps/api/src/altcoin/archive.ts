import type { Pool, PoolClient } from 'pg';
import { ReplayCoverageError, readSeries } from '../archive.js';
import { readSnapshot } from '../snapshots/archive.js';
import { guardDiscoveryReplay } from '../discovery/archive.js';
import { marketDataset } from '../snapshots/providers.js';
import { capitalCatalogId } from '../feeds/capital.js';
import { dailySeriesId } from '../daily-history.js';
import type { Coverage, Snapshot } from '../perp/calculations.js';
import { emergingView, launchesView, type EmergingFilters, type LaunchFilters, type PoolRow, type EnrichmentRow } from './calculations.js';

/** A query parser returns `undefined` for an absent parameter. Spreading that over the
 *  defaults would clobber them, so only the keys that were actually supplied are merged. */
const defined = <T extends object>(overrides: Partial<T>): Partial<T> =>
  Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) as Partial<T>;

export const poolDataset = (chain: 'solana' | 'base') => `geckoterminal:pools:${chain}:v1`;
export const pairDataset = (chain: 'solana' | 'base', slot: number) => `dexscreener:${chain}:pairs:slot${slot}:v1`;
export const orderDataset = (chain: 'solana' | 'base', slot: number) => `dexscreener:${chain}:orders:slot${slot}:v1`;
export const launchChains = ['solana', 'base'] as const;
const ENRICHMENT_SLOTS = 20;

/** One refused feed must not hide the feeds whose coverage does reach this cutoff. A feed
 *  this installation never configured is unavailable, which is not the same as refused. */
function refusals(client: PoolClient) {
  const list: string[] = [];
  const attempt = async <T>(feed: string, read: () => Promise<T>) => {
    try { return await read(); } catch (error) {
      if (!(error instanceof ReplayCoverageError)) throw error;
      if (!list.includes(feed)) list.push(feed);
      return null;
    }
  };
  const configured = async (table: 'discovery_datasets' | 'data_series', id: string) =>
    !!(await client.query(`select 1 from ${table} where id=$1`, [id])).rowCount;
  const dataset = async <T>(feed: string, id: string, read: () => Promise<T>) =>
    await configured('discovery_datasets', id) ? attempt(feed, read) : null;
  const series = async <T>(feed: string, id: string, read: () => Promise<T>) =>
    await configured('data_series', id) ? attempt(feed, read) : null;
  return { list, dataset, series };
}

function coverage(snapshot: Awaited<ReturnType<typeof readSnapshot>> | null, replayRefused: boolean): Coverage {
  const metadata = snapshot?.metadata;
  return { source: metadata?.source ?? null, scope: metadata?.coverage ?? null, observedAt: metadata?.observedAt ?? null,
    recordedAt: metadata?.recordedAt ?? null, snapshotId: metadata?.snapshotId ?? null, payloadId: metadata?.payloadId ?? null,
    replayCoverageStart: metadata?.replayCoverageStart ?? null, intervalSeconds: metadata?.intervalSeconds ?? null,
    methodologyVersion: metadata?.methodologyVersion ?? null, unavailable: metadata?.unavailable ?? true,
    stale: metadata?.stale ?? true, degraded: metadata?.degraded ?? false, error: metadata?.error ?? null,
    replayRefused, classification: metadata?.classification ?? 'forward tracking' };
}
const snapshot = (read: Awaited<ReturnType<typeof readSnapshot>> | null, replayRefused: boolean): Snapshot =>
  read ? { members: read.members as any, events: read.events as any, coverage: coverage(read, replayRefused),
    notes: (read.metadata.coverageNotes as Record<string, unknown> | null) ?? null }
    : replayRefused ? { members: [], events: [], coverage: coverage(null, true), notes: null } : null;

async function readOnly<T>(database: Pool, action: (client: PoolClient) => Promise<T>) {
  const client = await database.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const result = await action(client);
    await client.query('commit');
    return result;
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

export const EMERGING_DEFAULTS: EmergingFilters = { screen: 'eligible', minMarketCapUsd: 10_000_000,
  maxMarketCapUsd: 2_000_000_000, minMedianVolumeUsd: 1_000_000, minHistoryDays: 90, search: null, limit: 150 };

export async function emergingArchive(database: Pool, asOf?: string, filters: Partial<EmergingFilters> = {}) {
  const applied = { ...EMERGING_DEFAULTS, ...defined(filters) };
  return readOnly(database, async client => {
    const { list, dataset, series } = refusals(client);
    const now = (await client.query('select clock_timestamp()::text as time')).rows[0].time as string;
    const market = await dataset('tracked-market', marketDataset, () => readSnapshot(client, marketDataset, asOf));
    const peg = await dataset('stablecoin-catalog', capitalCatalogId, () => readSnapshot(client, capitalCatalogId, asOf));

    // Only assets whose daily series are already archived carry archive-computed evidence.
    const identities = (await client.query(`select distinct asset_id from data_series
      where metric_code in ('price_usd','volume_24h_usd') and source_id='coingecko' and interval_seconds=86400
        and asset_id is not null order by asset_id`)).rows;
    const prices = [], volumes = [];
    for (const identity of identities) {
      const assetId = identity.asset_id as string;
      const price = await series('daily-histories', dailySeriesId(assetId), () => readSeries(dailySeriesId(assetId), { asOf, limit: 400 }, client));
      if (price) prices.push({ assetId, points: price.points });
      const volumeId = dailySeriesId(assetId, 'volume_24h_usd');
      const volume = await series('daily-histories', volumeId, () => readSeries(volumeId, { asOf, limit: 400 }, client));
      if (volume) volumes.push({ assetId, points: volume.points });
    }

    const exclusions = (await client.query(`select distinct on (asset_id) asset_id,symbol,reason,canonical_asset_id,evidence,methodology_version
      from asset_universe_exclusions where recorded_at <= coalesce($1::timestamptz,clock_timestamp())
      order by asset_id,recorded_at desc,id desc`, [asOf ?? null])).rows;
    const categories = (await client.query(`select distinct on (asset_id) asset_id,category from asset_taxonomy
      where recorded_at <= coalesce($1::timestamptz,clock_timestamp()) order by asset_id,recorded_at desc,id desc`, [asOf ?? null])).rows;
    const alertRules = (await client.query(`select asset_id,name,metric,operator,threshold from research_alert_rules
      where enabled and created_at <= coalesce($1::timestamptz,clock_timestamp()) order by asset_id,created_at`, [asOf ?? null])).rows;

    if (list.length && !market) throw new ReplayCoverageError('Emerging Projects replay predates production coverage for the archived tracked page');
    return emergingView({ now: asOf ?? now, asOf,
      market: snapshot(market, list.includes('tracked-market')),
      prices, volumes,
      pegSymbols: ((peg?.members ?? []) as { data: Record<string, any> }[]).map(member => ({
        symbol: String(member.data.symbol ?? ''), name: String(member.data.name ?? '') })).filter(row => row.symbol),
      pegCoverage: peg ? coverage(peg, list.includes('stablecoin-catalog')) : null,
      exclusions: exclusions.map(row => ({ assetId: row.asset_id as string, symbol: row.symbol as string,
        reason: row.reason as string, canonicalAssetId: row.canonical_asset_id as string | null,
        evidence: row.evidence as string, methodologyVersion: row.methodology_version as string })),
      categories: categories.map(row => ({ assetId: row.asset_id as string, category: row.category as string })),
      alertRules: alertRules.map(row => ({ assetId: row.asset_id as string, title: row.name as string,
        metric: row.metric as string, comparator: row.operator as string, threshold: Number(row.threshold) })),
      replayRefusals: list, filters: applied });
  });
}

export const LAUNCH_DEFAULTS: LaunchFilters = { screen: 'new', windowDays: 30, chain: null,
  minLiquidityUsd: 100_000, includeUnknownLiquidity: false, search: null, limit: 200 };

export async function launchesArchive(database: Pool, asOf?: string, filters: Partial<LaunchFilters> = {}) {
  const applied = { ...LAUNCH_DEFAULTS, ...defined(filters) };
  return readOnly(database, async client => {
    const { list, dataset } = refusals(client);
    const now = (await client.query('select clock_timestamp()::text as time')).rows[0].time as string;
    const chains: { chain: 'solana' | 'base'; datasetId: string; coverage: Coverage; notes: Record<string, unknown> | null }[] = [];
    const covered: { chain: 'solana' | 'base'; datasetId: string }[] = [];
    for (const chain of launchChains) {
      if (applied.chain && chain !== applied.chain) continue;
      const datasetId = poolDataset(chain);
      const read = await dataset(`pools:${chain}`, datasetId, async () => {
        await guardDiscoveryReplay(client, datasetId, asOf);
        return readSnapshot(client, datasetId, asOf);
      });
      chains.push({ chain, datasetId, coverage: coverage(read, list.includes(`pools:${chain}`)),
        notes: (read?.metadata.coverageNotes as Record<string, unknown> | null) ?? null });
      if (read) covered.push({ chain, datasetId });
    }

    // Every pool this archive has ever sampled, not only those still in the newest page:
    // a token's first observation must survive its pools rotating out of a 20-row sample.
    const pools: PoolRow[] = covered.length ? (await client.query(`
      with bounded as (
        select id,dataset_id,observed_at from discovery_snapshots
        where dataset_id = any($1) and recorded_at <= coalesce($2::timestamptz,clock_timestamp())
          and observed_at <= coalesce($2::timestamptz,clock_timestamp())),
      latest as (select distinct on (dataset_id) dataset_id,id from bounded order by dataset_id,observed_at desc,id desc),
      current as (
        select distinct on (m.dataset_id,m.entity_key) m.dataset_id,m.entity_key,m.data,m.snapshot_id,s.observed_at
        from discovery_members m join bounded s on s.id=m.snapshot_id
        order by m.dataset_id,m.entity_key,m.snapshot_id desc)
      select c.dataset_id,c.entity_key,c.data,c.observed_at,
        l.id = c.snapshot_id as in_latest_snapshot,
        f.observed_at as first_observed_at,
        b.data->>'baseTokenAddress' as first_base_token,
        p.data as prior_data,p.observed_at as prior_observed_at
      from current c
      join latest l on l.dataset_id=c.dataset_id
      join discovery_first_seen f on f.dataset_id=c.dataset_id and f.entity_key=c.entity_key
      left join lateral (select m.data from discovery_members m join bounded s on s.id=m.snapshot_id
        where m.dataset_id=c.dataset_id and m.entity_key=c.entity_key
        order by m.snapshot_id asc limit 1) b on true
      left join lateral (select m.data,s.observed_at from discovery_members m join bounded s on s.id=m.snapshot_id
        where m.dataset_id=c.dataset_id and m.entity_key=c.entity_key and m.snapshot_id < c.snapshot_id
        order by m.snapshot_id desc limit 1) p on true
      order by c.dataset_id,c.entity_key`, [covered.map(entry => entry.datasetId), asOf ?? null])).rows.map(row => {
      const chain = covered.find(entry => entry.datasetId === row.dataset_id)!.chain;
      return { chain, datasetId: row.dataset_id as string, entityKey: row.entity_key as string,
        // The base token of the pool's earliest archived observation is its identity here;
        // a later revision must not silently move the pool to a different token.
        baseTokenAddress: (row.first_base_token as string | null) ?? (row.data?.baseTokenAddress as string | null) ?? null,
        firstObservedAt: row.first_observed_at as Date, data: row.data as Record<string, any> | null,
        observedAt: row.observed_at as Date, inLatestSnapshot: !!row.in_latest_snapshot,
        priorData: row.prior_data as Record<string, any> | null, priorObservedAt: row.prior_observed_at as Date | null };
    }) : [];

    const pairs: EnrichmentRow[] = [], orders: EnrichmentRow[] = [];
    for (const { chain } of covered)
      for (let slot = 0; slot < ENRICHMENT_SLOTS; slot++) {
        for (const [kind, target, id] of [['pairs', pairs, pairDataset(chain, slot)], ['orders', orders, orderDataset(chain, slot)]] as const) {
          const read = await dataset(`enrichment:${chain}`, id, () => readSnapshot(client, id, asOf));
          for (const member of (read?.members ?? []) as { key: string; data: Record<string, any> }[]) {
            const token = kind === 'pairs' ? member.data.requestedToken : member.data.token;
            if (typeof token !== 'string' || !token) continue;
            target.push({ chain, datasetId: id, token, data: member.data, observedAt: read!.metadata.observedAt });
          }
        }
      }

    const quoteTokens = (await client.query(`select distinct on (chain,token_address) chain,token_address,symbol,kind,evidence
      from spot_quote_tokens where recorded_at <= coalesce($1::timestamptz,clock_timestamp())
      order by chain,token_address,recorded_at desc,id desc`, [asOf ?? null])).rows;

    if (!covered.length && list.length) throw new ReplayCoverageError('Spot launch replay predates production coverage for every sampled chain');
    return launchesView({ now: asOf ?? now, asOf, pools, pairs, orders, chains,
      quoteTokens: quoteTokens.map(row => ({ chain: row.chain as string, tokenAddress: row.token_address as string,
        symbol: row.symbol as string, kind: row.kind as string, evidence: row.evidence as string })),
      replayRefusals: list, filters: applied });
  });
}
