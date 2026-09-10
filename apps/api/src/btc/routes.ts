import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readSeries } from '../archive.js';
import { btcMetrics, btcSeriesId } from '../feeds/bitcoin.js';
import { dailySeriesId } from '../daily-history.js';
import { body, cutoff, send } from '../http.js';
import { InputError, object, uuid } from '../research/validation.js';
import { BTC_METHOD, DAY, btcTrend, cycleComparisons, type Point } from './calculations.js';
import { signalStudy, STUDY_METHOD } from './study.js';

export async function btcArchive(database: Pool, asOf?: string) {
  const client = await database.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const acquiredAt = (await client.query('select clock_timestamp()::text as time')).rows[0].time as string;
    const series: Awaited<ReturnType<typeof readSeries>>[] = [];
    for (const metric of btcMetrics) series.push(await readSeries(btcSeriesId(metric.code), { asOf, limit: 10000 }, client));
    await client.query('commit');
    return { acquiredAt, series };
  } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
}

export function btcView(archive: Awaited<ReturnType<typeof btcArchive>>, asOf?: string) {
  const { series } = archive;
  const now = Date.parse(asOf ?? archive.acquiredAt);
  const completedBefore = Math.floor(now / DAY) * DAY;
  const points = series.map(s => (s?.points ?? []).filter(p => Date.parse(p.observedAt) < completedBefore));
  const [prices, caps, ratios, supply] = points;
  const maps = [caps, ratios, supply].map(rows => new Map(rows.map(p => [p.observedAt, p.value])));
  const trend = btcTrend(prices).map(p => {
    const cap = maps[0].get(p.observedAt), mvrv = maps[1].get(p.observedAt) ?? null, units = maps[2].get(p.observedAt);
    return { ...p, mvrv, realizedPrice: cap != null && mvrv !== null && units != null && mvrv > 0 && units > 0 ? cap / mvrv / units : null };
  });
  const coverage = series.map((s, i) => {
    const valid = points[i].filter(p => p.value !== null);
    const last = valid.at(-1)?.observedAt ?? null;
    return { metric: btcMetrics[i].code, ...s?.metadata, source: 'coinmetrics', seriesId: btcSeriesId(btcMetrics[i].code),
      first: valid[0]?.observedAt ?? null, last, points: valid.length, missing: points[i].filter(p => p.value === null).length,
      stale: last === null || Date.parse(last) < completedBefore - DAY,
      formula: btcMetrics[i].field, timestamp: 'UTC day label; values for that completed day', license: 'CC BY-NC 4.0' };
  });
  return { data: { points: trend, latest: trend.at(-1) ?? null, cycles: cycleComparisons(prices, ratios), coverage,
    methodology: { version: BTC_METHOD, classification: 'historical-reconstruction', snapshotAsOf: asOf ?? null,
      regime: 'Bullish: close > SMA200 and SMA200 > its value 20 days earlier. Bearish: both reverse. Otherwise transitional. Three consecutive daily candidates confirm any change; gaps reset confirmation.',
      weekly: 'Completed Monday–Sunday UTC weeks; require seven daily prices. SMA20/200, seeded EMA21 and Wilder RSI14. The latest completed week carries through the current week.',
      valuation: 'Mayer = close / SMA200. MVRV = CapMrktCurUSD / CapRealUSD. Derived realized price = (CapMrktCurUSD / CapMVRVCur) / SplyCur on matching dates. These valuation views share inputs.',
      risk: 'Volatility: sample standard deviation of 30/90 daily log returns × sqrt(365). Drawdown uses the running maximum within observed coverage. Recovery duration is unavailable across gaps.',
      cycles: 'Halving-day close = 100, ending before the next halving. About three completed comparable cycles: illustration, not statistical inference or a price target.',
      replay: 'A cutoff selects archived revisions known then. Historical chart labels are reconstructed; they do not prove signal availability on those dates.',
      sources: ['https://raw.githubusercontent.com/coinmetrics/docs-website/master/asset-metrics/market/priceusd.md', 'https://raw.githubusercontent.com/coinmetrics/docs-website/master/asset-metrics/market/capmvrvcur.md', 'https://bitcoin.org/en/halving'],
    } }, metadata: { source: 'Coin Metrics Community', observedAt: coverage[0].last, stale: coverage[0].stale,
      unavailable: !coverage[0].points, coverage: 'BTC daily USD closes · historical reconstruction · CC BY-NC 4.0' } };
}

export async function createSignalStudy(database: Pool, input: unknown) {
  const options = object(input);
  if (Object.keys(options).some(k => !['assetId', 'signal', 'from', 'to', 'eventDates'].includes(k))) throw new InputError('Unsupported study option; historical reconstruction only');
  const assetId = options.assetId ?? 'bitcoin';
  if (!['bitcoin', 'ethereum', 'solana', 'hyperliquid'].includes(String(assetId))) throw new InputError('Asset history is outside this study scope');
  const signal = options.signal ?? 'bullish';
  if (!['bullish', 'bearish', 'transitional', 'custom'].includes(String(signal))) throw new InputError('Unsupported signal');
  if (assetId !== 'bitcoin' && signal !== 'custom') throw new InputError('Other assets require custom event dates');
  const date = (v: unknown) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) throw new InputError('Expected a calendar date (YYYY-MM-DD)');
    return v;
  };
  const from = options.from === undefined ? undefined : date(options.from), to = options.to === undefined ? undefined : date(options.to);
  if (from && to && from > to) throw new InputError('Study start must precede its end');
  let custom: string[] | undefined;
  if (signal === 'custom') {
    if (!Array.isArray(options.eventDates) || !options.eventDates.length || options.eventDates.length > 1000) throw new InputError('Provide 1–1000 event dates');
    custom = options.eventDates.map(date);
  } else if (options.eventDates !== undefined) throw new InputError('Event dates require a custom study');
  const archive = await btcArchive(database);
  const view = btcView(archive);
  let dataset = archive.series[0], benchmarkDataset = dataset;
  if (assetId !== 'bitcoin') {
    const client = await database.connect();
    try {
      await client.query('begin isolation level repeatable read read only');
      // Both sides are CoinGecko daily samples at the same UTC instant. Never
      // compare them with Coin Metrics' differently labeled end-of-day price.
      dataset = await readSeries(dailySeriesId(String(assetId)), { limit: 10000 }, client);
      benchmarkDataset = await readSeries(dailySeriesId('bitcoin'), { limit: 10000 }, client);
      await client.query('commit');
    } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
  }
  if (!dataset?.points.length || !benchmarkDataset?.points.length) throw new InputError('Asset and benchmark histories must both be acquired', 409);
  const points: Point[] = dataset.points, benchmark: Point[] = benchmarkDataset.points;
  // Only confirmed transitions after an established baseline emit automatic study events.
  const eventDates = (custom ?? view.data.points.filter((p, i, rows) => i > 0 && p.regime === signal && rows[i - 1].regime !== p.regime && rows[i - 1].regime !== 'insufficient-history').map(p => p.observedAt.slice(0, 10)))
    .filter(d => (!from || d >= from) && (!to || d <= to));
  const result = signalStudy(points, benchmark, eventDates);
  const timestampConvention = assetId === 'bitcoin' ? 'Coin Metrics end-of-day close labeled by UTC day' : 'Aligned CoinGecko daily price samples at UTC midnight; not OHLC closes';
  if (assetId !== 'bitcoin') result.limitations[1] = 'Daily sampled-price conditional outcomes, not executable strategy returns. No fees, slippage or next execution model.';
  if (assetId !== 'bitcoin') result.limitations[2] = 'Maximum adverse movement uses daily samples, requires a complete path, and excludes intraday lows.';
  const frozen = { signal, from: from ?? null, to: to ?? null, eventDates: result.events.map(e => e.date),
    dataset, benchmarkDataset, timestampConvention, signalVersion: BTC_METHOD, methodologyVersion: STUDY_METHOD,
    asset: assetId, benchmark: 'bitcoin', classification: 'historical-reconstruction' };
  const hash = createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
  const runId = randomUUID();
  const stored = (await database.query(`insert into signal_studies (id,methodology_version,input_hash,input,result)
    values ($1,$2,$3,$4,$5) returning id,created_at,input_hash`, [runId, STUDY_METHOD, hash, frozen, result])).rows[0];
  return { ...stored, result, signal, asset: assetId, classification: 'historical-reconstruction', timestampConvention,
    benchmark: 'BTC; relative return is zero when BTC is compared with itself' };
}

export async function btcRoute(database: Pool, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!url.pathname.startsWith('/api/v1/btc/') && !url.pathname.startsWith('/api/v1/signal-studies')) return false;
  if (url.pathname === '/api/v1/btc/cycles') {
    if (req.method !== 'GET') { send(res, 405, { error: 'Method not allowed' }); return true; }
    const asOf = cutoff(url.searchParams.get('asOf'));
    send(res, 200, btcView(await btcArchive(database, asOf), asOf)); return true;
  }
  if (url.pathname === '/api/v1/signal-studies' && req.method === 'POST') {
    if (url.search) throw new InputError('Study options belong in the request body; replay is unavailable');
    send(res, 201, { data: await createSignalStudy(database, await body(req)) }); return true;
  }
  const match = url.pathname.match(/^\/api\/v1\/signal-studies\/([^/]+)$/);
  if (match && req.method === 'GET') {
    if (url.search) throw new InputError('Saved studies are immutable snapshots; replay parameters are unsupported');
    const row = (await database.query('select * from signal_studies where id=$1', [uuid(match[1])])).rows[0];
    send(res, row ? 200 : 404, row ? { data: row } : { error: 'Study not found' }); return true;
  }
  send(res, 405, { error: 'Method not allowed' }); return true;
}
