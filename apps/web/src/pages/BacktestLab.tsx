import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useData } from '../api';
import { ResearchChart, download } from '../components/ResearchChart';
import { SignalStudy } from '../components/SignalStudy';

type Stats = { days: number; totalReturnPct: number | null; cagrPct: number | null; volatilityPct: number | null;
  sharpe: number | null; sortino: number | null; maxDrawdownPct: number | null; openDrawdown: boolean };
type RegimeResult = {
  methodologyVersion: 'btc-regime-strategy:v1';
  window: { from: string; to: string; tradingDays: number; returnDays: number; missingCloseDays: number; years: number | null };
  strategy: { stats: Stats };
  benchmark: { label: string; stats: Stats };
  holdout: { splitDate: string; holdoutPct: number; note: string;
    inSample: { strategy: Stats; benchmark: Stats }; outOfSample: { strategy: Stats; benchmark: Stats } };
  trades: { entries: number; exits: number; total: number; turnoverPerYear: number | null; exposurePct: number | null };
  costSensitivity: { costBps: number; cagrPct: number | null; totalReturnPct: number | null; sharpe: number | null; maxDrawdownPct: number | null }[];
  equity: { dates: number[]; strategy: number[]; benchmark: number[] };
  limitations: string[];
  warnings?: string[];
  dataset: Dataset;
};
type Metrics = { endingEquityUsd: number | null; totalContributedUsd: number | null; profitUsd: number | null; profitPct: number | null;
  moneyWeightedReturnPct: number | null; cagrPct: number | null; volatilityPct: number | null; sharpe: number | null; sortino: number | null; maxDrawdownPct: number | null };
type PortfolioResult = {
  methodologyVersion: 'portfolio-strategy:v1';
  hasContributions: boolean;
  window: { from: string; to: string; tradingDays: number; missingCloseDays: number; years: number | null };
  strategy: { metrics: Metrics; timeInMarketPct: number | null; avgInvestedPct: number | null; avgCashDragPct: number | null;
    trades: { buys: number; sells: number; total: number; turnoverPerYear: number | null } };
  benchmarks: { dcaHold: { label: string; metrics: Metrics }; lumpSum: { label: string; metrics: Metrics } };
  holdout: { splitDate: string; holdoutPct: number; note: string;
    inSample: { strategy: Metrics; dcaHold: Metrics; lumpSum: Metrics }; outOfSample: { strategy: Metrics; dcaHold: Metrics; lumpSum: Metrics } };
  costSensitivity: { costBps: number; moneyWeightedReturnPct: number | null; profitPct: number | null; maxDrawdownPct: number | null }[];
  equity: { dates: number[]; strategy: number[]; dcaHold: number[]; lumpSum: number[]; contributed: number[] };
  ledger: { entries: { date: string; kind: 'buy' | 'sell'; usd: number; units: number; price: number }[]; buys: number; sells: number };
  limitations: string[];
  warnings?: string[];
  dataset: Dataset;
};
type Dataset = { seriesId: string; source: string; replayCoverageStart: string | null; firstObservedAt: string | null; lastObservedAt: string | null; completedPrices: number; classification: string };
type Run = { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; result: RegimeResult | PortfolioResult | null; error: string | null;
  input_hash?: string; inputHash?: string; reproduced?: boolean };
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
const usd = (v: number | null | undefined) => v == null ? 'Unavailable'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: Math.abs(v) >= 1e6 ? 'compact' : 'standard', maximumFractionDigits: Math.abs(v) >= 1e6 ? 2 : 0 }).format(v);

// ---------------------------------------------------------------------------
// Condition builder (shared by entry guard and exit trigger)
// ---------------------------------------------------------------------------
type Cond = { type: string; op?: string; value?: number; pct?: number; side?: string; regimes?: string[] };
const CONDITION_TYPES: { value: string; label: string; kind: 'plain' | 'regime' | 'threshold' | 'side' }[] = [
  { value: 'none', label: 'None', kind: 'plain' },
  { value: 'regime-in', label: 'Regime is in set', kind: 'regime' },
  { value: 'regime-leave', label: 'Regime has left set', kind: 'regime' },
  { value: 'new-ath', label: 'New all-time high', kind: 'plain' },
  { value: 'drawdown-from-ath', label: 'Drawdown from ATH', kind: 'threshold' },
  { value: 'mayer', label: 'Mayer multiple', kind: 'threshold' },
  { value: 'price-vs-sma200', label: 'Price vs 200D SMA', kind: 'side' },
  { value: 'weekly-rsi', label: 'Weekly RSI', kind: 'threshold' },
  { value: 'mvrv', label: 'MVRV', kind: 'threshold' },
  { value: 'fear-greed', label: 'Fear & Greed Index', kind: 'threshold' },
];
const REGIMES = ['bullish', 'transitional', 'bearish'];

function ConditionInput({ label, value, onChange, allowNone }: { label: string; value: Cond; onChange: (c: Cond) => void; allowNone: boolean }) {
  const meta = CONDITION_TYPES.find(t => t.value === value.type)!;
  return <fieldset className="btc-controls"><legend>{label}</legend>
    <label>Type<select aria-label={`${label} type`} value={value.type} onChange={e => onChange({ type: e.target.value, op: 'gte', value: 1, pct: 20, side: 'below', regimes: ['bullish'] })}>
      {CONDITION_TYPES.filter(t => allowNone || t.value !== 'none').map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
    </select></label>
    {meta.kind === 'regime' && <label>Regimes<select multiple aria-label={`${label} regimes`} value={value.regimes ?? ['bullish']} onChange={e => onChange({ ...value, regimes: [...e.target.selectedOptions].map(o => o.value) })}>
      {REGIMES.map(r => <option key={r} value={r}>{r}</option>)}
    </select></label>}
    {meta.kind === 'threshold' && <>
      <label>Op<select aria-label={`${label} op`} value={value.op ?? 'gte'} onChange={e => onChange({ ...value, op: e.target.value })}><option value="gte">≥</option><option value="lte">≤</option></select></label>
      <label>{value.type === 'drawdown-from-ath' ? 'Percent' : 'Value'}<input type="number" step="0.1" aria-label={`${label} value`}
        value={value.type === 'drawdown-from-ath' ? value.pct ?? 20 : value.value ?? 1}
        onChange={e => onChange(value.type === 'drawdown-from-ath' ? { ...value, pct: Number(e.target.value) } : { ...value, value: Number(e.target.value) })} /></label>
    </>}
    {meta.kind === 'side' && <label>Side<select aria-label={`${label} side`} value={value.side ?? 'below'} onChange={e => onChange({ ...value, side: e.target.value })}><option value="above">above</option><option value="below">below</option></select></label>}
  </fieldset>;
}
function condPayload(c: Cond): Cond {
  switch (c.type) {
    case 'none': case 'new-ath': return { type: c.type };
    case 'regime-in': case 'regime-leave': return { type: c.type, regimes: c.regimes?.length ? c.regimes : ['bullish'] };
    case 'drawdown-from-ath': return { type: c.type, op: c.op ?? 'gte', pct: c.pct ?? 20 };
    case 'price-vs-sma200': return { type: c.type, side: c.side ?? 'below' };
    default: return { type: c.type, op: c.op ?? 'gte', value: c.value ?? 1 };
  }
}

// ---------------------------------------------------------------------------
// Custom strategy form
// ---------------------------------------------------------------------------
type Form = {
  startCapitalUsd: number; contribAmount: number; contribCadence: 'monthly' | 'weekly'; contribDay: number;
  entryTrigger: 'on-contribution' | 'monthly' | 'weekly'; entryDay: number; entryGuard: Cond;
  entrySizeType: 'all-cash' | 'fixed' | 'pct-cash'; entrySizeValue: number; entryRedeploy: 'immediate' | 'scheduled';
  exitTrigger: Cond; exitSizeType: 'all' | 'pct'; exitSizeValue: number;
  costBps: number; from: string; to: string; holdoutPct: number;
};
const BASE_FORM: Form = {
  startCapitalUsd: 0, contribAmount: 500, contribCadence: 'monthly', contribDay: 1,
  entryTrigger: 'on-contribution', entryDay: 1, entryGuard: { type: 'none' },
  entrySizeType: 'all-cash', entrySizeValue: 250, entryRedeploy: 'immediate',
  exitTrigger: { type: 'none' }, exitSizeType: 'all', exitSizeValue: 50,
  costBps: 25, from: '', to: '', holdoutPct: 30,
};
const PRESETS: Record<string, Partial<Form>> = {
  'dca-hold': { startCapitalUsd: 0, contribAmount: 500, entryTrigger: 'on-contribution', entryGuard: { type: 'none' }, entrySizeType: 'all-cash', exitTrigger: { type: 'none' } },
  'dca-regime': { contribAmount: 500, entryTrigger: 'monthly', entryDay: 1, entryGuard: { type: 'regime-in', regimes: ['bullish'] }, entrySizeType: 'all-cash', entryRedeploy: 'immediate', exitTrigger: { type: 'regime-leave', regimes: ['bullish'] }, exitSizeType: 'all' },
  'dca-ath': { contribAmount: 500, entryTrigger: 'on-contribution', entryGuard: { type: 'none' }, entrySizeType: 'all-cash', exitTrigger: { type: 'new-ath' }, exitSizeType: 'all' },
  'lump-hold': { startCapitalUsd: 10000, contribAmount: 0, entryTrigger: 'on-contribution', entryGuard: { type: 'none' }, entrySizeType: 'all-cash', exitTrigger: { type: 'none' } },
};

function buildSpec(f: Form) {
  const size = f.entrySizeType === 'all-cash' ? { type: 'all-cash' }
    : { type: f.entrySizeType, value: f.entrySizeValue };
  return {
    startCapitalUsd: f.startCapitalUsd,
    contribution: { amountUsd: f.contribAmount, cadence: f.contribCadence, day: f.contribDay },
    entry: { trigger: f.entryTrigger, day: f.entryDay, guard: condPayload(f.entryGuard), size, redeploy: f.entryRedeploy },
    exit: { trigger: condPayload(f.exitTrigger), size: f.exitSizeType === 'all' ? { type: 'all' } : { type: 'pct', value: f.exitSizeValue } },
    costBps: f.costBps, holdoutPct: f.holdoutPct,
    ...(f.from ? { from: f.from } : {}), ...(f.to ? { to: f.to } : {}),
  };
}

function CustomForm({ form, setForm }: { form: Form; setForm: (f: Form) => void }) {
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  return <>
    <fieldset className="btc-controls"><legend>Capital</legend>
      <label>Start lump sum (USD)<input type="number" min={0} value={form.startCapitalUsd} onChange={e => set('startCapitalUsd', Number(e.target.value))} /></label>
      <label>Contribution (USD, 0 = none)<input type="number" min={0} value={form.contribAmount} onChange={e => set('contribAmount', Number(e.target.value))} /></label>
      <label>Cadence<select value={form.contribCadence} onChange={e => set('contribCadence', e.target.value as Form['contribCadence'])}><option value="monthly">monthly</option><option value="weekly">weekly</option></select></label>
      <label>{form.contribCadence === 'monthly' ? 'Day of month' : 'Day of week (0=Sun)'}<input type="number" min={0} max={form.contribCadence === 'monthly' ? 28 : 6} value={form.contribDay} onChange={e => set('contribDay', Number(e.target.value))} /></label>
    </fieldset>
    <fieldset className="btc-controls"><legend>Entry</legend>
      <label>Trigger<select aria-label="Entry trigger" value={form.entryTrigger} onChange={e => set('entryTrigger', e.target.value as Form['entryTrigger'])}>
        <option value="on-contribution">when cash arrives</option><option value="monthly">monthly</option><option value="weekly">weekly</option></select></label>
      {form.entryTrigger !== 'on-contribution' && <label>{form.entryTrigger === 'monthly' ? 'Day of month' : 'Day of week'}<input type="number" min={0} max={form.entryTrigger === 'monthly' ? 28 : 6} value={form.entryDay} onChange={e => set('entryDay', Number(e.target.value))} /></label>}
      <label>Size<select aria-label="Entry size" value={form.entrySizeType} onChange={e => set('entrySizeType', e.target.value as Form['entrySizeType'])}>
        <option value="all-cash">all available cash</option><option value="fixed">fixed USD</option><option value="pct-cash">% of cash</option></select></label>
      {form.entrySizeType !== 'all-cash' && <label>Amount<input type="number" min={0} value={form.entrySizeValue} onChange={e => set('entrySizeValue', Number(e.target.value))} /></label>}
      <label>Redeploy on guard turn<select aria-label="Redeploy" value={form.entryRedeploy} onChange={e => set('entryRedeploy', e.target.value as Form['entryRedeploy'])}>
        <option value="immediate">immediate</option><option value="scheduled">wait for schedule</option></select></label>
    </fieldset>
    <ConditionInput label="Entry guard (only buy while true)" value={form.entryGuard} onChange={c => set('entryGuard', c)} allowNone />
    <fieldset className="btc-controls"><legend>Exit</legend>
      <label>Size<select aria-label="Exit size" value={form.exitSizeType} onChange={e => set('exitSizeType', e.target.value as Form['exitSizeType'])}><option value="all">sell everything</option><option value="pct">sell %</option></select></label>
      {form.exitSizeType === 'pct' && <label>Percent<input type="number" min={1} max={100} value={form.exitSizeValue} onChange={e => set('exitSizeValue', Number(e.target.value))} /></label>}
    </fieldset>
    <ConditionInput label="Exit trigger (sell when this becomes true)" value={form.exitTrigger} onChange={c => set('exitTrigger', c)} allowNone />
    <fieldset className="btc-controls"><legend>Costs &amp; window</legend>
      <label>Cost bps / side<input type="number" min={0} max={200} value={form.costBps} onChange={e => set('costBps', Number(e.target.value))} /></label>
      <label>Holdout %<input type="number" min={10} max={50} value={form.holdoutPct} onChange={e => set('holdoutPct', Number(e.target.value))} /></label>
      <label>From<input type="date" value={form.from} onChange={e => set('from', e.target.value)} /></label>
      <label>Through<input type="date" value={form.to} onChange={e => set('to', e.target.value)} /></label>
    </fieldset>
  </>;
}

// ---------------------------------------------------------------------------
// Result renderers
// ---------------------------------------------------------------------------
const REGIME_STAT_ROWS: [string, keyof Stats, (v: number | null) => string][] = [
  ['Total return', 'totalReturnPct', v => pct(v)], ['CAGR', 'cagrPct', v => pct(v)],
  ['Realized volatility', 'volatilityPct', v => pct(v)], ['Sharpe (rf 0%)', 'sharpe', ratio],
  ['Sortino (rf 0%)', 'sortino', ratio], ['Max drawdown', 'maxDrawdownPct', v => pct(v)],
];

function RegimeResultView({ run, r }: { run: Run; r: RegimeResult }) {
  const eq = { x: r.equity.dates, lines: [
    { label: 'Regime filter (start = 100)', color: '#71bcdf', values: r.equity.strategy },
    { label: 'BTC buy-and-hold', color: '#e8ba68', values: r.equity.benchmark }] };
  return <>
    {eq.x.length > 1 && <ResearchChart title="Equity curve (start = 100)" x={eq.x} lines={eq.lines} log syncKey="backtest" height={320}
      attribution={`Coin Metrics Community · CC BY-NC 4.0 · ${r.dataset.classification}`} />}
    <div className="btc-table-wrap"><table><thead><tr><th>Metric</th><th>Regime filter</th><th>BTC buy-and-hold</th></tr></thead><tbody>
      {REGIME_STAT_ROWS.map(([label, key, fmt]) => <tr key={label}><td>{label}</td><td>{fmt(r.strategy.stats[key] as number | null)}</td><td>{fmt(r.benchmark.stats[key] as number | null)}</td></tr>)}
    </tbody></table></div>
    <h3>Chronological holdout</h3><p>{r.holdout.note} Split at {r.holdout.splitDate} ({r.holdout.holdoutPct}% held out).</p>
    <div className="btc-table-wrap"><table><thead><tr><th>Segment</th><th>Filter CAGR</th><th>Filter max DD</th><th>Hold CAGR</th><th>Hold max DD</th></tr></thead><tbody>
      {(['inSample', 'outOfSample'] as const).map(seg => <tr key={seg}><td>{seg === 'inSample' ? 'In-sample' : 'Holdout'}</td>
        <td>{pct(r.holdout[seg].strategy.cagrPct)}</td><td>{pct(r.holdout[seg].strategy.maxDrawdownPct)}</td>
        <td>{pct(r.holdout[seg].benchmark.cagrPct)}</td><td>{pct(r.holdout[seg].benchmark.maxDrawdownPct)}</td></tr>)}
    </tbody></table></div>
    <h3>Trading and cost sensitivity</h3>
    <p>{r.trades.entries} entries · {r.trades.exits} exits · {r.trades.turnoverPerYear ?? '—'} trades/year · {r.trades.exposurePct ?? '—'}% of days exposed. The idle leg earns nothing.</p>
    <div className="btc-table-wrap"><table><thead><tr><th>Cost / side</th><th>CAGR</th><th>Total return</th><th>Sharpe</th><th>Max drawdown</th></tr></thead><tbody>
      {r.costSensitivity.map(row => <tr key={row.costBps}><td>{row.costBps} bps</td><td>{pct(row.cagrPct)}</td><td>{pct(row.totalReturnPct)}</td><td>{ratio(row.sharpe)}</td><td>{pct(row.maxDrawdownPct)}</td></tr>)}
    </tbody></table></div>
    <ResultTail run={run} r={r} />
  </>;
}

function MetricRows({ metrics, hasContributions }: { metrics: Metrics; hasContributions: boolean }) {
  return <>
    <td>{hasContributions ? pct(metrics.moneyWeightedReturnPct) : pct(metrics.cagrPct)}</td>
    <td>{pct(metrics.profitPct)}</td>
    <td>{usd(metrics.profitUsd)}</td>
    <td>{pct(metrics.maxDrawdownPct)}</td>
  </>;
}

function PortfolioResultView({ run, r }: { run: Run; r: PortfolioResult }) {
  const m = r.strategy.metrics;
  const eq = { x: r.equity.dates, lines: [
    { label: 'Strategy', color: '#71bcdf', values: r.equity.strategy },
    { label: 'DCA — buy every dollar', color: '#70bca6', values: r.equity.dcaHold },
    { label: 'Lump sum (hindsight)', color: '#e8ba68', values: r.equity.lumpSum },
    { label: 'Total contributed', color: '#aeb5c1', values: r.equity.contributed }] };
  const [showLedger, setShowLedger] = useState(false);
  return <>
    <section className="btc-kpis">
      <div><span>{r.hasContributions ? 'Money-weighted return (IRR)' : 'CAGR'}</span><strong>{pct(r.hasContributions ? m.moneyWeightedReturnPct : m.cagrPct)}</strong></div>
      <div><span>Ending equity</span><strong>{usd(m.endingEquityUsd)}</strong></div>
      <div><span>Total contributed</span><strong>{usd(m.totalContributedUsd)}</strong></div>
      <div><span>Profit</span><strong>{usd(m.profitUsd)} ({pct(m.profitPct)})</strong></div>
      <div><span>Max drawdown</span><strong>{pct(m.maxDrawdownPct)}</strong></div>
      <div><span>Time in market</span><strong>{pct(r.strategy.timeInMarketPct, 0)}</strong></div>
    </section>
    {eq.x.length > 1 && <ResearchChart title="Equity vs benchmarks (USD)" x={eq.x} lines={eq.lines} log syncKey="backtest" height={340}
      attribution={`Coin Metrics Community · CC BY-NC 4.0 · ${r.dataset.classification}`} />}
    <div className="btc-table-wrap"><table><thead><tr><th>Strategy vs benchmarks</th><th>{r.hasContributions ? 'IRR' : 'CAGR'}</th><th>Profit %</th><th>Profit $</th><th>Max drawdown</th></tr></thead><tbody>
      <tr><td>This strategy</td><MetricRows metrics={m} hasContributions={r.hasContributions} /></tr>
      <tr><td>{r.benchmarks.dcaHold.label}</td><MetricRows metrics={r.benchmarks.dcaHold.metrics} hasContributions={r.hasContributions} /></tr>
      <tr><td>{r.benchmarks.lumpSum.label}</td><MetricRows metrics={r.benchmarks.lumpSum.metrics} hasContributions={false} /></tr>
    </tbody></table></div>
    <h3>Chronological holdout</h3><p>{r.holdout.note} Split at {r.holdout.splitDate} ({r.holdout.holdoutPct}% held out).</p>
    <div className="btc-table-wrap"><table><thead><tr><th>Segment</th><th>Strategy {r.hasContributions ? 'IRR' : 'CAGR'}</th><th>Strategy max DD</th><th>DCA {r.hasContributions ? 'IRR' : 'CAGR'}</th><th>Lump {r.hasContributions ? 'IRR' : 'CAGR'}</th></tr></thead><tbody>
      {(['inSample', 'outOfSample'] as const).map(seg => { const h = r.holdout[seg]; const key = r.hasContributions ? 'moneyWeightedReturnPct' : 'cagrPct'; return <tr key={seg}>
        <td>{seg === 'inSample' ? 'In-sample' : 'Holdout'}</td><td>{pct(h.strategy[key])}</td><td>{pct(h.strategy.maxDrawdownPct)}</td>
        <td>{pct(h.dcaHold[key])}</td><td>{pct(h.lumpSum.moneyWeightedReturnPct ?? h.lumpSum.cagrPct)}</td></tr>; })}
    </tbody></table></div>
    <h3>Activity and cost sensitivity</h3>
    <p>{r.strategy.trades.buys} buys · {r.strategy.trades.sells} sells · {r.strategy.trades.turnoverPerYear ?? '—'} trades/year · avg invested {pct(r.strategy.avgInvestedPct, 0)} · avg cash drag {pct(r.strategy.avgCashDragPct, 0)}.</p>
    <div className="btc-table-wrap"><table><thead><tr><th>Cost / side</th><th>{r.hasContributions ? 'IRR' : 'Return'}</th><th>Profit %</th><th>Max drawdown</th></tr></thead><tbody>
      {r.costSensitivity.map(row => <tr key={row.costBps}><td>{row.costBps} bps</td><td>{pct(row.moneyWeightedReturnPct)}</td><td>{pct(row.profitPct)}</td><td>{pct(row.maxDrawdownPct)}</td></tr>)}
    </tbody></table></div>
    <p><button onClick={() => setShowLedger(v => !v)}>{showLedger ? 'Hide' : 'Show'} trade ledger ({r.ledger.buys} buys / {r.ledger.sells} sells)</button></p>
    {showLedger && <div className="btc-table-wrap"><table><thead><tr><th>Date</th><th>Action</th><th>USD</th><th>Units</th><th>Price</th></tr></thead><tbody>
      {r.ledger.entries.map((e, i) => <tr key={i}><td>{e.date}</td><td>{e.kind}</td><td>{usd(e.usd)}</td><td>{e.units}</td><td>{usd(e.price)}</td></tr>)}
    </tbody></table>{r.ledger.buys + r.ledger.sells > r.ledger.entries.length && <p className="regime-key">Showing the last {r.ledger.entries.length} of {r.ledger.buys + r.ledger.sells} trades.</p>}</div>}
    <ResultTail run={run} r={r} />
  </>;
}

function ResultTail({ run, r }: { run: Run; r: RegimeResult | PortfolioResult }) {
  return <>
    {!!(r.warnings && r.warnings.length) && <ul className="regime-key">{r.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
    <details><summary>Dataset, reproducibility and limitations</summary>
      <p>{r.dataset.source} · {r.dataset.seriesId} · {r.dataset.completedPrices} completed daily prices ({r.dataset.firstObservedAt?.slice(0, 10)} – {r.dataset.lastObservedAt?.slice(0, 10)}). Replay coverage starts {r.dataset.replayCoverageStart?.slice(0, 10) ?? 'unavailable'}.</p>
      <p>Input hash {run.inputHash ?? run.input_hash}. An identical template version and parameter set over the same archive reproduces this result byte for byte.</p>
      <ul>{r.limitations.map(l => <li key={l}>{l}</li>)}</ul>
    </details>
  </>;
}

// ---------------------------------------------------------------------------
function StrategyTest() {
  const { result: templatesApi } = useData<TemplatesResponse>('/backtest/templates');
  const templates = templatesApi?.data.templates ?? [];
  const coverage = templatesApi?.data.coverage;
  const [templateKey, setTemplateKey] = useState('btc-regime-filter');
  const [activeRegimes, setActiveRegimes] = useState('bullish');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [holdoutPct, setHoldoutPct] = useState(30), [costBps, setCostBps] = useState(25);
  const [preset, setPreset] = useState('dca-hold');
  const [form, setForm] = useState<Form>({ ...BASE_FORM, ...PRESETS['dca-hold'] });
  const [run, setRun] = useState<Run>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const applyPreset = (key: string) => { setPreset(key); if (PRESETS[key]) setForm({ ...BASE_FORM, ...PRESETS[key] }); };

  const poll = (id: string) => {
    timer.current = setTimeout(async () => {
      try {
        const next = (await api<Run>(`/backtest/runs/${id}`)).data;
        setRun(next);
        if (next.status === 'queued' || next.status === 'running') poll(id); else setBusy(false);
      } catch (e) { setError((e as Error).message); setBusy(false); }
    }, 1200);
  };
  const start = async () => {
    setBusy(true); setError(''); setRun(undefined);
    try {
      const params = templateKey === 'custom-strategy' ? buildSpec(form)
        : { activeRegimes, ...(from ? { from } : {}), ...(to ? { to } : {}), holdoutPct, costBps };
      const created = (await api<Run>('/backtest/runs', { method: 'POST', body: JSON.stringify({ templateKey, params }) })).data;
      if (created.status === 'succeeded') { setRun(created); setBusy(false); } else { setRun(created); poll(created.id); }
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  const chosen = templates.find(t => t.key === templateKey);
  const r = run?.result;
  const custom = templateKey === 'custom-strategy';

  return <section className="panel" aria-label="Strategy test">
    <div className="panelhead"><div><h2>Strategy test</h2><span>Queued · reproducible · coverage-aware</span></div></div>
    <p>Two engines run over the full Coin Metrics BTC price history. <b>BTC regime filter</b> is all-in / all-out on the confirmed regime. <b>Custom strategy</b> is a portfolio simulator: a starting lump sum and a recurring contribution, your own entry rule (trigger + optional indicator guard + size) and exit rule, compared against buy-every-dollar DCA and a hindsight lump sum. Attention-basket and perp studies stay deferred until replay coverage accrues.</p>
    <form className="btc-controls" onSubmit={e => { e.preventDefault(); void start(); }}>
      <label>Template<select aria-label="Template" value={templateKey} onChange={e => setTemplateKey(e.target.value)}>
        {templates.map(t => <option key={t.key} value={t.key} disabled={t.status === 'deferred'}>{t.label}{t.status === 'deferred' ? ' — deferred' : ''}</option>)}
      </select></label>
      {custom && <label>Preset<select aria-label="Preset" value={preset} onChange={e => applyPreset(e.target.value)}>
        <option value="dca-hold">Monthly DCA + hold</option><option value="dca-regime">Monthly DCA + regime exit</option>
        <option value="dca-ath">Monthly DCA + sell at ATH</option><option value="lump-hold">Lump sum + hold</option><option value="custom">Custom (keep current)</option>
      </select></label>}
      {!custom && <>
        <label>Active regime<select aria-label="Active regime" value={activeRegimes} onChange={e => setActiveRegimes(e.target.value)}>
          <option value="bullish">Bullish only</option><option value="bullish+transitional">Bullish or transitional</option></select></label>
        <label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label>Through<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
        <label>Holdout %<input type="number" min={10} max={50} value={holdoutPct} onChange={e => setHoldoutPct(Number(e.target.value))} /></label>
        <label>Cost bps / side<input type="number" min={0} max={200} value={costBps} onChange={e => setCostBps(Number(e.target.value))} /></label>
      </>}
      <button disabled={busy || chosen?.status === 'deferred'}>{busy ? 'Running…' : 'Run backtest'}</button>
    </form>
    {custom && <CustomForm form={form} setForm={f => { setForm(f); setPreset('custom'); }} />}
    {chosen?.status === 'deferred' && <p role="alert">{chosen.gate}</p>}
    {error && <p role="alert">{error}</p>}
    {run && !r && <p>Run {run.id} · {run.status}{run.error ? ` · ${run.error}` : ''}</p>}

    {r && <>
      <p className="study-identity">Run {run!.id}{run!.reproduced ? ' · reproduced from an identical earlier run' : ''} · {r.methodologyVersion} · window {r.window.from} → {r.window.to} ({r.window.tradingDays} trading days, {r.window.years ?? '—'}y)
        <button onClick={() => download(`backtest-${run!.id}.json`, JSON.stringify(run, null, 2))}>Export run JSON</button></p>
      {r.methodologyVersion === 'portfolio-strategy:v1'
        ? <PortfolioResultView run={run!} r={r} />
        : <RegimeResultView run={run!} r={r} />}
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
