import { useMemo } from 'react';
import { useData } from '../api';
import { ResearchChart } from '../components/ResearchChart';
import { MetricCard, evidenceDate, status, type Evidence } from '../components/Evidence';

type Asset = { id: string; symbol: string; name: string; rank: number | null; priceUsd: number | null;
  marketCapUsd: number | null; volume24hUsd: number | null; change24h: number | null };
type Sampled = { observedAt: string; acquiredAt: string; marketCapUsd: number | null; volume24hUsd: number | null; btcDominance: number | null };
type Change = { changePct: number | null; comparisonAt: string | null; comparisonValue: number | null };
type CoveredAsset = { assetId: string; symbol: string; name: string; observedAt: string | null; samples: number;
  closeUsd: number | null; sma50: number | null; sma200: number | null; above50d: boolean | null; above200d: boolean | null };
type Overview = {
  global: { marketCapUsd: number | null; volume24hUsd: number | null; btcDominance: number | null; ethDominance: number | null;
    evidence: Evidence; formula: string; limitations: string };
  reportedVolume: { points: Sampled[]; latest: Sampled | null; change24h: Change; change7d: Change;
    coverage: Evidence & { samples: number; first: string | null; last: string | null };
    formula: string; interpretation: string; limitations: string };
  breadth: { advancing: number; declining: number; unchanged: number; unknown: number; total: number;
    scope: string; evidence: Evidence; formula: string; limitations: string };
  averages: { assets: CoveredAsset[]; sma50: { above: number; covered: number; percent: number | null };
    sma200: { above: number; covered: number; percent: number | null }; tracked: number; scope: string; formula: string; limitations: string };
  btc: { regime: string; candidate: string; confirmationDays: number; observedAt: string | null; closeUsd: number | null;
    sma200Usd: number | null; sma200Slope20d: number | null; mayerMultiple: number | null; mvrv: number | null;
    drawdownPct: number | null; volatility30d: number | null; weeklyRsi: number | null; evidence: Evidence & { values: number };
    rule: string | null; interpretation: string; limitations: string };
  liquidity: { stablecoin: { value: number | null; observedAt: string | null; comparisonAt: string | null; comparisonValue: number | null;
      changePct: number | null; changeUsd: number | null; values: number; first: string | null; coverage: Evidence;
      formula: string; interpretation: string; limitations: string };
    reportedVolume: { latest: number | null; change24hPct: number | null; change7dPct: number | null; coverage: Evidence } };
  performance: { benchmark: string; benchmarkReturns: { d7: number | null; d30: number | null; d90: number | null };
    rows: { assetId: string; symbol: string; name: string; observedAt: string | null; samples: number;
      usd: { d7: number | null; d30: number | null; d90: number | null };
      relative: { d7: number | null; d30: number | null; d90: number | null } }[];
    unarchivedAssets: string[]; replayRefused: boolean; scope: string; formula: string; limitations: string };
  reportedChanges: { leaders: Asset[]; laggards: Asset[]; scope: string; window: string; limitations: string };
  sectors: { status: string; tracked: number; classified: number; unclassified: number;
    categories: { category: string; assets: number; marketCapUsd: number; members: string[]; classifiedSharePct: number | null }[];
    coverage: string; limitations: string };
  signalChanges: { type: string; observedAt: string | null; title: string; detail: string; evidence: Record<string, unknown> }[];
  methodology: { version: string; classification: string; snapshotAsOf: string | null; scope: string; degradation: string;
    replay: string; replayRefusals: string[]; sources: string[] };
};

const compact = (value: number | null | undefined) => value == null ? 'Unavailable'
  : `$${value.toLocaleString('en-US', { notation: Math.abs(value) >= 1e6 ? 'compact' : 'standard', maximumFractionDigits: 2 })}`;
const pct = (value: number | null | undefined, digits = 2) => value == null ? 'Unavailable'
  : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
const ratio = (value: number | null | undefined, suffix = '') => value == null ? 'Unavailable'
  : `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;
const sign = (value: number | null | undefined) => value == null ? '' : value < 0 ? 'down' : value > 0 ? 'up' : '';
const label = (value: string) => value.replaceAll('-', ' ');

function ReturnCell({ value }: { value: number | null }) {
  return <td className={sign(value)}>{value == null ? '—' : pct(value)}</td>;
}

export function MarketOverview({ select }: { select: (id: string) => void }) {
  const { result, loading, error, reload } = useData<Overview>('/market/overview');
  const d = result?.data;
  const charts = useMemo(() => {
    const rows = d?.reportedVolume.points ?? [];
    const x = rows.map(row => Date.parse(row.observedAt) / 1000);
    return { x, volume: [{ label: 'Provider-global reported 24h volume (USD)', color: '#71bcdf', values: rows.map(row => row.volume24hUsd) }],
      participation: [{ label: 'Provider-global market cap (USD)', color: '#e8ba68', values: rows.map(row => row.marketCapUsd) }],
      dominance: [{ label: 'BTC dominance (%)', color: '#b399e2', values: rows.map(row => row.btcDominance) }] };
  }, [d]);
  if (loading) return <p>Loading archived market conditions…</p>;
  if (error || !d || !result) return <p role="alert">Unable to load the market overview. <button onClick={reload}>Try again</button></p>;
  const { global, breadth, averages, btc, liquidity, performance, reportedChanges, sectors, reportedVolume } = d;
  return <div className="btc-workspace overview-workspace">
    <div className="btc-intro"><div><span className="eyebrow">MARKET CONDITIONS · {d.methodology.classification.toUpperCase()}</span>
      <h2>What environment are we in?</h2>
      <p>{d.methodology.scope}</p></div><a href="#data-health">Inspect Data Health →</a></div>
    <div className={`status ${result.metadata.stale ? 'stale' : ''}`}><span>{result.metadata.source}</span>
      <span>{result.metadata.coverage}</span><span>{result.metadata.stale ? 'ONE OR MORE FEEDS STALE' : 'ALL SURFACED FEEDS CURRENT'}</span></div>

    <section className="panel btc-method" aria-label="Market conditions summary">
      <div className="panelhead"><div><h2>Conditions</h2><span>Each figure carries its own scope, freshness and formula</span></div></div>
      <div className="context-grid">
        <MetricCard defaultSource="CoinGecko" title="Provider global market cap" metric={global.evidence} value={compact(global.marketCapUsd)} formula={global.formula} />
        <MetricCard defaultSource="CoinGecko" title="Provider global 24h volume" metric={global.evidence} value={compact(global.volume24hUsd)}
          formula={`${reportedVolume.formula} 24h change: ${pct(reportedVolume.change24h.changePct)}; 7D change: ${pct(reportedVolume.change7d.changePct)}.`} />
        <MetricCard defaultSource="CoinGecko" title="BTC dominance" metric={global.evidence}
          value={global.btcDominance == null ? 'Unavailable' : `${global.btcDominance.toFixed(1)}%`}
          formula={`Provider market-cap percentage. ETH: ${global.ethDominance == null ? 'Unavailable' : `${global.ethDominance.toFixed(1)}%`}. ${global.limitations}`} />
        <MetricCard defaultSource="Coin Metrics" title="BTC regime" metric={btc.evidence} value={label(btc.regime)}
          formula={`${btc.rule ?? 'Regime rule unavailable.'} Candidate: ${label(btc.candidate)} · Confirmation ${btc.confirmationDays}/3.`} />
        <MetricCard defaultSource="DefiLlama" title="Covered stablecoin supply" metric={liquidity.stablecoin.coverage}
          value={compact(liquidity.stablecoin.value)} formula={liquidity.stablecoin.formula} />
        <MetricCard defaultSource="DefiLlama" title="Stablecoin supply · 30D" metric={{ ...liquidity.stablecoin.coverage, unavailable: liquidity.stablecoin.changePct == null }}
          value={pct(liquidity.stablecoin.changePct)}
          formula={`Compared with ${evidenceDate(liquidity.stablecoin.comparisonAt)}: ${compact(liquidity.stablecoin.comparisonValue)}. Absolute change: ${compact(liquidity.stablecoin.changeUsd)}. ${liquidity.stablecoin.interpretation}`} />
      </div>
      <p>{liquidity.stablecoin.limitations}</p>
    </section>

    <section className="panel btc-method" aria-label="BTC regime evidence">
      <div className="panelhead"><div><h2>BTC regime</h2><span>Trend, valuation and risk shown side by side</span></div><a href="#btc">Open BTC Cycles →</a></div>
      <div className="overview-figures">
        {[['Completed close', compact(btc.closeUsd)], ['200D SMA', compact(btc.sma200Usd)], ['20-day SMA change', compact(btc.sma200Slope20d)],
          ['Mayer Multiple', ratio(btc.mayerMultiple, '×')], ['Coin Metrics MVRV', ratio(btc.mvrv, '×')],
          ['Drawdown from observed ATH', ratio(btc.drawdownPct, '%')], ['30D realized volatility', ratio(btc.volatility30d, '%')],
          ['Weekly Wilder RSI', ratio(btc.weeklyRsi)]].map(([name, value]) => <div key={name}><span>{name}</span><strong>{value}</strong></div>)}
      </div>
      <p>{btc.interpretation}</p><p>{btc.limitations} Price day: {evidenceDate(btc.observedAt)} · {btc.evidence.values} archived daily values · {status(btc.evidence)}.</p>
    </section>

    <section className="panel btc-method" aria-label="Market breadth">
      <div className="panelhead"><div><h2>Breadth</h2><span>{breadth.scope}</span></div></div>
      <div className="overview-figures">
        <div><span>Advancing</span><strong className="up">{breadth.advancing}</strong></div>
        <div><span>Declining</span><strong className="down">{breadth.declining}</strong></div>
        <div><span>Unchanged</span><strong>{breadth.unchanged}</strong></div>
        <div><span>Unknown 24h change</span><strong>{breadth.unknown}</strong></div>
        <div><span>Snapshot membership</span><strong>{breadth.total}</strong></div>
        <div><span>Above own 50D average</span><strong>{averages.sma50.percent == null ? 'Unavailable' : `${averages.sma50.percent.toFixed(0)}%`}</strong>
          <small>{averages.sma50.above} of {averages.sma50.covered} covered</small></div>
        <div><span>Above own 200D average</span><strong>{averages.sma200.percent == null ? 'Unavailable' : `${averages.sma200.percent.toFixed(0)}%`}</strong>
          <small>{averages.sma200.above} of {averages.sma200.covered} covered</small></div>
      </div>
      <p>{breadth.formula} {breadth.limitations}</p>
      <p><b>Average coverage:</b> {averages.scope}. {averages.limitations}</p>
      {averages.assets.length > 0 && <div className="btc-table-wrap"><table><thead><tr>
        <th>Asset</th><th>Completed close</th><th>50D average</th><th>200D average</th><th>Above 50D / 200D</th><th>Archived samples</th></tr></thead>
        <tbody>{averages.assets.map(asset => <tr key={asset.assetId}>
          <td><button className="asset-link" onClick={() => select(asset.assetId)}>{asset.symbol}</button> {asset.name}</td>
          <td>{compact(asset.closeUsd)}</td><td>{compact(asset.sma50)}</td><td>{compact(asset.sma200)}</td>
          <td>{asset.above50d === null ? 'Uncovered' : asset.above50d ? 'Above' : 'Below'} / {asset.above200d === null ? 'Uncovered' : asset.above200d ? 'Above' : 'Below'}</td>
          <td>{asset.samples}</td></tr>)}</tbody></table></div>}
    </section>

    <ResearchChart title="Provider-global market capitalization (USD)" x={charts.x} lines={charts.participation} syncKey="overview-time" height={230}
      attribution="CoinGecko provider-global aggregates · Sampled hourly from this archive onward" />
    <ResearchChart title="Provider-global reported 24h volume (USD)" x={charts.x} lines={charts.volume} syncKey="overview-time" height={230}
      attribution="CoinGecko provider-global aggregates · Sampled hourly from this archive onward" />
    <ResearchChart title="BTC dominance (%)" x={charts.x} lines={charts.dominance} syncKey="overview-time" height={210}
      attribution="CoinGecko provider market-cap percentage · Sampled hourly from this archive onward" />
    <p className="chart-help">{reportedVolume.interpretation} {reportedVolume.limitations} Archived samples: {reportedVolume.coverage.samples} · {evidenceDate(reportedVolume.coverage.first)} – {evidenceDate(reportedVolume.coverage.last)}.</p>

    <section className="panel btc-method" aria-label="Relative performance">
      <div className="panelhead"><div><h2>Relative performance</h2><span>{performance.scope}</span></div></div>
      {performance.rows.length ? <div className="btc-table-wrap"><table><thead><tr>
        <th>Asset</th><th>7D USD</th><th>30D USD</th><th>90D USD</th><th>7D vs BTC</th><th>30D vs BTC</th><th>90D vs BTC</th><th>Last completed day</th></tr></thead>
        <tbody>{performance.rows.map(row => <tr key={row.assetId}>
          <td><button className="asset-link" onClick={() => select(row.assetId)}>{row.symbol}</button> {row.name}</td>
          <ReturnCell value={row.usd.d7} /><ReturnCell value={row.usd.d30} /><ReturnCell value={row.usd.d90} />
          <ReturnCell value={row.relative.d7} /><ReturnCell value={row.relative.d30} /><ReturnCell value={row.relative.d90} />
          <td>{row.observedAt?.slice(0, 10) ?? 'Unavailable'}</td></tr>)}</tbody></table></div>
        : <p>No archived daily price histories cover this cutoff yet.</p>}
      <p>{performance.formula} {performance.limitations}</p>
      {performance.unarchivedAssets.length > 0 && <p>{performance.unarchivedAssets.length} tracked {performance.unarchivedAssets.length === 1 ? 'asset has' : 'assets have'} no archived daily history and {performance.unarchivedAssets.length === 1 ? 'is' : 'are'} absent here: {performance.unarchivedAssets.slice(0, 12).join(', ')}{performance.unarchivedAssets.length > 12 ? '…' : ''}.</p>}
    </section>

    <section className="panel btc-method" aria-label="Provider-reported movers">
      <div className="panelhead"><div><h2>Provider-reported movers</h2><span>{reportedChanges.window} · {reportedChanges.scope}</span></div>
        <button onClick={() => (location.hash = 'assets')}>View all tracked assets →</button></div>
      <div className="overview-movers">
        {[['Largest reported gains', reportedChanges.leaders], ['Largest reported declines', reportedChanges.laggards]].map(([title, rows]) =>
          <div key={title as string}><h3>{title as string}</h3><table><thead><tr><th>Asset</th><th>Price</th><th>24h</th><th>Market cap</th></tr></thead>
            <tbody>{(rows as Asset[]).length ? (rows as Asset[]).map(asset => <tr key={asset.id}>
            <td><button className="asset-link" onClick={() => select(asset.id)}>{asset.symbol}</button></td>
            <td>{compact(asset.priceUsd)}</td><td className={sign(asset.change24h)}>{pct(asset.change24h)}</td>
            <td>{compact(asset.marketCapUsd)}</td></tr>) : <tr><td colSpan={4}>No separate entries at this membership size.</td></tr>}</tbody></table></div>)}
      </div>
      <p>{reportedChanges.limitations}</p>
    </section>

    <section className="panel btc-method" aria-label="Notable signal changes">
      <div className="panelhead"><div><h2>Notable changes</h2><span>Confirmed regime transitions, saved thesis crossings and tracked-page membership</span></div></div>
      {d.signalChanges.length ? <ul className="overview-changes">{d.signalChanges.map((change, index) => <li key={`${change.type}-${index}`}>
        <span className={`change-tag ${change.type}`}>{label(change.type)}</span>
        <div><b>{change.title}</b><small>{evidenceDate(change.observedAt)}</small><p>{change.detail}</p></div></li>)}</ul>
        : <p>No confirmed regime transitions, threshold crossings or membership changes are recorded for this cutoff.</p>}
    </section>

    <section className="panel btc-method" aria-label="Sector leadership">
      <div className="panelhead"><div><h2>Sector leadership</h2><span>Status: {sectors.status}</span></div></div>
      <p>{sectors.classified} of {sectors.tracked} tracked assets carry a curated classification; {sectors.unclassified} remain unclassified. {sectors.coverage}.</p>
      {sectors.categories.length > 0 && <div className="btc-table-wrap"><table><thead><tr><th>Curated category</th><th>Classified assets</th><th>Market cap</th><th>Share of classified</th><th>Members</th></tr></thead>
        <tbody>{sectors.categories.map(row => <tr key={row.category}><td>{row.category}</td><td>{row.assets}</td><td>{compact(row.marketCapUsd)}</td>
          <td>{row.classifiedSharePct == null ? 'Unavailable' : `${row.classifiedSharePct.toFixed(1)}%`}</td><td>{row.members.join(', ')}</td></tr>)}</tbody></table></div>}
      <p>{sectors.limitations}</p>
    </section>

    <section className="panel btc-method"><details><summary>Formulas, scope and replay</summary>
      <p>{d.methodology.scope}</p><p>{d.methodology.degradation}</p><p>{d.methodology.replay}</p>
      {d.methodology.replayRefusals.length > 0 && <p>Feeds refused at this cutoff: {d.methodology.replayRefusals.join(', ')}.</p>}
      <p>{global.formula}</p><p>{averages.formula}</p><p>{performance.formula}</p><p>{liquidity.stablecoin.formula}</p>
      <p>Methodology {d.methodology.version} · {d.methodology.classification}{d.methodology.snapshotAsOf ? ` · cutoff ${evidenceDate(d.methodology.snapshotAsOf)}` : ''}.
        {' '}{d.methodology.sources.map((source, index) => <a key={source} href={source} target="_blank" rel="noreferrer">Source {index + 1} </a>)}</p>
    </details></section>
  </div>;
}
