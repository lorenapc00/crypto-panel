import type { Pool, PoolClient } from 'pg';
import { ReplayCoverageError, readSeries } from '../archive.js';
import { readSnapshot } from '../snapshots/archive.js';
import { guardDiscoveryReplay } from '../discovery/archive.js';
import { marketDataset, fundamentalProfiles } from '../snapshots/providers.js';
import { coveredNamespaces } from '../discovery/providers.js';
import { perpOpenInterestDataset, perpOpenInterestSeriesId } from '../feeds/perp.js';
import { dailySeriesId } from '../daily-history.js';
import { projectsView, listingsView, type Coverage, type InstrumentRow, type Snapshot } from './calculations.js';

export const protocolsDataset = 'defillama:protocols:v1';
export const namespacesDataset = 'hyperliquid:namespaces:v1';
export const bookDataset = 'hyperliquid:book:BTC:v1';
export const fundingDataset = 'hyperliquid:funding:BTC:v1';
export const instrumentDataset = (namespace: string) => `hyperliquid:instruments:${namespace || 'native'}:v1`;
const instrumentDatasets = coveredNamespaces.map(namespace => ({ namespace, datasetId: instrumentDataset(namespace) }));
const fundamentalMetrics = ['fees_24h_usd', 'revenue_24h_usd', 'holder_revenue_24h_usd', 'tvl_usd'] as const;
const BENCHMARK_ASSETS = ['bitcoin', 'ethereum', 'solana', 'hyperliquid'];

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
  return { list, attempt, dataset, series };
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
  read ? { members: read.members as Snapshot extends null ? never : any, events: read.events as any,
    coverage: coverage(read, replayRefused), notes: (read.metadata.coverageNotes as Record<string, unknown> | null) ?? null }
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

export type ProjectFilters = { window?: 'all' | 'early'; venue?: string | null; stage?: string | null; search?: string | null; limit?: number };

export async function perpProjectsArchive(database: Pool, asOf?: string, filters: ProjectFilters = {}) {
  return readOnly(database, async client => {
    const { list, dataset, series } = refusals(client);
    const now = (await client.query('select clock_timestamp()::text as time')).rows[0].time as string;
    const catalog = await dataset('protocol-catalog', protocolsDataset, () => readSnapshot(client, protocolsDataset, asOf));
    const openInterest = await dataset('perp-open-interest', perpOpenInterestDataset, () => readSnapshot(client, perpOpenInterestDataset, asOf));
    const aggregate = await series('perp-open-interest', perpOpenInterestSeriesId, () => readSeries(perpOpenInterestSeriesId, { asOf, limit: 3000 }, client));
    const market = await dataset('tracked-market', marketDataset, () => readSnapshot(client, marketDataset, asOf));
    const fundamentals = [];
    for (const profile of fundamentalProfiles.filter(profile => profile.scope === 'protocol'))
      for (const metricCode of fundamentalMetrics) {
        const seriesId = `defillama:${profile.asset}:${metricCode}:daily:v1`;
        const history = await series('protocol-fundamentals', seriesId, () => readSeries(seriesId, { asOf, limit: 400 }, client));
        if (history) fundamentals.push({ assetId: profile.asset, metricCode, series: history });
      }
    const venueLinks = (await client.query(`select distinct on (protocol_id) protocol_id,protocol_slug,venue,namespace,evidence,methodology_version
      from perp_venue_links where recorded_at <= coalesce($1::timestamptz,clock_timestamp())
      order by protocol_id,recorded_at desc,id desc`, [asOf ?? null])).rows;
    // Linked venue activity is counted from the archived instrument snapshot of that namespace only.
    const venueActivity = [];
    for (const link of venueLinks) {
      const datasetId = instrumentDataset(link.namespace);
      const instruments = await dataset(`venue:${link.namespace || 'native'}`, datasetId, () => readSnapshot(client, datasetId, asOf));
      if (!instruments) continue;
      const members = instruments.members as { status: string; data: Record<string, any> }[];
      const total = (field: string) => members.reduce<number | null>((sum, member) =>
        typeof member.data[field] === 'number' && Number.isFinite(member.data[field]) ? (sum ?? 0) + member.data[field] : sum, null);
      venueActivity.push({ venue: link.venue, namespace: link.namespace, instruments: members.length,
        active: members.filter(member => member.status === 'active').length,
        openInterestNative: total('openInterestNative'), estimatedOpenInterestQuote: total('estimatedOpenInterestQuote'),
        reported24hNotionalVolume: total('reported24hNotionalVolume'), observedAt: instruments.metadata.observedAt });
    }
    const tokens = ((market?.members ?? []) as { data: Record<string, any> }[]).map(member => ({ id: String(member.data.id),
      symbol: String(member.data.symbol ?? ''), name: String(member.data.name ?? ''),
      priceUsd: typeof member.data.priceUsd === 'number' ? member.data.priceUsd : null,
      marketCapUsd: typeof member.data.marketCapUsd === 'number' ? member.data.marketCapUsd : null }));
    if (list.length && !catalog && !openInterest) throw new ReplayCoverageError('Perp project replay predates production coverage for the protocol catalog and the covered open-interest feed');
    return projectsView({ now: asOf ?? now, asOf,
      catalog: snapshot(catalog, list.includes('protocol-catalog')),
      openInterest: snapshot(openInterest, list.includes('perp-open-interest')),
      aggregate, fundamentals, venueActivity, tokens, replayRefusals: list,
      fundamentalLinks: fundamentalProfiles.filter(profile => profile.scope === 'protocol').map(profile => ({ key: profile.name,
        assetId: profile.asset, evidence: `Individually verified DefiLlama ${profile.name} protocol fee, revenue, holder-revenue and TVL histories archived in this workspace` })),
      venueLinks: venueLinks.map(link => ({ protocolId: link.protocol_id as string, protocolSlug: link.protocol_slug as string,
        venue: link.venue as string, namespace: link.namespace as string, evidence: link.evidence as string,
        methodologyVersion: link.methodology_version as string })),
      filters: { window: filters.window ?? 'all', venue: filters.venue ?? null, stage: filters.stage ?? null,
        search: filters.search ?? null, limit: filters.limit ?? 100 } });
  });
}

export type ListingFilters = { screen?: 'new' | 'all'; windowDays?: number; namespace?: string | null;
  underlying?: 'verified' | 'all'; search?: string | null; limit?: number };

export async function perpListingsArchive(database: Pool, asOf?: string, filters: ListingFilters = {}) {
  return readOnly(database, async client => {
    const { list, dataset, series } = refusals(client);
    const now = (await client.query('select clock_timestamp()::text as time')).rows[0].time as string;
    const namespaces = await dataset('namespace-catalog', namespacesDataset, () => readSnapshot(client, namespacesDataset, asOf));
    const datasets: { datasetId: string; namespace: string; coverage: Coverage }[] = [];
    const covered: string[] = [];
    for (const entry of instrumentDatasets) {
      const feed = `venue:${entry.namespace || 'native'}`;
      const read = await dataset(feed, entry.datasetId, async () => {
        await guardDiscoveryReplay(client, entry.datasetId, asOf);
        return readSnapshot(client, entry.datasetId, asOf);
      });
      datasets.push({ ...entry, coverage: coverage(read, list.includes(feed)) });
      if (read) covered.push(entry.datasetId);
    }
    const instruments = covered.length ? (await client.query(`
      with latest as (
        select distinct on (s.dataset_id) s.dataset_id,s.id,s.observed_at from discovery_snapshots s
        where s.dataset_id = any($1) and s.recorded_at <= coalesce($2::timestamptz,clock_timestamp())
          and s.observed_at <= coalesce($2::timestamptz,clock_timestamp())
        order by s.dataset_id,s.recorded_at desc,s.id desc),
      current as (
        select distinct on (m.dataset_id,m.entity_key) m.dataset_id,m.entity_key,m.status,m.data,
          m.snapshot_id,s.observed_at
        from discovery_members m join discovery_snapshots s on s.id=m.snapshot_id
        where m.dataset_id = any($1) and s.recorded_at <= coalesce($2::timestamptz,clock_timestamp())
          and s.observed_at <= coalesce($2::timestamptz,clock_timestamp())
        order by m.dataset_id,m.entity_key,m.snapshot_id desc)
      select c.dataset_id,c.entity_key as key,c.status,c.data,c.observed_at,
        l.id = c.snapshot_id as in_latest_snapshot,f.observed_at as first_observed_at,
        coalesce(e.types,'{}') as event_types,e.latest_type as latest_event_type,
        p.data as prior_data,p.observed_at as prior_observed_at,
        y.data as day_prior_data,y.observed_at as day_prior_observed_at
      from current c
      join latest l on l.dataset_id=c.dataset_id
      join discovery_first_seen f on f.dataset_id=c.dataset_id and f.entity_key=c.entity_key
      left join lateral (select array_agg(distinct v.event_type) as types,
          (array_agg(v.event_type order by v.snapshot_id desc))[1] as latest_type
        from discovery_events v join discovery_snapshots vs on vs.id=v.snapshot_id
        where v.dataset_id=c.dataset_id and v.entity_key=c.entity_key
          and vs.recorded_at <= coalesce($2::timestamptz,clock_timestamp())) e on true
      left join lateral (select m.data,s.observed_at from discovery_members m
        join discovery_snapshots s on s.id=m.snapshot_id
        where m.dataset_id=c.dataset_id and m.entity_key=c.entity_key and m.snapshot_id < c.snapshot_id
        order by m.snapshot_id desc limit 1) p on true
      left join lateral (select m.data,s.observed_at from discovery_members m
        join discovery_snapshots s on s.id=m.snapshot_id
        where m.dataset_id=c.dataset_id and m.entity_key=c.entity_key and m.snapshot_id < c.snapshot_id
          and s.observed_at <= c.observed_at - interval '24 hours'
        order by m.snapshot_id desc limit 1) y on true
      order by c.dataset_id,c.entity_key`, [covered, asOf ?? null])).rows : [];
    const book = await dataset('order-book', bookDataset, () => readSnapshot(client, bookDataset, asOf));
    const funding = await dataset('settled-funding', fundingDataset, () => readSnapshot(client, fundingDataset, asOf));
    const histories = [];
    for (const assetId of BENCHMARK_ASSETS) {
      const seriesId = dailySeriesId(assetId);
      const history = await series('daily-histories', seriesId, () => readSeries(seriesId, { asOf, limit: 400 }, client));
      if (history) histories.push({ assetId, points: history.points });
    }
    const underlyingLinks = (await client.query(`select distinct on (venue,namespace,instrument) venue,namespace,instrument,asset_id,asset_class,evidence
      from perp_underlying_links where recorded_at <= coalesce($1::timestamptz,clock_timestamp())
      order by venue,namespace,instrument,recorded_at desc,id desc`, [asOf ?? null])).rows;
    if (!covered.length && list.length) throw new ReplayCoverageError('Perp listing replay predates production coverage for every budgeted namespace');
    return listingsView({ now: asOf ?? now, asOf,
      namespaces: snapshot(namespaces, list.includes('namespace-catalog')), datasets,
      instruments: instruments.map(row => ({ ...row, namespace: String((row.data as Record<string, unknown>).namespace ?? ''),
        event_types: (row.event_types as string[]) ?? [] })) as InstrumentRow[],
      books: ((book?.members ?? []) as { key: string; data: Record<string, any> }[]).map(member => ({ entityKey: member.key,
        data: member.data, observedAt: book?.metadata.observedAt ?? null, datasetId: bookDataset })),
      settledFunding: ((funding?.members ?? []) as { key: string; data: Record<string, any> }[]).map(member => ({ entityKey: member.key,
        data: member.data, observedAt: funding?.metadata.observedAt ?? null, datasetId: fundingDataset })),
      underlyingLinks: underlyingLinks.map(link => ({ venue: link.venue as string, namespace: link.namespace as string,
        instrument: link.instrument as string, assetId: link.asset_id as string, assetClass: link.asset_class as string,
        evidence: link.evidence as string })),
      histories, replayRefusals: list,
      filters: { screen: filters.screen ?? 'new', windowDays: filters.windowDays ?? 30,
        namespace: filters.namespace ?? null, underlying: filters.underlying ?? 'verified',
        search: filters.search ?? null, limit: filters.limit ?? 200 } });
  });
}

/** Lifecycle alerts are derived from the immutable archived event log, so reading one
 *  cannot change its evidence and a baseline ingestion can never raise a listing alert. */
export async function perpAlerts(database: Pick<Pool, 'query'>, options: { limit?: number; unreadOnly?: boolean } = {}) {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Alert limit must be between 1 and 200');
  const rows = (await database.query(`select e.dataset_id,e.snapshot_id::text,e.entity_key,e.event_type,
      s.observed_at,s.recorded_at,s.payload_id::text,d.kind,d.scope,d.methodology_version,m.data,r.read_at
    from discovery_events e
    join discovery_snapshots s on s.id=e.snapshot_id
    join discovery_datasets d on d.id=e.dataset_id
    left join discovery_members m on m.snapshot_id=e.snapshot_id and m.entity_key=e.entity_key
    left join discovery_alert_reads r on r.dataset_id=e.dataset_id and r.snapshot_id=e.snapshot_id and r.entity_key=e.entity_key
    where e.event_type <> 'baseline'
      and (d.id = any($1) or (d.kind='protocols' and m.data->>'category'='Derivatives'))
      and ($3::boolean is not true or r.read_at is null)
    order by s.observed_at desc,e.snapshot_id desc,e.entity_key limit $2`,
  [[namespacesDataset, perpOpenInterestDataset, ...instrumentDatasets.map(entry => entry.datasetId)], limit, options.unreadOnly ?? false])).rows;
  const titles: Record<string, string> = { first_observed: 'first observed', delisted: 'delisted', relisted: 'relisted',
    catalog_absent: 'absent from the provider catalog', returned: 'returned to the provider catalog' };
  return { data: rows.map(row => ({ datasetId: row.dataset_id as string, snapshotId: row.snapshot_id as string,
    entityKey: row.entity_key as string, eventType: row.event_type as string,
    kind: row.kind as string, scope: row.scope as string,
    type: row.kind === 'instruments' ? 'perp-listing' : row.kind === 'namespaces' ? 'perp-venue-namespace'
      : row.kind === 'openinterest' ? 'perp-open-interest-coverage' : 'perp-protocol-catalog',
    title: `${row.data?.name ?? row.entity_key} ${titles[row.event_type as string] ?? row.event_type}`,
    subject: { name: row.data?.name ?? null, namespace: row.data?.namespace ?? null, slug: row.data?.slug ?? null },
    observedAt: (row.observed_at as Date).toISOString(), recordedAt: (row.recorded_at as Date).toISOString(),
    payloadId: row.payload_id as string, methodologyVersion: row.methodology_version as string,
    readAt: row.read_at ? (row.read_at as Date).toISOString() : null,
    evidence: 'Immutable archived lifecycle event. Acknowledging an alert records a read time and cannot alter this evidence.' })),
    metadata: { source: 'Archived discovery events', observedAt: rows[0] ? (rows[0].observed_at as Date).toISOString() : null,
      coverage: 'Perp venue namespaces, budgeted instrument catalogs, covered open-interest membership and `Derivatives` protocol catalog changes. Baseline ingestions are excluded by construction.',
      stale: false, unavailable: !rows.length } };
}

export async function acknowledgePerpAlert(database: Pick<Pool, 'query'>, datasetId: string, snapshotId: string, entityKey: string) {
  const result = await database.query(`insert into discovery_alert_reads (dataset_id,snapshot_id,entity_key)
    select $1,$2::bigint,$3 where exists (select 1 from discovery_events where dataset_id=$1 and snapshot_id=$2::bigint and entity_key=$3)
    on conflict do nothing returning read_at`, [datasetId, snapshotId, entityKey]);
  if (!result.rowCount && !(await database.query('select 1 from discovery_alert_reads where dataset_id=$1 and snapshot_id=$2::bigint and entity_key=$3',
    [datasetId, snapshotId, entityKey])).rowCount) throw new Error('Alert not found');
}
