import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../src/migrations.js';
import { apiServer } from '../src/server.js';
import { configureWorker,claim } from '../src/discovery/queue.js';
import { executeRun } from '../src/discovery/worker.js';
import { snapshotJobs,marketDataset,globalDataset } from '../src/snapshots/providers.js';
import { historyJobs } from '../src/feeds/history.js';
import { btcHistoryJob } from '../src/feeds/bitcoin.js';

if(!process.env.TEST_DATABASE_URL)throw new Error('Browser tests require TEST_DATABASE_URL');
const schema=`browser_${randomUUID().replaceAll('-','')}`;
const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
const database=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
await admin.query(`create schema ${schema}`);
await migrate(database);
const jobs=[...snapshotJobs.filter(j=>[marketDataset,globalDataset].includes(j.id)),historyJobs[0],btcHistoryJob];
await configureWorker(database,jobs);
for(const job of jobs){
  await database.query("update worker_provider_state set tokens=1,updated_at=clock_timestamp()");
  await database.query('insert into worker_runs (job_id,scheduled_at) values ($1,clock_timestamp())',[job.id]);
  const run=await claim(database);if(!run)throw new Error('Fixture job did not claim');
  const prices=Array.from({length:100},(_,i)=>[(Math.floor(Date.now()/86400000)-100+i)*86400000,100+i]);
  const payload=job.provider==='coinmetrics'?{data:Array.from({length:5000},(_,i)=>({asset:'btc',time:new Date((Math.floor(Date.now()/86400000)-5000+i)*86400000).toISOString(),PriceUSD:String(500+i+200*Math.sin(i/80)),CapMrktCurUSD:'1000000',CapMVRVCur:String(1.5+0.5*Math.sin(i/90)),SplyCur:'1000'}))}:job.kind==='history'?{prices,total_volumes:prices}:job.id===marketDataset?[['bitcoin','BTC','Bitcoin',100],['ethereum','ETH','Ethereum',50]].map(([id,symbol,name,cap],index)=>({
    id,symbol,name,current_price:cap,market_cap:cap,market_cap_rank:index+1,total_volume:10,price_change_percentage_24h:1,last_updated:new Date(Date.now()-1000).toISOString(),
  })):{data:{total_market_cap:{usd:1000},total_volume:{usd:100},market_cap_percentage:{btc:60,eth:20},updated_at:Math.floor(Date.now()/1000)}};
  await executeRun(database,run,job,async()=>new Response(JSON.stringify(payload)));
}
process.env.WEB_ORIGINS='http://127.0.0.1:5175';
delete process.env.WORKSPACE_TOKEN;
const server=apiServer(database).listen(3101,'127.0.0.1',()=>console.log('Isolated browser API ready'));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;server.close();server.closeAllConnections();await database.end();await admin.query(`drop schema ${schema} cascade`);await admin.end();}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
