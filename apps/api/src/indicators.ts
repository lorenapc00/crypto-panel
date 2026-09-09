export type Candle = { observedAt: string; close: number };
export type Indicators = { sma7: number | null; sma30: number | null; rsi14: number | null; macd: number | null };
const avg = (xs:number[]) => xs.reduce((a,b)=>a+b,0)/xs.length;
const ema = (xs:number[], p:number) => xs.length < p ? null : xs.slice(p).reduce((v,x)=>x*2/(p+1)+v*(1-2/(p+1)),avg(xs.slice(0,p)));
/** Server-side calculation. Candles must be chronologically ascending. */
export function indicators(c:Candle[]):Indicators { const x=c.map(v=>v.close); const sma=(n:number)=>x.length<n?null:avg(x.slice(-n)); let rsi:null|number=null;if(x.length>=15){const d=x.slice(-15).slice(1).map((v,i)=>v-x[x.length-15+i]);const loss=avg(d.map(v=>Math.max(-v,0)));rsi=loss===0?100:100-100/(1+avg(d.map(v=>Math.max(v,0)))/loss)}const f=ema(x,12),s=ema(x,26);return {sma7:sma(7),sma30:sma(30),rsi14:rsi,macd:f===null||s===null?null:f-s} }
