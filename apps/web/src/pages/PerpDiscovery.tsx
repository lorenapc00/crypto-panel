import { useMemo, useState } from 'react';
import { api, useData } from '../api';
import { ResearchChart } from '../components/ResearchChart';
import { MetricCard, evidenceDate, status, type Evidence } from '../components/Evidence';

type Point = { observedAt: string; value: number | null };
type Coverage = Evidence;
type Milestone = { type: string; observedAt: string | null; evidence: string };
type Project = {
  key: string; protocolId: string; slug: string | null; name: string | null; category: string | null;
  chains: string[]; parentProtocol: string | null; methodologyUrl: string | null; stage: string; tokenLink: string | null;
  token: { assetId: string; symbol: string; name: string; priceUsd: number | null; marketCapUsd: number | null;
    verifiedTerms: boolean; unlocks: string; valueCapture: string } | null;
  venue: { venue: string; namespace: string; evidence: string; instruments?: number; active?: number;
    openInterestNative?: number | null; estimatedOpenInterestQuote?: number | null;
    reported24hNotionalVolume?: number | null; observedAt?: string | null } | null;
  adoption: { covered: boolean; openInterestUsd: number | null; tvlUsd: number | null;
    openInterest7DaysAgoUsd: number | null; openInterest30DaysAgoUsd: number | null;
    openInterestChange7dPct: number | null; openInterestChange30dPct: number | null;
    providerChangePct1d: number | null; providerChangePct7d: number | null;
    openInterestShareOfCoveredPct: number | null; convention: string | null;
    reportedVolumeUsd: null; volumeSharePct: null; volumeGate: string };
  economics: { archived: boolean; scopeMatch: string | null; linkedAssetId: string | null; linkEvidence: string | null;
    fees30dUsd: number | null; feesGrowth30dPct: number | null; revenue30dUsd: number | null; revenueGrowth30dPct: number | null;
    holderRevenue30dUsd: number | null; holderRevenueGrowth30dPct: number | null; retainedFeeSharePct: number | null;
    archivedTvlUsd: number | null; effectiveFeeRate: null; coverage: string; definitions: string };
  milestones: Milestone[];
  lifecycle: { firstObservedAt: string | null; daysSinceFirstObserved: number | null; verifiedProtocolLaunchAt: string | null;
    verifiedTokenLaunchAt: string | null; verifiedMilestoneAt: string | null; launchDates: string; baseline: boolean };
  risks: string[]; whyWatch: string[]; contradictions: string[];
};
type Projects = {
  rows: Project[];
  aggregate: { points: Point[]; latest: Point | null; change7dPct: number | null; change30dPct: number | null;
    values: number; first: string | null; seriesId: string | null; replayCoverageStart: string | null;
    replayRefused: boolean; scope: string; formula: string; limitations: string };
  universe: { scope: string; matched: number; filtered: number; returned: number; catalogProtocols: number;
    catalogDerivatives: number; coveredOpenInterestProtocols: number; withVenueLink: number;
    withArchivedFundamentals: number; withVerifiedMilestone: number; withCoveredOpenInterest: number };
  earlyFilter: { window: string; defaultWindowDays: number; eligible: number; explanation: string };
  sorting: { applied: string; fallback: string; tieBreak: string; disabled: string[]; reason: string };
  coverage: { catalog: Coverage | null; openInterest: Coverage | null; openInterestNotes: Record<string, unknown> | null };
  methodology: { version: string; classification: string; snapshotAsOf: string | null; universe: string; openInterest: string;
    fundamentals: string; lifecycle: string; tokens: string; volume: string; replay: string; replayRefusals: string[]; sources: string[] };
};
type Listing = {
  key: string; datasetId: string; venue: string; namespace: string; instrument: string; baseSymbol: string; index: number | null;
  listing: { classification: string; firstObservedAt: string | null; daysSinceFirstObserved: number | null;
    verifiedTradingStartAt: string | null; announcedAt: string | null; suspendedAt: string | null; delistedAt: string | null;
    baseline: boolean; status: string; inLatestCatalog: boolean; lastObservedAt: string | null;
    firstObservedAnywhereAt: string | null; firstObservedAnywhere: boolean; alsoListedInNamespaces: string[]; evidence: string };
  underlying: { assetId: string | null; assetClass: string; linkEvidence: string | null; preMarket: string;
    spot: { observedAt: string | null; samples: number; usd: { d1: number | null; d7: number | null; d30: number | null };
      relativeToBtc: { d1: number | null; d7: number | null; d30: number | null }; scope: string } | null };
  market: { openInterestNative: number | null; openInterestUnit: string | null; estimatedOpenInterestQuote: number | null;
    quoteCurrency: string | null; notionalMethod: string | null; markPrice: number | null; oraclePrice: number | null;
    premiumBps: number | null; providerPremium: number | null; fundingRate: number | null; fundingIntervalSeconds: number | null;
    annualizedFundingPct: number | null; reported24hNotionalVolume: number | null; maxLeverage: number | null;
    marginMode: string | null; onlyIsolated: boolean | null;
    openInterestChange24h: { windowHours: number; comparisonAt: string | null; comparisonValue: number | null; changePct: number | null };
    openInterestChangeLatestInterval: { comparisonAt: string | null; comparisonValue: number | null; changePct: number | null };
    definitions: string };
  liquidity: { source: string; observedAt: string | null; spreadBps: number | null; depthQuote: number[] | null;
    impact: { notionalQuote: number; buy: { averagePrice: number; impactBps: number } | null;
      sell: { averagePrice: number; impactBps: number } | null }[] | null;
    quoteCurrency: string | null; levels: number[] | null; scope: string };
  settledFunding: { rate: number | null; premium: number | null; intervalSeconds: number | null; observedAt: string | null; definition: string | null } | null;
  risks: string[]; whyWatch: string[];
};
type Listings = {
  rows: Listing[];
  screen: { applied: string; windowDays: number; underlying: string; matched: number; selected: number; returned: number;
    excluded: { baseline: number; unresolvedUnderlying: number; unresolvedUnderlyingOutsideNative: number;
      delisted: number; absentFromLatestCatalog: number }; rule: string };
  lifecycle: { baselineInstruments: number; newListings: number; relistings: number; delistings: number;
    venueDelistedMarkets: number; absentFromLatestCatalog: number; verifiedUnderlyings: number;
    withOrderBook: number; evidence: string };
  namespaces: { namespace: string; label: string; deployer: string | null; feeRecipient: string | null; oracleUpdater: string | null;
    firstObservedAt: string | null; instruments: number; active: number; covered: boolean; coverage: Coverage | null;
    verifiedUnderlyings: number }[];
  coverage: { namespaceCatalog: Coverage | null; datasets: { datasetId: string; namespace: string; coverage: Coverage }[] };
  methodology: { version: string; classification: string; snapshotAsOf: string | null; scope: string; underlying: string;
    openInterest: string; funding: string; liquidity: string; spot: string; sorting: string; replay: string;
    replayRefusals: string[]; sources: string[] };
};
type Alert = { datasetId: string; snapshotId: string; entityKey: string; eventType: string; kind: string; scope: string;
  type: string; title: string; subject: { name: string | null; namespace: string | null; slug: string | null };
  observedAt: string; recordedAt: string; payloadId: string; methodologyVersion: string; readAt: string | null; evidence: string };

const compact = (value: number | null | undefined) => value == null ? 'Unavailable'
  : `$${value.toLocaleString('en-US', { notation: Math.abs(value) >= 1e6 ? 'compact' : 'standard', maximumFractionDigits: 2 })}`;
const pct = (value: number | null | undefined, digits = 2) => value == null ? 'Unavailable'
  : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
const units = (value: number | null | undefined) => value == null ? 'Unavailable'
  : value.toLocaleString('en-US', { maximumFractionDigits: 4 });
const sign = (value: number | null | undefined) => value == null ? '' : value < 0 ? 'down' : value > 0 ? 'up' : '';
const label = (value: string) => value.replaceAll('-', ' ');
const namespaceName = (namespace: string) => namespace || 'native';

function Cell({ value, format = pct }: { value: number | null; format?: (value: number | null) => string }) {
  return <td className={sign(value)}>{value == null ? '—' : format(value)}</td>;
}

function ProjectsView() {
  const [window, setWindow] = useState<'all' | 'early'>('all');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const path = `/perp/projects?window=${window}&limit=150${applied ? `&search=${encodeURIComponent(applied)}` : ''}`;
  const { result, loading, error, reload } = useData<Projects>(path);
  const d = result?.data;
  const chart = useMemo(() => {
    const rows = d?.aggregate.points ?? [];
    return { x: rows.map(row => Date.parse(row.observedAt) / 1000),
      lines: [{ label: 'Covered perp open interest (USD)', color: '#71bcdf', values: rows.map(row => row.value) }] };
  }, [d]);
  if (loading) return <p>Loading archived perp protocol evidence…</p>;
  if (error || !d || !result) return <p role="alert">Unable to load perp DEX projects. <button onClick={reload}>Try again</button></p>;
  const { aggregate, universe, earlyFilter, sorting, coverage } = d;
  return <>
    <section className="panel btc-method" aria-label="Covered perp open interest">
      <div className="panelhead"><div><h2>Covered open interest</h2><span>{aggregate.scope}</span></div></div>
      <div className="context-grid">
        <MetricCard defaultSource="DefiLlama" title="Covered open interest" value={compact(aggregate.latest?.value)}
          metric={{ ...coverage.openInterest, observedAt: aggregate.latest?.observedAt ?? null, unavailable: aggregate.latest?.value == null }}
          formula={`${aggregate.formula} ${aggregate.limitations}`} />
        <MetricCard defaultSource="DefiLlama" title="Covered open interest · 7D" value={pct(aggregate.change7dPct)}
          metric={{ ...coverage.openInterest, observedAt: aggregate.latest?.observedAt ?? null, unavailable: aggregate.change7dPct == null }}
          formula={`Exact calendar endpoints seven days apart. ${aggregate.values} archived daily values from ${evidenceDate(aggregate.first)}.`} />
        <MetricCard defaultSource="DefiLlama" title="Covered open interest · 30D" value={pct(aggregate.change30dPct)}
          metric={{ ...coverage.openInterest, observedAt: aggregate.latest?.observedAt ?? null, unavailable: aggregate.change30dPct == null }}
          formula={`Exact calendar endpoints thirty days apart. Series: ${aggregate.seriesId ?? 'Unavailable'}.`} />
        <MetricCard defaultSource="DefiLlama" title="Covered protocols" value={String(universe.coveredOpenInterestProtocols)}
          metric={{ ...coverage.openInterest, unavailable: !universe.coveredOpenInterestProtocols }}
          formula={`${universe.withCoveredOpenInterest} of ${universe.matched} perp-universe rows carry a covered open-interest value. ${universe.scope}`} />
        <MetricCard defaultSource="DefiLlama" title="Reported perp volume" value="Unavailable"
          metric={{ ...coverage.openInterest, unavailable: true, observedAt: null }} formula={d.methodology.volume} />
        <MetricCard defaultSource="Archive" title="Verified launch milestones" value={String(universe.withVerifiedMilestone)}
          metric={{ ...coverage.catalog, unavailable: universe.withVerifiedMilestone === 0 }} formula={earlyFilter.explanation} />
      </div>
      <ResearchChart title="Covered perp open interest (USD)" x={chart.x} lines={chart.lines} syncKey="perp-time" height={220}
        attribution="DefiLlama open-interest dimension · The provider convention counts both sides of each contract" />
      <p className="chart-help">{aggregate.limitations}</p>
    </section>

    <section className="panel btc-method" aria-label="Perp DEX projects">
      <div className="panelhead"><div><h2>Perp DEX projects</h2><span>{universe.scope}</span></div></div>
      <div className="btc-controls">
        <label>Filter
          <select value={window} onChange={event => setWindow(event.target.value as 'all' | 'early')}>
            <option value="all">Covered universe</option>
            <option value="early">Verified launch within {earlyFilter.defaultWindowDays} days</option>
          </select></label>
        <label>Search
          <input value={search} placeholder="protocol or slug" onChange={event => setSearch(event.target.value)} /></label>
        <button onClick={() => setApplied(search.trim())}>Apply</button>
        {applied && <button onClick={() => { setSearch(''); setApplied(''); }}>Clear</button>}
        <span>Sorted by {label(sorting.applied)}, falling back to {label(sorting.fallback)}; ties break on {sorting.tieBreak}.</span>
      </div>
      {window === 'early' && <p role="note">{earlyFilter.explanation}</p>}
      {d.rows.length ? <div className="btc-table-wrap"><table><thead><tr>
        <th>Protocol</th><th>Stage</th><th>Open interest</th><th>Share of covered</th><th>OI 7D</th><th>OI 30D</th>
        <th>Catalog TVL</th><th>Fees 30D</th><th>Revenue 30D</th><th>Venue link</th><th>First observed</th></tr></thead>
        <tbody>{d.rows.map(row => <tr key={row.key}>
          <td>{row.name ?? row.slug ?? row.protocolId} <em>{row.category ?? 'uncategorised'}</em></td>
          <td>{label(row.stage)}</td>
          <td>{compact(row.adoption.openInterestUsd)}</td>
          <td>{row.adoption.openInterestShareOfCoveredPct == null ? '—' : `${row.adoption.openInterestShareOfCoveredPct.toFixed(2)}%`}</td>
          <Cell value={row.adoption.openInterestChange7dPct} /><Cell value={row.adoption.openInterestChange30dPct} />
          <td>{compact(row.adoption.tvlUsd)}</td><td>{compact(row.economics.fees30dUsd)}</td>
          <td>{compact(row.economics.revenue30dUsd)}</td>
          <td>{row.venue ? `${row.venue.venue} ${namespaceName(row.venue.namespace)}` : '—'}</td>
          <td>{row.lifecycle.firstObservedAt?.slice(0, 10) ?? 'Unknown'}</td></tr>)}</tbody></table></div>
        : <p>No archived protocol matches this filter.</p>}
      <p>{universe.matched} protocols matched; {universe.returned} shown. {universe.catalogDerivatives} carry the provider
        `Derivatives` category, {universe.coveredOpenInterestProtocols} appear in the covered open-interest universe,
        {' '}{universe.withVenueLink} have a curated venue link and {universe.withArchivedFundamentals} have archived fundamentals.</p>
      <p>{sorting.reason}</p>
    </section>

    {d.rows.slice(0, 25).map(row => <section className="panel btc-method perp-evidence" key={row.key}
      aria-label={`Evidence for ${row.name ?? row.protocolId}`}>
      <details><summary>{row.name ?? row.protocolId} — why watch, contradictions, risks and milestones</summary>
        <div className="overview-figures">
          <div><span>Stage</span><strong>{label(row.stage)}</strong><small>{row.token ? `${row.token.symbol} linked; terms unverified` : 'No verified tradable token'}</small></div>
          <div><span>Open interest</span><strong>{compact(row.adoption.openInterestUsd)}</strong><small>{row.adoption.covered ? 'covered universe' : 'not covered'}</small></div>
          <div><span>Retained fee share</span><strong>{pct(row.economics.retainedFeeSharePct)}</strong><small>revenue ÷ fees, 30D</small></div>
          <div><span>Holder revenue 30D</span><strong>{compact(row.economics.holderRevenue30dUsd)}</strong><small>{row.economics.scopeMatch ? `${row.economics.scopeMatch} scope` : 'unavailable'}</small></div>
          <div><span>Token opportunity</span><strong>{row.token ? compact(row.token.marketCapUsd) : 'Unavailable'}</strong><small>{row.token?.unlocks ?? 'no verified terms'}</small></div>
          <div><span>Chains</span><strong>{row.chains.length || '—'}</strong><small>{row.chains.slice(0, 4).join(', ') || 'unavailable'}</small></div>
        </div>
        {row.whyWatch.length > 0 && <><h3>Why watch</h3><ul>{row.whyWatch.map(reason => <li key={reason}>{reason}</li>)}</ul></>}
        {row.contradictions.length > 0 && <><h3>Contradictory evidence</h3><ul>{row.contradictions.map(note => <li key={note}>{note}</li>)}</ul></>}
        <h3>Risk and coverage flags</h3><ul>{row.risks.map(risk => <li key={risk}>{risk}</li>)}</ul>
        <h3>Milestones</h3><ul>{row.milestones.length ? row.milestones.map(milestone => <li key={`${milestone.type}-${milestone.observedAt}`}>
          <b>{label(milestone.type)}</b> · {evidenceDate(milestone.observedAt)} — {milestone.evidence}</li>)
          : <li>No archived lifecycle milestone. Launch dates stay {row.lifecycle.launchDates}.</li>}</ul>
        <p>{row.economics.definitions} {row.economics.coverage}</p>
        <p>{row.adoption.convention ?? d.methodology.openInterest} {row.adoption.volumeGate}</p>
        {row.venue && <p>Venue link: {row.venue.evidence} Archived namespace instruments: {row.venue.instruments ?? 'Unavailable'}
          {' '}({row.venue.active ?? 'Unavailable'} active); native open interest {units(row.venue.openInterestNative)}.</p>}
      </details></section>)}

    <section className="panel btc-method"><details><summary>Formulas, universe and replay</summary>
      <p>{d.methodology.universe}</p><p>{d.methodology.openInterest}</p><p>{d.methodology.fundamentals}</p>
      <p>{d.methodology.lifecycle}</p><p>{d.methodology.tokens}</p><p>{d.methodology.volume}</p><p>{d.methodology.replay}</p>
      {d.methodology.replayRefusals.length > 0 && <p>Feeds refused at this cutoff: {d.methodology.replayRefusals.join(', ')}.</p>}
      <p>Catalog: {status(coverage.catalog ?? {})} · {evidenceDate(coverage.catalog?.observedAt)}. Open interest: {status(coverage.openInterest ?? {})} · {evidenceDate(coverage.openInterest?.observedAt)}.</p>
      <p>Methodology {d.methodology.version} · {d.methodology.classification}
        {d.methodology.snapshotAsOf ? ` · cutoff ${evidenceDate(d.methodology.snapshotAsOf)}` : ''}.
        {' '}{d.methodology.sources.map((source, index) => <a key={source} href={source} target="_blank" rel="noreferrer">Source {index + 1} </a>)}</p>
    </details></section>
  </>;
}

function ListingsView() {
  const [screen, setScreen] = useState<'new' | 'all'>('new');
  const [namespace, setNamespace] = useState('');
  const [underlying, setUnderlying] = useState<'verified' | 'all'>('verified');
  const path = `/perp/listings?screen=${screen}&underlying=${underlying}&limit=600${namespace ? `&namespace=${encodeURIComponent(namespace)}` : ''}`;
  const { result, loading, error, reload } = useData<Listings>(path);
  const d = result?.data;
  if (loading) return <p>Loading archived venue catalogs…</p>;
  if (error || !d || !result) return <p role="alert">Unable to load perp listings. <button onClick={reload}>Try again</button></p>;
  const { lifecycle, screen: selection, namespaces, coverage } = d;
  return <>
    <section className="panel btc-method" aria-label="Listing lifecycle">
      <div className="panelhead"><div><h2>Listing lifecycle</h2><span>{d.methodology.scope}</span></div></div>
      <div className="overview-figures">
        <div><span>New listings</span><strong className={lifecycle.newListings ? 'up' : ''}>{lifecycle.newListings}</strong><small>first observed after the baseline</small></div>
        <div><span>Baseline markets</span><strong>{lifecycle.baselineInstruments}</strong><small>existed before archiving began</small></div>
        <div><span>Relistings</span><strong>{lifecycle.relistings}</strong><small>relisted or returned to the catalog</small></div>
        <div><span>Delisting events</span><strong>{lifecycle.delistings}</strong><small>observed after the baseline</small></div>
        <div><span>Delisted markets</span><strong>{lifecycle.venueDelistedMarkets}</strong><small>venue flag, baseline included</small></div>
        <div><span>Absent from latest catalog</span><strong>{lifecycle.absentFromLatestCatalog}</strong><small>last observation retained</small></div>
        <div><span>Verified crypto underlyings</span><strong>{lifecycle.verifiedUnderlyings}</strong><small>of {selection.matched} archived markets</small></div>
        <div><span>Markets with an order book</span><strong>{lifecycle.withOrderBook}</strong><small>spread, depth and impact</small></div>
      </div>
      <p>{lifecycle.evidence}</p><p>{selection.rule}</p>
    </section>

    <section className="panel btc-method" aria-label="New perp listings">
      <div className="panelhead"><div><h2>{screen === 'new' ? 'New perp listings' : 'Archived venue catalog'}</h2>
        <span>{selection.selected} of {selection.matched} archived markets · window {selection.windowDays} days</span></div></div>
      <div className="btc-controls">
        <label>Screen
          <select value={screen} onChange={event => setScreen(event.target.value as 'new' | 'all')}>
            <option value="new">New listings</option><option value="all">Full archived catalog</option></select></label>
        <label>Underlying
          <select value={underlying} onChange={event => setUnderlying(event.target.value as 'verified' | 'all')}>
            <option value="verified">Verified crypto or native venue</option><option value="all">Include unresolved underlyings</option></select></label>
        <label>Namespace
          <select value={namespace} onChange={event => setNamespace(event.target.value)}>
            <option value="">All budgeted namespaces</option>
            {namespaces.map(row => <option key={row.namespace} value={namespaceName(row.namespace)}>{namespaceName(row.namespace)} · {row.instruments}</option>)}</select></label>
        <span>{d.methodology.sorting}</span>
      </div>
      {d.rows.length ? <div className="btc-table-wrap"><table><thead><tr>
        <th>Market</th><th>Listing</th><th>Since first observed</th><th>Open interest</th><th>Estimated notional</th>
        <th>OI 24H</th><th>Funding</th><th>Premium</th><th>Reported 24H volume</th><th>Spread</th><th>Spot 7D vs BTC</th></tr></thead>
        <tbody>{d.rows.map(row => <tr key={row.key}>
          <td>{row.instrument} <em>{namespaceName(row.namespace)}</em></td>
          <td>{label(row.listing.classification)}</td>
          <td>{row.listing.daysSinceFirstObserved == null ? 'Unknown' : `${row.listing.daysSinceFirstObserved}d`}</td>
          <td>{units(row.market.openInterestNative)}</td>
          <td>{compact(row.market.estimatedOpenInterestQuote)}</td>
          <Cell value={row.market.openInterestChange24h.changePct} />
          <Cell value={row.market.annualizedFundingPct} />
          <Cell value={row.market.premiumBps} format={value => `${value!.toFixed(1)} bps`} />
          <td>{compact(row.market.reported24hNotionalVolume)}</td>
          <td>{row.liquidity.spreadBps == null ? 'Unavailable' : `${row.liquidity.spreadBps.toFixed(2)} bps`}</td>
          <Cell value={row.underlying.spot?.relativeToBtc.d7 ?? null} /></tr>)}</tbody></table></div>
        : <p>No archived market matches this screen. {screen === 'new' ? 'Every budgeted namespace is still at its archive baseline, so there is no new listing to report.' : ''}</p>}
      <p>Excluded and counted: {selection.excluded.baseline} baseline, {selection.excluded.delisted} delisted,
        {' '}{selection.excluded.absentFromLatestCatalog} absent from the latest catalog,
        {' '}{selection.excluded.unresolvedUnderlyingOutsideNative} with an unresolved non-native underlying.</p>
      <p>{d.methodology.underlying}</p>
    </section>

    {d.rows.slice(0, 25).map(row => <section className="panel btc-method perp-evidence" key={row.key}
      aria-label={`Evidence for ${row.instrument}`}>
      <details><summary>{row.instrument} — market, liquidity, funding and underlying evidence</summary>
        <div className="overview-figures">
          <div><span>Open interest</span><strong>{units(row.market.openInterestNative)}</strong><small>{row.market.openInterestUnit ?? 'unit unavailable'}</small></div>
          <div><span>Estimated notional</span><strong>{compact(row.market.estimatedOpenInterestQuote)}</strong><small>{row.market.quoteCurrency ?? 'quote unresolved'}</small></div>
          <div><span>Mark / oracle</span><strong>{units(row.market.markPrice)}</strong><small>oracle {units(row.market.oraclePrice)}</small></div>
          <div><span>Funding</span><strong>{row.market.fundingRate == null ? 'Unavailable' : row.market.fundingRate.toExponential(3)}</strong><small>every {row.market.fundingIntervalSeconds ?? '—'}s</small></div>
          <div><span>Settled funding</span><strong>{row.settledFunding?.rate == null ? 'Unavailable' : row.settledFunding.rate.toExponential(3)}</strong><small>{evidenceDate(row.settledFunding?.observedAt)}</small></div>
          <div><span>Max leverage</span><strong>{row.market.maxLeverage ?? 'Unavailable'}×</strong><small>venue contract specification</small></div>
        </div>
        <p>{row.market.definitions}</p>
        <p><b>Open-interest change:</b> 24H {pct(row.market.openInterestChange24h.changePct)} against {evidenceDate(row.market.openInterestChange24h.comparisonAt)};
          {' '}previous archived snapshot {pct(row.market.openInterestChangeLatestInterval.changePct)} against {evidenceDate(row.market.openInterestChangeLatestInterval.comparisonAt)}.</p>
        <p><b>Liquidity ({row.liquidity.source}):</b> {row.liquidity.scope}
          {row.liquidity.depthQuote && ` Depth: ${row.liquidity.depthQuote.map(compact).join(' / ')}.`}
          {row.liquidity.impact && row.liquidity.impact.map(impact => ` Impact at ${compact(impact.notionalQuote)}: buy ${impact.buy ? `${impact.buy.impactBps.toFixed(1)} bps` : 'insufficient depth'}, sell ${impact.sell ? `${impact.sell.impactBps.toFixed(1)} bps` : 'insufficient depth'}.`)}</p>
        <p><b>Underlying:</b> {row.underlying.assetId ?? 'unresolved'} · class {row.underlying.assetClass} · pre-market {row.underlying.preMarket}.
          {row.underlying.linkEvidence && ` ${row.underlying.linkEvidence}.`}
          {row.underlying.spot && ` Spot versus BTC: 1D ${pct(row.underlying.spot.relativeToBtc.d1)}, 7D ${pct(row.underlying.spot.relativeToBtc.d7)}, 30D ${pct(row.underlying.spot.relativeToBtc.d30)} from ${row.underlying.spot.samples} archived samples. ${row.underlying.spot.scope}`}</p>
        <p><b>Lifecycle:</b> {row.listing.evidence} First observed {evidenceDate(row.listing.firstObservedAt)}; verified trading start {evidenceDate(row.listing.verifiedTradingStartAt)};
          {' '}first observed anywhere in the covered universe {evidenceDate(row.listing.firstObservedAnywhereAt)}.</p>
        {row.whyWatch.length > 0 && <><h3>Why it is attracting attention</h3><ul>{row.whyWatch.map(reason => <li key={reason}>{reason}</li>)}</ul></>}
        <h3>Risk and coverage flags</h3><ul>{row.risks.map(risk => <li key={risk}>{risk}</li>)}</ul>
      </details></section>)}

    <section className="panel btc-method" aria-label="Venue namespace coverage">
      <div className="panelhead"><div><h2>Venue namespaces</h2><span>{coverage.namespaceCatalog?.scope ?? 'Namespace catalog unavailable'}</span></div></div>
      <div className="btc-table-wrap"><table><thead><tr>
        <th>Namespace</th><th>Name</th><th>Archived markets</th><th>Active</th><th>Verified crypto underlyings</th>
        <th>Coverage</th><th>Deployer</th><th>First observed</th></tr></thead>
        <tbody>{namespaces.map(row => <tr key={row.namespace}>
          <td>{namespaceName(row.namespace)}</td><td>{row.label}</td><td>{row.instruments}</td><td>{row.active}</td>
          <td>{row.verifiedUnderlyings}</td>
          <td>{row.covered ? status(row.coverage ?? {}) : 'Uncovered'}</td>
          <td className="study-identity">{row.deployer ?? '—'}</td>
          <td>{row.firstObservedAt?.slice(0, 10) ?? 'Unknown'}</td></tr>)}</tbody></table></div>
      <p>A namespace outside the budgeted eleven is uncovered rather than empty, and an uncovered namespace never contributes to a count on this page.</p>
    </section>

    <section className="panel btc-method"><details><summary>Formulas, scope and replay</summary>
      <p>{d.methodology.scope}</p><p>{d.methodology.underlying}</p><p>{d.methodology.openInterest}</p>
      <p>{d.methodology.funding}</p><p>{d.methodology.liquidity}</p><p>{d.methodology.spot}</p><p>{d.methodology.replay}</p>
      {d.methodology.replayRefusals.length > 0 && <p>Feeds refused at this cutoff: {d.methodology.replayRefusals.join(', ')}.</p>}
      <p>Methodology {d.methodology.version} · {d.methodology.classification}
        {d.methodology.snapshotAsOf ? ` · cutoff ${evidenceDate(d.methodology.snapshotAsOf)}` : ''}.
        {' '}{d.methodology.sources.map((source, index) => <a key={source} href={source} target="_blank" rel="noreferrer">Source {index + 1} </a>)}</p>
    </details></section>
  </>;
}

function AlertsView() {
  const { result, loading, error, reload } = useData<Alert[]>('/perp/alerts?limit=100');
  const [busy, setBusy] = useState<string | null>(null);
  const acknowledge = async (alert: Alert) => {
    setBusy(alert.entityKey);
    try {
      await api('/perp/alerts', { method: 'POST', body: JSON.stringify({ datasetId: alert.datasetId,
        snapshotId: alert.snapshotId, entityKey: alert.entityKey }) });
      reload();
    } finally { setBusy(null); }
  };
  if (loading) return <p>Loading archived lifecycle alerts…</p>;
  if (error || !result) return <p role="alert">Unable to load perp alerts. <button onClick={reload}>Try again</button></p>;
  return <section className="panel btc-method" aria-label="Perp lifecycle alerts">
    <div className="panelhead"><div><h2>Lifecycle alerts</h2><span>{result.metadata.coverage}</span></div></div>
    {result.data.length ? <ul className="overview-changes">{result.data.map(alert => <li key={`${alert.datasetId}-${alert.snapshotId}-${alert.entityKey}`}>
      <span className={`change-tag ${alert.type}`}>{label(alert.type)}</span>
      <div><b>{alert.title}</b><small>{evidenceDate(alert.observedAt)} · {alert.readAt ? `read ${evidenceDate(alert.readAt)}` : 'unread'}</small>
        <p>{alert.scope}. {alert.evidence} Archived payload: {alert.payloadId}.</p>
        {!alert.readAt && <button disabled={busy === alert.entityKey} onClick={() => acknowledge(alert)}>Mark as read</button>}</div></li>)}</ul>
      : <p>No lifecycle alert is recorded. A first catalog ingestion is archived as a baseline and never raises a listing alert.</p>}
    <p>Alerts describe detection, listing, relisting, catalog absence and covered-universe membership changes. No order is ever placed.</p>
  </section>;
}

const views = [{ id: 'projects' as const, label: 'Perp DEX Projects' }, { id: 'listings' as const, label: 'New Perp Listings' },
  { id: 'alerts' as const, label: 'Lifecycle alerts' }];

export function PerpDiscovery() {
  const [view, setView] = useState<'projects' | 'listings' | 'alerts'>('projects');
  return <div className="btc-workspace overview-workspace">
    <div className="btc-intro"><div><span className="eyebrow">PERP DISCOVERY · FORWARD TRACKING</span>
      <h2>Which perp venues and markets deserve research?</h2>
      <p>Protocol adoption, token opportunity and individual contract activity stay separate. A venue listing an existing
        token is a new market event, not a token launch or a new perp DEX project.</p></div>
      <a href="#data-health">Inspect Data Health →</a></div>
    <div className="btc-controls" role="tablist" aria-label="Perp discovery views">
      {views.map(entry => <button key={entry.id} role="tab" aria-selected={view === entry.id}
        className={view === entry.id ? 'active' : ''} onClick={() => setView(entry.id)}>{entry.label}</button>)}
    </div>
    {view === 'projects' && <ProjectsView />}
    {view === 'listings' && <ListingsView />}
    {view === 'alerts' && <AlertsView />}
  </div>;
}
