import { writeFile } from 'node:fs/promises';
import { pool } from '../apps/api/dist/db.js';
import { marketDataset, globalDataset } from '../apps/api/dist/snapshots/providers.js';

// Read-only acceptance for the Market Overview: every figure must come from the archive.
try {
  const headers = process.env.WORKSPACE_TOKEN ? { authorization: `Bearer ${process.env.WORKSPACE_TOKEN}` } : {};
  const api = (query = '') => fetch(`http://127.0.0.1:3100/api/v1/market/overview${query}`, { headers, signal: AbortSignal.timeout(30000) });
  const response = await api();
  const body = await response.json();
  const uncovered = await api('?asOf=2017-01-01T00:00:00Z');
  await uncovered.arrayBuffer();
  const coverage = (await pool.query(`select max(starts_at) as starts_at from discovery_replay_coverage where dataset_id=any($1::text[])`,
    [[marketDataset, globalDataset]])).rows[0].starts_at;
  const cutoff = coverage ? new Date(Date.parse(coverage) + 60000).toISOString() : null;
  const replay = cutoff && Date.parse(cutoff) < Date.now() ? await api(`?asOf=${encodeURIComponent(cutoff)}`) : null;
  const replayBody = replay ? await replay.json() : null;
  const d = body.data ?? {};
  const report = { checkedAt: new Date().toISOString(), scope: 'Local supervised Mac; continuous hosting remains unverified',
    endpointStatus: response.status, replayBeforeCoverageStatus: uncovered.status,
    replayCutoff: cutoff, replayStatus: replay?.status ?? null,
    replayClassification: replayBody?.data?.methodology?.classification ?? null,
    replayRefusals: replayBody?.data?.methodology?.replayRefusals ?? null,
    migration: (await pool.query('select max(version)::int as version from schema_migrations')).rows[0].version,
    methodologyVersion: d.methodology?.version ?? null,
    global: { ...d.global, evidence: d.global?.evidence },
    breadth: { advancing: d.breadth?.advancing, declining: d.breadth?.declining, unchanged: d.breadth?.unchanged,
      unknown: d.breadth?.unknown, total: d.breadth?.total, scope: d.breadth?.scope, stale: d.breadth?.evidence?.stale },
    averages: { sma50: d.averages?.sma50, sma200: d.averages?.sma200, tracked: d.averages?.tracked, scope: d.averages?.scope,
      assets: d.averages?.assets?.map(asset => ({ assetId: asset.assetId, samples: asset.samples, above50d: asset.above50d, above200d: asset.above200d })) },
    btc: { regime: d.btc?.regime, candidate: d.btc?.candidate, confirmationDays: d.btc?.confirmationDays,
      observedAt: d.btc?.observedAt, mayerMultiple: d.btc?.mayerMultiple, mvrv: d.btc?.mvrv, drawdownPct: d.btc?.drawdownPct,
      evidence: d.btc?.evidence },
    liquidity: { stablecoin: { value: d.liquidity?.stablecoin?.value, changePct: d.liquidity?.stablecoin?.changePct,
      comparisonAt: d.liquidity?.stablecoin?.comparisonAt, values: d.liquidity?.stablecoin?.values, coverage: d.liquidity?.stablecoin?.coverage },
      reportedVolume: d.liquidity?.reportedVolume },
    reportedVolumeSamples: d.reportedVolume?.coverage,
    performance: { benchmark: d.performance?.benchmark, rows: d.performance?.rows,
      unarchivedAssets: d.performance?.unarchivedAssets?.length ?? null, scope: d.performance?.scope },
    sectors: { status: d.sectors?.status, tracked: d.sectors?.tracked, classified: d.sectors?.classified,
      unclassified: d.sectors?.unclassified, categories: d.sectors?.categories?.map(row => row.category) },
    signalChanges: d.signalChanges?.map(change => ({ type: change.type, observedAt: change.observedAt, title: change.title })),
    limitations: ['Tracked-page breadth, sector coverage and reported movers describe the archived top-100 page, never the market.',
      'Above-average participation covers only assets with archived daily histories; the rest are uncovered, not below.',
      'Provider-global aggregates carry the provider’s own coverage; reported volume is sampled hourly from this archive onward.',
      'Sector leadership stays gated until asset-sector mappings and historical membership are verified.',
      'Acquisition remains locally supervised; an always-on host is still outstanding.'] };
  const passed = response.status === 200 && uncovered.status === 409 && d.methodology?.version === 'market-overview:v1'
    && d.breadth?.total > 0 && d.global?.marketCapUsd > 0 && d.sectors?.status === 'gated'
    && (replay === null || (replay.status === 200 && replayBody.data.methodology.classification === 'point-in-time'));
  const output = new URL('../docs/data/stage3-overview-2026-09-10.json', import.meta.url);
  if (!passed) { console.error(JSON.stringify({ passed, status: response.status, uncovered: uncovered.status, replay: replay?.status, error: body.error }, null, 2)); process.exitCode = 1; }
  else { await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ passed, output: output.pathname, breadth: report.breadth, averages: report.averages.scope, btc: report.btc.regime, sectors: report.sectors }, null, 2)); }
} finally { await pool.end(); }
