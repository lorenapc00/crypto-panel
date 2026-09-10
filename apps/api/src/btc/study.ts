import { DAY, dailyGrid, mean, type Point } from './calculations.js';
export const STUDY_METHOD = 'forward-close-study:v1';
export const horizons = [1, 7, 30, 90, 180, 365] as const;

export function signalStudy(asset: Point[], benchmark: Point[], eventDates: string[]) {
  const prices = dailyGrid(asset), btc = dailyGrid(benchmark);
  const byDate = new Map(prices.map(p => [Date.parse(p.observedAt), p.value]));
  const btcByDate = new Map(btc.map(p => [Date.parse(p.observedAt), p.value]));
  const times = [...new Set(eventDates.map(d => Date.parse(d)))].sort((a, b) => a - b);
  if (times.length > 1000 || times.some(t => !Number.isFinite(t) || t % DAY)) throw new Error('Invalid or excessive event dates');
  const valid = (value: number | null | undefined): value is number => value != null && value > 0;
  const events = times.map(time => ({ date: new Date(time).toISOString(), horizons: horizons.map(days => {
    const start = byDate.get(time), end = byDate.get(time + days * DAY), bs = btcByDate.get(time), be = btcByDate.get(time + days * DAY);
    const mature = time + days * DAY <= Date.parse(prices.at(-1)?.observedAt ?? '');
    const returnPct = valid(start) && valid(end) ? (end / start - 1) * 100 : null;
    const btcReturnPct = valid(bs) && valid(be) ? (be / bs - 1) * 100 : null;
    const path = Array.from({ length: days + 1 }, (_, i) => byDate.get(time + i * DAY));
    const maximumAdversePct = path.every(valid) && valid(start) ? Math.min(0, ...path.map(v => (v! / start - 1) * 100)) : null;
    return { days, returnPct, btcReturnPct,
      relativeReturnPct: returnPct !== null && btcReturnPct !== null ? ((1 + returnPct / 100) / (1 + btcReturnPct / 100) - 1) * 100 : null,
      maximumAdversePct, status: returnPct !== null ? 'available' : mature ? 'missing-data' : 'unmatured' };
  }) }));
  return { methodologyVersion: STUDY_METHOD, events, summaries: horizons.map((days, i) => {
    const outcomes = events.map(e => e.horizons[i]);
    const values = outcomes.map(o => o.returnPct).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const relatives = outcomes.map(o => o.relativeReturnPct).filter((v): v is number => v !== null);
    const adverse = outcomes.map(o => o.maximumAdversePct).filter((v): v is number => v !== null);
    const quantile = (q: number) => { if (!values.length) return null; const index = (values.length - 1) * q, low = Math.floor(index); return values[low] + (values[Math.ceil(index)] - values[low]) * (index - low); };
    return { days, eventCount: events.length, sampleCount: values.length, relativeSampleCount: relatives.length, adverseSampleCount: adverse.length,
      missing: outcomes.filter(o => o.status === 'missing-data').length, unmatured: outcomes.filter(o => o.status === 'unmatured').length,
      meanReturnPct: values.length ? mean(values) : null, medianReturnPct: quantile(0.5), p10: quantile(0.1), p90: quantile(0.9),
      negativeReturnRatePct: values.length ? values.filter(v => v < 0).length / values.length * 100 : null,
      meanRelativeReturnPct: relatives.length ? mean(relatives) : null, worstAdversePct: adverse.length ? Math.min(...adverse) : null,
      overlappingPairs: times.reduce((n, t, j) => n + times.slice(j + 1).filter(next => next < t + days * DAY).length, 0) };
  }), limitations: [
    'Historical reconstruction using archived revisions frozen at study creation; past publication availability is not established.',
    'Close-to-close conditional outcomes, not executable strategy returns. No fees, slippage or next execution model.',
    'Maximum adverse movement uses daily closes, requires a complete path, and excludes intraday lows.',
    'Overlapping windows are dependent. Descriptive results have no significance or out-of-sample claim.',
    'Missing endpoints and unmatured events remain unavailable; no forward fill. Failure rate means a negative endpoint return.',
  ] };
}
