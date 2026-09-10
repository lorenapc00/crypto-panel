import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../src/migrations.js';
import { apiServer } from '../src/server.js';
import { configureWorker,claim } from '../src/discovery/queue.js';
import { executeRun } from '../src/discovery/worker.js';
import { snapshotJobs,marketDataset,globalDataset } from '../src/snapshots/providers.js';
import { historyJobs } from '../src/feeds/history.js';
import { btcHistoryJob } from '../src/feeds/bitcoin.js';
import { capitalJobs } from '../src/feeds/capital.js';
import { discoveryJobs } from '../src/discovery/providers.js';
import { venueJobs } from '../src/feeds/venue.js';
import { perpJobs } from '../src/feeds/perp.js';

if(!process.env.TEST_DATABASE_URL)throw new Error('Browser tests require TEST_DATABASE_URL');
const schema=`browser_${randomUUID().replaceAll('-','')}`;
const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
const database=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
await admin.query(`create schema ${schema}`);
await migrate(database);
const instrumentsJob=discoveryJobs.find(j=>j.id==='hyperliquid:instruments:native:v1')!;
const solanaPoolsJob=discoveryJobs.find(j=>j.id==='geckoterminal:pools:solana:v1')!;
const basePoolsJob=discoveryJobs.find(j=>j.id==='geckoterminal:pools:base:v1')!;
const jobs=[...snapshotJobs.filter(j=>[marketDataset,globalDataset].includes(j.id)),historyJobs[0],btcHistoryJob,
  ...capitalJobs,instrumentsJob,venueJobs[0],venueJobs[1],solanaPoolsJob,basePoolsJob,
  discoveryJobs.find(j=>j.id==='defillama:protocols:v1')!,discoveryJobs.find(j=>j.id==='hyperliquid:namespaces:v1')!,...perpJobs];
await configureWorker(database,jobs);
const midnight=Math.floor(Date.now()/86400000)*86400000;
// A second instrument acquisition turns one archived baseline into one real listing event.
let instrumentRuns=0;
// The global aggregate is acquired twice so the overview has a sampled series, not one point.
for(const job of [...jobs,snapshotJobs.find(j=>j.id===globalDataset)!,instrumentsJob]){
  await database.query('update worker_provider_state s set tokens=l.bucket_capacity,updated_at=clock_timestamp() from worker_provider_limits l where l.provider_id=s.provider_id');
  await database.query('insert into worker_runs (job_id,scheduled_at) values ($1,clock_timestamp())',[job.id]);
  const run=await claim(database);if(!run)throw new Error('Fixture job did not claim');
  const prices=Array.from({length:100},(_,i)=>[(Math.floor(Date.now()/86400000)-100+i)*86400000,100+i]);
  const payload=job.provider==='coinmetrics'?{data:Array.from({length:5000},(_,i)=>({asset:'btc',time:new Date((Math.floor(Date.now()/86400000)-5000+i)*86400000).toISOString(),PriceUSD:String(500+i+200*Math.sin(i/80)),CapMrktCurUSD:'1000000',CapMVRVCur:String(1.5+0.5*Math.sin(i/90)),SplyCur:'1000'}))}:job.kind==='history'?{prices,total_volumes:prices}:job.id===marketDataset?[['bitcoin','BTC','Bitcoin',100],['ethereum','ETH','Ethereum',50]].map(([id,symbol,name,cap],index)=>({
    id,symbol,name,current_price:cap,market_cap:cap,market_cap_rank:index+1,total_volume:10,price_change_percentage_24h:1,last_updated:new Date(Date.now()-1000).toISOString(),
  })):{data:{total_market_cap:{usd:1000},total_volume:{usd:100},market_cap_percentage:{btc:60,eth:20},updated_at:Math.floor(Date.now()/1000)}};
  const contextPayload = job.id===capitalJobs[0].id?Array.from({length:100},(_,i)=>({date:String((Math.floor(Date.now()/86400000)-100+i)*86400),totalCirculatingUSD:{peggedUSD:100000000000+i*100000000}})):
    job.id===capitalJobs[1].id?{peggedAssets:[{id:'1',name:'Tether',symbol:'USDT',pegType:'peggedUSD',chains:['Ethereum'],circulating:{peggedUSD:1000000},price:1},
      {id:'2',name:'Euro fixture',symbol:'EUR',pegType:'peggedEUR',chains:[],price:1.1}]}:
    job.kind==='instruments'?(()=>{const names=instrumentRuns++?['BTC','NEWPERP']:['BTC'];
      return [{universe:names.map(name=>({name,szDecimals:5,maxLeverage:40,marginTableId:1})),collateralToken:0},
        names.map((_,index)=>({openInterest:String(1234+index*10),markPx:'60000',oraclePx:'59970',funding:'-0.0000125',
          premium:'0.0004',dayNtlVlm:'2500000',impactPxs:['59990','60010']}))];})():
    job.kind==='namespaces'?[null,{name:'mkts',fullName:'Markets DEX',deployer:'0xabc'}]:
    job.kind==='protocols'?[{id:'5507',slug:'hyperliquid-perps',name:'Hyperliquid Perps',category:'Derivatives',chains:['Hyperliquid L1'],tvl:180000000,gecko_id:null},
      {id:'9001',slug:'emerging-perps',name:'Emerging Perps',category:'Derivatives',chains:['Base'],tvl:1000000,gecko_id:'bitcoin'},
      {id:'777',slug:'a-lender',name:'A Lender',category:'Lending',chains:['Base'],tvl:50,gecko_id:null}]:
    job.kind==='openinterest'?{total24h:15000000000,
      totalDataChart:Array.from({length:40},(_,i)=>[(midnight-(40-i)*86400000)/1000,10000000000+i*100000000]),
      protocols:[{defillamaId:'5507',slug:'hyperliquid-perps',name:'Hyperliquid Perps',category:'Derivatives',
        chains:['Hyperliquid L1'],parentProtocol:'parent#hyperliquid',module:'hyperliquid-perp-oi',
        total24h:14000000000,total7DaysAgo:13000000000,total30DaysAgo:10000000000,change_1d:0.5}]}:
    job.kind==='book'?{coin:'BTC',time:Date.now()-60000,levels:[[{px:'59990',sz:'2'}],[{px:'60010',sz:'2'}]]}:
    job.kind==='funding'?[{coin:'BTC',time:Date.now()-1000,fundingRate:'0.000025'}]:
    job.id==='geckoterminal:pools:solana:v1'?{data:[
      {id:'solana_PoolAeCoreEmergentToken00000000000000000001',attributes:{address:'PoolAeCoreEmergentToken00000000000000000001',name:'DEEPWORK / SOL',pool_created_at:new Date(midnight).toISOString(),reserve_in_usd:180000,volume_usd:{h24:520000},transactions:{h24:{buys:140,sells:60}}},relationships:{base_token:{data:{id:'solana_DeepWorkTokenMint000000000000000000000001'}},quote_token:{data:{id:'solana_So11111111111111111111111111111111111111112'}}}},
      {id:'solana_PoolBeSecondaryDeepWorkPair0000000000000002',attributes:{address:'PoolBeSecondaryDeepWorkPair0000000000000002',name:'DEEPWORK / USDC',pool_created_at:new Date(midnight).toISOString(),reserve_in_usd:40000,volume_usd:{h24:90000},transactions:{h24:{buys:20,sells:15}}},relationships:{base_token:{data:{id:'solana_DeepWorkTokenMint000000000000000000000001'}},quote_token:{data:{id:'solana_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'}}}},
      {id:'solana_PoolCeThinLaunchLiquidityPair000000000003',attributes:{address:'PoolCeThinLaunchLiquidityPair000000000003',name:'THINCOIN / SOL',pool_created_at:new Date(midnight).toISOString(),reserve_in_usd:12000,volume_usd:{h24:3000},transactions:{h24:{buys:4,sells:9}}},relationships:{base_token:{data:{id:'solana_ThinCoinMint00000000000000000000000000002'}},quote_token:{data:{id:'solana_So11111111111111111111111111111111111111112'}}}}]}:
    job.id==='geckoterminal:pools:base:v1'?{data:[
      {id:'base_0x00000000000000000000000000000000000000a1',attributes:{address:'0x00000000000000000000000000000000000000A1',name:'BASEGEM / WETH',pool_created_at:new Date(midnight).toISOString(),reserve_in_usd:null,volume_usd:{h24:15000},transactions:{h24:{buys:8,sells:8}}},relationships:{base_token:{data:{id:'base_0x00000000000000000000000000000000000000b2'}},quote_token:{data:{id:'base_0x4200000000000000000000000000000000000006'}}}}]}:payload;
  const result=await executeRun(database,run,job,async()=>new Response(JSON.stringify(contextPayload)));
  if(result.status!=='succeeded')throw new Error(`Fixture failed: ${job.id} ${result.status}`);
}
process.env.WEB_ORIGINS='http://127.0.0.1:5175';
delete process.env.WORKSPACE_TOKEN;
const server=apiServer(database).listen(3101,'127.0.0.1',()=>console.log('Isolated browser API ready'));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;server.close();server.closeAllConnections();await database.end();await admin.query(`drop schema ${schema} cascade`);await admin.end();}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
