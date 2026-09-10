import type { DiscoveryJob, DiscoverySample } from '../discovery/providers.js';
import { parseDailyChart, dailySeriesId } from '../daily-history.js';
import { fundamentalProfiles } from '../snapshots/providers.js';
import type { SeriesPoint } from '../archive.js';

const identities = [
  {id:'bitcoin',symbol:'BTC',name:'Bitcoin'}, {id:'ethereum',symbol:'ETH',name:'Ethereum'},
  {id:'solana',symbol:'SOL',name:'Solana'}, {id:'hyperliquid',symbol:'HYPE',name:'Hyperliquid'},
];
export function parseFundamentalHistory(payload: unknown, field: 'fees' | 'revenue' | 'holder_revenue' | 'tvl', chain: boolean, receivedAt: string): SeriesPoint[] {
  const data = payload as any;
  const rows = field === 'tvl' ? chain ? data : data?.tvl : data?.totalDataChart;
  if (!Array.isArray(rows) || !rows.length) throw new Error('Missing fundamental history');
  let previous = -Infinity;
  const points: SeriesPoint[] = [];
  for (const row of rows) {
    const time = (field === 'tvl' ? row.date : row[0]) * 1000;
    const value = field === 'tvl' ? row[chain ? 'tvl' : 'totalLiquidityUSD'] : row[1];
    if (!Number.isSafeInteger(time) || time <= previous || time < 0 || time > Date.parse(receivedAt)) throw new Error('Invalid fundamental history timestamp');
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Invalid fundamental history value');
    previous = time;
    // Exclude the live day. Historical TVL timestamps are preserved verbatim;
    // interval evidence flags irregular samples rather than shifting their time.
    if (time >= Math.floor(Date.parse(receivedAt)/86400000)*86400000) continue;
    if (field!=='tvl' && time % 86400000 !== 0) throw new Error('Fundamental history is not on a daily UTC grid');
    points.push({observedAt:new Date(time).toISOString(),value});
  }
  if (!points.length) throw new Error('No completed daily fundamentals');
  return points;
}

export const historyJobs: DiscoveryJob[] = [
  ...identities.map(asset => ({ id:`coingecko:${asset.id}:daily-history:v1`,provider:'coingecko',kind:'history' as const,
    scope:`${asset.id} completed daily USD prices and sampled rolling 24h volume`,intervalSeconds:86400,offsetSeconds:900,
    membership:'sample' as const,weight:1,methodologyVersion:'daily-sample:v1',
    endpoint:`https://api.coingecko.com/api/v3/coins/${asset.id}/market_chart?vs_currency=usd&days=365&interval=daily`,
    parse:(payload:unknown,receivedAt=new Date().toISOString()):DiscoverySample=>{
      const parsed = parseDailyChart(payload,Date.parse(receivedAt));
      return {members:[],assets:[asset],notes:{history:'Pre-archive values are reconstructed; scheduled acquisition starts forward coverage'},series:
        (['price_usd','volume_24h_usd'] as const).map(metricCode=>({definition:{id:dailySeriesId(asset.id,metricCode),assetId:asset.id,
          metricCode,sourceId:'coingecko',unit:'USD',scope:'asset',intervalSeconds:86400,methodologyVersion:'daily-sample:v1'},
          points:metricCode==='price_usd'?parsed.prices:parsed.volumes}))};
    } })),
  ...fundamentalProfiles.flatMap(profile => (profile.scope==='chain' ? ['fees','tvl'] as const : ['fees','revenue','holder_revenue','tvl'] as const).map(field=>{
    const chain = profile.scope==='chain';
    const metricCode = {fees:'fees_24h_usd',revenue:'revenue_24h_usd',holder_revenue:'holder_revenue_24h_usd',tvl:'tvl_usd'}[field];
    const endpoint = field==='tvl' ? `https://api.llama.fi/${chain?'v2/historicalChainTvl':'protocol'}/${profile.name}`
      : `https://api.llama.fi/${chain?'overview':'summary'}/fees/${profile.name}?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true${field==='fees'?'':`&dataType=${field==='revenue'?'dailyRevenue':'dailyHoldersRevenue'}`}`;
    return {id:`defillama:${profile.asset}:${field}:daily-history:v1`,provider:'defillama',kind:'history' as const,
      scope:`${profile.scope}:${profile.name}:${metricCode}`,intervalSeconds:86400,offsetSeconds:1800,membership:'sample' as const,
      weight:1,methodologyVersion:'fundamental-daily:v1',endpoint,
      parse:(payload:unknown,receivedAt=new Date().toISOString()):DiscoverySample=>({members:[],assets:identities.filter(a=>a.id===profile.asset),
        notes:{definition:field==='holder_revenue'?'Provider-defined holder revenue; mechanism and recipients require individual review':`${profile.scope} ${field}; not token net flows`,
          history:field==='tvl'?'Provider TVL timestamps; nominal daily spacing with irregular steps flagged':'Daily UTC observations; historical revisions retained from acquisition onward'},
        series:[{definition:{id:`defillama:${profile.asset}:${metricCode}:daily:v1`,assetId:profile.asset,metricCode,sourceId:'defillama',
          unit:'USD',scope:profile.scope,intervalSeconds:86400,methodologyVersion:'fundamental-daily:v1'},
          points:parseFundamentalHistory(payload,field,chain,receivedAt)}]}) };
  })),
];
