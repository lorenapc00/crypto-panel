import { useEffect, useState } from 'react';
import { api } from '../api';
import { download } from './ResearchChart';

type Summary = { days: number; eventCount: number; sampleCount: number; relativeSampleCount: number; adverseSampleCount: number;
  meanReturnPct: number | null; medianReturnPct: number | null; p10: number | null; p90: number | null;
  negativeReturnRatePct: number | null; meanRelativeReturnPct: number | null; worstAdversePct: number | null;
  missing: number; unmatured: number; overlappingPairs: number };
type Study = { id: string; input_hash: string; asset?: string; signal?: string; timestampConvention?: string;
  input?: { asset: string; signal: string; timestampConvention: string };
  result: { summaries: Summary[]; limitations: string[]; events: { date: string; horizons: { days: number; returnPct: number | null; maximumAdversePct: number | null }[] }[] } };

const num = (v: number | null | undefined, suffix = '') => v == null ? 'Unavailable' : `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;

export function SignalStudy() {
  const [signal, setSignal] = useState('bullish'), [from, setFrom] = useState(''), [to, setTo] = useState(''), [dates, setDates] = useState('');
  const [assetId, setAssetId] = useState('bitcoin');
  const [study, setStudy] = useState<Study>(), [error, setError] = useState(''), [running, setRunning] = useState(false);
  const [runId, setRunId] = useState(() => new URLSearchParams(location.hash.split('?')[1]).get('study') ?? '');
  const load = async (id: string) => { setError(''); try { setStudy((await api<Study>(`/signal-studies/${encodeURIComponent(id)}`)).data); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { if (runId) void load(runId); }, []);
  const run = async () => {
    setRunning(true); setError('');
    try { const result = await api<Study>('/signal-studies', { method: 'POST', body: JSON.stringify({ assetId, signal, ...(from ? { from } : {}), ...(to ? { to } : {}),
      ...(signal === 'custom' ? { eventDates: dates.split(/[\s,]+/).filter(Boolean) } : {}) }) });
      setStudy(result.data); setRunId(result.data.id); history.replaceState(null, '', `#backtest?study=${result.data.id}`);
    } catch (e) { setError((e as Error).message); } finally { setRunning(false); }
  };
  return <section className="panel btc-study"><div className="panelhead"><div><h2>Signal study</h2><span>Historical reconstruction · Event dates to forward returns</span></div></div>
    <p>Study BTC regime changes or custom event dates for four archived assets. BTC uses Coin Metrics daily closes; other assets use matching CoinGecko daily samples for the asset and BTC benchmark. BTC-relative returns are zero when BTC is compared with itself. These descriptive outcomes exclude costs and execution.</p>
    <form className="btc-controls" onSubmit={e => { e.preventDefault(); void run(); }}>
      <label>Study asset<select aria-label="Study asset" value={assetId} onChange={e => { setAssetId(e.target.value); if (e.target.value !== 'bitcoin') setSignal('custom'); }}><option value="bitcoin">BTC</option><option value="ethereum">ETH</option><option value="solana">SOL</option><option value="hyperliquid">HYPE</option></select></label>
      <label>Signal<select aria-label="Signal" value={signal} onChange={e => setSignal(e.target.value)}><option disabled={assetId !== 'bitcoin'} value="bullish">Confirmed bullish transition</option><option disabled={assetId !== 'bitcoin'} value="bearish">Confirmed bearish transition</option><option disabled={assetId !== 'bitcoin'} value="transitional">Confirmed transitional regime</option><option value="custom">Custom event dates</option></select></label>
      <label>Events from<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>Events through<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
      {signal === 'custom' && <label>Event dates<input value={dates} placeholder="2020-05-11, 2024-04-20" onChange={e => setDates(e.target.value)} required /></label>}
      <button disabled={running}>{running ? 'Computing…' : 'Run study'}</button>
    </form>
    <form className="btc-controls" onSubmit={e => { e.preventDefault(); void load(runId); }}><label>Saved study ID<input value={runId} onChange={e => setRunId(e.target.value)} required /></label><button>Load saved study</button></form>
    {error && <p role="alert">{error}</p>}
    {study && <><p className="study-identity">Saved study {study.id} · Immutable inputs and results <button onClick={() => { void api(`/signal-studies/${study.id}`).then(r => download(`btc-study-${study.id}.json`, JSON.stringify(r.data, null, 2))).catch(e => setError(e.message)); }}>Export study JSON</button></p>
      <p>{study.input?.asset ?? study.asset} / BTC · Signal: {study.input?.signal ?? study.signal} · {study.input?.timestampConvention ?? study.timestampConvention}</p>
      {!study.result.events.length && <p>No confirmed transitions in this date range. The initial regime baseline does not create an event.</p>}
      <div className="btc-table-wrap"><table><thead><tr>{['Horizon', 'Samples / events', 'Mean', 'Median', '10th–90th percentile', 'Negative returns', 'BTC-relative', 'Worst adverse / n', 'Missing / immature', 'Overlapping pairs'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>
        {study.result.summaries.map(s => <tr key={s.days}><td>{s.days}D</td><td>{s.sampleCount} / {s.eventCount}</td><td>{num(s.meanReturnPct, '%')}</td><td>{num(s.medianReturnPct, '%')}</td><td>{num(s.p10, '%')} – {num(s.p90, '%')}</td><td>{num(s.negativeReturnRatePct, '%')}</td><td>{num(s.meanRelativeReturnPct, '%')} (n={s.relativeSampleCount})</td><td>{num(s.worstAdversePct, '%')} / {s.adverseSampleCount}</td><td>{s.missing} / {s.unmatured}</td><td>{s.overlappingPairs}</td></tr>)}
      </tbody></table></div>
      <details><summary>Individual event outcomes and limitations</summary><ul>{study.result.limitations.map(l => <li key={l}>{l}</li>)}</ul><div className="btc-table-wrap"><table><thead><tr><th>Event UTC day</th>{[1, 7, 30, 90, 180, 365].map(n => <th key={n}>{n}D return / adverse</th>)}</tr></thead><tbody>{study.result.events.map(e => <tr key={e.date}><td>{e.date.slice(0, 10)}</td>{e.horizons.map(h => <td key={h.days}>{num(h.returnPct, '%')} / {num(h.maximumAdversePct, '%')}</td>)}</tr>)}</tbody></table></div></details>
    </>}
  </section>;
}
