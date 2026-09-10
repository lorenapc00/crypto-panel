import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useData } from '../api';
import { ResearchChart, download } from '../components/ResearchChart';
import { SignalStudy } from '../components/SignalStudy';

type Stats = { days: number; totalReturnPct: number | null; cagrPct: number | null; volatilityPct: number | null;
  sharpe: number | null; sortino: number | null; maxDrawdownPct: number | null; openDrawdown: boolean };
type RunResult = {
  methodologyVersion: string;
  window: { from: string; to: string; tradingDays: number; returnDays: number; missingCloseDays: number; years: number | null };
  params: { activeRegimes: string; from: string | null; to: string | null; holdoutPct: number; costBps: number };
  strategy: { stats: Stats };
  benchmark: { label: string; stats: Stats };
  holdout: { splitDate: string; holdoutPct: number; note: string;
    inSample: { strategy: Stats; benchmark: Stats }; outOfSample: { strategy: Stats; benchmark: Stats } };
  trades: { entries: number; exits: number; total: number; turnoverPerYear: number | null; exposurePct: number | null };
  costSensitivity: { costBps: number; cagrPct: number | null; totalReturnPct: number | null; sharpe: number | null; maxDrawdownPct: number | null }[];
  equity: { dates: number[]; strategy: number[]; benchmark: number[] };
  limitations: string[];
  warnings?: string[];
  dataset: { seriesId: string; source: string; replayCoverageStart: string | null; firstObservedAt: string | null; lastObservedAt: string | null; completedPrices: number; classification: string };
  generatedAt: string;
};
type Run = { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; result: RunResult | null; error: string | null;
  input_hash?: string; inputHash?: string; created_at?: string; reproduced?: boolean };
type Template = { key: string; label: string; summary: string; methodologyVersion: string; status: 'available' | 'deferred'; gate: string | null };
type TemplatesResponse = { templates: Template[];
  coverage: { note: string; series: { id: string; source: string; metric: string; replayCoverageStart: string | null; classification: string }[];
    datasets: { id: string; provider: string; replayCoverageStart: string | null; classification: string }[] } };
type Replay = { asOf: string; classification: string;
  marketOverview: { regime: string; trackedAssets: number | null } | null;
  emerging: { tracked: number | null; eligible: number | null } | null;
  spotLaunches: { tokens: number | null; shortlisted: number | null } | null;
  perpProjects: { matched: number | null; coveredOpenInterestProtocols: number | null } | null;
  perpListings: { matched: number | null } | null;
  refusals: { workspace: string; message: string }[]; note: string };

const pct = (v: number | null | undefined, digits = 2) => v == null ? 'Unavailable' : `${v.toFixed(digits)}%`;
const ratio = (v: number | null | undefined) => v == null ? 'Unavailable' : v.toFixed(2);
const STAT_ROWS: [string, keyof Stats, (v: number | null) => string][] = [
  ['Total return', 'totalReturnPct', v => pct(v)], ['CAGR', 'cagrPct', v => pct(v)],
  ['Realized volatility', 'volatilityPct', v => pct(v)], ['Sharpe (rf 0%)', 'sharpe', ratio],
  ['Sortino (rf 0%)', 'sortino', ratio], ['Max drawdown', 'maxDrawdownPct', v => pct(v)],
];

function StatTable({ strategy, benchmark }: { strategy: Stats; benchmark: Stats }) {
  return <div className="btc-table-wrap"><table><thead><tr><th>Metric</th><th>Regime filter</th><th>BTC buy-and-hold</th></tr></thead><tbody>
    {STAT_ROWS.map(([label, key, format]) => <tr key={label}><td>{label}</td><td>{format(strategy[key] as number | null)}</td><td>{format(benchmark[key] as number | null)}</td></tr>)}
  </tbody></table></div>;
}

function StrategyTest() {
  const { result: templatesApi } = useData<TemplatesResponse>('/backtest/templates');
  const templates = templatesApi?.data.templates ?? [];
  const coverage = templatesApi?.data.coverage;
  const [templateKey, setTemplateKey] = useState('btc-regime-filter');
  const [activeRegimes, setActiveRegimes] = useState('bullish');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [holdoutPct, setHoldoutPct] = useState(30), [costBps, setCostBps] = useState(25);
  const [run, setRun] = useState<Run>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const poll = (id: string) => {
    timer.current = setTimeout(async () => {
      try {
        const next = (await api<Run>(`/backtest/runs/${id}`)).data;
        setRun(next);
        if (next.status === 'queued' || next.status === 'running') poll(id);
        else setBusy(false);
      } catch (e) { setError((e as Error).message); setBusy(false); }
    }, 1200);
  };
  const start = async () => {
    setBusy(true); setError(''); setRun(undefined);
    try {
      const params = { activeRegimes, ...(from ? { from } : {}), ...(to ? { to } : {}), holdoutPct, costBps };
      const created = (await api<Run>('/backtest/runs', { method: 'POST', body: JSON.stringify({ templateKey, params }) })).data;
      if (created.status === 'succeeded') { setRun(created); setBusy(false); }
      else { setRun(created); poll(created.id); }
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  const equity = useMemo(() => {
    const r = run?.result;
    if (!r) return null;
    return { x: r.equity.dates, lines: [
      { label: 'Regime filter (start = 100)', color: '#71bcdf', values: r.equity.strategy },
      { label: 'BTC buy-and-hold', color: '#e8ba68', values: r.equity.benchmark },
    ] };
  }, [run]);
  const chosen = templates.find(t => t.key === templateKey);
  const r = run?.result;

  return <section className="panel" aria-label="Strategy test">
    <div className="panelhead"><div><h2>Strategy test</h2><span>Queued · reproducible · coverage-aware</span></div></div>
    <p>Only the BTC regime filter is available. It is fully backfillable from Coin Metrics daily price history. Attention-basket, early-launch and perp studies stay deferred until this archive has accumulated the point-in-time replay coverage they need.</p>
    <form className="btc-controls" onSubmit={e => { e.preventDefault(); void start(); }}>
      <label>Template<select aria-label="Template" value={templateKey} onChange={e => setTemplateKey(e.target.value)}>
        {templates.map(t => <option key={t.key} value={t.key} disabled={t.status === 'deferred'}>{t.label}{t.status === 'deferred' ? ' — deferred' : ''}</option>)}
      </select></label>
      <label>Active regime<select aria-label="Active regime" value={activeRegimes} onChange={e => setActiveRegimes(e.target.value)}>
        <option value="bullish">Bullish only</option><option value="bullish+transitional">Bullish or transitional</option>
      </select></label>
      <label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>Through<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
      <label>Holdout %<input type="number" min={10} max={50} value={holdoutPct} onChange={e => setHoldoutPct(Number(e.target.value))} /></label>
      <label>Cost bps / side<input type="number" min={0} max={200} value={costBps} onChange={e => setCostBps(Number(e.target.value))} /></label>
      <button disabled={busy || chosen?.status === 'deferred'}>{busy ? 'Running…' : 'Run backtest'}</button>
    </form>
    {chosen?.status === 'deferred' && <p role="alert">{chosen.gate}</p>}
    {error && <p role="alert">{error}</p>}
    {run && !r && <p>Run {run.id} · {run.status}{run.error ? ` · ${run.error}` : ''}</p>}

    {r && <>
      <p className="study-identity">Run {run!.id}{run!.reproduced ? ' · reproduced from an identical earlier run' : ''} · {r.methodologyVersion} · window {r.window.from} → {r.window.to} ({r.window.tradingDays} trading days, {r.window.years ?? '—'}y)
        <button onClick={() => download(`backtest-${run!.id}.json`, JSON.stringify(run, null, 2))}>Export run JSON</button></p>
      {equity && equity.x.length > 1 && <ResearchChart title="Equity curve (start = 100)" x={equity.x} lines={equity.lines} log syncKey="backtest" height={320}
        attribution={`Coin Metrics Community · CC BY-NC 4.0 · ${r.dataset.classification}`} />}
      <StatTable strategy={r.strategy.stats} benchmark={r.benchmark.stats} />
      <h3>Chronological holdout</h3>
      <p>{r.holdout.note} Split at {r.holdout.splitDate} ({r.holdout.holdoutPct}% held out).</p>
      <div className="btc-table-wrap"><table><thead><tr><th>Segment</th><th>Regime CAGR</th><th>Regime max DD</th><th>Buy-and-hold CAGR</th><th>Buy-and-hold max DD</th></tr></thead><tbody>
        <tr><td>In-sample</td><td>{pct(r.holdout.inSample.strategy.cagrPct)}</td><td>{pct(r.holdout.inSample.strategy.maxDrawdownPct)}</td><td>{pct(r.holdout.inSample.benchmark.cagrPct)}</td><td>{pct(r.holdout.inSample.benchmark.maxDrawdownPct)}</td></tr>
        <tr><td>Holdout</td><td>{pct(r.holdout.outOfSample.strategy.cagrPct)}</td><td>{pct(r.holdout.outOfSample.strategy.maxDrawdownPct)}</td><td>{pct(r.holdout.outOfSample.benchmark.cagrPct)}</td><td>{pct(r.holdout.outOfSample.benchmark.maxDrawdownPct)}</td></tr>
      </tbody></table></div>
      <h3>Trading and cost sensitivity</h3>
      <p>{r.trades.entries} entries · {r.trades.exits} exits · {r.trades.turnoverPerYear ?? '—'} trades/year · {r.trades.exposurePct ?? '—'}% of days exposed. The idle leg earns nothing.</p>
      <div className="btc-table-wrap"><table><thead><tr><th>Cost / side</th><th>CAGR</th><th>Total return</th><th>Sharpe</th><th>Max drawdown</th></tr></thead><tbody>
        {r.costSensitivity.map(row => <tr key={row.costBps}><td>{row.costBps} bps</td><td>{pct(row.cagrPct)}</td><td>{pct(row.totalReturnPct)}</td><td>{ratio(row.sharpe)}</td><td>{pct(row.maxDrawdownPct)}</td></tr>)}
      </tbody></table></div>
      {!!(r.warnings && r.warnings.length) && <ul className="regime-key">{r.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
      <details><summary>Dataset, reproducibility and limitations</summary>
        <p>{r.dataset.source} · {r.dataset.seriesId} · {r.dataset.completedPrices} completed daily prices ({r.dataset.firstObservedAt?.slice(0, 10)} – {r.dataset.lastObservedAt?.slice(0, 10)}). Replay coverage starts {r.dataset.replayCoverageStart?.slice(0, 10) ?? 'unavailable'}.</p>
        <p>Input hash {run!.inputHash ?? run!.input_hash}. An identical template version and parameter set over the same archive reproduces this result byte for byte.</p>
        <ul>{r.limitations.map(l => <li key={l}>{l}</li>)}</ul>
      </details>
    </>}

    {coverage && <details><summary>Replay-coverage horizon</summary><p>{coverage.note}</p>
      <div className="btc-table-wrap"><table><thead><tr><th>Dataset</th><th>Source</th><th>Replay coverage starts</th><th>Classification</th></tr></thead><tbody>
        {coverage.series.map(s => <tr key={s.id}><td>{s.metric}</td><td>{s.source}</td><td>{s.replayCoverageStart?.slice(0, 10) ?? '—'}</td><td>{s.classification}</td></tr>)}
        {coverage.datasets.map(d => <tr key={d.id}><td>{d.id}</td><td>{d.provider}</td><td>{d.replayCoverageStart?.slice(0, 10) ?? '—'}</td><td>{d.classification}</td></tr>)}
      </tbody></table></div></details>}
  </section>;
}

function HistoricalReplay() {
  const [date, setDate] = useState('');
  const [replay, setReplay] = useState<Replay>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = async () => {
    if (!date) return;
    setBusy(true); setError(''); setReplay(undefined);
    try { setReplay((await api<Replay>(`/backtest/replay?asOf=${encodeURIComponent(`${date}T00:00:00.000Z`)}`)).data); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const cards: [string, string | number | null][] = replay ? [
    ['BTC regime', replay.marketOverview?.regime ?? 'refused'],
    ['Tracked assets', replay.marketOverview?.trackedAssets ?? '—'],
    ['Emerging tracked / eligible', replay.emerging ? `${replay.emerging.tracked ?? '—'} / ${replay.emerging.eligible ?? '—'}` : 'refused'],
    ['Spot launch tokens / shortlisted', replay.spotLaunches ? `${replay.spotLaunches.tokens ?? '—'} / ${replay.spotLaunches.shortlisted ?? '—'}` : 'refused'],
    ['Perp protocols matched', replay.perpProjects?.matched ?? 'refused'],
    ['Perp markets matched', replay.perpListings?.matched ?? 'refused'],
  ] : [];
  return <section className="panel" aria-label="Historical replay">
    <div className="panelhead"><div><h2>Historical replay</h2><span>The eligible universe exactly as it was archived</span></div></div>
    <p>Historical replay works only for dates after this system began archiving each dataset. A request before a dataset's coverage start is refused for that workspace, not reconstructed. For everything except BTC price history this remains a forward-tracking product.</p>
    <form className="btc-controls" onSubmit={e => { e.preventDefault(); void load(); }}>
      <label>Replay date (UTC)<input type="date" value={date} onChange={e => setDate(e.target.value)} required /></label>
      <button disabled={busy}>{busy ? 'Loading…' : 'Inspect'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {replay && <>
      <p>Point-in-time as of {replay.asOf}.</p>
      <section className="btc-kpis">{cards.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
      {!!replay.refusals.length && <div><h3>Refused workspaces</h3><ul>{replay.refusals.map(r => <li key={r.workspace}>{r.workspace}: {r.message}</li>)}</ul></div>}
      <p className="regime-key">{replay.note}</p>
    </>}
  </section>;
}

const TABS = [['strategy', 'Strategy test'], ['study', 'Signal study'], ['replay', 'Historical replay']] as const;

export function BacktestLab() {
  const initial = location.hash.includes('study=') ? 'study' : 'strategy';
  const [tab, setTab] = useState<(typeof TABS)[number][0]>(initial);
  return <div className="btc-workspace">
    <div className="btc-intro"><div><span className="eyebrow">BACKTEST LAB</span><h2>Would these signals have helped, evaluated at the time?</h2>
      <p>Historical replay, the signal-study primitive, and reproducible strategy tests over the archive.</p></div><a href="#data-health">Inspect Data Health →</a></div>
    <nav className="chart-ranges" aria-label="Backtest Lab mode">{TABS.map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {tab === 'strategy' && <StrategyTest />}
    {tab === 'study' && <SignalStudy />}
    {tab === 'replay' && <HistoricalReplay />}
  </div>;
}
