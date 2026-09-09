export type Candle = { observedAt: string; close: number | null };
export type Indicators = { sma7: number | null; sma30: number | null; rsi14: number | null; macd: number | null };
const avg = (xs:number[]) => xs.reduce((a,b)=>a+b,0)/xs.length;
const ema = (xs:number[], p:number) => xs.length < p ? null : xs.slice(p).reduce((v,x)=>x*2/(p+1)+v*(1-2/(p+1)),avg(xs.slice(0,p)));
const DAY_MS = 86_400_000;

/** Use only the contiguous completed daily segment after the most recent gap. */
export function indicators(c: Candle[]): Indicators {
  const x: number[] = [];
  let previous: number | undefined;
  for (const point of c) {
    const time = Date.parse(point.observedAt);
    if (!Number.isFinite(time) || time % DAY_MS !== 0 || previous !== undefined && time <= previous) return { sma7: null, sma30: null, rsi14: null, macd: null };
    if (previous !== undefined && time - previous !== DAY_MS) x.length = 0;
    if (point.close === null || !Number.isFinite(point.close) || point.close < 0) x.length = 0;
    else x.push(point.close);
    previous = time;
  }
  const sma = (n: number) => x.length < n ? null : avg(x.slice(-n));
  let rsi: number | null = null;
  if (x.length >= 15) {
    const deltas = x.slice(1).map((value, index) => value - x[index]);
    let gain = avg(deltas.slice(0, 14).map(delta => Math.max(delta, 0)));
    let loss = avg(deltas.slice(0, 14).map(delta => Math.max(-delta, 0)));
    for (const delta of deltas.slice(14)) {
      gain = (gain * 13 + Math.max(delta, 0)) / 14;
      loss = (loss * 13 + Math.max(-delta, 0)) / 14;
    }
    rsi = gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  const f = ema(x, 12), s = ema(x, 26);
  return { sma7: sma(7), sma30: sma(30), rsi14: rsi, macd: f === null || s === null ? null : f - s };
}

/** Calendar returns need exact endpoint dates, even when intermediate days are missing. */
export function returns(c: Candle[]) {
  const byTime = new Map<number, number | null>();
  let previous = -Infinity;
  for (const point of c) {
    const time = Date.parse(point.observedAt);
    if (!Number.isFinite(time) || time % DAY_MS !== 0 || time <= previous) return { day: null, week: null, month: null, quarter: null };
    byTime.set(time, point.close);
    previous = time;
  }
  const last = c.at(-1);
  const change = (days: number) => {
    if (!last || last.close === null || !Number.isFinite(last.close) || last.close < 0) return null;
    const first = byTime.get(Date.parse(last.observedAt) - days * DAY_MS);
    return first === undefined || first === null || !Number.isFinite(first) || first <= 0 ? null : (last.close / first - 1) * 100;
  };
  return { day: change(1), week: change(7), month: change(30), quarter: change(90) };
}
