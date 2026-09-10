import { setTimeout } from 'node:timers/promises';
import { pool } from './db.js';
import { configureWorker, schedule, retryCurrentFailures } from './discovery/queue.js';
import { workOne } from './discovery/worker.js';
import { dataHealth } from './discovery/archive.js';
import { discoveryJobs } from './discovery/providers.js';
import { snapshotJobs } from './snapshots/providers.js';
import { historyJobs } from './feeds/history.js';
import { venueJobs } from './feeds/venue.js';
import { spotJobs } from './feeds/spot.js';
import { randomUUID } from 'node:crypto';
import { recordSeriesGaps } from './health.js';
import { btcHistoryJob } from './feeds/bitcoin.js';
import { capitalJobs } from './feeds/capital.js';
import { perpJobs } from './feeds/perp.js';
import { runBacktests } from './backtest/executor.js';

const jobs = [...discoveryJobs, ...snapshotJobs, ...historyJobs, ...venueJobs, ...spotJobs, btcHistoryJob, ...capitalJobs, ...perpJobs];
const workerId=randomUUID();
let lastHealth=0,registered=false;

const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  if (process.argv.includes('--health')) {
    console.log(JSON.stringify(await dataHealth(pool), null, 2));
  } else {
    // Migrations are a separate explicit operation; starting a worker does not
    // silently modify the schema of an existing installation.
    await configureWorker(pool, jobs);
    if(process.argv.includes('--retry-failed'))console.log(`Requeued ${await retryCurrentFailures(pool)} current failed slots within the three-attempt limit`);
    await pool.query('insert into worker_heartbeats (id) values ($1)',[workerId]);
    registered=true;
    console.log('Archive worker ready; using persisted quotas and schedules');
    await schedule(pool);
    while (!stopping) {
      await pool.query('update worker_heartbeats set last_seen_at=clock_timestamp() where id=$1',[workerId]);
      if(Date.now()-lastHealth>60000){await recordSeriesGaps(pool);lastHealth=Date.now();}
      if (!once) await schedule(pool);
      await runBacktests(pool).catch(error => console.error(error instanceof Error ? error.message : error));
      const result = await workOne(pool, fetch, jobs);
      if (result) {
        // Routine pacing deferrals are already visible in the database; logging
        // every sibling's reschedule would drown out actual acquisition results.
        if (result.status !== 'deferred') console.log(JSON.stringify(result));
      } else if (once) break;
      else await setTimeout(1000);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Worker stopped unexpectedly');
  process.exitCode = 1;
} finally {
  if(registered) await pool.query('update worker_heartbeats set stopped_at=clock_timestamp() where id=$1',[workerId]).catch(()=>{});
  await pool.end();
}
