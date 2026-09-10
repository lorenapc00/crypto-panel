import { writeFile } from 'node:fs/promises';
import { pool } from '../apps/api/dist/db.js';
import { btcHistoryJob } from '../apps/api/dist/feeds/bitcoin.js';

// Read-only local acceptance check. Acquisition belongs to the scheduled worker.
try {
  const headers = process.env.WORKSPACE_TOKEN ? { authorization: `Bearer ${process.env.WORKSPACE_TOKEN}` } : {};
  const response = await fetch('http://127.0.0.1:3100/api/v1/btc/cycles', { headers, signal: AbortSignal.timeout(20000) });
  const body = await response.json();
  const guard = await fetch('http://127.0.0.1:3100/api/v1/btc/cycles?asOf=2010-01-01', { headers, signal: AbortSignal.timeout(20000) });
  await guard.arrayBuffer();
  const jobs = (await pool.query(`select j.id,j.next_run_at,r.status,r.error,r.finished_at,
    (select count(*)::int from worker_requests where provider_id='coinmetrics') as requests
    from worker_jobs j left join lateral (select status,error,finished_at from worker_runs where job_id=j.id order by id desc limit 1) r on true where j.id=$1`, [btcHistoryJob.id])).rows;
  const revisions = (await pool.query(`select s.id,count(o.*)::int as observations,count(distinct o.observed_at)::int as dates,
    min(o.observed_at) as first,max(o.observed_at) as last from data_series s left join series_observations o on o.series_id=s.id
    where s.source_id='coinmetrics' group by s.id order by s.id`)).rows;
  const report = { checkedAt: new Date().toISOString(), scope: 'Local supervised Mac; continuous hosting remains unverified',
    endpointStatus: response.status, replayBeforeCoverageStatus: guard.status,
    migration: (await pool.query('select max(version)::int as version from schema_migrations')).rows[0].version,
    jobs, revisions, coverage: body.data?.coverage, latest: body.data?.latest,
    cycleCoverage: body.data?.cycles?.map(c => ({ date: c.date, anchorPrice: c.anchorPrice, observations: c.points.length })),
    methodology: body.data?.methodology,
    limitations: ['Historical reconstructions do not establish past publication availability.',
      'BTC study controls cover confirmed regimes and custom dates; other priority assets support custom dates on aligned CoinGecko samples.',
      'Venue/capital context has separate verification in ops/verify-btc-context.mjs; broader study evaluation remains subsequent work.'] };
  const passed = response.status === 200 && guard.status === 409 && body.data?.points?.length > 5000 && jobs[0]?.status === 'succeeded';
  if (!passed) { console.error(JSON.stringify({ passed, endpointStatus: response.status, replayStatus: guard.status, jobs, error: body.error })); process.exitCode = 1; }
  else {
    const output = new URL('../docs/data/stage2-btc-2026-09-09.json', import.meta.url);
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output: output.pathname, passed, jobs, coverage: report.coverage, cycleCoverage: report.cycleCoverage }, null, 2));
  }
} finally { await pool.end(); }
