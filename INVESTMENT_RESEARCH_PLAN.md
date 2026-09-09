# Crypto Panel: investment research, BTC cycles, and altcoin discovery

**Progress — 2026-09-09:** stage 0 is complete. Stage 1 now has versioned transactional migrations, quarantined legacy candles, raw-response provenance, immutable daily-series revisions, guarded `asOf` repository reads, and corrected daily price history/calculations in the existing asset page. The [capability manifest](docs/data/CAPABILITY_MANIFEST.md) and [quota budget](docs/data/quota-budget.json) constrain the remaining build. **Next: the scheduled worker, quota enforcement and production discovery archive.** Manual price backfills do not start replay coverage. The 1,000-asset expansion still needs verified Demo access; macro and unsupported feeds stay gated.

## 1. Product direction and priorities

Build a personal research workspace that answers four questions:

- What market environment are we in?
- Is BTC becoming more attractive, overheated, or structurally weaker?
- Which altcoins deserve investigation, and what measurable evidence supports them?
- Would these signals have helped when evaluated using information available at the time?

Agreed defaults: weeks-to-years investment horizon; daily/weekly analysis; free data first; explainable signals; separate emerging-project and early-launch tracks. Prioritize both new perp DEX projects/tokens (including pre-token projects) and newly listed perpetual markets within Early Launches. Solana and Base remain the initial chains for general spot-token launches; perp DEX coverage follows supported protocols and venues across chains. Portfolio tracking, trade execution, and multi-user accounts are outside this version.

The current React/TypeScript/PostgreSQL stack is sufficient. Keep it. But this plan describes a platform that does not exist yet, not a reorganization of one that does. Before stage 0 tooling, the repository was a working prototype of roughly 1,980 lines: about 570 lines of API across eight files, a single 822-line `main.tsx`, and 536 lines of global CSS. There is still no worker, no authentication, no HTTP router, no general request validation, no chart library, and no lint or CI. `packages/shared/` is an empty directory without a `package.json`. Application work below remains planned unless marked complete in the execution status.

### Correctness issues that must come first

The following were confirmed in the prototype audit. Resolved items are marked after the first stage 1 implementation; unmarked items remain open.

- **"Global" market cap and dominance use only the top 100 assets.** `server.ts` sums the `per_page=100` response from `market.ts`, so BTC dominance is systematically overstated and market breadth counts only the top 100. The interface labels these "Global market cap" and "BTC dominance" with no scope qualifier. Worse than a labeling problem: in the database-fallback path, the stored-snapshot query returns *every asset ever persisted*, an unbounded set that can exceed 100, so the denominator silently changes between the live and stale paths. That same path hardcodes 24-hour change to `0`, which makes breadth report `0 up / 0 down`.
- **Resolved: the daily-history path used four-day OHLC bars.** The old fetch/write path has been removed; legacy rows are quarantined and the asset page uses validated daily price samples. Original finding: CoinGecko returns four-day bars for `days >= 31`, roughly 23 rows. They are written with `interval: "daily"`. [CoinGecko OHLC documentation](https://docs.coingecko.com/reference/coins-id-ohlc)
- **Resolved: returns used row counts.** Calendar-date endpoints now determine 1D/7D/30D/90D returns; absent endpoints produce null. Original finding: With four-day bars, the value labeled 1D is a four-day change, the value labeled 7D is a 28-day change, and 30D and 90D are permanently null because they require 30 and 90 rows that never exist. The interface renders all four as calendar periods.
- **Resolved: indicator intervals and RSI smoothing.** Indicators use contiguous daily observations, restart after gaps, and apply Wilder RSI. Original finding: `sma7` is a 28-day mean presented as "SMA 7"; `sma30` and MACD are always null because they need 30 and 26 bars. RSI additionally uses a simple average rather than Wilder smoothing.
- **Resolved: populated history did not refresh.** Manual ingestion now checks the newest completed daily sample against the provider publication boundary; `--force-history` rechecks revisions. Original finding: The refetch is gated on the series being empty rather than on the newest bar being stale, so re-running the ingestion command does not refresh OHLC either, contrary to what the README implies.
- **Resolved: rolling volume was attached to OHLC bars.** It is now a separate sampled metric with independent timestamps; no OHLCV is fabricated. Original finding: The value comes from `market_chart.total_volumes`, which is a trailing-24-hour figure sampled at an instant. It is matched to the nearest candle timestamp with no distance cap and written to `candles.volume`, then displayed as the volume of the bar. The metric definition in the schema describes it correctly, so the schema and its use disagree.
- **Resolved for daily history: updates overwrote bars.** Legacy candles are immutable and excluded; replacement daily-series values append revisions with payload provenance and ingestion timestamps. The old snapshot-observation table still needs migration before broader replay. Original finding: The write is `on conflict ... do update`, the opposite of the append-only `do nothing` used for observations. The candles primary key excludes `recorded_at`, so there is exactly one row per logical bar and no bitemporal dimension: point-in-time replay is impossible by construction, not merely unimplemented. Note the ordering hazard — this overwrite is currently dormant *because* history never refreshes. Repairing the refresh bug first would begin destroying history.
- **Resolved: the schema could not evolve.** Ordered SQL migrations now run transactionally under a database lock and verify applied-file checksums. Original finding: The migration is a single `create table if not exists` string with no version table and no `ALTER` path, so changes to the five existing tables silently no-op.
- **Watchlists are temporary, shared server memory.** They live in module-level JavaScript objects, wiped on restart. The frontend never sends an `Authorization` header, so every request falls through to a single shared guest session: all users of the app read and write one watchlist. The interface claims the data is "saved in this browser's demo workspace"; nothing is stored in the browser.
- **Partly resolved: `assetDetails` triggered backfills on page load.** Historical data now comes only from persisted series. Market snapshots, fundamentals and issuance still fetch live on API reads and must move behind the worker.
- **`tokenomics_events` has no writers anywhere in the codebase.** The substrate for the token-economics KPI row in §2 is a permanently empty table.
- **Asset taxonomy is a hardcoded ten-entry TypeScript object**, while the `assets.category` column exists in the schema and is always written `null`.
- **There is no authentication.** The README now describes the shared demo accurately. The development session endpoint still mints a token for any email address, its `expiresAt` is never enforced, and `access-control-allow-origin: *` is returned on every response.

Tests now include 13 API unit cases, eight PostgreSQL integration cases, and twelve capability/budget cases. API tests discover files recursively and assert a minimum executed case count with no skips; database tests require `TEST_DATABASE_URL` and create isolated schemas. They verify upgrade preservation, rollback, concurrent migrations, scope/provenance integrity, revision replay, stale refresh, daily intervals, missing values and Wilder RSI. Worker, universe and full backtest invariants remain future coverage.

## 2. Overall experience and important KPIs

Use five primary tabs, with a persistent research watchlist and a secondary Data Health page.

| Workspace | Main purpose | Proposed content |
|---|---|---|
| Market Overview | Understand conditions and changes | BTC regime summary, market breadth, liquidity, notable signal changes; sector leadership after taxonomy coverage is verified |
| BTC Cycles | Evaluate trend and cycle conditions | Long-term charts, valuation, holders, leverage, macro, historical cycle comparisons |
| Altcoin Discovery | Find evidence-backed candidates | Emerging Projects and Early Launches; prioritize Perp DEX Projects and New Perp Listings, with separate filters, evidence, risk flags, and historical outcomes |
| Asset Research | Investigate a candidate | Price, relative strength, fundamentals, token value capture, dilution, peers, thesis notes |
| Backtest Lab | Evaluate signal usefulness | Historical screen replay, signal studies, strategy templates, benchmarks, costs, reproducible results |

Replace the current oversized cards and simple sparkline with a chart-centered research interface: neutral dark surfaces, readable typography, restrained colors, compact tables, and consistent spacing. Use color for meaning, with text labels for accessibility.

Charts need real date/value axes, crosshairs, zoom, log scale, synchronized comparison panels, event annotations, and export. Default ranges: 30D, 90D, 1Y, and All. Save filters and chart settings.

**Charting library: uPlot.** Roughly 40KB, MIT-licensed, fast on long series, with log scale and cursor built in and synchronized panels supported. Zoom, annotations, and axis formatting require more hand-written code than a purpose-built financial charting library; that cost is accepted in exchange for size and control. It replaces the current hand-drawn `<polyline>` sparkline, which has no axes and cannot be extended.

Each important metric should show its value, change, historical context, interpretation, and source. Clicking opens its formula, scope, freshness, coverage, and limitations.

### Data Health

This system's value rests on an archive accumulating unattended, so Data Health is a first-class deliverable rather than a diagnostic afterthought. It must show, per source and per series:

- Last successful run, and time since.
- Gap detection: missing intervals, with detection latency recorded explicitly.
- Expected versus actual bar interval, so a provider changing granularity is visible rather than silently mislabeled.
- Quota consumed against the declared budget.
- Provider error rates and the current degradation state of each metric.
- Replay coverage start date per dataset.

### Market and asset KPI priorities

The following is the initial build shortlist after stage 0. Accessible endpoints are not implemented adapters: verify each asset/protocol's coverage and metric definition before exposing it.

| Category | KPIs to add | Decision supported |
|---|---|---|
| Market participation | Provider global market cap and BTC dominance; percentage above 50D/200D averages where complete history exists; advance/decline breadth within archived membership | Is strength broadening or concentrated? |
| Relative performance | 7D/30D/90D returns in USD and versus BTC from aligned completed daily price samples | Is an altcoin outperforming the opportunity cost of holding BTC? |
| Liquidity | Covered USD-pegged stablecoin supply and 30D change; sampled reported 24H volume trends; selected Hyperliquid order-book spreads, depth and estimated impact | Is capital entering, and can a position realistically be traded? |
| Risk | 30D/90D realized volatility, maximum drawdown, recovery time, BTC correlation and beta | How much downside and shared market exposure exists? |
| Adoption | Scoped DefiLlama fees, retained revenue and TVL histories; BTC active addresses where useful, labeled as addresses | Is usage growing beyond price speculation? |
| Token economics | Circulating/total/max supply; FDV/market cap; observed BTC subsidy era and Solana inflation parameter, distinguished from realized net issuance | Could dilution offset business growth? |
| Value capture | Provider-defined holder revenue for individually verified protocols, with recipient/mechanism and coverage | Does protocol success benefit the token? |

Deferred from the initial interface: sector-relative returns/multiples until asset-sector mappings and membership are verified; broad perp-volume/share comparisons; retention, protocol active users, net inflows, unlock schedules and general net issuance; separate buyback/distribution amounts without verified mechanism-level data. Do not design populated metric rows for these feeds yet.

Use trailing 30D/90D fundamentals and their growth rates; avoid annualizing one unusually strong day. Compare like-for-like sectors. Addresses are not users, TVL growth is not necessarily net inflow, and protocol revenue is not automatically token-holder income.

Persist watchlists, saved screens, dated thesis notes, and in-app alerts for signal changes, unlocks, and thesis conditions.

## 3. BTC cycle research

The BTC page should separate **trend**, **valuation**, **positioning**, and **liquidity**. These can disagree; the interface should make that visible.

| Lens | Metrics | Interpretation |
|---|---|---|
| Trend | 50D/200D SMA, 20W SMA/21W EMA, 200W SMA, moving-average slopes, weekly RSI, drawdown from ATH | Direction, durability, and distance from long-term reference levels |
| Valuation | Mayer Multiple; Coin Metrics MVRV; optionally derived realized price using matching market cap, MVRV and circulating supply | Price relative to provider-defined cost-basis proxies and its own history |
| Mining | Coin Metrics hash rate and USD issuance inputs; observed BTC tip/subsidy era | Network conditions; derived mining signals require separately validated definitions |
| Leverage | Hyperliquid BTC funding and native-unit OI; estimated quote notional/OI-to-market-cap only with explicit conversion and coverage | Crowding within the covered venue, not market-wide positioning |
| Capital | Covered USD-pegged stablecoin supply change | One liquidity proxy with declared asset coverage |

Implement price-derived metrics first. Stage 0 verified free Coin Metrics Community daily BTC price and MVRV from July 2010 through 2026-09-08, plus supply, hash rate, active addresses and USD issuance. Use its API as primary: the sampled GitHub archive's populated metrics stopped on 2026-05-23. Historical downloads are reconstruction, not proof of prior availability. Direct realized-cap, difficulty, miner-revenue, SOPR and NUPL metric requests were denied; do not assume a similarly named metric is interchangeable. [Observed coverage and definitions](docs/data/CAPABILITY_MANIFEST.md#coin-metrics-use-the-community-api-for-btc).

Deferred: MVRV Z-score, NUPL variants, SOPR/aSOPR, holder cohorts/profit metrics, difficulty, Puell/Hash Ribbons until their inputs and methods are specified, futures basis, liquidations, options IV/skew, ETF and exchange flows. Macro inputs (`DFII10`, `DTWEXBGS`, `SP500`) need a free FRED key and successful vintage checks. These are per-feed gates, not a blanket claim that the concepts have no free source.

MVRV, NUPL, and related measures share underlying inputs. Group them as related evidence instead of counting each as an independent bullish or bearish vote. Provider definitions and adjustment methods must remain attached to each series. [Glassnode indicator reference](https://docs.glassnode.com/basic-api/endpoints/indicators)

**Initial regime rule:** bullish when the completed daily close exceeds the 200D SMA and that average exceeds its value 20 days earlier; bearish when both conditions reverse; otherwise transitional. Require three consecutive completed daily observations to change the displayed regime. Show insufficient history separately.

This is a transparent baseline to test, not a claim that a moving average identifies every cycle turning point. Display valuation and leverage conditions alongside it rather than embedding them in an unexplained probability.

**Required historical charts:**

- Log BTC price with long-term averages, halving dates and regime shading; optional derived realized price labeled with its Coin Metrics formula and coverage.
- Cycle returns normalized to 100 at each halving.
- Drawdown from running ATH and time to recover.
- MVRV compared at equivalent cycle stages; add other metrics only after their individual access/methodology gates pass.
- Forward 30D/90D/180D/365D return distributions after selected signals, including downside and sample count.

Allow overlays aligned to historical peaks and troughs, but label those anchors as hindsight-based and exclude them from predictive backtests. Show individual cycles and their actual coverage; do not extrapolate an average cycle into a price target. Pi Cycle and similar historical heuristics belong in an optional research layer.

**Halving-cycle comparisons have a sample size of about three.** They are illustration, not inference, and the interface must say so. The walk-forward, holdout, and statistical-significance language in §4 applies to daily-frequency signal studies, where sample counts are meaningful; it does not apply to cycle overlays and must not be used to lend them borrowed rigor.

## 4. Altcoin discovery and backtesting

### Emerging Projects

Expand discovery beyond today's top 100 to a budgeted, rank-selected acquisition universe of up to 1,000 assets, conditional on verified Demo access. This is not exhaustive coverage of the market-cap band. Default to assets with at least 90 days of price history, market cap of $10M-$2B, and a 30-day median of reported trailing-24-hour volume samples of at least $1M, sampled at a consistent daily boundary. Exclude stablecoins and duplicate wrapped representations.

These are editable research defaults, not validated investment thresholds. Offer "young projects" as a filter using verified launch dates; keep overlooked older projects discoverable.

Provide separate attention, fundamentals, valuation, and risk columns. The initial attention ranking uses:

- 40% cross-sectional percentile of 90D excess return over BTC.
- 30% percentile of 30D excess return over BTC.
- 30% percentile of reported 24H-volume acceleration: the mean of daily sampled trailing-24-hour volumes over 7 days divided by the preceding 30 days. Preserve sampling times; these are not candle-traded volumes.

Compute within the eligible universe on each date. Missing required inputs mean "unranked." Label the result **Attention**, not expected investment return.

**These weights are unvalidated, and the three components are not independent.** The 90D and 30D excess-return percentiles are heavily correlated, and volume acceleration is itself momentum-adjacent, so the score is closer to a single momentum factor than to three. Treat it as a v0 placeholder. The first signal study to run against it is whether the ranking beats an equal-weight eligible-universe benchmark at all; until that study exists, the score should not occupy prime interface space or be described as evidence.

Every candidate gets an evidence panel:

- Why it appeared and when the signal first triggered.
- Adoption and revenue trends versus sector peers.
- Whether the token captures economic value.
- Dilution, liquidity, concentration, and data gaps.
- Contradictory evidence and saved thesis conditions.
- Outcomes of comparable historical signals.

### Early Launches: perp DEX priority

Deliver two distinct discovery views first: **Perp DEX Projects** and **New Perp Listings**. Keep project adoption, token investment performance, and individual contract activity separate. A venue listing an existing token is a new market event, not a token launch or a new perp DEX project.

#### Perp DEX Projects

Track protocols through pre-token, announced token launch, and live-token stages. Record protocol launch, token launch, announcements, and first observation separately, with sources and publication times. Token issuance or airdrops must not be assumed for pre-token projects.

Default the early-project filter to verified protocol or token launches within 180 days, plus pre-token protocols with observable activity. Keep established peers available for comparison. Unknown launch dates appear as unknown, not as newly launched. Do not apply the Emerging Projects price-history or spot-pool thresholds to pre-token protocols.

| Evidence | Metrics and interpretation |
|---|---|
| Adoption and share | 7D/30D perp volume and growth, share of the covered perp DEX universe, open interest and its change; show absolute scale alongside growth |
| Activity quality | Reported versus provider-normalized volume where available, volume/OI, active trader addresses and retention where supported; annotate points, rebates, and incentive periods |
| Economics | Fees, protocol revenue, effective fee rate, measurable incentives, token-holder distributions and buybacks; keep each recipient and metric scope explicit |
| Liquidity and resilience | Spreads and depth for supported venues, collateral deposits/net flows, insurance coverage where comparable, bad debt, oracle dependencies, withdrawal restrictions, and incident history |
| Token opportunity | Verified token status, launch terms, circulating supply, FDV, unlocks, and actual token value capture; unavailable before a tradable token and verified terms exist |

Compare order-book, AMM, and liquidity-pool models within appropriate peer groups. Reported and normalized volume must remain separate series; normalization is provider-defined, not proof that all remaining activity is organic. DefiLlama documents perp volume normalization and separates aggregator volume to avoid double counting. [DefiLlama data definitions](https://docs.llama.fi/analysts/data-definitions)

Start with a sortable evidence table. **Stage 0 gate:** DefiLlama's perp-volume overview and Hyperliquid volume-summary endpoints returned HTTP 402, while the protocol catalog, OI aggregate and sampled fee/TVL histories were accessible. Initially sort by most recent verified protocol/token milestone, with undated entries last and stable protocol-ID tie-breaking. Keep 30D market-share-change sorting disabled until comparable free volume windows and consistent covered-universe membership are verified. Direct Hyperliquid volume is venue evidence, not a replacement denominator for the protocol universe. Show available revenue, risks, and coverage; missing volume/incentive metrics remain unavailable. Each protocol gets a "why watch," contradictory evidence, and milestone history panel; pre-token entries support research watchlisting without simulated token returns.

#### New Perp Listings

Track newly tradable crypto perpetual contracts on covered perp DEX venues. Start the direct venue adapter with Hyperliquid; enumerate its supported perp DEX namespaces and persist the exact coverage. Add other venues through the same capability contract when accessible data supports it. This initial venue choice does not limit the broader protocol discovery catalog.

Identify markets by venue, perp DEX namespace, and stable instrument identifier; link the underlying asset independently. Distinguish venue-new listings from the first listing observed anywhere in our covered universe. Record announcements, verified trading start, first observation, suspensions, delistings, and relistings. Treat the first catalog ingestion as a baseline; existing instruments must not all trigger new-listing alerts.

Default the listing window to 30 days. Show time since listing, 1H/24H/7D volume where supported, OI and OI change, funding with its settlement interval, mark/index premium, bid/ask spread, executable depth and estimated impact at $1K/$10K notionals, and underlying spot returns versus BTC. Keep pre-market contracts separate and exclude non-crypto underlyings from the default screen.

Default sorting is most recent verified trading start, with an explicit first-observed fallback. Offer sorts by 24H OI change and volume growth only when comparable windows exist. Display "why attracting attention" using the actual changes, alongside liquidity, oracle, funding, and data-gap flags. High leverage or high OI alone is not a positive investment signal.

Use venue metadata and market context for discovery, funding, and OI, and venue order books for liquidity. Normalize OI to USD using the instrument's documented units and contract specification; never assume every venue reports USD or count both sides twice. Hyperliquid exposes perpetual metadata and contexts including funding, OI, prices, and volume. [Hyperliquid perpetuals API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)

Archive venue catalogs and market snapshots hourly, and protocol fundamentals daily, subject to declared provider quotas. Store missed intervals and detection latency explicitly. In-app alerts describe the first detection, listing, or changed evidence; no order placement is included.

### Early Launches: spot tokens on Solana and Base

Create a separate screen for tokens first observed within 30 days, with a default minimum observed pool liquidity of $100K. Deduplicate by chain and contract address; a newly created pool must not automatically make an old token "new."

Show liquidity and its change, volume acceleration, buy/sell transaction imbalance, price behavior, holder concentration where available, deployer holdings, mint/freeze or administrative powers, and liquidity withdrawal risks.

Separate **attention** from **risk status**. Unverified contract checks stay "unknown"; they do not become a passing result. Exclude known sell restrictions and unresolved critical risk flags from the default shortlist, while preserving them in historical records.

Use GeckoTerminal's new-pool endpoints for a sampled discovery feed: initially the first 20 pools on each of Solana and Base every five minutes. Stage 0 received both feeds, including missing Base liquidity values that must stay unknown. Use DEX Screener for pair-level enrichment and explicitly identify paid boosts as promotion. Its documented API exposes paid orders and boosts separately from trading data. [GeckoTerminal API](https://api.geckoterminal.com/docs/index.html), [DEX Screener API](https://docs.dexscreener.com/api/reference)

Under the free-first constraint, launch discovery is a sampled radar with declared coverage—not a claim to capture every launch. Start archiving immediately.

### Backtest Lab

Provide three modes:

1. **Historical replay:** choose a date and inspect the eligible universe, available metrics, and rankings.
2. **Signal study:** measure subsequent returns, BTC-relative performance, maximum adverse movement, and failure rates.
3. **Strategy test:** apply saved selection and execution rules and compare results with benchmarks.

**The replay horizon is a hard limit, and the product must display it.** No free source provides historical altcoin universe membership or historical metric vintages. Historical replay therefore works only for dates *after* this system began archiving. Persist a replay-coverage start date per dataset, show it in the interface, and refuse replay requests before it rather than silently returning a reconstruction. For the first several months of operation this is a forward-tracking product for everything except BTC price history.

Initial templates:

- BTC regime filter versus BTC buy-and-hold.
- Weekly top-10 Emerging Projects attention basket, equally weighted, versus BTC and an equal-weight eligible-universe benchmark.
- Early-launch signal studies at 1D/7D/30D horizons. Enable executable strategy results only when historical liquidity and execution evidence support them.
- Perp DEX project studies: evaluate subsequent 30D/90D adoption, market share, and revenue; evaluate token returns versus BTC and sector peers only after actual token tradability. Preserve projects that never launch a token or cease operating, with unavailable token returns rather than invented prices.
- New-perp-listing event studies: compare underlying spot returns with BTC at 1D/7D/30D, alongside changes in OI, funding, and liquidity. Keep this separate from perpetual-contract P&L; actual perp simulations require historical fills or defensible execution estimates, fees, funding cash flows, margin rules, and delisting settlement. Suppress executable results when these inputs are missing.

Backtesting requirements:

- Use historical universe membership, including delistings, failed tokens, and migrations.
- Respect publication times, revisions, signal computation time, and next available execution.
- Fit thresholds and normalization only on preceding data.
- Use chronological walk-forward evaluation and retain an untouched final evaluation period.
- Report fees, slippage, turnover, liquidity constraints, failed exits, and sensitivity to costs.
- Default liquid-asset strategy tests to a stated 25 basis points per side execution-cost assumption; repeat at 50 and 100. Do not apply this shortcut to early-launch tokens.
- Never forward-fill a disappeared token indefinitely or assume an exit at its last quoted price.
- For perp research, replay protocol/token stages and venue membership as known at the time; preserve failed projects and closed markets. Use first-observed detection for replay unless earlier public availability is evidenced, and handle multiple venues listing the same underlying as related events rather than independent samples. Maintain a consistent covered-universe denominator for market-share comparisons.
- Show sample sizes, overlapping observation warnings, drawdown, CAGR, Sharpe/Sortino assumptions, and benchmark-relative performance.

Label datasets/results as **point-in-time**, **historical reconstruction**, or **forward tracking**. A historical value downloaded today is not proof that the value was available then. Revised on-chain metrics are a concrete source of this problem. [Glassnode point-in-time methodology](https://docs.glassnode.com/data/point-in-time-metrics)

## 5. Implementation, data constraints, and acceptance

**Architecture and interfaces**

- Retain the existing stack; separate frontend pages/components and backend providers, calculations, signals, and backtesting modules.
- Replace the single idempotent schema string with versioned, transactional migrations before any other schema work. This is implemented in `apps/api/migrations/`; applied migrations must not be edited.
- Introduce a PostgreSQL-backed worker for scheduled ingestion and long-running backtests. API reads use persisted data; opening a page must not trigger a historical backfill.
- Store raw payload provenance, metric definitions, revision history, asset/contract mappings, universe snapshots, signal versions, and backtest runs.
- Model protocols, venues, instruments, and their token/underlying relationships separately. Persist launch/listing lifecycle events, incentives, funding intervals, contract specifications, and timestamped order-book observations where available; protocols may have no token.
- Distinguish event time, provider publication time, ingestion time, and revision availability. Historical replay must select the version available at its cutoff. This requires a bitemporal key on time-series tables; the new daily-series archive retains revisions and guards replay coverage; remaining snapshot, universe and lifecycle datasets still need equivalent storage.
- Add series queries with asset, metric, date range, interval, and `asOf`; dedicated BTC regime/cycle and discovery endpoints; asynchronous backtest creation/status/results endpoints.
- Expose separate discovery queries for perp projects and perp listings, with stage, venue/chain, date-window, coverage, and `asOf` filters. Responses distinguish protocol, token, instrument, and underlying identifiers and carry lifecycle evidence and observation times.
- Extend response metadata to each series/metric: source, scope, interval, coverage, freshness, methodology version, and replay eligibility.
- Detect bar interval from the data rather than assuming the provider's documented granularity, and store the detected value. Flag irregular spacing instead of storing it as regular.
- Keep existing asset routes working. Quarantine incorrectly labeled legacy candles, refetch supported history, and recompute dependent indicators rather than silently relabeling data.

**Free-first data strategy**

Use CoinGecko for market snapshots, the Coin Metrics Community API for supported long BTC histories, DefiLlama for accessible fundamentals, and source-specific public feeds for additional context. The [stage 0 capability manifest](docs/data/CAPABILITY_MANIFEST.md) records actual endpoint results and controls the initial scope.

For perp discovery, use DefiLlama's covered protocol catalog and individually verified fundamental histories, then direct venue APIs for listings and market context. Broad perp-volume history is deferred after HTTP 402 responses; website visibility did not establish free API access. Keep reported/normalized volume, OI, and revenue definitions versioned and label every aggregate with its actual venue/protocol coverage. In particular, DefiLlama's documented OI convention counts both sides; do not merge it with direct-venue OI without explicit normalization. [DefiLlama data definitions](https://docs.llama.fi/analysts/data-definitions)

Do not assume the existing CoinGecko feed can supply multiple cycles: Demo historical chart access is restricted to the past 365 days. Coin Metrics Community API coverage was verified; its GitHub archive was stale in the sample, so check per-metric freshness before using it as fallback. Retain the noncommercial license and attribution. [CoinGecko historical limits](https://docs.coingecko.com/demo/reference/coins-id-market-chart), [Coin Metrics archives](https://github.com/coinmetrics/data)

Build a capability manifest recording actual endpoints, history, quotas, licensing, and revision behavior. Free credentials are supported; no paid subscriptions are assumed. Unlocks and other advanced fundamentals are gated where free access is unavailable. [DefiLlama API coverage](https://defillama.com/docs/api)

Use ALFRED vintages for macro inputs in historical tests. [ALFRED documentation](https://fred.stlouisfed.org/docs/api/fred/alfred.html)

**Rate limits and quota budget**

Provider quotas are the binding constraint on this entire plan, and they are currently unmanaged in the application. Most existing adapters still use unauthenticated public endpoints. Application settings include `DATABASE_URL`, `PORT`, and the optional daily-history Demo key. Market/fundamental adapters still lack shared quota enforcement, retries, backoff and request scheduling. The new manual daily-history adapter supports `COINGECKO_DEMO_API_KEY` and local pacing; production quota enforcement still belongs to the worker.

Stage 0 produced a [per-provider budget](docs/data/quota-budget.json), recalculated by `pnpm research:budget`. The initial CoinGecko design is 1,000 acquired assets at 250 per page, hourly market/global snapshots, four daily priority charts and one category-catalog call. A 31-day month plus 1,000 one-time history calls totals **4,875**; a local 6,000-call ceiling leaves 1,125 for errors/retries and extra lookups. This is conditional on authenticated Demo access, whose documented allowance is 10,000/month; keyless limits remain dynamic. A 3,000-asset equivalent would cost 12,827 and is excluded. Daily per-asset history refetches are excluded too: archive daily samples from snapshots after bootstrap, preserving their distinct source/frequency.

The budget also covers 11 Hyperliquid namespaces hourly, selected books/funding, daily protocol fundamentals and sampled spot discovery. Unknown provider quotas remain unknown; local ceilings are not advertised provider guarantees. Implement ingestion as a queue with per-provider token buckets (weighted for Hyperliquid), monthly ceilings, explicit backoff, and recorded quota consumption surfaced on Data Health. Probe scripts perform bounded checks; they do not implement this production worker.

**Delivery sequence**

Step 0 is a gate, not a deliverable: it produces a decision, and the metric tables in §2 and §3 are pruned against its findings before any interface is designed. Building an interface for metrics that have no feed is the largest waste risk in this plan.

| # | Stage | Contents |
|---|---|---|
| 0 | **Capability spike and quota budget** | Time-boxed. Actually call every candidate endpoint; record free versus paid, history depth, rate limit, licensing, and revision behavior into the capability manifest. Produce the per-provider quota budget above. Prune the §2 and §3 metric lists against the results. |
| 1 | **Reliable foundation and archive clock** | Fix the correctness issues in §1; introduce versioned migrations, the worker, provenance, bitemporal storage, persistent research state, and Data Health. Start protocol, perp-listing, and spot-launch snapshots immediately as a headless job. |
| 2 | **BTC and the signal-study primitive** | Long-term charts, baseline regime, core KPIs, and a minimal signal study: event date to forward 1/7/30/90/180/365-day return versus BTC, with sample count and maximum adverse movement. |
| 3 | **Market Overview** | Redesigned interface, true global aggregates with declared scope, breadth, liquidity, sector leadership. |
| 4 | **Perp discovery interface** | Perp DEX Projects and New Perp Listings views, lifecycle tracking, evidence, risk flags, and in-app alerts, built on data that has been archiving since stage 1. |
| 5 | **Broader altcoin research** | Emerging Projects and general Solana/Base spot-token launches, evidence panels, sector comparisons, risk filtering. |
| 6 | **Backtest Lab and expanded evidence** | Historical replay, strategy templates, reproducible reports, coverage-aware results, separate perp-project and listing studies; additional on-chain, unlock, ETF, and derivatives feeds as verified access permits. |

**Execution status**

- [x] Stage 0: repeatable read-only endpoint probes and dated evidence; actual free/denied access and history checks; per-provider budget with bootstrap/retry headroom; prune initial KPI/metric commitments.
- [x] Verify the original five API tests execute and the application builds; add twelve tests for interval/coverage evidence, credentials, response validation, and quota arithmetic.
- [x] Stage 1 foundation slice: transactional, versioned migrations; quarantine legacy candles; immutable daily-series revisions and raw-payload provenance; coverage registry and guarded `asOf` repository reads.
- [x] Stage 1 daily-history slice: explicit stale-aware ingestion, separate rolling volume, calendar returns, Wilder RSI, stored-only history reads and truthful chart labeling. Broader API reads still need the worker.
- [ ] Stage 1 next: scheduled worker and quota enforcement; begin protocol/venue/pool archiving with baseline semantics; migrate remaining API reads and snapshot storage; persist research state; Data Health.
- [ ] Stages 2–6: deliver the remaining interfaces and research tools in the sequence above, subject to the recorded feed gates.

Two ordering decisions are deliberate and depart from an earlier draft of this plan.

*Starting the archive clock is separated from building the perp interface.* Only non-backfillable data is genuinely urgent: perp venue catalogs, new listings, and new spot pools cannot be recovered later. That is a headless worker and a set of tables, and it belongs in stage 1. The perp product surface — two discovery views, evidence panels, risk flags, alerts — is weeks of work and does not need to block BTC, which is fully backfillable and immediately useful.

*The signal-study primitive moves forward into stage 2.* Deferring all validation to the final stage would mean stages 2 through 5 ship rankings that have never been tested, which is precisely what §4 warns against. The replay invariants — `asOf`, revision selection, universe snapshots — are also schema decisions, and retrofitting them after four stages of table design is expensive. The full Backtest Lab stays late; the primitive that validates each signal as it ships does not.

**Acceptance criteria**

- Tests catch irregular candle intervals, stale history, missing values, incorrect volume semantics, and incompatible metric scopes.
- The test suite is verified to actually execute, and its case count is asserted rather than assumed.
- Adding future observations or revisions does not change an earlier point-in-time replay.
- Identical dataset and strategy versions reproduce identical results.
- Backtests preserve failed assets and model costs and unavailable exits.
- Replay requests before a dataset's coverage start date are refused explicitly rather than silently reconstructed.
- Pre-token projects remain researchable without a price, market cap, or fabricated return; protocol launches, token launches, and perp listings are distinguishable.
- Initial venue ingestion produces a baseline without false new-listing alerts; later listings, relistings, delistings, namespace collisions, and identical symbols on different venues are handled explicitly.
- Perp data checks cover OI units, funding intervals, missing depth, incentives, changes in covered-universe membership, and separation of spot returns from funded perpetual P&L.
- Every ranking and regime assessment exposes its inputs, rules, contradictions, and coverage.
- Every aggregate declares its scope; a top-N figure is never labeled as global.
- Charts clearly distinguish historical comparison from information usable for prediction.
- Provider failures degrade individual metrics without breaking the whole page.
- Quota consumption stays inside the declared per-provider budget, and overruns are visible on Data Health.
- A user can move from market conditions to a candidate's evidence and its historical evaluation without leaving the panel.
