import { writeFile } from 'node:fs/promises';
import { pool } from '../apps/api/dist/db.js';
import { perpOpenInterestDataset } from '../apps/api/dist/feeds/perp.js';

// Read-only acceptance for stage 4 perp discovery: every figure must come from the archive,
// a baseline catalog must not become a listing, and gated feeds must stay unavailable.
try {
  const headers = process.env.WORKSPACE_TOKEN ? { authorization: `Bearer ${process.env.WORKSPACE_TOKEN}` } : {};
  const api = (path) => fetch(`http://127.0.0.1:3100/api/v1${path}`, { headers, signal: AbortSignal.timeout(60000) });
  const projects = await api('/perp/projects?limit=200');
  const projectBody = await projects.json();
  const listings = await api('/perp/listings?screen=new');
  const listingBody = await listings.json();
  const catalog = await api('/perp/listings?screen=all&underlying=all&limit=1000');
  const catalogBody = await catalog.json();
  const alerts = await api('/perp/alerts?limit=50');
  const alertBody = await alerts.json();
  const uncovered = await api('/perp/projects?asOf=2017-01-01T00:00:00Z');
  await uncovered.arrayBuffer();
  const coverage = (await pool.query('select starts_at from discovery_replay_coverage where dataset_id=$1', [perpOpenInterestDataset])).rows[0]?.starts_at ?? null;
  const cutoff = coverage ? new Date(Date.parse(coverage) + 60000).toISOString() : null;
  const replay = cutoff && Date.parse(cutoff) < Date.now() ? await api(`/perp/projects?asOf=${encodeURIComponent(cutoff)}`) : null;
  const replayBody = replay ? await replay.json() : null;
  const p = projectBody.data ?? {}, l = listingBody.data ?? {}, c = catalogBody.data ?? {};
  const quota = (await pool.query(`select provider_id,requests_this_month,remaining_requests from (
    select l.provider_id,coalesce(u.requests,0) as requests_this_month,l.requests_per_month-coalesce(u.requests,0) as remaining_requests
    from worker_provider_limits l left join worker_monthly_usage u on u.provider_id=l.provider_id
      and u.month=date_trunc('month',clock_timestamp() at time zone 'UTC')::date) t
    where provider_id in ('defillama','hyperliquid') order by provider_id`)).rows;
  const report = { checkedAt: new Date().toISOString(),
    scope: 'Local supervised Mac; continuous hosting remains unverified',
    migration: (await pool.query('select max(version)::int as version from schema_migrations')).rows[0].version,
    endpointStatus: { projects: projects.status, newListings: listings.status, catalog: catalog.status, alerts: alerts.status },
    replayBeforeCoverageStatus: uncovered.status, replayCutoff: cutoff, replayStatus: replay?.status ?? null,
    replayClassification: replayBody?.data?.methodology?.classification ?? null,
    replayRefusals: replayBody?.data?.methodology?.replayRefusals ?? null,
    projects: { methodologyVersion: p.methodology?.version ?? null, universe: p.universe ?? null,
      earlyFilter: p.earlyFilter ?? null, sorting: p.sorting ?? null,
      aggregate: { latest: p.aggregate?.latest ?? null, change7dPct: p.aggregate?.change7dPct ?? null,
        change30dPct: p.aggregate?.change30dPct ?? null, values: p.aggregate?.values ?? null,
        first: p.aggregate?.first ?? null, seriesId: p.aggregate?.seriesId ?? null,
        replayCoverageStart: p.aggregate?.replayCoverageStart ?? null },
      coverage: p.coverage ?? null,
      leaders: (p.rows ?? []).slice(0, 10).map(row => ({ protocolId: row.protocolId, slug: row.slug, stage: row.stage,
        openInterestUsd: row.adoption?.openInterestUsd ?? null,
        openInterestShareOfCoveredPct: row.adoption?.openInterestShareOfCoveredPct ?? null,
        openInterestChange30dPct: row.adoption?.openInterestChange30dPct ?? null,
        tvlUsd: row.adoption?.tvlUsd ?? null, archivedFundamentals: row.economics?.archived ?? null,
        venue: row.venue ? `${row.venue.venue}:${row.venue.namespace || 'native'}` : null,
        firstObservedAt: row.lifecycle?.firstObservedAt ?? null,
        verifiedMilestoneAt: row.lifecycle?.verifiedMilestoneAt ?? null })),
      gatedVolume: p.methodology?.volume ?? null },
    listings: { methodologyVersion: l.methodology?.version ?? null, lifecycle: l.lifecycle ?? null,
      screen: l.screen ?? null, newListingRows: (l.rows ?? []).map(row => ({ instrument: row.instrument,
        classification: row.listing?.classification, firstObservedAt: row.listing?.firstObservedAt })),
      namespaces: (c.namespaces ?? []).map(row => ({ namespace: row.namespace || 'native', instruments: row.instruments,
        active: row.active, covered: row.covered, verifiedUnderlyings: row.verifiedUnderlyings })),
      withOrderBook: c.lifecycle?.withOrderBook ?? null,
      verifiedUnderlyings: (c.rows ?? []).filter(row => row.underlying?.assetClass === 'crypto')
        .map(row => ({ instrument: row.instrument, assetId: row.underlying.assetId,
          openInterestNative: row.market?.openInterestNative ?? null,
          estimatedOpenInterestQuote: row.market?.estimatedOpenInterestQuote ?? null,
          premiumBps: row.market?.premiumBps ?? null, fundingIntervalSeconds: row.market?.fundingIntervalSeconds ?? null,
          liquiditySource: row.liquidity?.source ?? null, spotSamples: row.underlying?.spot?.samples ?? null,
          relativeToBtc7d: row.underlying?.spot?.relativeToBtc?.d7 ?? null })) },
    alerts: { count: (alertBody.data ?? []).length, unavailable: alertBody.metadata?.unavailable ?? null,
      entries: (alertBody.data ?? []).slice(0, 10).map(alert => ({ type: alert.type, eventType: alert.eventType,
        title: alert.title, observedAt: alert.observedAt, readAt: alert.readAt })) },
    quota,
    limitations: ['Covered open interest follows the DefiLlama convention that counts both sides of each contract and is never merged with venue-native open interest.',
      'Reported and normalized perp volume, and therefore volume market share, stay gated at HTTP 402.',
      'No free feed publishes protocol or token launch dates, so every project entry is undated and the 180-day early filter selects nothing.',
      'Instrument asset class is unknown unless a curated underlying link exists; non-native namespaces are mostly equities, indices, FX and commodities and stay out of the default screen.',
      'Order-book spread, depth and impact exist only for the single archived native BTC book.',
      'Listing counts are archive detections, not venue trading-start dates, and the first ingestion of each namespace is a baseline.',
      'Acquisition remains locally supervised; an always-on host is still outstanding.'] };
  const passed = projects.status === 200 && listings.status === 200 && catalog.status === 200 && alerts.status === 200
    && uncovered.status === 409 && p.methodology?.version === 'perp-projects:v1' && l.methodology?.version === 'perp-listings:v1'
    && p.universe?.matched > 0 && p.universe?.coveredOpenInterestProtocols > 0 && p.universe?.withVerifiedMilestone === 0
    && p.methodology?.volume?.includes('402') && (c.rows ?? []).length > 0
    && (replay === null || (replay.status === 200 && replayBody.data.methodology.classification === 'point-in-time'));
  const output = new URL('../docs/data/stage4-perp-2026-09-10.json', import.meta.url);
  if (!passed) { console.error(JSON.stringify({ passed, status: report.endpointStatus, uncovered: uncovered.status,
    replay: replay?.status, projectError: projectBody.error, listingError: listingBody.error }, null, 2)); process.exitCode = 1; }
  else { await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed, output: output.pathname, universe: report.projects.universe,
      aggregate: report.projects.aggregate, lifecycle: report.listings.lifecycle, alerts: report.alerts.count }, null, 2)); }
} finally { await pool.end(); }
