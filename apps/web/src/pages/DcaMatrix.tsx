import { useMemo, useState } from 'react';
import { useData } from '../api';

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
type Matrix = {
  methodologyVersion: string; classification: string;
  params: { from: string; costBps: number; holdoutPct: number; contributionUsd: number };
  dataset: Dataset; cells: Cell[]; note: string;
};

const pct = (v: number | null | undefined, digits = 1) => v == null ? '—' : `${v.toFixed(digits)}%`;
const usd = (v: number | null | undefined) => v == null ? '—'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: Math.abs(v) >= 1e6 ? 'compact' : 'standard', maximumFractionDigits: Math.abs(v) >= 1e6 ? 2 : 0 }).format(v);

/** Tints a cell by how its IRR compares to the DCA-hold benchmark over the same window
 *  -- the matrix's whole point is showing which guard/trigger pairs actually beat just
 *  buying every month and holding, not a raw return heatmap. */
function cellTone(cell: Cell): string {
  if (cell.error || cell.moneyWeightedReturnPct == null || cell.dcaHold?.moneyWeightedReturnPct == null) return '';
  return cell.moneyWeightedReturnPct > cell.dcaHold.moneyWeightedReturnPct ? 'dca-cell-beats' : 'dca-cell-lags';
}

export function DcaMatrix() {
  const { result, loading, error, reload } = useData<Matrix>('/backtest/dca-matrix');
  const d = result?.data;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const { entries, exits, byKey } = useMemo(() => {
    if (!d) return { entries: [] as { key: string; label: string }[], exits: [] as { key: string; label: string }[], byKey: new Map<string, Cell>() };
    const entries: { key: string; label: string }[] = [];
    const exits: { key: string; label: string }[] = [];
    const byKey = new Map<string, Cell>();
    for (const cell of d.cells) {
      if (!entries.some(e => e.key === cell.entryKey)) entries.push({ key: cell.entryKey, label: cell.entryLabel });
      if (!exits.some(e => e.key === cell.exitKey)) exits.push({ key: cell.exitKey, label: cell.exitLabel });
      byKey.set(`${cell.entryKey}::${cell.exitKey}`, cell);
    }
    return { entries, exits, byKey };
  }, [d]);

  const selected = selectedKey ? byKey.get(selectedKey) ?? null : null;

  if (loading) return <p>Running the DCA matrix…</p>;
  if (error || !d) return <p role="alert">Unable to load the DCA matrix. <button onClick={reload}>Try again</button></p>;

  return <section className="dca-matrix-workspace" aria-label="DCA Matrix">
    <div className="dca-matrix-intro"><span className="eyebrow">BACKTEST</span><h2>BTC DCA Matrix</h2>
      <p>Every entry guard crossed with every exit trigger, monthly ${d.params.contributionUsd.toLocaleString('en-US')} DCA,
        {' '}{d.params.costBps}bps cost, from {d.params.from}. {d.note}</p></div>

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
              return <td key={ex.key} className={cellTone(cell)}>
                <button type="button" onClick={() => setSelectedKey(key)} className={selectedKey === key ? 'dca-cell-selected' : ''}>
                  {pct(cell.moneyWeightedReturnPct)}
                </button>
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>
    <p className="dca-matrix-legend">Cell = strategy IRR. Green beats the DCA-hold benchmark over the same window, red lags it. Click a cell for the full breakdown.</p>

    {selected && !selected.error && <section className="dca-matrix-detail" aria-label="Cell detail">
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
    </section>}

    <p className="dca-matrix-dataset">{d.dataset.source} · {d.dataset.firstObservedAt?.slice(0, 10)} → {d.dataset.lastObservedAt?.slice(0, 10)} · {d.dataset.classification}</p>
  </section>;
}
