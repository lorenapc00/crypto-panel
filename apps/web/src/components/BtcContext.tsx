import { useMemo } from 'react';
import { useData } from '../api';
import { ResearchChart } from './ResearchChart';
import { MetricCard, evidenceDate as date, status, type Evidence } from './Evidence';

type Metric = Evidence & { value: number | null; unit: string };
type CapitalPoint = { observedAt: string; value: number | null; change30dPct: number | null; change30dUsd: number | null;
  comparisonAt: string; comparisonValue: number | null; payloadId?: string };
type Context = { venue: { name: string; openInterest: Metric; estimatedNotional: Metric & { markPrice: number | null; formula: string };
  sampledFunding: Metric; settledFunding: Metric; interpretation: string; limitations: string; sources: string[] };
  capital: { points: CapitalPoint[]; latest: CapitalPoint | null; coverage: Evidence & { first: string | null; last: string | null; values: number; missing: number };
    catalog: { members: { id: string; name: string; symbol: string; chains: string[]; circulatingNative: number | null; priceUsd: number | null }[]; coverage: Evidence };
    formula: string; interpretation: string; limitations: string; sources: string[] } };
const number = (v: number | null | undefined, digits = 2) => v == null ? 'Unavailable' : v.toLocaleString('en-US', { maximumFractionDigits: digits });

export function BtcContext({ range }: { range: string }) {
  const { result, loading, error, reload } = useData<Context>('/btc/context');
  const data = result?.data;
  const chart = useMemo(() => {
    const rows = data?.capital.points ?? [], last = Date.parse(rows.at(-1)?.observedAt ?? '');
    const days = range === '30D' ? 30 : range === '90D' ? 90 : range === '1Y' ? 365 : Infinity;
    const visible = rows.filter(p => Date.parse(p.observedAt) >= last - (days - 1) * 86400000);
    return { x: visible.map(p => Date.parse(p.observedAt) / 1000), lines: [{ label: 'Covered USD-pegged supply (USD)', color: '#70bca6', values: visible.map(p => p.value) }] };
  }, [data, range]);
  if (loading) return <p>Loading venue and capital context…</p>;
  if (error || !data) return <section className="panel btc-method"><p role="alert">Venue and capital context could not load. <button onClick={reload}>Retry context</button></p></section>;
  const { venue, capital } = data, last = capital.latest;
  const funding = (m: Metric) => m.value === null ? 'Unavailable' : `${number(m.value * 100, 6)}% / hour`;
  return <div className="btc-context">
    <section className="panel btc-method" aria-label="BTC venue leverage"><div className="panelhead"><div><h2>Venue leverage</h2><span>{venue.name} · Hourly archive</span></div></div>
      <div className="context-grid">
        <MetricCard defaultSource="Hyperliquid" title="Native open interest" metric={venue.openInterest} value={venue.openInterest.value === null ? 'Unavailable' : `${number(venue.openInterest.value)} BTC`} formula="One underlying BTC unit per contract; native OI is counted once. No inference of directional conviction." />
        <MetricCard defaultSource="Hyperliquid" title="Estimated OI notional" metric={venue.estimatedNotional} value={venue.estimatedNotional.value === null ? 'Unavailable' : `${number(venue.estimatedNotional.value)} USDT price units`} formula={`${venue.estimatedNotional.formula}. Mark: ${number(venue.estimatedNotional.markPrice)}; collateral: USDC.`} />
        <MetricCard defaultSource="Hyperliquid" title="Sampled funding" metric={venue.sampledFunding} value={funding(venue.sampledFunding)} formula="Current hourly rate sampled with the instrument context; may change before settlement. Positive: longs pay shorts. Negative: shorts pay longs." />
        <MetricCard defaultSource="Hyperliquid" title="Latest settled funding" metric={venue.settledFunding} value={funding(venue.settledFunding)} formula="Latest published hourly funding event in the archived two-hour window; actual event timestamp retained. This is a rate, not an account payment." />
      </div><p>{venue.interpretation}</p><p>{venue.limitations} <a href={venue.sources[0]} target="_blank" rel="noreferrer">Contract specification</a> · <a href={venue.sources[1]} target="_blank" rel="noreferrer">Funding definition</a></p>
    </section>
    <section className="panel btc-method" aria-label="BTC capital context"><div className="panelhead"><div><h2>Capital context</h2><span>DefiLlama · Covered USD-pegged stablecoins</span></div></div>
      <div className="context-grid">
        <MetricCard defaultSource="Hyperliquid" title="Covered circulating supply" metric={capital.coverage} value={last?.value == null ? 'Unavailable' : `$${number(last.value)}`} formula={capital.formula} />
        <MetricCard defaultSource="Hyperliquid" title="30D supply change" metric={{ ...capital.coverage, unavailable: last?.change30dPct == null }} value={last?.change30dPct == null ? 'Unavailable' : `${number(last.change30dPct)}%`} formula={`Compared with ${date(last?.comparisonAt)}: $${number(last?.comparisonValue)}. Absolute change: ${last?.change30dUsd == null ? 'Unavailable' : `$${number(last.change30dUsd)}`}. Exact calendar endpoints; no forward fill.`} />
      </div><p>{capital.interpretation}</p><p>{capital.limitations}</p>
      <details><summary>Stablecoin coverage and methodology</summary><p>{capital.formula}</p>
        <p>Populated history: {capital.coverage.first?.slice(0, 10) ?? 'Unavailable'} – {capital.coverage.last?.slice(0, 10) ?? 'Unavailable'} UTC · {capital.coverage.values} values · {capital.coverage.missing} missing days. Historical reconstruction; latest archived revisions. <a href={capital.sources[0]} target="_blank" rel="noreferrer">DefiLlama API definitions</a></p>
        <p>Current catalog: {capital.catalog.members.length} covered USD-pegged assets · {status(capital.catalog.coverage)} · Acquired {date(capital.catalog.coverage.acquiredAt)} · Replay starts {date(capital.catalog.coverage.replayCoverageStart)}. Catalog supply is in native units; it is not summed into the historical USD aggregate.</p>
        <div className="btc-table-wrap"><table><thead><tr><th>Provider asset</th><th>Symbol</th><th>Chains</th><th>Circulating units</th><th>USD price</th></tr></thead><tbody>{capital.catalog.members.map(m => <tr key={m.id}><td>{m.name} ({m.id})</td><td>{m.symbol}</td><td>{m.chains.join(', ') || 'Unavailable'}</td><td>{number(m.circulatingNative)}</td><td>{number(m.priceUsd, 6)}</td></tr>)}</tbody></table></div>
      </details>
    </section>
    <ResearchChart title="Covered USD-pegged stablecoin supply (USD)" x={chart.x} lines={chart.lines} height={250} attribution="DefiLlama · Covered USD-pegged assets · Historical reconstruction" />
  </div>;
}
