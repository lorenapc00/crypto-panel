export const DAY = 86400000;
export const BTC_METHOD = 'btc-trend:v1';
export type Point = { observedAt: string; value: number | null };
export type Regime = 'bullish' | 'bearish' | 'transitional' | 'insufficient-history';
export const mean = (values: number[]) => values.reduce((sum, n) => sum + n, 0) / values.length;

/** Materialize absent dates as null so charts and all rolling calculations break at gaps. */
export function dailyGrid(points: Point[]): Point[] {
  let previous = -Infinity;
  const result: Point[] = [];
  for (const p of points) {
    const time = Date.parse(p.observedAt);
    if (!Number.isFinite(time) || time % DAY || time <= previous || p.value !== null && (!Number.isFinite(p.value) || p.value <= 0)) throw new Error('Invalid positive daily series');
    if (previous !== -Infinity && time - Date.parse(points[0].observedAt) > 10000 * DAY) throw new Error('Daily history exceeds 10000 days');
    for (let missing = previous + DAY; previous !== -Infinity && missing < time; missing += DAY) result.push({ observedAt: new Date(missing).toISOString(), value: null });
    result.push({ observedAt: new Date(time).toISOString(), value: p.value }); previous = time;
  }
  return result;
}

function movingAverage(values: (number | null)[], period: number) {
  let sum = 0, count = 0;
  return values.map((v, i) => {
    if (v !== null) { sum += v; count++; }
    if (i >= period && values[i - period] !== null) { sum -= values[i - period]!; count--; }
    return i >= period - 1 && count === period ? sum / period : null;
  });
}

export function btcTrend(input: Point[]) {
  const points = dailyGrid(input), prices = points.map(p => p.value);
  const sma50 = movingAverage(prices, 50), sma200 = movingAverage(prices, 200);
  // A week is Monday–Sunday UTC; only a fully observed Sunday close enters weekly indicators.
  const weeks: { index: number; value: number | null }[] = [];
  for (let i = 0; i < points.length; i++) if (new Date(points[i].observedAt).getUTCDay() === 0) weeks.push({ index: i,
    value: i >= 6 && prices.slice(i - 6, i + 1).every(v => v !== null) ? prices[i] : null });
  const weekly = weeks.map(p => p.value), sma20w = movingAverage(weekly, 20), sma200w = movingAverage(weekly, 200);
  const weeklyAt = new Map(weeks.map((w, i) => [w.index, i]));
  let weeklyRun: number[] = [], ema21w: number | null = null, gain = 0, loss = 0, weeklyRsi: number | null = null;
  let weekIndex: number | undefined;
  let shown: Regime = 'insufficient-history', candidate: Regime = 'insufficient-history', confirmations = 0;
  let ath = 0, athTime = 0, gapSinceAth = false, runLength = 0;
  return points.map((p, i) => {
    const time = Date.parse(p.observedAt), close = p.value;
    runLength = close === null ? 0 : runLength + 1;
    const slope = runLength >= 220 && sma200[i] !== null && sma200[i - 20] != null ? sma200[i]! - sma200[i - 20]! : null;
    const raw: Regime = close === null || slope === null ? 'insufficient-history'
      : close > sma200[i]! && slope > 0 ? 'bullish' : close < sma200[i]! && slope < 0 ? 'bearish' : 'transitional';
    if (raw === 'insufficient-history') { shown = raw; candidate = raw; confirmations = 0; }
    else {
      confirmations = candidate === raw ? confirmations + 1 : 1; candidate = raw;
      if (confirmations >= 3) shown = raw;
    }
    let recoveryDays: number | null = null;
    if (close === null) gapSinceAth = true;
    if (close !== null && close >= ath) {
      if (ath && i && prices[i - 1] !== null && prices[i - 1]! < ath && !gapSinceAth) recoveryDays = (time - athTime) / DAY;
      ath = close; athTime = time; gapSinceAth = false;
    }
    const newWeek = weeklyAt.get(i);
    if (newWeek !== undefined) {
      weekIndex = newWeek;
      const value = weekly[newWeek];
      if (value === null) { weeklyRun = []; ema21w = null; weeklyRsi = null; gain = loss = 0; }
      else {
        const prev = weeklyRun.at(-1); weeklyRun.push(value);
        if (weeklyRun.length === 21) ema21w = mean(weeklyRun);
        else if (weeklyRun.length > 21) ema21w = value * 2 / 22 + ema21w! * 20 / 22;
        if (weeklyRun.length >= 2 && weeklyRun.length <= 15) { gain += Math.max(value - prev!, 0) / 14; loss += Math.max(prev! - value, 0) / 14; }
        else if (weeklyRun.length > 15) { gain = (gain * 13 + Math.max(value - prev!, 0)) / 14; loss = (loss * 13 + Math.max(prev! - value, 0)) / 14; }
        if (weeklyRun.length >= 15) weeklyRsi = gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    }
    const vol = (days: number) => {
      if (runLength < days + 1) return null;
      const changes = prices.slice(i - days + 1, i + 1).map((v, j) => Math.log(v! / prices[i - days + j]!));
      const avg = mean(changes);
      return Math.sqrt(changes.reduce((sum, n) => sum + (n - avg) ** 2, 0) / (days - 1)) * Math.sqrt(365) * 100;
    };
    return { ...p, sma50: sma50[i], sma200: sma200[i], sma200Slope20d: slope,
      sma20w: weekIndex === undefined ? null : sma20w[weekIndex], ema21w,
      sma200w: weekIndex === undefined ? null : sma200w[weekIndex], weeklyRsi,
      mayerMultiple: close !== null && sma200[i] !== null ? close / sma200[i]! : null,
      drawdownPct: close !== null && ath ? (close / ath - 1) * 100 : null,
      daysUnderwater: close !== null && !gapSinceAth ? (time - athTime) / DAY : null, recoveryDays,
      volatility30d: vol(30), volatility90d: vol(90), regime: shown, candidate: raw,
      confirmationDays: Math.min(confirmations, 3), athCoverage: 'running maximum of observed closes' };
  });
}

export const halvings = [
  { date: '2012-11-28', height: 210000 }, { date: '2016-07-09', height: 420000 },
  { date: '2020-05-11', height: 630000 }, { date: '2024-04-20', height: 840000 },
];
export function cycleComparisons(prices: Point[], mvrv: Point[]) {
  const ratios = new Map(mvrv.map(p => [p.observedAt, p.value]));
  return halvings.map((halving, i) => {
    const start = Date.parse(halving.date), end = i + 1 < halvings.length ? Date.parse(halvings[i + 1].date) : Infinity;
    const base = prices.find(p => Date.parse(p.observedAt) === start)?.value;
    return { ...halving, anchorPrice: base ?? null,
      points: prices.filter(p => Date.parse(p.observedAt) >= start && Date.parse(p.observedAt) < end).map(p => ({
        day: (Date.parse(p.observedAt) - start) / DAY, date: p.observedAt,
        indexedPrice: base && p.value !== null ? p.value / base * 100 : null, mvrv: ratios.get(p.observedAt) ?? null,
      })) };
  });
}
