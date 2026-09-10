import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../src/migrations.js';
import { configureWorker,claim,configureExternalProvider,reserveExternalRequest } from '../src/discovery/queue.js';
import { executeRun } from '../src/discovery/worker.js';
import { snapshotJobs,marketDataset } from '../src/snapshots/providers.js';
import { historyJobs } from '../src/feeds/history.js';
import { spotJobs } from '../src/feeds/spot.js';
import { workspace,watch,saveNote,saveScreen,savePreference,createAlertRule } from '../src/research/store.js';
import { recordSeriesGaps,seriesHealth } from '../src/health.js';
import { readSeries } from '../src/archive.js';
import { dailySeriesId } from '../src/daily-history.js';
import { apiServer } from '../src/server.js';
import { meteredFetch } from '../src/requests.js';

async function isolated(run:(database:Pool)=>Promise<void>){
  const connectionString=process.env.TEST_DATABASE_URL;if(!connectionString)throw new Error('TEST_DATABASE_URL required');
  const schema=`stage1_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString,max:1});
  const database=new Pool({connectionString,options:`-c search_path=${schema}`,max:5});
  try{await admin.query(`create schema ${schema}`);await migrate(database);await run(database);}
  finally{await database.end();await admin.query(`drop schema if exists ${schema} cascade`);await admin.end();}
}
const market=snapshotJobs.find(j=>j.id===marketDataset)!;
async function ingest(database:Pool,job:typeof market,payload:unknown){
  await database.query(`update worker_provider_state s set tokens=l.bucket_capacity,updated_at=clock_timestamp(),blocked_until=null from worker_provider_limits l where s.provider_id=l.provider_id`);
  await database.query('insert into worker_runs (job_id,scheduled_at) values ($1,clock_timestamp())',[job.id]);
  const run=await claim(database);assert.ok(run);assert.equal(run.job_id,job.id);
  return executeRun(database,run,job,async()=>new Response(JSON.stringify(payload)));
}
const coin=(price:number|null)=>[{id:'bitcoin',name:'Bitcoin',symbol:'btc',market_cap_rank:1,current_price:price,market_cap:100,price_change_percentage_24h:1,last_updated:new Date(Date.now()-1000).toISOString()}];

test('research state survives new API instances, notes keep revisions and conflicting edits are rejected',async()=>isolated(async database=>{
  await database.query("insert into assets (id,name,symbol) values ('bitcoin','Bitcoin','BTC')");
  await watch(database,'bitcoin',true);await watch(database,'bitcoin',true);
  const screen=await saveScreen(database,{name:'BTC research',filters:{query:'BTC'}});
  await savePreference(database,'price-chart',{range:'1Y'});
  const note=await saveNote(database,{assetId:'bitcoin',body:'Initial thesis'});
  await saveNote(database,{assetId:'bitcoin',body:'Updated thesis',version:1},note.id);
  await assert.rejects(saveNote(database,{assetId:'bitcoin',body:'Conflicting edit',version:1},note.id),/changed/);
  assert.equal((await database.query('select count(*)::int as n from research_note_revisions')).rows[0].n,2);
  const server=apiServer(database).listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as any;
  const data=await fetch(`http://127.0.0.1:${address.port}/api/v1/workspace`).then(r=>r.json()) as any;
  assert.equal(data.data.watchlist.length,1);assert.equal(data.data.screens[0].id,screen.id);assert.equal(data.data.preferences['price-chart'].range,'1Y');
  const closed=once(server,'close');server.close();server.closeAllConnections();await closed;
  assert.equal((await workspace(database)).watchlist.length,1);
}));

test('threshold alerts establish a baseline, survive null observations and emit once per crossing',async()=>isolated(async database=>{
  await configureWorker(database,[market]);await ingest(database,market,coin(20));
  await createAlertRule(database,{assetId:'bitcoin',name:'Above 10',metric:'priceUsd',operator:'above',threshold:10});
  await ingest(database,market,coin(20));assert.equal((await database.query('select count(*)::int as n from research_alerts')).rows[0].n,0);
  await ingest(database,market,coin(5));await ingest(database,market,coin(null));await ingest(database,market,coin(15));await ingest(database,market,coin(16));
  const alerts=(await database.query('select * from research_alerts')).rows;
  assert.equal(alerts.length,1);assert.equal(alerts[0].evidence.value,15);
  await assert.rejects(database.query("update research_alerts set evidence='{}' where id=$1",[alerts[0].id]),/immutable/);
  await database.query('update research_alerts set read_at=clock_timestamp() where id=$1',[alerts[0].id]);
  await ingest(database,market,coin(4));await ingest(database,market,coin(11));assert.equal((await database.query('select count(*)::int as n from research_alerts')).rows[0].n,2);
}));

test('scheduled daily histories record gaps and revisions without changing earlier series replay',async()=>isolated(async database=>{
  const job=historyJobs.find(j=>j.id==='coingecko:bitcoin:daily-history:v1')!;await configureWorker(database,[job]);
  const midnight=Math.floor(Date.now()/86400000)*86400000,day=86400000;
  const chart=(middle:number|null)=>({prices:[[midnight-3*day,10],[midnight-2*day,middle],[midnight-day,12]],total_volumes:[[midnight-3*day,1],[midnight-2*day,2],[midnight-day,3]]});
  assert.equal((await ingest(database,job,chart(null))).status,'succeeded');await recordSeriesGaps(database);
  const cutoff=(await database.query('select clock_timestamp()::text as now')).rows[0].now;
  const old=await readSeries(dailySeriesId('bitcoin'),{asOf:cutoff},database);
  const health=(await seriesHealth(database)).find(s=>s.metric_code==='price_usd');assert.ok(health.missing_intervals>=1);assert.ok(health.replay_coverage_start);assert.equal(health.detected_interval_seconds,86400);
  await ingest(database,job,chart(11));await recordSeriesGaps(database);
  assert.deepEqual(await readSeries(dailySeriesId('bitcoin'),{asOf:cutoff},database),old);
  assert.ok((await seriesHealth(database)).find(s=>s.metric_code==='price_usd').resolved_gaps>=1);
}));

test('manual requests and probes cannot bypass a shared monthly quota and never retain credentials',async()=>isolated(async database=>{
  await configureWorker(database,[market]);await configureExternalProvider(database,'coingecko',1,true);
  await database.query("update worker_provider_limits set requests_per_month=1 where provider_id='coingecko'");
  const reservations=await Promise.all([reserveExternalRequest(database,'coingecko',1,'capability-probe','https://example.com'),reserveExternalRequest(database,'coingecko',1,'manual-history','https://example.com')]);
  assert.equal(reservations.filter(r=>r.request).length,1);
  assert.equal((await database.query('select requests from worker_monthly_usage')).rows[0].requests,1);
  await database.query('delete from worker_monthly_usage');
  const result=await meteredFetch('coingecko','https://example.com?api_key=secret',{},{database,purpose:'capability-probe',fetchImpl:async()=>new Response('{}',{status:429,headers:{'retry-after':'120'}})});
  assert.equal(result.response.status,429);
  const request=(await database.query('select endpoint,purpose,http_status from worker_requests where id=$1',[result.requestId])).rows[0];
  assert.equal(request.endpoint,'https://example.com/');assert.equal(request.purpose,'capability-probe');assert.equal(request.http_status,429);
  assert.ok((await database.query('select blocked_until>clock_timestamp() as blocked from worker_provider_state')).rows[0].blocked);
}));

test('enrichment without eligible pool observations skips acquisition without quota use or false coverage',async()=>isolated(async database=>{
  const job=spotJobs[0];await configureWorker(database,[job]);
  const result=await ingest(database,job,{});assert.equal(result.status,'skipped');
  assert.equal((await database.query('select count(*)::int as n from worker_requests')).rows[0].n,0);
  assert.equal((await database.query('select count(*)::int as n from discovery_replay_coverage')).rows[0].n,0);
}));

test('API mutations validate payloads and origins, remove fake auth and enforce HTTP methods',async()=>isolated(async database=>{
  const server=apiServer(database).listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as any;
  const request=(path:string,options?:RequestInit)=>fetch(`http://127.0.0.1:${address.port}/api/v1${path}`,options);
  try{
    assert.equal((await request('/auth/dev-session',{method:'POST'})).status,410);
    assert.equal((await request('/workspace',{headers:{origin:'https://foreign.example'}})).status,403);
    assert.equal((await request('/research/notes',{method:'POST',headers:{'content-type':'application/json'},body:'{bad'})).status,400);
    assert.equal((await request('/research/screens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'x',filters:{minCap:10,maxCap:1}})})).status,400);
    assert.equal((await request('/assets',{method:'DELETE'})).status,405);
    assert.equal((await request('/series?asset=bitcoin&metric=price_usd&interval=bad')).status,400);
    assert.equal((await request('/series?asset=bitcoin&metric=price_usd&from=bad')).status,400);
  }finally{const closed=once(server,'close');server.close();server.closeAllConnections();await closed;}
}));
