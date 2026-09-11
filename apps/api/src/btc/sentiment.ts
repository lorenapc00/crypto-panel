import type { Pool } from 'pg';
import { readSeries } from '../archive.js';
import { fearGreedSeriesId } from '../feeds/sentiment.js';
import { halvings, DAY } from './calculations.js';

export const SENTIMENT_METHOD = 'fear-greed-cycles:v1';

/** Halving-day segmentation, mirroring `cycleComparisons` but with no anchor price:
 *  the indicator has its own 0-100 scale, not a price to index. */
export function sentimentCycles(points: { observedAt: string; value: number | null }[]) {
  return halvings.map((halving, i) => {
    const start = Date.parse(halving.date), end = i + 1 < halvings.length ? Date.parse(halvings[i + 1].date) : Infinity;
    return { ...halving, points: points.filter(p => Date.parse(p.observedAt) >= start && Date.parse(p.observedAt) < end)
      .map(p => ({ day: (Date.parse(p.observedAt) - start) / DAY, date: p.observedAt, value: p.value })) };
  });
}

export async function sentimentView(database: Pool, asOf?: string) {
  const series = await readSeries(fearGreedSeriesId, { asOf, limit: 10000 }, database);
  const points = series?.points ?? [];
  const valid = points.filter(p => p.value !== null);
  const latest = valid.at(-1) ?? null;
  return {
    data: {
      points, cycles: sentimentCycles(points), latest,
      methodology: {
        version: SENTIMENT_METHOD,
        formula: 'Alternative.me composite crypto Fear & Greed Index, 0 (extreme fear) to 100 (extreme greed). The provider\'s weighting across volatility, momentum/volume, social media, dominance and trends inputs is not independently verified here.',
        coverage: 'This archive\'s daily acquisition begins its production replay coverage; the provider\'s published history back to 2018-02-01 is historical reconstruction, not proof the value was available on that date.',
        cycles: 'Segmented by halving date like the price and MVRV cycle charts. The 2012 and 2016 halving cycles predate the provider\'s 2018-02-01 published history and show no data, or only their later days.',
        sources: ['https://alternative.me/crypto/fear-and-greed-index/'],
      },
      coverage: {
        source: 'alternative-me', seriesId: fearGreedSeriesId,
        first: valid[0]?.observedAt ?? null, last: latest?.observedAt ?? null,
        values: valid.length, missing: points.length - valid.length,
        replayCoverageStart: series?.metadata.replayCoverageStart ?? null,
        classification: series?.metadata.classification ?? 'historical-reconstruction',
      },
    },
    metadata: {
      source: 'Alternative.me', observedAt: latest?.observedAt ?? null,
      stale: !latest || Date.now() - Date.parse(latest.observedAt) > 2 * DAY,
      unavailable: !latest,
      coverage: 'Crypto Fear & Greed Index; attribution required next to displayed values',
    },
  };
}
