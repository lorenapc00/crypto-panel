import type { Pool } from 'pg';
import { readSeries } from '../archive.js';
import { readDiscovery } from '../discovery/archive.js';
import { capitalCatalogId, capitalHistoryId, capitalSeriesId, capitalScope } from '../feeds/capital.js';

const DAY = 86400000;
export const nativeBtcDataset = 'hyperliquid:instruments:native:v1';
export const btcFundingDataset = 'hyperliquid:funding:BTC:v1';
type Snapshot = Awaited<ReturnType<typeof readDiscovery>>;
type Series = Awaited<ReturnType<typeof readSeries>>;
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function evidence(snapshot: Snapshot, observedAt: string | null, present: boolean, now: number, intervalSeconds: number) {
  return { ...snapshot?.metadata, observedAt, acquiredAt: iso(snapshot?.metadata.observedAt),
    unavailable: !present, stale: observedAt === null || now - Date.parse(observedAt) > intervalSeconds * 1000,
    intervalSeconds, replayCoverageStart: iso(snapshot?.metadata.replayCoverageStart),
    classification: snapshot?.metadata.mode ?? 'forward tracking' };
}

export function contextView(input: { sample: Snapshot; funding: Snapshot; capital: Series; catalog: Snapshot; history?: Snapshot; now: string; asOf?: string }) {
  const { sample, funding, capital, catalog } = input;
  const now = Date.parse(input.now), midnight = Math.floor(now / DAY) * DAY;
  // Identity is venue + namespace + instrument, never an unqualified symbol.
  const member = sample?.members.find(m => m.key === JSON.stringify(['hyperliquid', '', 'BTC']) && m.status === 'active');
  const native = member?.data;
  const oi = numeric(native?.openInterestNative), mark = numeric(native?.markPrice);
  const rate = native?.fundingIntervalSeconds === 3600 ? numeric(native?.fundingRate) : null;
  const observedAt = iso(sample?.metadata.observedAt);
  const sampleEvidence = evidence(sample, observedAt, !!native, now, 3600);
  const notional = oi !== null && oi >= 0 && mark !== null && mark > 0 ? numeric(oi * mark) : null;
  const settled = (funding?.members ?? []).map(m => m.data).filter(d => d.venue === 'hyperliquid' && d.namespace === '' && d.coin === 'BTC' && d.intervalSeconds === 3600 && iso(d.observedAt) !== null && Date.parse(d.observedAt) <= now)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).at(-1);
  const settledRate = numeric(settled?.fundingRate);
  const rows = (capital?.points ?? []).filter(p => Date.parse(p.observedAt) < midnight);
  const byTime = new Map(rows.map(p => [Date.parse(p.observedAt), p]));
  // Materialize absent days as null so charts do not bridge acquisition/history gaps.
  const points = rows.length ? Array.from({ length: Math.floor((Date.parse(rows.at(-1)!.observedAt) - Date.parse(rows[0].observedAt)) / DAY) + 1 }, (_, i) => {
    const time = Date.parse(rows[0].observedAt) + i * DAY;
    const point = byTime.get(time), prior = byTime.get(time - 30 * DAY);
    const value = point?.value ?? null, previous = prior?.value ?? null;
    return { ...point, observedAt: new Date(time).toISOString(), value,
      change30dPct: value !== null && previous !== null && previous > 0 ? (value / previous - 1) * 100 : null,
      change30dUsd: value !== null && previous !== null ? value - previous : null,
      comparisonAt: new Date(time - 30 * DAY).toISOString(), comparisonValue: previous };
  }) : [];
  const latest = points.at(-1) ?? null;
  const capitalLast = latest?.observedAt ?? null, valid = rows.filter(p => p.value !== null);
  const catalogEvidence = evidence(catalog, iso(catalog?.metadata.observedAt), !!catalog?.members.length, now, 86400);
  return { data: { venue: { name: 'Hyperliquid native BTC perpetual',
    openInterest: { value: oi, unit: 'BTC', ...sampleEvidence, unavailable: oi === null },
    estimatedNotional: { value: notional,
      markPrice: mark, unit: 'USDT price units', collateral: 'USDC', formula: 'Native OI (BTC) × contemporaneous mark price; counted once; no stablecoin-to-USD conversion', ...sampleEvidence, unavailable: notional === null },
    sampledFunding: { value: rate, unit: 'rate per hour', ...sampleEvidence, unavailable: rate === null },
    settledFunding: { value: settledRate, unit: 'rate per hour', ...evidence(funding, iso(settled?.observedAt), settledRate !== null, now, 7200) },
    interpretation: 'OI measures open exposure on this venue. High OI alone gives no directional signal. Positive funding means longs pay shorts; negative means shorts pay longs. Sampled rates and published settled rates are separate evidence, without annualization or account cash flows.',
    limitations: 'Single native venue market, not market-wide positioning. BTC prices follow the documented USDT convention with USDC collateral; no USD OI or OI/market-cap ratio is inferred. Provider publication time is unknown.',
    sources: ['https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications', 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding'],
  }, capital: { points, latest, coverage: { ...capital?.metadata, source: 'defillama', scope: capitalScope, seriesId: capitalSeriesId,
      first: valid[0]?.observedAt ?? null, last: valid.at(-1)?.observedAt ?? null, values: valid.length,
      missing: points.filter(p => p.value === null).length, observedAt: capitalLast,
      acquiredAt: iso(input.history?.metadata.observedAt), lastRevisionAt: latest?.recordedAt ?? null,
      payloadId: latest?.payloadId ?? null, unavailable: latest?.value == null,
      stale: capitalLast === null || Date.parse(capitalLast) < midnight - DAY,
      classification: 'historical-reconstruction', archiveSelection: input.asOf ? 'point-in-time revisions' : 'latest archived revisions' },
    catalog: { members: catalog?.members.map(m => m.data) ?? [], coverage: catalogEvidence },
    formula: 'DefiLlama totalCirculatingUSD.peggedUSD. 30D change = (value / value exactly 30 UTC days earlier − 1) × 100; absent or zero denominator makes the percentage unavailable.',
    interpretation: 'A capital context proxy for provider-covered USD-pegged supply. Expansion or contraction can reflect coverage, supply and valuation changes; it is not measured net inflow into BTC.',
    limitations: 'Non-USD pegs excluded. Coverage changes over time; historical constituents are unavailable. The separately acquired catalog describes current provider coverage and does not establish the historical denominator. Provider publication time is unknown; historical values may be revised.',
    sources: ['https://api-docs.defillama.com/', 'https://stablecoins.llama.fi/stablecoincharts/all'],
  }, methodologyVersion: 'btc-context:v1' }, metadata: { source: 'Hyperliquid / DefiLlama', observedAt: input.now,
    stale: sampleEvidence.stale || capitalLast === null || Date.parse(capitalLast) < midnight - DAY,
    coverage: 'Independent venue and covered stablecoin context; each input reports freshness and provenance' } };
}

export async function btcContext(database: Pool, asOf?: string) {
  const client = await database.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const now = (await client.query('select clock_timestamp()::text as time')).rows[0].time as string;
    const sample = await readDiscovery(client, nativeBtcDataset, asOf);
    const funding = await readDiscovery(client, btcFundingDataset, asOf);
    const capital = await readSeries(capitalSeriesId, { asOf, limit: 10000 }, client);
    const history = await readDiscovery(client, capitalHistoryId, asOf);
    const catalog = await readDiscovery(client, capitalCatalogId, asOf);
    const result = contextView({ sample, funding, capital, catalog, history, now: asOf ?? now, asOf });
    await client.query('commit');
    return result;
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}
