import { useEffect, useMemo, useState } from 'react';
import { api, useData } from '../api';
import { ResearchChart } from '../components/ResearchChart';

type Dataset = { seriesId: string; source: string; replayCoverageStart: string | null; firstObservedAt: string | null; lastObservedAt: string | null; completedPrices: number; classification: string };
type SideMetrics = { moneyWeightedReturnPct: number | null; maxDrawdownPct: number | null };
type Cell = {
  entryKey: string; entryLabel: string; exitKey: string; exitLabel: string;
  moneyWeightedReturnPct?: number | null; endingEquityUsd?: number | null; profitPct?: number | null;
  maxDrawdownPct?: number | null; timeInMarketPct?: number | null; trades?: number;
  dcaHold?: SideMetrics; lumpSum?: SideMetrics; outOfSample?: SideMetrics;
  window?: { from: string; to: string; tradingDays: number; years: number | null };
  error: string | null;
};
type MatrixReport = {
  methodologyVersion: string; classification: string;
  params: { from: string; costBps: number; holdoutPct: number; contributionUsd: number };
  dataset: Dataset; grid: { cells: Cell[] }; note: string;
};

type LedgerEntry = { date: string; kind: 'buy' | 'sell'; usd: number; units: number; price: number };
type ThresholdMetric = 'mayer' | 'mvrv' | 'drawdown-from-ath' | 'weekly-rsi' | 'fear-greed';
type ThresholdSweep = {
  metric: ThresholdMetric; metricLabel: string; side: 'entry' | 'exit'; op: 'gte' | 'lte';
  thresholds: number[]; trades: (number | null)[];
  withOther: (number | null)[]; withOtherDd: (number | null)[]; otherLabel: string;
  baseline: (number | null)[]; baselineDd: (number | null)[]; baselineLabel: string;
};
type Segment = { label: string; strategy: number | null; dca: number | null; strategyDD: number | null; dcaDD: number | null; trades: number };
type Robustness = { combo: { entryLabel: string; exitLabel: string }; segments: Segment[]; expanding: { to: string; strategy: number | null; dca: number | null }[]; ledger: LedgerEntry[] };
type AdaptiveRow = { label: string; dca: number | null; fixed: number | null; adaptive: number | null };
type Adaptive = { windowDays: number; entryPercentile: number; exitPercentile: number; fixedLabel: { entryLabel: string; exitLabel: string }; rows: AdaptiveRow[]; ledger: LedgerEntry[] };
type CellDeepDive = { entryKey: string; exitKey: string; entryLabel: string; exitLabel: string; sweeps: ThresholdSweep[]; robustness: Robustness; adaptive: Adaptive | null };

const pct = (v: number | null | undefined, digits = 1) => v == null ? '—' : `${v.toFixed(digits)}%`;
const usd = (v: number | null | undefined) => v == null ? '—'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: Math.abs(v) >= 1e6 ? 'compact' : 'standard', maximumFractionDigits: Math.abs(v) >= 1e6 ? 2 : 0 }).format(v);
const dateSec = (d: string) => Date.parse(`${d}T00:00:00.000Z`) / 1000;

type Metric = 'irr' | 'dd' | 'tim';
const METRIC_LABEL: Record<Metric, string> = { irr: 'IRR', dd: 'max DD', tim: 'in mkt' };
function metricValue(cell: Cell, metric: Metric): number | null | undefined {
  return metric === 'irr' ? cell.moneyWeightedReturnPct : metric === 'dd' ? cell.maxDrawdownPct : cell.timeInMarketPct;
}

/** Tints a cell against the baseline (no guard, never sell) cell's value for the same
 *  metric -- higher is "better" for all three (IRR, time in market, and drawdown, since
 *  drawdown is stored as a negative number: -10 beats -20). */
function cellTone(cell: Cell, baseline: Cell | undefined, metric: Metric): string {
  const v = metricValue(cell, metric), b = baseline && metricValue(baseline, metric);
  if (cell.error || v == null || b == null) return '';
  return v > b ? 'dca-cell-beats' : v < b ? 'dca-cell-lags' : '';
}

function findMax(values: (number | null)[]): { index: number; value: number } | null {
  let best: { index: number; value: number } | null = null;
  values.forEach((v, i) => { if (v != null && (!best || v > best.value)) best = { index: i, value: v }; });
  return best;
}

function ledgerTable(entries: LedgerEntry[]) {
  const lastSellIdx = entries.map(e => e.kind).lastIndexOf('sell');
  return <div className="dca-matrix-table-wrap"><table className="dca-ledger">
    <thead><tr><th>Date</th><th>Action</th><th>USD</th><th>BTC price</th></tr></thead>
    <tbody>{entries.map((e, i) => <tr key={i} className={i > lastSellIdx ? 'dca-ledger-open' : ''}>
      <td>{e.date}</td><td className={`dca-ledger-${e.kind}`}>{e.kind}{i > lastSellIdx && e.kind === 'buy' ? ' (still held)' : ''}</td>
      <td>${e.usd.toLocaleString('en-US')}</td><td>${e.price.toLocaleString('en-US')}</td>
    </tr>)}</tbody>
  </table></div>;
}

function sweepSection(sweep: ThresholdSweep) {
  const opLabel = sweep.op === 'gte' ? '≥' : '≤';
  const peak = findMax(sweep.withOther);
  return <section className="panel" aria-label={`${sweep.metricLabel} ${sweep.side} sensitivity`} key={`${sweep.metric}-${sweep.side}`}>
    <h3>{sweep.metricLabel} {sweep.side} sensitivity</h3>
    <p className="dca-matrix-legend">{sweep.side === 'entry' ? 'Entry' : 'Exit'} fixed to "{sweep.metricLabel} {opLabel} threshold" —
      only the threshold moves, {sweep.thresholds[0]} → {sweep.thresholds.at(-1)}.</p>
    <ResearchChart title={`IRR vs ${sweep.metricLabel} ${sweep.side} threshold`} x={sweep.thresholds} time={false} xLabel={`${sweep.metricLabel} threshold`} height={230}
      lines={[{ label: sweep.otherLabel, color: '#71bcdf', values: sweep.withOther },
              { label: sweep.baselineLabel, color: '#5c6878', values: sweep.baseline }]}
      attribution="Live portfolio-strategy:v1 sweep, not archived" />
    {peak && <p className="dca-matrix-finding">
      With {sweep.otherLabel.toLowerCase()} held fixed, IRR peaks at <b>{pct(peak.value)}</b> around {sweep.metricLabel} {opLabel} {sweep.thresholds[peak.index]}.
      A narrow spike around the clicked threshold suggests it was fit to this window; a wide plateau suggests it's more robust.
      With the other side neutral ({sweep.baselineLabel.toLowerCase()}), the sweep shows whether the threshold matters on its own.
    </p>}
  </section>;
}

export function DcaMatrix() {
  const { result, loading, error, reload } = useData<MatrixReport>('/backtest/dca-matrix');
  const d = result?.data;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>('irr');
  const [deep, setDeep] = useState<{ loading: boolean; error?: string; data?: CellDeepDive }>({ loading: false });

  const { entries, exits, byKey, baseline } = useMemo(() => {
    if (!d) return { entries: [] as { key: string; label: string }[], exits: [] as { key: string; label: string }[], byKey: new Map<string, Cell>(), baseline: undefined as Cell | undefined };
    const entries: { key: string; label: string }[] = [];
    const exits: { key: string; label: string }[] = [];
    const byKey = new Map<string, Cell>();
    for (const cell of d.grid.cells) {
      if (!entries.some(e => e.key === cell.entryKey)) entries.push({ key: cell.entryKey, label: cell.entryLabel });
      if (!exits.some(e => e.key === cell.exitKey)) exits.push({ key: cell.exitKey, label: cell.exitLabel });
      byKey.set(`${cell.entryKey}::${cell.exitKey}`, cell);
    }
    return { entries, exits, byKey, baseline: byKey.get('none::none') };
  }, [d]);

  const selected = selectedKey ? byKey.get(selectedKey) ?? null : null;
  const ranked = useMemo(() => {
    if (!d) return { top: [] as Cell[], bottom: [] as Cell[] };
    const sortable = d.grid.cells.filter(c => !c.error && c.moneyWeightedReturnPct != null).sort((a, b) => b.moneyWeightedReturnPct! - a.moneyWeightedReturnPct!);
    return { top: sortable.slice(0, 5), bottom: sortable.slice(-5).reverse() };
  }, [d]);
  const best = ranked.top[0];

  // Default to the best cell once the grid loads, so the deep dive isn't empty before
  // any click; a real click always overrides this.
  useEffect(() => { if (!selectedKey && best) setSelectedKey(`${best.entryKey}::${best.exitKey}`); }, [best, selectedKey]);

  const [deepAttempt, setDeepAttempt] = useState(0);
  useEffect(() => {
    if (!selectedKey) return;
    const [entryKey, exitKey] = selectedKey.split('::');
    let cancelled = false;
    setDeep({ loading: true });
    api<CellDeepDive>(`/backtest/dca-matrix/cell?entry=${encodeURIComponent(entryKey)}&exit=${encodeURIComponent(exitKey)}`)
      .then(r => { if (!cancelled) setDeep({ loading: false, data: r.data }); })
      .catch(() => { if (!cancelled) setDeep({ loading: false, error: "Unable to load this cell's deep dive." }); });
    return () => { cancelled = true; };
  }, [selectedKey, deepAttempt]);

  if (loading) return <p>Running the DCA Matrix grid over the live archive, a few seconds…</p>;
  if (error || !d) return <p role="alert">Unable to load the DCA matrix. <button onClick={reload}>Try again</button></p>;

  const dd = deep.data;
  const seg = dd?.robustness.segments;
  const cycle2 = seg?.[1];
  const openPositions = dd ? (() => {
    const l = dd.robustness.ledger; const lastSell = l.map(e => e.kind).lastIndexOf('sell');
    return l.slice(lastSell + 1).filter(e => e.kind === 'buy');
  })() : [];
  const expandingEdges = dd?.robustness.expanding.map(e => e.strategy != null && e.dca != null ? e.strategy - e.dca : null) ?? [];
  const firstEdge = expandingEdges.find(e => e != null) ?? null;
  const lastEdge = [...expandingEdges].reverse().find(e => e != null) ?? null;
  const adaptiveFull = dd?.adaptive?.rows.at(-1);

  return <section className="dca-matrix-workspace" aria-label="DCA Matrix">
    <div className="dca-matrix-intro"><span className="eyebrow">BACKTEST</span><h2>BTC DCA Matrix</h2>
      <p>{d.grid.cells.length} monthly-DCA strategies on BTC from {d.params.from}, every one of {entries.length} entry
        rules crossed with every one of {exits.length} exit rules. ${d.params.contributionUsd.toLocaleString('en-US')} contributed
        on the 1st of each month; a {d.params.costBps}bps cost on every trade. Click any cell to stress-test it: threshold
        sensitivity for every numeric rule involved, a cross-cycle robustness check, and — for a Mayer/MVRV pairing — a
        self-adjusting adaptive comparison.</p></div>

    {baseline && <div className="dca-matrix-refs">
      <div className="dca-matrix-ref-tile dca-matrix-ref-base">
        <span className="label">Baseline · plain monthly DCA, hold</span>
        <span className="value">{pct(baseline.moneyWeightedReturnPct)} IRR</span>
        <span className="sub">{pct(baseline.maxDrawdownPct)} max drawdown · {usd(baseline.endingEquityUsd)} ending equity</span>
      </div>
      <div className="dca-matrix-ref-tile">
        <span className="label">Hindsight lump sum · same capital on day one</span>
        <span className="value">{pct(baseline.lumpSum?.moneyWeightedReturnPct)} IRR</span>
        <span className="sub">{pct(baseline.lumpSum?.maxDrawdownPct)} max drawdown · not achievable without the capital upfront</span>
      </div>
      {best && <div className="dca-matrix-ref-tile dca-matrix-ref-win">
        <span className="label">Best of {d.grid.cells.length} · {best.entryLabel} → {best.exitLabel}</span>
        <span className="value">{pct(best.moneyWeightedReturnPct)} IRR</span>
        <span className="sub">{pct(best.maxDrawdownPct)} max drawdown · {best.trades} trades · selected below by default</span>
      </div>}
    </div>}

    <div className="dca-matrix-metric-toggle" role="group" aria-label="Heatmap metric">
      {(['irr', 'dd', 'tim'] as Metric[]).map(m => <button key={m} type="button" className={metric === m ? 'on' : ''} onClick={() => setMetric(m)}>
        {m === 'irr' ? 'Money-weighted return' : m === 'dd' ? 'Max drawdown' : 'Time in market'}
      </button>)}
    </div>

    <div className="dca-matrix-table-wrap">
      <table className="dca-matrix-table">
        <thead><tr><th>Entry \ Exit</th>{exits.map(x => <th key={x.key}>{x.label}</th>)}</tr></thead>
        <tbody>
          {entries.map(en => <tr key={en.key}>
            <th>{en.label}</th>
            {exits.map(ex => {
              const cell = byKey.get(`${en.key}::${ex.key}`);
              const key = `${en.key}::${ex.key}`;
              if (!cell || cell.error) return <td key={ex.key} className="dca-cell-error" title={cell?.error ?? 'No data'}>—</td>;
              const v = metricValue(cell, metric);
              return <td key={ex.key} className={cellTone(cell, baseline, metric)}>
                <button type="button" onClick={() => setSelectedKey(key)} className={selectedKey === key ? 'dca-cell-selected' : ''}>
                  <span className="dca-cell-v">{metric === 'tim' ? pct(v, 0) : pct(v)}</span>
                  <span className="dca-cell-t">{METRIC_LABEL[metric]}</span>
                </button>
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>
    <p className="dca-matrix-legend">Color compares each cell to the baseline (top-left) on the selected metric. Click a cell to stress-test it below.</p>

    <div className="dca-matrix-lower">
      <section className="dca-matrix-detail" aria-label="Cell detail">
        {selected && !selected.error ? <>
          <h3>{selected.entryLabel} → {selected.exitLabel}</h3>
          <table>
            <tbody>
              <tr><td>Window</td><td>{selected.window?.from} – {selected.window?.to} ({selected.window?.years}y, {selected.window?.tradingDays} days)</td></tr>
              <tr><td>Strategy IRR</td><td>{pct(selected.moneyWeightedReturnPct)}</td></tr>
              <tr><td>Ending equity</td><td>{usd(selected.endingEquityUsd)}</td></tr>
              <tr><td>Profit</td><td>{pct(selected.profitPct)}</td></tr>
              <tr><td>Max drawdown</td><td>{pct(selected.maxDrawdownPct)}</td></tr>
              <tr><td>Time in market</td><td>{pct(selected.timeInMarketPct, 0)}</td></tr>
              <tr><td>Trades</td><td>{selected.trades}</td></tr>
              <tr><td>DCA-hold benchmark IRR</td><td>{pct(selected.dcaHold?.moneyWeightedReturnPct)} (drawdown {pct(selected.dcaHold?.maxDrawdownPct)})</td></tr>
              <tr><td>Lump-sum benchmark IRR</td><td>{pct(selected.lumpSum?.moneyWeightedReturnPct)} (drawdown {pct(selected.lumpSum?.maxDrawdownPct)})</td></tr>
              <tr><td>Out-of-sample IRR (last {d.params.holdoutPct}%)</td><td>{pct(selected.outOfSample?.moneyWeightedReturnPct)} (drawdown {pct(selected.outOfSample?.maxDrawdownPct)})</td></tr>
            </tbody>
          </table>
        </> : <p className="dca-matrix-legend">Click a cell in the grid to inspect its full result.</p>}
      </section>
      <section className="dca-matrix-ranked" aria-label="Rankings">
        <h3>Top 5 by money-weighted return</h3>
        <ol>{ranked.top.map(c => <li key={`${c.entryKey}::${c.exitKey}`} onClick={() => setSelectedKey(`${c.entryKey}::${c.exitKey}`)}>
          <span className="names"><span className="e">{c.entryLabel}</span><span className="x">→ {c.exitLabel}</span></span>
          <span className="figure">{pct(c.moneyWeightedReturnPct)}</span></li>)}</ol>
        <h3 style={{ marginTop: 14 }}>Bottom 5 by money-weighted return</h3>
        <ol>{ranked.bottom.map(c => <li key={`${c.entryKey}::${c.exitKey}`} onClick={() => setSelectedKey(`${c.entryKey}::${c.exitKey}`)}>
          <span className="names"><span className="e">{c.entryLabel}</span><span className="x">→ {c.exitLabel}</span></span>
          <span className="figure">{pct(c.moneyWeightedReturnPct)}</span></li>)}</ol>
      </section>
    </div>

    {deep.loading && <p className="dca-matrix-legend">Stress-testing {selected ? `${selected.entryLabel} → ${selected.exitLabel}` : 'this cell'} — threshold sweeps, cycle segments, robustness…</p>}
    {deep.error && <p role="alert">{deep.error} <button onClick={() => setDeepAttempt(n => n + 1)}>Try again</button></p>}

    {dd?.sweeps.map(sweepSection)}

    {dd && seg && cycle2 && <section className="panel" aria-label="Robustness check">
      <h3>Robustness check: is {dd.entryLabel} → {dd.exitLabel} a real edge, or one lucky window?</h3>
      <p className="dca-matrix-legend">Tested against three ways the {d.params.from} → {d.dataset.lastObservedAt?.slice(0, 10)} window could be misleading.</p>
      <div className="dca-matrix-verdict">
        <b>{cycle2.strategy != null && cycle2.dca != null && cycle2.strategy < cycle2.dca ? 'Mostly one window.' : 'Holds up across cycles.'}</b>{' '}
        Isolated to the <b>2020 halving cycle alone</b>, this combo returns <b>{pct(cycle2.strategy)} IRR versus {pct(cycle2.dca)} for plain DCA</b>
        {cycle2.strategy != null && cycle2.dca != null && cycle2.strategy < cycle2.dca ? <> — it <b>loses</b> to just buying every month.</> : <> — it beats plain DCA in this cycle too.</>}
        {openPositions.length > 0 && <> {openPositions.length} position{openPositions.length > 1 ? 's' : ''} bought for {usd(openPositions.reduce((s, e) => s + e.usd, 0))} {openPositions.length > 1 ? 'are' : 'is'} still
          <b> open and unsold</b> as of {d.dataset.lastObservedAt?.slice(0, 10)} — the exit condition hasn't fired again in the current cycle. Any headline return blends realized wins with unrealized bets that haven't paid off yet.</>}
      </div>
      <h4>A · Each halving cycle judged on its own, not cumulatively</h4>
      <div className="dca-matrix-seg-cards">{seg.map(s => {
        const edge = s.strategy != null && s.dca != null ? s.strategy - s.dca : null;
        return <div className="dca-matrix-seg-card" key={s.label}>
          <div className="seg-label">{s.label}</div>
          <div className="seg-row"><span>Strategy IRR</span><span>{pct(s.strategy)}</span></div>
          <div className="seg-row"><span>DCA-hold IRR</span><span>{pct(s.dca)}</span></div>
          <div className="seg-row"><span>Strategy max DD</span><span>{pct(s.strategyDD)}</span></div>
          <div className={`edge ${edge != null && edge >= 0 ? 'pos' : 'neg'}`}>{edge != null ? `${edge >= 0 ? '+' : ''}${edge.toFixed(1)} pp vs DCA` : '—'} · {s.trades} trades</div>
        </div>;
      })}</div>
      <h4 style={{ marginTop: 14 }}>B · Same monthly DCA since {d.params.from}, only the end date moves</h4>
      <ResearchChart title="Strategy edge over DCA-hold as the end date moves forward" x={dd.robustness.expanding.map(e => dateSec(e.to))} height={200}
        lines={[{ label: 'Edge over DCA-hold (pp)', color: '#71bcdf', values: expandingEdges }]}
        attribution="Live portfolio-strategy:v1 sweep, not archived" />
      {firstEdge != null && lastEdge != null && <p className="dca-matrix-finding">
        Edge over DCA-hold (strategy IRR − DCA IRR) as the end date creeps from {dd.robustness.expanding[0].to} to today:
        started at <b>{firstEdge >= 0 ? '+' : ''}{firstEdge.toFixed(0)}pp</b>, now at <b>{lastEdge >= 0 ? '+' : ''}{lastEdge.toFixed(0)}pp</b>.
        {lastEdge < firstEdge ? ' A shrinking edge as the sample grows is what a lucky-early-trade pattern looks like, not a stable, repeatable one.' : ' A stable or growing edge as the sample grows is a better sign than a single-window headline number.'}
      </p>}
      <h4 style={{ marginTop: 14 }}>C · Every trade this combo actually made</h4>
      {ledgerTable(dd.robustness.ledger)}
    </section>}

    {dd?.adaptive && <section className="panel" aria-label="Adaptive comparison">
      <h3>Does making the thresholds cycle-relative actually help?</h3>
      <p className="dca-matrix-legend">Same ${d.params.contributionUsd.toLocaleString('en-US')}/mo. Entry: its metric in its own bottom {dd.adaptive.entryPercentile}% over the trailing {Math.round(dd.adaptive.windowDays / 365)} years.
        Exit: its metric in its own top {100 - dd.adaptive.exitPercentile}% over the same window. Self-adjusting — no fixed number.</p>
      <div className="dca-matrix-table-wrap"><table className="dca-ledger">
        <thead><tr><th>Window</th><th>DCA-hold</th><th>Fixed ({dd.adaptive.fixedLabel.entryLabel} / {dd.adaptive.fixedLabel.exitLabel})</th><th>Adaptive (own trailing-{dd.adaptive.windowDays}d {dd.adaptive.entryPercentile}th/{dd.adaptive.exitPercentile}th pct)</th></tr></thead>
        <tbody>{dd.adaptive.rows.map(r => <tr key={r.label}>
          <td>{r.label}</td><td>{pct(r.dca)}</td><td>{pct(r.fixed)}</td>
          <td className={r.adaptive != null && r.dca != null && r.adaptive >= r.dca ? 'pos' : 'neg'}>{pct(r.adaptive)}</td>
        </tr>)}</tbody>
      </table></div>
      {adaptiveFull && <p className="dca-matrix-finding">
        <b>Fixes the blindness, doesn't necessarily fix the returns.</b> The adaptive version trades in every cycle — including the current
        one, where the fixed version can sit frozen — because "top/bottom X% of its own recent range" always has a top/bottom X%, no matter
        how compressed the cycle gets. Its full-window IRR (<b>{pct(adaptiveFull.adaptive)}</b>) is {adaptiveFull.adaptive != null && adaptiveFull.dca != null && adaptiveFull.adaptive < adaptiveFull.dca ? <>below <i>both</i> plain DCA-hold ({pct(adaptiveFull.dca)}) and the fixed version's headline ({pct(adaptiveFull.fixed)})</> : <>reported alongside plain DCA-hold ({pct(adaptiveFull.dca)}) and the fixed version's headline ({pct(adaptiveFull.fixed)}) above</>}.
        Making a threshold self-adjusting is a real fix for "the rule went silent" — on its own it is not evidence that timing entries and exits beats simply buying every month.
      </p>}
      <h4 style={{ marginTop: 14 }}>Every trade the adaptive version made</h4>
      {ledgerTable(dd.adaptive.ledger)}
    </section>}

    <section className="panel note">
      <p><b>Method.</b> {d.note}</p>
      <p><b>"Mayer ≤ 1.0" and "price below 200D SMA" produce identical rows.</b> That's not a bug: Mayer Multiple is defined as close ÷ SMA200, so the two conditions are the same by construction.</p>
      <p>The grid runs live on every page load; each cell's deep dive (sensitivity, robustness, adaptive) runs on click, a few
        hundred ms to a couple of seconds depending on the combo — none of it persisted through the app's <code>backtest_runs</code> queue.
        Reproduce any single grid cell in Backtest Lab → Strategy test → Custom strategy with the same entry/exit choice for a queued, immutable result.</p>
    </section>

    <p className="dca-matrix-dataset">{d.dataset.source} · {d.dataset.firstObservedAt?.slice(0, 10)} → {d.dataset.lastObservedAt?.slice(0, 10)} · {d.dataset.classification}</p>
  </section>;
}
