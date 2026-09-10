import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBook,parseFunding } from './venue.js';
import { parsePairs,parseOrders } from './spot.js';
import { parseFundamentalHistory } from './history.js';

test('books preserve missing depth and suppress impact estimates when the book cannot fill a notional',()=>{
  const time=Date.now()-1,book={coin:'BTC',time,levels:[[{px:'99',sz:'1'}],[{px:'101',sz:'1'}]]};
  const data=parseBook(book,'BTC').members[0].data;
  assert.equal((data.impact as any[])[0].buy,null);assert.equal(data.spreadBps,200);
  assert.equal(parseBook({...book,levels:[[],[]]},'BTC').members[0].data.spreadBps,null);
  assert.throws(()=>parseBook({...book,levels:[[{px:'102',sz:'1'}],[{px:'101',sz:'1'}]]},'BTC'),/Crossed/);
  assert.throws(()=>parseBook({...book,coin:'ETH'},'BTC'));
});
test('funding preserves actual settlement timestamps, signed rates and instrument identity',()=>{
  const time=Date.now()-1000,payload=[{coin:'BTC',time,fundingRate:'-0.001',premium:'0.01'}];
  const row=parseFunding(payload,'BTC').members[0].data;
  assert.equal(row.observedAt,new Date(time).toISOString());assert.equal(row.fundingRate,-0.001);assert.equal(row.intervalSeconds,3600);
  assert.throws(()=>parseFunding([...payload,...payload],'BTC'));
  assert.throws(()=>parseFunding([{...payload[0],coin:'ETH'}],'BTC'));
});
test('fundamental histories exclude intraday tails and reject off-grid historical values',()=>{
  const now='2026-09-10T12:00:00Z',day=Date.parse('2026-09-09T00:00:00Z')/1000;
  assert.equal(parseFundamentalHistory({tvl:[{date:day,totalLiquidityUSD:1},{date:day+90000,totalLiquidityUSD:2}]},'tvl',false,now).length,1);
  assert.equal(parseFundamentalHistory({totalDataChart:[[day,null]]},'fees',true,now)[0].value,null);
  assert.throws(()=>parseFundamentalHistory({totalDataChart:[[day+1,10]]},'fees',true,now),/UTC grid/);
  assert.equal(parseFundamentalHistory({tvl:[{date:day+123,totalLiquidityUSD:10}]},'tvl',false,now)[0].observedAt,new Date((day+123)*1000).toISOString());
});
test('spot enrichment validates chain/token identity and keeps promotion separate from risk',()=>{
  const token='0x'+'1'.repeat(40),quote='0x'+'2'.repeat(40),pair='0x'+'3'.repeat(40);
  const payload=[{chainId:'base',baseToken:{address:token},quoteToken:{address:quote},pairAddress:pair,liquidity:null}];
  const data=parsePairs(payload,'base',token).members[0].data;
  assert.equal(data.liquidityUsd,null);assert.equal(data.contractRisk,'unknown');assert.equal(data.tokenLaunchAt,null);
  assert.throws(()=>parsePairs(payload,'base','0x'+'4'.repeat(40)),/token mismatch/);
  assert.equal(parseOrders({orders:[],boosts:[]},'base',token).members[0].data.classification,'paid promotion');
  assert.throws(()=>parseOrders([], 'base',token));
  const v4=parsePairs([{...payload[0],pairAddress:'0x'+'a'.repeat(64)}],'base',token).members[0].data;
  assert.equal(v4.pairIdentityKind,'pool-id');
});
