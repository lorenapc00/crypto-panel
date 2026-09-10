import type { DiscoveryJob, DiscoverySample } from '../discovery/providers.js';

function number(value: unknown, positive = false): number {
  if (!['string','number'].includes(typeof value) || String(value).trim()==='' || !Number.isFinite(Number(value)) || (positive && Number(value)<=0)) throw new Error('Invalid venue value');
  return Number(value);
}
export function parseBook(payload: unknown, coin: string, receivedAt = new Date().toISOString()): DiscoverySample {
  const row = payload as any;
  if (row?.coin!==coin || !Array.isArray(row.levels) || row.levels.length!==2 || !Number.isSafeInteger(row.time) || row.time>Date.parse(receivedAt) || row.time<0) throw new Error('Invalid order book');
  const levels = row.levels.map((side:any[],index:number)=>{
    if (!Array.isArray(side) || side.length>20) throw new Error('Unexpected order-book depth');
    return side.map((level:any,i:number)=>{
      const price = number(level.px,true),size = number(level.sz,true);
      if (i && (index===0 ? price>=Number(side[i-1].px) : price<=Number(side[i-1].px))) throw new Error('Unordered book levels');
      return {price,size};
    });
  });
  const bid = levels[0][0]?.price??null,ask = levels[1][0]?.price??null;
  if (bid!==null && ask!==null && bid>=ask) throw new Error('Crossed book');
  const mid = bid===null||ask===null?null:(bid+ask)/2;
  const impact = (side:{price:number;size:number}[],notional:number) => {
    if (!mid || !side.length) return null;
    let remaining=notional,quantity=0;
    for (const level of side) { const fill=Math.min(remaining,level.price*level.size);quantity+=fill/level.price;remaining-=fill;if(remaining<=0)break; }
    return remaining>0?null:{averagePrice:notional/quantity,impactBps:Math.abs(notional/quantity/mid-1)*10000};
  };
  return {members:[{key:JSON.stringify(['hyperliquid','',coin]),status:'observed',data:{coin,venue:'hyperliquid',namespace:'',
    observedAt:new Date(row.time).toISOString(),levels,quoteCurrency:'USDC',usdAssumption:'USDC notionals, no USD peg conversion',
    spreadBps:mid===null?null:(ask!-bid!)/mid*10000,
    depthQuote:levels.map((side:{price:number;size:number}[])=>side.reduce((sum,level)=>sum+level.price*level.size,0)),
    impact:[1000,10000].map(notional=>({notionalQuote:notional,buy:impact(levels[1],notional),sell:impact(levels[0],notional)}))}}],
    notes:{coverage:'Top 20 visible levels per side; missing sides and insufficient depth stay unknown',execution:'Instantaneous estimates, not guaranteed fills'}};
}
export function parseFunding(payload: unknown, coin: string, receivedAt = new Date().toISOString()): DiscoverySample {
  if (!Array.isArray(payload) || payload.length>20) throw new Error('Unexpected funding window size');
  let previous=-Infinity;
  const members=payload.map(row=>{
    if (row.coin!==coin || !Number.isSafeInteger(row.time) || row.time<=previous || row.time>Date.parse(receivedAt) || row.time < Date.parse(receivedAt)-3*3600000) throw new Error('Invalid funding event time');
    previous=row.time;
    return {key:JSON.stringify(['hyperliquid','',coin,row.time]),status:'observed' as const,data:{coin,venue:'hyperliquid',namespace:'',
      observedAt:new Date(row.time).toISOString(),fundingRate:number(row.fundingRate),premium:row.premium==null?null:number(row.premium),
      intervalSeconds:3600,definition:'Published historical hourly funding rate; not account cash flow'}};
  });
  return {members,notes:{coverage:'Last two hours for the verified native BTC market; overlapping events deduplicate by identity',publicationTime:'Provider publication time unknown'}};
}
export const venueJobs: DiscoveryJob[] = [
  {id:'hyperliquid:book:BTC:v1',provider:'hyperliquid',kind:'book',scope:'Native BTC perpetual; top 20 levels; USDC',intervalSeconds:3600,
    membership:'sample',weight:2,methodologyVersion:'book:v1',endpoint:'https://api.hyperliquid.xyz/info',body:{type:'l2Book',coin:'BTC'},parse:(p,t)=>parseBook(p,'BTC',t)},
  {id:'hyperliquid:funding:BTC:v1',provider:'hyperliquid',kind:'funding',scope:'Native BTC historical hourly funding; last two hours',intervalSeconds:3600,
    membership:'sample',weight:21,methodologyVersion:'funding:v1',endpoint:'https://api.hyperliquid.xyz/info',
    request:async database=>{const now=(await database.query('select extract(epoch from clock_timestamp())::float8*1000 as now')).rows[0].now;
      return {endpoint:'https://api.hyperliquid.xyz/info',body:{type:'fundingHistory',coin:'BTC',startTime:Math.floor(now-2*3600000),endTime:Math.floor(now)}};},parse:(p,t)=>parseFunding(p,'BTC',t)},
];
