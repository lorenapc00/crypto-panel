import assert from 'node:assert/strict';
import test from 'node:test';
import { filters,text,id,version } from './validation.js';
import { authorize } from '../http.js';
import { safeEndpoint,probeWeight } from '../requests.js';

test('research filters reject unsupported settings, invalid ranges and non-finite thresholds',()=>{
  assert.deepEqual(filters({query:'BTC',sort:'cap',minCap:1,maxCap:2}),{query:'BTC',sort:'cap',minCap:1,maxCap:2});
  for(const value of [{sort:'sql'}, {query:[]}, {minCap:2,maxCap:1},{minCap:-1},{unknown:true}])assert.throws(()=>filters(value));
  assert.throws(()=>text('  ','name'));assert.throws(()=>version(1.5));assert.throws(()=>id('../bitcoin'));
});
test('workspace access rejects fake tokens and foreign browser origins',()=>{
  assert.doesNotThrow(()=>authorize({headers:{authorization:'Bearer secret',origin:'http://127.0.0.1:5174'}} as any,'secret'));
  assert.throws(()=>authorize({headers:{authorization:'Bearer wrong'}} as any,'secret'),/token required/);
  assert.throws(()=>authorize({headers:{origin:'https://foreign.example'}} as any,undefined),/Origin/);
});
test('quota evidence strips credentials and reserves worst-case probe response weight',()=>{
  assert.equal(safeEndpoint('https://user:secret@example.com/path?api_key=secret&metric=price'),'https://example.com/path?metric=price');
  assert.equal(probeWeight('hyperliquid',{type:'fundingHistory'}),45);
  assert.equal(probeWeight('hyperliquid',{type:'l2Book'}),2);
});
