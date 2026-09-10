import { writeFile } from 'node:fs/promises';
import { pool } from '../apps/api/dist/db.js';
import { capitalJobs, capitalSeriesId } from '../apps/api/dist/feeds/capital.js';

// Read-only acceptance: only the scheduled worker can acquire or start coverage.
try {
  const headers = process.env.WORKSPACE_TOKEN ? { authorization: `Bearer ${process.env.WORKSPACE_TOKEN}` } : {};
  const response = await fetch('http://127.0.0.1:3100/api/v1/btc/context', { headers, signal: AbortSignal.timeout(20000) });
  const body = await response.json();
  const guard = await fetch('http://127.0.0.1:3100/api/v1/btc/context?asOf=2017-01-01', { headers, signal: AbortSignal.timeout(20000) });
  await guard.arrayBuffer();
  const jobs = (await pool.query(`select j.id,j.next_run_at,r.status,r.error,r.finished_at,
    (select count(*)::int from worker_requests q join worker_runs w on w.id=q.run_id where w.job_id=j.id) as requests
    from worker_jobs j left join lateral (select status,error,finished_at from worker_runs where job_id=j.id order by id desc limit 1) r on true
    where j.id=any($1::text[]) order by j.id`, [capitalJobs.map(j => j.id)])).rows;
  const series = (await pool.query(`select s.id,s.asset_id,s.scope,count(o.*)::int as revisions,count(distinct o.observed_at)::int as dates,
    min(o.observed_at) as first,max(o.observed_at) as last from data_series s left join series_observations o on o.series_id=s.id where s.id=$1 group by s.id`, [capitalSeriesId])).rows;
  const capital = body.data?.capital;
  const report = { checkedAt: new Date().toISOString(), scope: 'Local supervised Mac; continuous hosting remains unverified',
    endpointStatus: response.status, replayBeforeCoverageStatus: guard.status,
    migration: (await pool.query('select max(version)::int as version from schema_migrations')).rows[0].version,
    scheduledJobs: (await pool.query('select count(*)::int as n from worker_jobs where enabled')).rows[0].n,
    normalizedSeries: (await pool.query('select count(*)::int as n from data_series')).rows[0].n,
    jobs, series, venue: body.data?.venue, capital: { latest: capital?.latest, coverage: capital?.coverage,
      catalog: { members: capital?.catalog.members.length, coverage: capital?.catalog.coverage },
      formula: capital?.formula, interpretation: capital?.interpretation, limitations: capital?.limitations },
    methodologyVersion: body.data?.methodologyVersion,
    limitations: ['No USD conversion or market-wide positioning claim; native BTC is the only surfaced venue market.',
      'Stablecoin history has changing provider coverage; current catalog does not establish historical constituents.',
      'Acquisition is supervised locally. An always-on host, mining/macro feeds and strategy evaluation remain outside this slice.'] };
  const passed = response.status === 200 && guard.status === 409 && jobs.length === 2 && jobs.every(j => j.status === 'succeeded')
    && capital?.coverage.values > 3000 && capital?.catalog.members.length > 0 && body.data?.venue.openInterest.value !== null;
  const output = new URL('../docs/data/stage2-context-2026-09-09.json', import.meta.url);
  if (!passed) { console.error(JSON.stringify({ passed, status: response.status, jobs, capitalCoverage: capital?.coverage, error: body.error })); process.exitCode = 1; }
  else { await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ passed, output: output.pathname, jobs, series, catalogMembers: capital.catalog.members.length }, null, 2)); }
} finally { await pool.end(); }
