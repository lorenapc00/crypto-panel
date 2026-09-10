import { useEffect, useMemo, useState } from 'react';
import { api, useData } from '../api';
import { ResearchChart } from '../components/ResearchChart';
import { BtcContext } from '../components/BtcContext';

type Point = { observedAt: string; value: number | null; sma50: number | null; sma200: number | null;
  sma20w: number | null; ema21w: number | null; sma200w: number | null; weeklyRsi: number | null;
  mayerMultiple: number | null; mvrv: number | null; realizedPrice: number | null; drawdownPct: number | null;
  daysUnderwater: number | null; recoveryDays: number | null; volatility30d: number | null; volatility90d: number | null;
  regime: string; candidate: string; confirmationDays: number; sma200Slope20d: number | null };
type Cycle = { date: string; anchorPrice: number | null; points: { day: number; indexedPrice: number | null; mvrv: number | null }[] };
type Btc = { points: Point[]; latest: Point | null; cycles: Cycle[];
  coverage: { metric: string; source: string; first: string | null; last: string | null; points: number; stale: boolean; formula: string; replayCoverageStart?: string | null }[];
  methodology: { version: string; regime: string; weekly: string; valuation: string; risk: string; cycles: string; replay: string; sources: string[] } };
const colors = ['#e8ba68', '#71bcdf', '#b399e2', '#70bca6', '#ce879b', '#aeb5c1', '#82a8ff'];
const num = (v: number | null | undefined, suffix = '') => v == null ? 'Unavailable' : `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;
const usd = (v: number | null | undefined) => v == null ? 'Unavailable' : `$${num(v)}`;

export function BtcCycles() {
  const { result, loading, error, reload } = useData<Btc>('/btc/cycles');
  const [range, setRange] = useState('All'), [log, setLog] = useState(true), [settingsReady, setSettingsReady] = useState(false), [saveError, setSaveError] = useState('');
  useEffect(() => { void api<{ preferences: Record<string, { range: string; log: boolean }> }>('/workspace').then(r => {
    const setting = r.data.preferences['btc-chart']; if (setting) { setRange(setting.range); setLog(setting.log); }
  }).catch(() => {}).finally(() => setSettingsReady(true)); }, []);
  const setting = (r: string, l: boolean) => { setRange(r); setLog(l); setSaveError(''); void api('/research/preferences/btc-chart', { method: 'PUT', body: JSON.stringify({ range: r, log: l }) }).catch(() => setSaveError('Unable to save chart settings.')); };
  const d = result?.data;
  const charts = useMemo(() => {
    if (!d) return null;
    const last = Date.parse(d.points.at(-1)?.observedAt ?? ''), days = range === '30D' ? 30 : range === '90D' ? 90 : range === '1Y' ? 365 : 10000;
    const rows = d.points.filter(p => Date.parse(p.observedAt) >= last - (days - 1) * 86400000), x = rows.map(p => Date.parse(p.observedAt) / 1000);
    const priceFields = ['value', 'sma50', 'sma200', 'sma20w', 'ema21w', 'sma200w', 'realizedPrice'] as const;
    const labels = ['BTC USD close', '50D SMA', '200D SMA', '20W SMA', '21W EMA', '200W SMA', 'Derived realized price'];
    const priceLines = priceFields.map((field, i) => ({ label: labels[i], color: colors[i], values: rows.map(p => p[field]) }));
    const bands: { from: number; to: number; color: string }[] = [];
    rows.forEach((p, i) => { const color = p.regime === 'bullish' ? '#58b39316' : p.regime === 'bearish' ? '#e17f8718' : '#a6aebb09';
      const prev = bands.at(-1); if (prev?.color === color) prev.to = x[i] + 86400; else bands.push({ from: x[i], to: x[i] + 86400, color }); });
    const annotations = d.cycles.map(c => ({ x: Date.parse(c.date) / 1000, label: `${c.date.slice(0, 4)} halving` }));
    const cycleX = Array.from({ length: Math.max(0, ...d.cycles.map(c => (c.points.at(-1)?.day ?? -1) + 1)) }, (_, i) => i);
    const cycleLines = (field: 'indexedPrice' | 'mvrv') => d.cycles.map((c, i) => { const byDay = new Map(c.points.map(p => [p.day, p[field]])); return { label: c.date, color: colors[i], values: cycleX.map(day => byDay.get(day) ?? null) }; });
    return { x, priceLines, bands, annotations, drawdown: [{ label: 'Drawdown %', color: colors[4], values: rows.map(p => p.drawdownPct) }],
      mvrv: [{ label: 'MVRV', color: colors[2], values: rows.map(p => p.mvrv) }], cycleX, cyclePrice: cycleLines('indexedPrice'), cycleMvrv: cycleLines('mvrv') };
  }, [d, range]);
  if (loading) return <p>Loading archived BTC research…</p>;
  if (error || !result || !d || !charts) return <><p role="alert">Unable to load BTC research. <button onClick={reload}>Try again</button></p><BtcContext range={range} /></>;
  if (!d.latest) return <><section className="panel btc-empty"><h2>BTC history is awaiting acquisition</h2><p>The scheduled Coin Metrics feed has not archived completed daily prices yet. Data Health shows its acquisition status.</p><a href="#data-health">Open Data Health</a></section><BtcContext range={range} /></>;
  const last = d.latest;
  const kpis = [
    ['Completed daily close', usd(last.value)], ['Regime', last.regime.replaceAll('-', ' ')], ['Mayer Multiple', num(last.mayerMultiple, '×')],
    ['Coin Metrics MVRV', num(last.mvrv, '×')], ['Drawdown from observed ATH', num(last.drawdownPct, '%')], ['Days below observed ATH', num(last.daysUnderwater)],
    ['30D realized volatility', num(last.volatility30d, '%')], ['90D realized volatility', num(last.volatility90d, '%')], ['Weekly Wilder RSI', num(last.weeklyRsi)],
  ];
  return <div className="btc-workspace">
    <div className="btc-intro"><div><span className="eyebrow">BTC / DAILY & WEEKLY</span><h2>Trend and cycle evidence</h2><p>Historical reconstruction · {d.coverage[0].first?.slice(0, 10)} – {d.coverage[0].last?.slice(0, 10)} UTC</p></div><a href="#data-health">Inspect Data Health →</a></div>
    <div className={`status ${result.metadata.stale ? 'stale' : ''}`}><span>Coin Metrics Community · CC BY-NC 4.0</span><span>Price day: {result.metadata.observedAt?.slice(0, 10)} UTC (end of day)</span><span>{result.metadata.stale ? 'STALE / UNAVAILABLE' : 'LATEST COMPLETED PRICE'}</span></div>
    <section className="btc-kpis">{kpis.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
    <p className="regime-evidence">Candidate: {last.candidate.replaceAll('-', ' ')} · Confirmation: {last.confirmationDays}/3 · 200D SMA: {usd(last.sma200)} · 20-day SMA change: {usd(last.sma200Slope20d)}. Valuation is separate evidence.</p>
    <div className="btc-controls" aria-label="BTC chart settings">{['30D', '90D', '1Y', 'All'].map(r => <button disabled={!settingsReady} className={range === r ? 'active' : ''} key={r} onClick={() => setting(r, log)}>{r}</button>)}<label><input type="checkbox" checked={log} disabled={!settingsReady} onChange={e => setting(range, e.target.checked)} />Log price scale</label></div>
    {saveError && <p role="alert">{saveError}</p>}
    <ResearchChart title="BTC price and long-term averages" x={charts.x} lines={charts.priceLines} log={log} bands={charts.bands} annotations={charts.annotations} syncKey="btc-time" height={360} />
    <p className="regime-key">Shading: green = bullish · red = bearish · neutral = transitional / insufficient history. Daily price represents the end of the labeled UTC day.</p>
    <ResearchChart title="Drawdown from observed ATH (%)" x={charts.x} lines={charts.drawdown} syncKey="btc-time" height={210} />
    <ResearchChart title="Coin Metrics MVRV" x={charts.x} lines={charts.mvrv} syncKey="btc-time" height={230} />
    <BtcContext range={range} />
    <div className="btc-cycle-heading"><h2>Halving comparisons</h2><p>{d.methodology.cycles} <a href="https://bitcoin.org/en/halving" target="_blank" rel="noreferrer">Halving dates</a></p></div>
    <ResearchChart title="Cycle price · halving-day close = 100" x={charts.cycleX} lines={charts.cyclePrice} time={false} log={log} syncKey="btc-cycles" />
    <ResearchChart title="MVRV at equivalent cycle stages" x={charts.cycleX} lines={charts.cycleMvrv} time={false} syncKey="btc-cycles" height={230} />
    <p className="btc-cycle-heading"><a href="#backtest">Signal studies and strategy backtests moved to Backtest Lab &rarr;</a></p>
    <section className="panel btc-method"><details><summary>Formulas, sources and coverage</summary><p>{d.methodology.regime}</p><p>{d.methodology.weekly}</p><p>{d.methodology.valuation}</p><p>{d.methodology.risk}</p><p>{d.methodology.replay}</p>
      <div className="btc-table-wrap"><table><thead><tr><th>Source metric</th><th>Populated dates</th><th>Values</th><th>Freshness</th><th>Archive replay starts</th></tr></thead><tbody>{d.coverage.map(c => <tr key={c.metric}><td>{c.formula}</td><td>{c.first?.slice(0, 10) ?? 'Unavailable'} – {c.last?.slice(0, 10) ?? 'Unavailable'}</td><td>{c.points}</td><td>{c.stale ? 'Stale / unavailable' : 'Current'}</td><td>{c.replayCoverageStart ?? 'Unavailable'}</td></tr>)}</tbody></table></div>
      <p>Coin Metrics Community · CC BY-NC 4.0 · {d.methodology.version}. <a href={d.methodology.sources[0]} target="_blank" rel="noreferrer">Daily price definition</a> · <a href={d.methodology.sources[1]} target="_blank" rel="noreferrer">MVRV definition</a></p>
    </details></section>
  </div>;
}
