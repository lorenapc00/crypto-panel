import type { DiscoveryJob, DiscoverySample } from '../discovery/providers.js';

const canonical = (chain:string,value:string)=>chain==='base'?value.toLowerCase():value;
function address(chain:string,value:unknown):string {
  if (typeof value!=='string' || !(chain==='base'?/^0x[0-9a-fA-F]{40}$/:/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).test(value)) throw new Error('Invalid token address');
  return canonical(chain,value);
}
function optional(value:unknown):number|null {
  if(value==null)return null;
  if(!['string','number'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value)))throw new Error('Invalid pair metric');
  return Number(value);
}
export function parsePairs(payload:unknown,chain:string,token:string):DiscoverySample {
  if(!Array.isArray(payload)||payload.length>500)throw new Error('Invalid pair response');
  const members=payload.map(row=>{
    if(row.chainId!==chain)throw new Error('Pair chain mismatch');
    const base=address(chain,row.baseToken?.address),quote=address(chain,row.quoteToken?.address);
    if(base!==token&&quote!==token)throw new Error('Pair token mismatch');
    // A Uniswap v4 pool ID is a bytes32 identifier, not a token contract.
    const pair=chain==='base'&&typeof row.pairAddress==='string'&&/^0x[0-9a-fA-F]{64}$/.test(row.pairAddress)
      ? row.pairAddress.toLowerCase() : address(chain,row.pairAddress);
    const created=optional(row.pairCreatedAt);
    if(created!==null&&(!Number.isSafeInteger(created)||created<0))throw new Error('Invalid pool creation time');
    return {key:JSON.stringify([chain,pair]),status:'observed' as const,data:{chain,pairAddress:pair,
      pairIdentityKind:chain==='base'&&pair.length===66?'pool-id':'contract-address',requestedToken:token,
      baseTokenAddress:base,quoteTokenAddress:quote,priceUsd:optional(row.priceUsd),liquidityUsd:optional(row.liquidity?.usd),
      volume24hUsd:optional(row.volume?.h24),transactions:row.txns??null,providerPoolCreatedAt:created===null?null:new Date(created).toISOString(),
      boosts:row.boosts??null,contractRisk:'unknown',tokenLaunchAt:null}};
  });
  if(new Set(members.map(row=>row.key)).size!==members.length)throw new Error('Duplicate pair identity');
  return {members,notes:{chain,token,coverage:'Pairs reported for a token from the sampled pool feed',promotion:'Boosts are paid promotion, not organic demand',risk:'Contract powers, concentration and sell restrictions are unverified'}};
}
export function parseOrders(payload:unknown,chain:string,token:string):DiscoverySample {
  const row=payload as any;
  if(!row||!Array.isArray(row.orders)||!Array.isArray(row.boosts))throw new Error('Invalid promotion response');
  return {members:[{key:JSON.stringify([chain,token]),status:'observed',data:{chain,token,orders:row.orders,boosts:row.boosts,
    classification:'paid promotion',contractRisk:'unknown'}}],notes:{coverage:'Provider-reported paid orders and boosts; not a trading or safety signal'}};
}
export const spotJobs:DiscoveryJob[]=(['solana','base'] as const).flatMap(chain=>Array.from({length:20},(_,slot)=>(['pairs','orders'] as const).map(kind=>({
  id:`dexscreener:${chain}:${kind}:slot${slot}:v1`,provider:'dexscreener',kind:'enrichment' as const,
  scope:`${chain} sampled pool base token slot ${slot}; ${kind}`,intervalSeconds:3600,membership:'sample' as const,
  weight:1,methodologyVersion:'sampled-enrichment:v1',endpoint:'https://api.dexscreener.com',
  request:async(database:import('pg').Pool)=>{
    const tokens=(await database.query(`select distinct m.data->>'baseTokenAddress' as token from discovery_members m
      where m.snapshot_id=(select id from discovery_snapshots where dataset_id=$1 and observed_at>clock_timestamp()-interval '1 hour'
        order by recorded_at desc,id desc limit 1) order by token`,[`geckoterminal:pools:${chain}:v1`])).rows;
    const token=tokens[slot]?.token;
    if(!token)return null;
    address(chain,token);
    return {endpoint:`https://api.dexscreener.com/${kind==='pairs'?'token-pairs':'orders'}/v1/${chain}/${encodeURIComponent(token)}`,
      parse:(payload:unknown)=>kind==='pairs'?parsePairs(payload,chain,token):parseOrders(payload,chain,token)};
  },
  parse:()=>{throw new Error('Enrichment requires a selected token');},
}))).flat());
