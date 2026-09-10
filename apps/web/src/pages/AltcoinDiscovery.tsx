import { useState } from 'react';
import { useData } from '../api';
import { MetricCard, evidenceDate, status, type Evidence } from '../components/Evidence';

type Check = 'pass' | 'fail' | 'unknown';
type Coverage = Evidence;
type Returns = { d7: number | null; d30: number | null; d90: number | null };
type Attention = { ranked: boolean; score: number | null; missingInputs: string[]; reason: string | null;
  percentiles: { excess90d: number; excess30d: number; volumeAcceleration: number } | null };
type Project = {
  assetId: string; symbol: string; name: string; rank: number | null; priceUsd: number | null;
  marketCapUsd: number | null; category: string | null; observedAt: string | null;
  providerChanges: { d1: number | null; d7: number | null; d30: number | null };
  returns: { usd: Returns; relative: Returns; benchmark: string; formula: string; limitations: string };
  risk: { volatility30dPct: number | null; volatility90dPct: number | null; maxDrawdown90dPct: number | null;
    drawdownRecoveryDays: number | null; drawdownRecovered: boolean | null; btcCorrelation90d: number | null;
    btcBeta90d: number | null; correlationSamples: number; formula: string; limitations: string };
  liquidity: { reportedVolume24hUsd: number | null; medianVolume30dUsd: number | null; volumeAcceleration: number | null;
    volumeSamples: number; turnoverPct: number | null; formula: string; limitations: string };
  dilution: { circulatingSupply: number | null; totalSupply: number | null; maxSupply: number | null; fdvUsd: number | null;
    marketCapUsd: number | null; fdvToMarketCap: number | null; circulatingOfTotalPct: number | null;
    circulatingOfMaxPct: number | null; unlockSchedule: string; formula: string; limitations: string };
  identity: { excluded: boolean; reason: string | null; canonicalAssetId: string | null; evidence: string | null;
    pegSymbolMatch: string | null; pegSymbolNote: string | null };
  eligibility: { marketCap: Check; history: Check; medianVolume: Check; identity: Check; eligible: boolean;
    blockedBy: string[]; contiguousHistoryDays: number; archivedPriceSamples: number; rule: string };
  attention: Attention | null;
  valueCapture: { status: string; note: string };
  peers: { status: string; category: string | null; note: string };
  evidence: { whyAppeared: string[]; firstTriggeredAt: string | null; gaps: string[]; contradictions: string[];
    savedConditions: { assetId: string; title: string; metric: string; comparator: string; threshold: number }[];
    historicalOutcomes: string };
};
type Emerging = {
  rows: Project[];
  universe: { scope: string; tracked: number; eligible: number; filtered: number; returned: number;
    withArchivedPrices: number; withNinetyDayHistory: number; withMedianVolume: number; curatedExclusions: number;
    pegSymbolMatches: number; unknownChecks: { marketCap: number; history: number; medianVolume: number };
    failedChecks: { marketCap: number; history: number; medianVolume: number; identity: number }; expansion: string; youngProjects: string };
  attention: { label: string; prime: boolean; weights: Record<string, number>; ranked: number; unranked: number;
    population: Record<string, number>; formula: string; caveat: string; firstStudy: string };
  benchmark: { assetId: string; returns: Returns; archivedSamples: number; replayRefused: boolean };
  coverage: { market: Coverage | null; pegCatalog: Coverage | null;
    dailyHistories: { assets: number; replayRefused: boolean; scope: string } };
  sectors: { status: string; classified: number; tracked: number; note: string };
  methodology: { version: string; classification: string; snapshotAsOf: string | null; universe: string; eligibility: string;
    identity: string; attention: string; attentionCaveat: string; risk: string; valueCapture: string; launchDates: string; replay: string;
    replayRefusals: string[]; sources: string[] };
};
type Launch = {
  key: string; chain: string; tokenAddress: string; poolLabel: string | null; baseLabel: string | null; labelEvidence: string;
  lifecycle: { firstObservedAt: string | null; daysSinceFirstObserved: number | null; newestPoolFirstObservedAt: string | null;
    hasNewerPools: boolean; withinWindow: boolean; providerPoolCreatedAt: string | null; tokenLaunchAt: null;
    lastObservedAt: string | null; inLatestSample: boolean; evidence: string };
  liquidity: { liquidityUsd: number | null; unknownLiquidityPools: number; poolsObserved: number; poolsEverSampled: number;
    changeSincePrior: { comparisonAt: string | null; comparisonValue: number | null; elapsedHours: number | null;
      changePct: number | null; covered: boolean; poolsCompared: number; window: string; reason: string | null };
    quoteTokens: { address: string; symbol: string | null; kind: string; evidence: string }[]; verifiedQuote: boolean;
    formula: string; limitations: string };
  attention: { reported24hVolumeUsd: number | null; turnoverPct: number | null;
    transactions24h: { buys: number | null; sells: number | null }; buySellImbalancePct: number | null;
    priceUsd: number | null; pools: number; sampledPoolsNow: number; note: string };
  risk: { contract: string; sellRestrictions: string; mintOrFreezeAuthority: string; deployerHoldings: string;
    holderConcentration: string; liquidityWithdrawal: string; flags: string[]; criticalFlags: string[]; status: string; note: string };
  promotion: { boosts: string; orders: unknown; classification: string; observedAt: string | null };
  enrichment: { pairs: number; observedAt: string | null; scope: string };
  screen: { liquidity: Check; window: Check; shortlisted: boolean };
  whyAttracting: string[];
};
type Launches = {
  rows: Launch[];
  universe: { scope: string; tokens: number; filtered: number; returned: number; poolsEverSampled: number;
    withinWindow: number; shortlisted: number; unknownLiquidity: number; belowMinimumLiquidity: number;
    multiPoolTokens: number; tokensWithLaterPools: number; withEnrichment: number; withPromotion: number };
  chains: { chain: string; datasetId: string; coverage: Coverage; tokens: number; shortlisted: number;
    unknownLiquidity: number; pools: number }[];
  riskGate: { verifiedChecks: number; criticalFlagsResolved: number; excludedForCriticalFlags: number; rule: string };
  methodology: { version: string; classification: string; snapshotAsOf: string | null; scope: string; identity: string;
    liquidity: string; promotion: string; risk: string; launchDates: string; replay: string;
    replayRefusals: string[]; sources: string[] };
};

const compact = (value: number | null | undefined) => value == null ? 'Unavailable'
  : `$${value.toLocaleString('en-US', { notation: Math.abs(value) >= 1e6 ? 'compact' : 'standard', maximumFractionDigits: 2 })}`;
const pct = (value: number | null | undefined, digits = 2) => value == null ? 'Unavailable'
  : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
const plain = (value: number | null | undefined, digits = 2) => value == null ? 'Unavailable' : value.toFixed(digits);
const sign = (value: number | null | undefined) => value == null ? '' : value < 0 ? 'down' : value > 0 ? 'up' : '';
const label = (value: string) => value.replaceAll('-', ' ');
const verdict = (check: Check) => check === 'pass' ? '✓ pass' : check === 'fail' ? '✗ fail' : '? unknown';
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function Cell({ value, format = pct }: { value: number | null; format?: (value: number | null) => string }) {
  return <td className={sign(value)}>{value == null ? '—' : format(value)}</td>;
}

function EmergingView() {
  const [screen, setScreen] = useState<'eligible' | 'all'>('eligible');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const path = `/altcoin/emerging?screen=${screen}&limit=150${applied ? `&search=${encodeURIComponent(applied)}` : ''}`;
  const { result, loading, error, reload } = useData<Emerging>(path);
  const d = result?.data;
  if (loading) return <p>Loading archived tracked-page evidence…</p>;
  if (error || !d || !result) return <p role="alert">Unable to load Emerging Projects. <button onClick={reload}>Try again</button></p>;
  const { universe, attention, coverage, benchmark } = d;
  return <>
    <section className="panel btc-method" aria-label="Eligible universe">
      <div className="panelhead"><div><h2>Eligible universe</h2><span>{universe.scope}</span></div></div>
      <div className="context-grid">
        <MetricCard defaultSource="CoinGecko" title="Tracked assets" value={String(universe.tracked)}
          metric={{ ...coverage.market, unavailable: !universe.tracked }}
          formula={`Exact membership of the newest archived tracked-page snapshot. ${universe.scope}`} />
        <MetricCard defaultSource="Archive" title="Eligible assets" value={String(universe.eligible)}
          metric={{ ...coverage.market, unavailable: universe.eligible === 0 }}
          formula={d.methodology.eligibility} />
        <MetricCard defaultSource="CoinGecko" title="With 90D archived history" value={`${universe.withNinetyDayHistory} of ${universe.tracked}`}
          metric={{ ...coverage.market, unavailable: !universe.withNinetyDayHistory, replayRefused: coverage.dailyHistories.replayRefused }}
          formula={`${coverage.dailyHistories.scope} ${universe.unknownChecks.history} assets have no archived daily price series at all, so their history screen is unknown rather than failed.`} />
        <MetricCard defaultSource="Archive" title="With a 30D volume median" value={`${universe.withMedianVolume} of ${universe.tracked}`}
          metric={{ ...coverage.market, unavailable: !universe.withMedianVolume }}
          formula={`A contiguous 30-day window of daily sampled trailing-24-hour volume is required. ${universe.unknownChecks.medianVolume} assets have none, so their volume screen is unknown.`} />
        <MetricCard defaultSource="Archive" title="Curated exclusions" value={String(universe.curatedExclusions)}
          metric={{ ...coverage.pegCatalog, unavailable: !universe.curatedExclusions }}
          formula={`${d.methodology.identity} ${universe.pegSymbolMatches} assets additionally carry a peg-catalog symbol collision, flagged for review only.`} />
        <MetricCard defaultSource="Archive" title="Ranked by Attention" value={`${attention.ranked} of ${universe.tracked}`}
          metric={{ ...coverage.market, unavailable: attention.ranked === 0 }}
          formula={`${attention.formula} ${attention.caveat}`} />
      </div>
      <p>{universe.expansion}</p>
      <p>{universe.youngProjects}</p>
      {universe.eligible === 0 && <p role="note">No asset passes every research default on this date.
        {' '}{universe.failedChecks.marketCap} fail the market-cap band, {universe.failedChecks.identity} carry a curated
        exclusion, and {universe.unknownChecks.history} have no archived daily history at all. Switch to all tracked assets
        to inspect each verdict, or widen the defaults — they are editable research settings, not validated thresholds.</p>}
    </section>

    <section className="panel btc-method" aria-label="Emerging Projects">
      <div className="panelhead"><div><h2>Emerging Projects</h2>
        <span>Sorted by archived 30-day return against {benchmark.assetId}, not by Attention</span></div></div>
      <div className="btc-controls">
        <label>Screen
          <select value={screen} onChange={event => setScreen(event.target.value as 'eligible' | 'all')}>
            <option value="eligible">Eligible universe</option>
            <option value="all">All tracked assets</option>
          </select></label>
        <label>Search
          <input value={search} placeholder="name or symbol" onChange={event => setSearch(event.target.value)} /></label>
        <button onClick={() => setApplied(search.trim())}>Apply</button>
        {applied && <button onClick={() => { setSearch(''); setApplied(''); }}>Clear</button>}
      </div>
      {d.rows.length ? <div className="btc-table-wrap"><table><thead><tr>
        <th>Asset</th><th>Market cap</th><th>Eligible</th><th>7D vs BTC</th><th>30D vs BTC</th><th>90D vs BTC</th>
        <th>Vol 90D</th><th>Max DD 90D</th><th>BTC beta</th><th>Median vol 30D</th><th>Attention</th></tr></thead>
        <tbody>{d.rows.map(row => <tr key={row.assetId}>
          <td>{row.name} <em>{row.symbol}</em></td>
          <td>{compact(row.marketCapUsd)}</td>
          <td className={row.eligibility.eligible ? 'up' : ''}>{row.eligibility.eligible ? 'yes'
            : row.eligibility.blockedBy.map(label).join(', ')}</td>
          <Cell value={row.returns.relative.d7} /><Cell value={row.returns.relative.d30} /><Cell value={row.returns.relative.d90} />
          <td>{pct(row.risk.volatility90dPct, 0)}</td>
          <td className={sign(row.risk.maxDrawdown90dPct)}>{pct(row.risk.maxDrawdown90dPct, 1)}</td>
          <td>{plain(row.risk.btcBeta90d)}</td>
          <td>{compact(row.liquidity.medianVolume30dUsd)}</td>
          <td>{row.attention?.ranked ? row.attention.score!.toFixed(1) : 'unranked'}</td></tr>)}</tbody></table></div>
        : <p>No archived asset matches this screen.</p>}
      <p>{universe.filtered} assets matched; {universe.returned} shown. {d.methodology.eligibility}</p>
      <p role="note">{attention.caveat} {attention.firstStudy}</p>
    </section>

    {d.rows.slice(0, 25).map(row => <section className="panel btc-method perp-evidence" key={row.assetId}
      aria-label={`Evidence for ${row.name}`}>
      <details><summary>{row.name} — why it appeared, contradictions, dilution and data gaps</summary>
        <div className="overview-figures">
          <div><span>Eligibility</span><strong>{row.eligibility.eligible ? 'eligible' : 'excluded'}</strong>
            <small>cap {verdict(row.eligibility.marketCap)} · history {verdict(row.eligibility.history)} · volume {verdict(row.eligibility.medianVolume)} · identity {verdict(row.eligibility.identity)}</small></div>
          <div><span>Archived history</span><strong>{row.eligibility.contiguousHistoryDays}d</strong>
            <small>{row.eligibility.archivedPriceSamples} archived daily samples</small></div>
          <div><span>Volatility 30D / 90D</span><strong>{pct(row.risk.volatility30dPct, 0)}</strong>
            <small>90D {pct(row.risk.volatility90dPct, 0)}</small></div>
          <div><span>Max drawdown 90D</span><strong>{pct(row.risk.maxDrawdown90dPct, 1)}</strong>
            <small>{row.risk.drawdownRecovered === null ? 'unavailable' : row.risk.drawdownRecovered
              ? `recovered in ${row.risk.drawdownRecoveryDays} days` : 'not yet recovered'}</small></div>
          <div><span>BTC correlation / beta</span><strong>{plain(row.risk.btcCorrelation90d)}</strong>
            <small>beta {plain(row.risk.btcBeta90d)} over {row.risk.correlationSamples} shared days</small></div>
          <div><span>FDV ÷ market cap</span><strong>{plain(row.dilution.fdvToMarketCap)}×</strong>
            <small>{row.dilution.circulatingOfTotalPct == null ? 'circulating share unavailable'
              : `${row.dilution.circulatingOfTotalPct.toFixed(0)}% of total supply circulating`}</small></div>
          <div><span>Reported turnover</span><strong>{pct(row.liquidity.turnoverPct, 1)}</strong>
            <small>24h volume ÷ market cap</small></div>
          <div><span>Attention</span><strong>{row.attention?.ranked ? row.attention.score!.toFixed(1) : 'unranked'}</strong>
            <small>{row.attention?.ranked ? `${row.attention.percentiles!.excess90d.toFixed(0)} / ${row.attention.percentiles!.excess30d.toFixed(0)} / ${row.attention.percentiles!.volumeAcceleration.toFixed(0)} percentiles`
              : row.attention?.reason ?? 'unavailable'}</small></div>
        </div>
        {row.evidence.whyAppeared.length > 0 && <><h3>Why it appeared</h3>
          <ul>{row.evidence.whyAppeared.map(reason => <li key={reason}>{reason}</li>)}</ul>
          <p>Signal first observed in this archive: {evidenceDate(row.evidence.firstTriggeredAt)}.</p></>}
        {row.evidence.contradictions.length > 0 && <><h3>Contradictory evidence</h3>
          <ul>{row.evidence.contradictions.map(note => <li key={note}>{note}</li>)}</ul></>}
        <h3>Data gaps</h3><ul>{row.evidence.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>
        <h3>Saved thesis conditions</h3>
        <ul>{row.evidence.savedConditions.length ? row.evidence.savedConditions.map(rule =>
          <li key={rule.title}>{rule.title} — {rule.metric} {rule.comparator} {rule.threshold}</li>)
          : <li>No saved condition for this asset. Add one from the Research workspace.</li>}</ul>
        <h3>Adoption, peers and value capture</h3>
        <ul><li>{row.peers.note}</li><li>{row.valueCapture.note}</li><li>{row.evidence.historicalOutcomes}</li></ul>
        <p>{row.returns.formula} {row.returns.limitations}</p>
        <p>{row.risk.formula} {row.risk.limitations}</p>
        <p>{row.dilution.formula} {row.dilution.limitations} Unlocks: {row.dilution.unlockSchedule}.</p>
        <p>{row.liquidity.formula} {row.liquidity.limitations}</p>
        {row.identity.evidence && <p>Identity: {row.identity.evidence}</p>}
        {row.identity.pegSymbolNote && <p role="note">{row.identity.pegSymbolNote}</p>}
      </details></section>)}

    <section className="panel btc-method"><details><summary>Formulas, universe and replay</summary>
      <p>{d.methodology.universe}</p><p>{d.methodology.eligibility}</p><p>{d.methodology.identity}</p>
      <p>{d.methodology.attention}</p><p>{d.methodology.attentionCaveat}</p><p>{d.methodology.risk}</p>
      <p>{d.methodology.valueCapture}</p><p>{d.methodology.launchDates}</p><p>{d.sectors.note}</p><p>{d.methodology.replay}</p>
      {d.methodology.replayRefusals.length > 0 && <p>Feeds refused at this cutoff: {d.methodology.replayRefusals.join(', ')}.</p>}
      <p>Tracked page: {status(coverage.market ?? {})} · {evidenceDate(coverage.market?.observedAt)}.
        {' '}Peg catalog: {status(coverage.pegCatalog ?? {})} · {evidenceDate(coverage.pegCatalog?.observedAt)}.
        {' '}Benchmark {benchmark.assetId}: {benchmark.archivedSamples} archived daily samples.</p>
      <p>Methodology {d.methodology.version} · {d.methodology.classification}
        {d.methodology.snapshotAsOf ? ` · cutoff ${evidenceDate(d.methodology.snapshotAsOf)}` : ''}.
        {' '}{d.methodology.sources.map((source, index) => <a key={source} href={source} target="_blank" rel="noreferrer">Source {index + 1} </a>)}</p>
    </details></section>
  </>;
}

function LaunchesView() {
  const [screen, setScreen] = useState<'new' | 'all'>('new');
  const [chain, setChain] = useState('');
  const [unknown, setUnknown] = useState(false);
  const path = `/altcoin/launches?screen=${screen}&includeUnknownLiquidity=${unknown}&limit=300${chain ? `&chain=${chain}` : ''}`;
  const { result, loading, error, reload } = useData<Launches>(path);
  const d = result?.data;
  if (loading) return <p>Loading sampled pool archives…</p>;
  if (error || !d || !result) return <p role="alert">Unable to load spot launches. <button onClick={reload}>Try again</button></p>;
  const { universe, riskGate } = d;
  return <>
    <section className="panel btc-method" aria-label="Sampled launch coverage">
      <div className="panelhead"><div><h2>Sampled launch coverage</h2><span>{universe.scope}</span></div></div>
      <div className="overview-figures">
        <div><span>Tokens observed</span><strong>{universe.tokens}</strong><small>from {universe.poolsEverSampled} sampled pools</small></div>
        <div><span>Within the window</span><strong>{universe.withinWindow}</strong><small>first observed inside the screen window</small></div>
        <div><span>Shortlisted</span><strong className={universe.shortlisted ? 'up' : ''}>{universe.shortlisted}</strong><small>meet the liquidity default</small></div>
        <div><span>Unknown liquidity</span><strong>{universe.unknownLiquidity}</strong><small>never counted as zero or as passing</small></div>
        <div><span>Below the minimum</span><strong>{universe.belowMinimumLiquidity}</strong><small>observed under the default</small></div>
        <div><span>Multi-pool tokens</span><strong>{universe.multiPoolTokens}</strong><small>{universe.tokensWithLaterPools} gained a later pool</small></div>
        <div><span>With enrichment</span><strong>{universe.withEnrichment}</strong><small>DEX Screener pair checks</small></div>
        <div><span>Paid promotion</span><strong>{universe.withPromotion}</strong><small>promotion, not demand</small></div>
      </div>
      <p>{d.methodology.identity}</p>
      <p role="note">{riskGate.rule}</p>
    </section>

    <section className="panel btc-method" aria-label="Chain coverage">
      <div className="panelhead"><div><h2>Chain coverage</h2><span>Each sampled chain declares its own freshness</span></div></div>
      <div className="context-grid">
        {d.chains.map(entry => <MetricCard key={entry.chain} defaultSource="GeckoTerminal" title={label(entry.chain)}
          value={`${entry.tokens} tokens`} metric={{ ...entry.coverage, unavailable: !entry.tokens }}
          formula={`${entry.pools} sampled pools, ${entry.shortlisted} shortlisted, ${entry.unknownLiquidity} with unknown liquidity. Dataset ${entry.datasetId}.`} />)}
      </div>
    </section>

    <section className="panel btc-method" aria-label="New spot launches">
      <div className="panelhead"><div><h2>New spot launches</h2>
        <span>Sorted by first observation in this archive, then observed liquidity</span></div></div>
      <div className="btc-controls">
        <label>Screen
          <select value={screen} onChange={event => setScreen(event.target.value as 'new' | 'all')}>
            <option value="new">Shortlist</option><option value="all">All observed tokens</option>
          </select></label>
        <label>Chain
          <select value={chain} onChange={event => setChain(event.target.value)}>
            <option value="">Both chains</option><option value="solana">Solana</option><option value="base">Base</option>
          </select></label>
        <label>Include unknown liquidity
          <input type="checkbox" checked={unknown} onChange={event => setUnknown(event.target.checked)} /></label>
      </div>
      {d.rows.length ? <div className="btc-table-wrap"><table><thead><tr>
        <th>Token</th><th>Chain</th><th>First observed</th><th>Liquidity</th><th>24H volume</th><th>Turnover</th>
        <th>Buy/sell</th><th>Pools</th><th>Risk</th><th>Promotion</th></tr></thead>
        <tbody>{d.rows.map(row => <tr key={row.key}>
          <td>{row.baseLabel ?? short(row.tokenAddress)} <em>{short(row.tokenAddress)}</em></td>
          <td>{label(row.chain)}</td>
          <td>{row.lifecycle.daysSinceFirstObserved == null ? 'Unknown'
            : row.lifecycle.daysSinceFirstObserved === 0 ? 'today' : `${row.lifecycle.daysSinceFirstObserved}d ago`}</td>
          <td>{compact(row.liquidity.liquidityUsd)}</td>
          <td>{compact(row.attention.reported24hVolumeUsd)}</td>
          <td>{pct(row.attention.turnoverPct, 0)}</td>
          <Cell value={row.attention.buySellImbalancePct} format={value => pct(value, 0)} />
          <td>{row.liquidity.poolsEverSampled}</td>
          <td>{row.risk.status}</td>
          <td>{row.promotion.boosts}</td></tr>)}</tbody></table></div>
        : <p>No observed token matches this screen.</p>}
      <p>{universe.filtered} tokens matched; {universe.returned} shown. {d.methodology.launchDates}</p>
    </section>

    {d.rows.slice(0, 25).map(row => <section className="panel btc-method perp-evidence" key={row.key}
      aria-label={`Evidence for ${row.baseLabel ?? row.tokenAddress}`}>
      <details><summary>{row.baseLabel ?? short(row.tokenAddress)} — attention, risk status, liquidity and lifecycle</summary>
        <div className="overview-figures">
          <div><span>Observed liquidity</span><strong>{compact(row.liquidity.liquidityUsd)}</strong>
            <small>{row.liquidity.poolsObserved} pools · {row.liquidity.unknownLiquidityPools} without a value</small></div>
          <div><span>Change since prior</span><strong>{pct(row.liquidity.changeSincePrior.changePct, 1)}</strong>
            <small>{row.liquidity.changeSincePrior.covered
              ? `over ${row.liquidity.changeSincePrior.elapsedHours?.toFixed(1)}h` : 'not comparable'}</small></div>
          <div><span>Risk status</span><strong>{row.risk.status}</strong><small>no verified contract check exists</small></div>
          <div><span>Quote reference</span><strong>{row.liquidity.verifiedQuote ? 'verified' : 'unverified'}</strong>
            <small>{row.liquidity.quoteTokens.map(quote => quote.symbol ?? 'unrecognised').join(', ') || 'unavailable'}</small></div>
          <div><span>Price</span><strong>{row.attention.priceUsd == null ? 'Unavailable' : `$${row.attention.priceUsd}`}</strong>
            <small>{row.enrichment.pairs} enrichment observations</small></div>
          <div><span>Transactions 24H</span><strong>{row.attention.transactions24h.buys ?? '—'} / {row.attention.transactions24h.sells ?? '—'}</strong>
            <small>buys / sells; not distinct traders</small></div>
        </div>
        {row.whyAttracting.length > 0 && <><h3>Why it is attracting attention</h3>
          <ul>{row.whyAttracting.map(reason => <li key={reason}>{reason}</li>)}</ul></>}
        <h3>Risk and coverage flags</h3><ul>{row.risk.flags.map(flag => <li key={flag}>{flag}</li>)}</ul>
        <h3>Lifecycle</h3>
        <ul><li>First observed here: {evidenceDate(row.lifecycle.firstObservedAt)}</li>
          <li>Newest pool first observed: {evidenceDate(row.lifecycle.newestPoolFirstObservedAt)}
            {row.lifecycle.hasNewerPools ? ' — a later pool did not reset this token’s first observation.' : ''}</li>
          <li>Provider pool creation: {evidenceDate(row.lifecycle.providerPoolCreatedAt)} — a pool creation time, not a token launch.</li>
          <li>Last observed: {evidenceDate(row.lifecycle.lastObservedAt)}{row.lifecycle.inLatestSample ? '' : ' — absent from the newest sample; its last observation is retained.'}</li>
          <li>Verified token launch: {row.lifecycle.tokenLaunchAt ?? 'unavailable'}</li></ul>
        <p>{row.lifecycle.evidence}</p>
        <p>{row.liquidity.formula} {row.liquidity.limitations}</p>
        <p>{row.attention.note} {row.risk.note}</p>
        <p>{row.promotion.classification} Promotion observed: {evidenceDate(row.promotion.observedAt)}. {row.labelEvidence}</p>
        <p>Contract address: {row.tokenAddress}</p>
      </details></section>)}

    <section className="panel btc-method"><details><summary>Formulas, coverage and replay</summary>
      <p>{d.methodology.scope}</p><p>{d.methodology.identity}</p><p>{d.methodology.liquidity}</p>
      <p>{d.methodology.promotion}</p><p>{d.methodology.risk}</p><p>{d.methodology.launchDates}</p><p>{d.methodology.replay}</p>
      {d.methodology.replayRefusals.length > 0 && <p>Feeds refused at this cutoff: {d.methodology.replayRefusals.join(', ')}.</p>}
      <p>Methodology {d.methodology.version} · {d.methodology.classification}
        {d.methodology.snapshotAsOf ? ` · cutoff ${evidenceDate(d.methodology.snapshotAsOf)}` : ''}.
        {' '}{d.methodology.sources.map((source, index) => <a key={source} href={source} target="_blank" rel="noreferrer">Source {index + 1} </a>)}</p>
    </details></section>
  </>;
}

const views = [{ id: 'emerging' as const, label: 'Emerging Projects' }, { id: 'launches' as const, label: 'Spot Launches' }];

export function AltcoinDiscovery() {
  const [view, setView] = useState<'emerging' | 'launches'>('emerging');
  return <div className="btc-workspace overview-workspace">
    <div className="btc-intro"><div><span className="eyebrow">ALTCOIN DISCOVERY · FORWARD TRACKING</span>
      <h2>Which altcoins deserve investigation, and what evidence supports them?</h2>
      <p>Established projects and brand-new tokens are researched separately. Every screen states whether a check passed,
        failed or is simply unknown, and an unknown check never becomes a passing result.</p></div>
      <a href="#data-health">Inspect Data Health →</a></div>
    <div className="btc-controls" role="tablist" aria-label="Altcoin discovery views">
      {views.map(entry => <button key={entry.id} role="tab" aria-selected={view === entry.id}
        className={view === entry.id ? 'active' : ''} onClick={() => setView(entry.id)}>{entry.label}</button>)}
    </div>
    {view === 'emerging' && <EmergingView />}
    {view === 'launches' && <LaunchesView />}
  </div>;
}
