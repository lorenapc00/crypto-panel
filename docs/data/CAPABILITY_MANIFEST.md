# Data capabilities and the stage 0 decision

Checked 2026-09-09. **Stage 0 approved BTC history, market snapshots, scoped fundamentals, Hyperliquid catalogs, and sampled spot-pool discovery.** Broad perp-volume market-share rankings, advanced holder metrics, and macro vintages remain gated. The implementation update below distinguishes that original capability decision from the running archive.

**Implementation update:** Stage 1 software is complete, with persistent research state, Data Health, shared quota accounting for worker/manual/probe requests, and supervised local worker/backup operation. The 120 job definitions include protocol/venue/pool catalogs, top-100 market/global and issuance snapshots, seven fundamental summaries, four priority price/volume histories, eight fundamental histories, native BTC book/funding, and 80 sampled token pair/promotion slots. Live validation recorded 112 successful jobs and eight empty slots skipped without quota or replay coverage. Sixteen normalized series are archived; irregular intervals remain visible. A backup restore and automatic worker restart were verified. Always-on hosting remains open. See the [worker runbook](DISCOVERY_WORKER.md), [operation procedures](../../ops/README.md) and [dated finalization evidence](stage1-finalization-2026-09-09.json). The evidence below describes the original capability spike unless a follow-up is identified.

Evidence: [initial probes](capability-results-2026-09-09.json), [history and batch follow-up](capability-followup-2026-09-09.json), and [chain probes](capability-chains-2026-09-09.json). The three runs made 59 requests covering all 48 defined probes and ten additional discovered namespaces, with one repeated request after throttling. They produced 46 successful samples, 12 other HTTP failures, and one 429. Every result records its request, credential mode, UTC acquisition time, HTTP status, response hash, and available shape/coverage checks. Requests used no credentials. Success means a sample was received; it does not certify every asset, continuous service, metric comparability, or historical publication times. These reports are not the replay archive.

## Reproduce the spike

```bash
pnpm research:probe
pnpm research:probe --only cg-global,cm-btc-core-batch
pnpm research:budget
pnpm test
```

The [probe definitions](../../scripts/capability-probes.json) specify exact GET URLs and read-only POST bodies. Output defaults to ignored `.reports/capabilities.json`; use `--output path` to preserve a dated result. `hl-namespaces` also probes every named namespace returned by the catalog; `hl-contexts-native` checks the native namespace separately. An explicit `--only` list never implies full provider coverage.

Optional exported `COINGECKO_DEMO_API_KEY` and `FRED_API_KEY` are supported by the probe. It does not load `.env` or print keys, request headers, or error bodies. The subsequent daily-history adapter also supports the Demo key; scheduled CoinGecko market/global jobs also support it. Negative HTTP results are evidence, not test failures. Transport failures, malformed successful responses, or throttling exit nonzero. A 429 stops further requests to that provider for that run; there are no automatic retries. The original run hit one CoinGecko 429, retained in the evidence. A later follow-up returned 401 for the same 730-day request. Default CoinGecko pacing was subsequently reduced to five requests/minute.

## Capability manifest

### CoinGecko: keep snapshots and sampled price history

| Probe / metric | Observed access and coverage | Build decision |
|---|---|---|
| `cg-global`: `/global` | HTTP 200; provider global USD market cap, BTC percentage, update time | Use provider aggregates. Never substitute a sum of tracked assets. Provider coverage still belongs on the metric. |
| `cg-markets`: `/coins/markets`, page size 250 | HTTP 200; 250 assets with IDs, caps, reported volume, update times | Budget an hourly, rank-selected universe of up to 1,000 assets. Persist each membership snapshot and page completeness. |
| `cg-chart-365d`: BTC daily `market_chart` | 366 points, 2025-09-10 to 2026-09-09; final point at 11:58:50 UTC is off the daily grid | Completed daily price samples support returns and indicators. Separate the live tail. `total_volumes` remains sampled trailing-24-hour volume. |
| `cg-ohlc-90d`: BTC OHLC | 23 bars; **345,600 seconds (four days)** between bars | Exclude from daily calculations. Quarantine legacy rows before refresh; daily close samples are not fabricated OHLC candles. |
| `cg-chart-outside-demo`: 730 days | First 429, then 401 after cooldown | No verified access beyond one year; use Coin Metrics for BTC cycles. |
| `cg-categories`: category list | HTTP 200; 974 category definitions | Archive vocabulary only. This is not asset/category membership or historical sector coverage. |

Demo history is documented as limited to 365 days; its chart response reports prices and 24-hour volume samples. [Chart contract](https://docs.coingecko.com/demo/reference/coins-id-market-chart). OHLC timestamps mark candle closes and automatic granularity changes with range. [OHLC contract](https://docs.coingecko.com/reference/coins-id-ohlc).

**Revision/replay:** these endpoints return current snapshots or current historical estimates, without historical vintages. Store new revisions with ingestion time. Backfills are historical reconstruction; universe replay begins only when production archiving starts. Missing daily observations remain gaps. Pagination while rankings change can duplicate/omit assets: retain exact IDs/page times, deduplicate, and mark incomplete cycles.

**Access/license:** keyless access is subject to dynamic shared-IP limits, distinct from authenticated Demo allowances. The 1,000-asset budget below is conditional on revalidation with a free Demo key. Attribution is required for Demo; no paid or unrestricted redistribution license is assumed. [Keyless access](https://docs.coingecko.com/docs/keyless-public-api), [Demo plan](https://www.coingecko.com/en/api/pricing).

### Coin Metrics: use the Community API for BTC

**Stage 2 follow-up — 2026-09-09 local:** the production worker now schedules one
daily batch for PriceUSD, CapMrktCurUSD, CapMVRVCur and SplyCur, within the existing
100-request monthly ceiling. The first request archived 5,898 prices through
2026-09-09; the other three metrics have null latest-day values and retain their
2026-09-08 populated endpoints. There are now 121 jobs and 20 normalized series.
BTC Cycles and immutable descriptive signal studies are implemented. See
[live evidence](stage2-btc-2026-09-09.json) and [timestamp/formula conventions](BTC_RESEARCH.md).
The original Stage 0 evidence below is retained unchanged.

`cm-btc-core-batch` returned all seven requested daily metrics in one unpaginated response. Bounds below are **numeric metric coverage**, not the first date in the response.

| Metric | Observed numeric history | Scope / initial use |
|---|---|---|
| `PriceUSD` | 2010-07-18–2026-09-08, 5,897 daily values | BTC USD daily price; trend, returns, drawdown, volatility and historical signal studies |
| `CapMrktCurUSD`, `CapMVRVCur` | Same 5,897 dates | BTC current-supply market cap and MVRV; provider-specific valuation context |
| `SplyCur` | 2010-01-01–2026-09-08 in requested window | BTC native circulating units; do not mistake the requested lower bound for inception |
| `HashRate` | Same requested window | Provider hash-rate estimate; optional mining context after units/methodology are implemented |
| `AdrActCnt` | Same requested window | Active addresses, not users or retention |
| `IssTotUSD` | 2010-07-18–2026-09-08 | USD-valued issuance input; optional Puell research only after formula/issuance semantics are validated |

Individual `CapRealUSD`, `DiffMean`, `RevUSD`, `SOPR`, and `NUPL` requests returned 403. This establishes denied access for these requested metric IDs; it does not establish that every concept is necessarily paid or that every ID is supported on another plan. Do not build those direct-feed dependencies.

MVRV is explicitly `CapMrktCurUSD / CapRealUSD`. Realized price may be derived as `(CapMrktCurUSD / CapMVRVCur) / SplyCur` with matching dates and positive denominators, labeled as a **derived Coin Metrics estimate**. This is not a direct realized-price feed or an independent valuation vote. MVRV Z-score and NUPL variants remain deferred until their own method is specified. [MVRV definition](https://raw.githubusercontent.com/coinmetrics/docs-website/master/asset-metrics/market/capmvrvcur.md).

**Archive freshness finding:** the GitHub CSV returned 6,351 dates through 2026-05-24, but the requested populated metrics ended on **2026-05-23**, 109 days behind the live API. Its README says daily updates; the sample contradicts relying on that as a freshness guarantee. Keep CSV as a checked fallback, not the ingestion clock. [Archive and CC BY-NC 4.0 license](https://github.com/coinmetrics/data).

**Revision/replay:** Community historical responses contain latest values, without verified vintage access in this spike. Preserve raw revisions and mark pre-archive studies as reconstruction. Never use CSV row count to infer price coverage: BTC price is absent before July 2010.

**Access/license/quota:** Community requires no key; documented rate is ten requests per six-second sliding window. Data is free for noncommercial use. Keep attribution and source methodology with derived outputs. [Community API](https://docs.coinmetrics.io/api).

### DefiLlama: keep fundamentals, defer broad perp-volume rankings

| Probe / endpoint family | Observed result | Scope / decision |
|---|---|---|
| `llama-protocols`: `/protocols` | 8,208 entries; only 2,366 have `gecko_id` | Protocol catalog is broader than token catalog. Missing token links do not prove pre-token status. Verify lifecycle separately. |
| `/overview/derivatives`, `/summary/derivatives/hyperliquid` | Both **402** | Free perp-volume history unavailable in this sample. Defer normalized/reported volume-share ranking. |
| `/overview/open-interest` | 126 covered entries; aggregate history 2021-02-25–2026-09-09 | Provider-covered aggregate only. This does not prove each current protocol has the full history. |
| Hyperliquid fees, revenue, holder revenue | All three returned 621 daily observations, 2024-12-23–2026-09-08 | Retain each data type separately. Verify product scope and allocation before computing comparable ratios. |
| Hyperliquid `/protocol` TVL | 1,190 observations, 2023-06-09 onward, with an intraday tail | Protocol TVL, not token value capture, net flows, or guaranteed daily bars. |
| Ethereum/Solana chain TVL and fee overviews | Sampled separately in chain report | Chain scope. Fees of protocols deployed on a chain must not be relabeled as native-token revenue or base-chain transaction fees. |
| `stablecoincharts/all` | 3,207 rows, 2017-11-29–2026-09-09 | Verified USD-pegged circulating-USD field; retain peg/currency scope, rather than claiming all stablecoin supply. |

The provider now explicitly lists derivatives history, unlocks/emissions, ETF flows, inflows, and several advanced analytics as Pro-only. Those authenticated routes were not called with invented keys. They are excluded by documented access, not reported as successfully probed. The original expectation that website perp history implied a free API was incorrect. [Free/Pro route manifest](https://raw.githubusercontent.com/DefiLlama/api-docs/main/llms.txt).

**Semantics:** `dailyRevenue` is retained revenue and may reach treasury/team or token holders; it is not automatically treasury-only protocol revenue. Holder revenue may include buyback/burn mechanisms rather than cash distributions. DefiLlama currently defines OI as both sides counted. Archive that definition and keep it separate from direct-venue OI until normalization is verified; do not add the aggregates together. [Provider definitions](https://docs.llama.fi/analysts/data-definitions).

**Revision/replay/license:** historical charts can change; no vintage contract was verified. Current protocol membership does not establish historical membership. Catalog/history are reconstruction until archived with cutoff-aware revisions. Public access and open-source adapters do not establish an unrestricted data redistribution license; retain provider attribution and record terms as provider-specific. A numeric free rate guarantee was not found: the budget uses a local ceiling, not an invented quota.

### Hyperliquid: start hourly catalog and market snapshots

All discovered namespaces returned aligned metadata/context arrays. The report preserves namespace index/name and each returned instrument name/index, including delisted entries:

| Namespace | Instrument entries |
|---|---:|
| Native (`""`) | 234 |
| `xyz` | 119 |
| `flx` | 16 |
| `vntl` | 15 |
| `hyna` | 25 |
| `km` | 23 |
| `abcd` | 1 |
| `cash` | 17 |
| `para` | 35 |
| `mkts` | 23 |
| `io` | 9 |

These 517 entries are not 517 active crypto assets. Preserve namespace/instrument identity, classify crypto/non-crypto and pre-market status separately, and resolve underlying assets independently. First ingestion is a baseline, not a burst of listing alerts. Listing announcements and true trading-start dates were not established by these context responses. [Perpetual metadata contract](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals).

BTC `l2Book` returned both sides; BTC funding history returned 168 observations over the requested seven days. Funding timestamps differ by milliseconds from exact hours: store actual event times and the documented settlement interval separately. Coverage of a seven-day query does not establish the oldest available funding history. `impactPxs` was missing for many instruments and does not replace an executable order book at the requested $1K/$10K size.

Contracts use one unit of the underlying; retain `openInterest` in native units and use a documented price basis for estimated quote notional. Preserve quote currency/collateral and conversion assumptions before calling it USD. Funding settles hourly. Never double an OI value merely because contracts have two counterparties. [Contract specification](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications), [Funding specification](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding).

**Revision/replay/license:** metadata, context, and books are current observations. No historical catalog, closed-market lifecycle, or historical depth was verified. These need forward archiving; funding history alone cannot support executable perp backtests. Public read-only access was verified without an account; no unrestricted redistribution license was established by the API documentation.

### Spot pools, issuance, and deferred feeds

| Provider / probes | Observed access | Decision and limitations |
|---|---|---|
| GeckoTerminal Solana/Base `new_pools` | 20 pools per chain; Base liquidity absent for 2/20 | Add as the sampled discovery feed. Store chain, pool, token identities, provider pool-creation time and first observation separately. New pool does not mean new token. |
| DEX Screener profiles/boosts | 30 profiles, 29 boosted entries | Auxiliary discovery/promotion only; no exhaustive launch coverage. |
| DEX Screener Solana/Base token pairs | 30 pairs each; Base creation time absent for 9/30 | Pair enrichment. Missing launch/creation times remain unknown. |
| DEX Screener orders | Separate `orders` and `boosts` arrays | Record promotion independently; ordering data is not investment evidence. |
| mempool.space tip height | Integer response | Current BTC subsidy-era input; no historical vintage evidence. |
| Solana `getInflationRate` | Numeric total rate and epoch | Observed annualized protocol inflation parameter, not realized net issuance. |
| ALFRED/FRED `DFII10`, `DTWEXBGS`, `SP500` vintage queries | All 400 without a key | Free-key gate. Reprobe coverage and vintages after `FRED_API_KEY` is configured; not a paid-access finding. |
| Glassnode SOPR | 401 without credentials | No verified feed. Advanced holder/valuation variants remain unavailable. |

The original GeckoTerminal API reference suggested approximately ten calls/minute. **Worker follow-up, 2026-09-09:** the current [provider FAQ](https://apiguide.geckoterminal.com/faq) states 30/minute; the local budget remains five/minute. The beta API adapter pins its response version. [GeckoTerminal API](https://api.geckoterminal.com/docs/index.html). DEX Screener documents separate rate classes for promotional endpoints and market data. [DEX Screener API](https://docs.dexscreener.com/api/reference).

Pool/profile snapshots have no verified historical vintages. Neither provider validates launch age, sell restrictions, concentration, retained liquidity, or contract powers for this plan: those fields stay unknown. Data redistribution rights were not established; record provider terms/attribution separately from API accessibility. ALFRED can request earlier vintages, but no actual vintage response or series-specific licensing was verified here. [Vintage query contract](https://fred.stlouisfed.org/docs/api/fred/series_observations.html).

## Quota budget and universe decision

The executable [budget](quota-budget.json) uses a **31-day month**, includes bootstrap calls, and separates documented limits from conservative local ceilings. `pnpm research:budget` recalculates totals and fails if a configured monthly ceiling is exceeded. Every acquisition path now shares provider enforcement, including the manual-history and probe CLIs. The full job list below remains a design budget; only individually verified feeds in the worker runbook are scheduled.

| Provider | Scheduled work | First-month calls | Local monthly ceiling / remaining |
|---|---|---:|---:|
| CoinGecko | 4 market pages + global hourly; 4 priority charts + category catalog daily; 1,000 one-time history requests | 4,875 | 6,000 / 1,125 |
| Coin Metrics | One BTC metric batch daily + initial backfill | 32 | 100 / 68 |
| DefiLlama | Catalog, OI and stablecoins daily; 4 fundamentals for up to 20 protocols; 4 chain requests | 2,697 | 4,000 / 1,303 |
| Hyperliquid | Catalog + 11 namespaces + 20 books + 20 short funding queries hourly | 38,688 | 50,000 / 11,312 |
| GeckoTerminal | First new-pool page on each chain every five minutes | 17,856 | 30,000 / 12,144 |
| DEX Screener | Profiles/boosts + pair/order checks for 40 selected tokens total, hourly | 61,008 | 80,000 / 18,992 |
| mempool.space | Tip hourly | 744 | 1,000 / 256 |
| Solana RPC | Inflation hourly | 744 | 1,000 / 256 |
| FRED, disabled reserve | Three daily series + three initial vintage requests | 96 if enabled | 250 / 154 |
| Glassnode, disabled | None | 0 | 0 / 0 |

CoinGecko Demo documents 10,000 calls/month and 100/minute. The chosen plan leaves 5,125 calls below the provider allowance, while the stricter local 6,000 ceiling reserves 1,125 for probes, errors, retries and extra lookups. A 3,000-asset universe at the same frequency would require **12,827** first-month calls and is rejected. Fetching history daily for all 1,000 assets is also rejected. After the initial backfill, retain daily samples from archived market snapshots; keep their source/frequency distinct from the provider's historical daily series. [Demo limits](https://www.coingecko.com/en/api/pricing).

The starting 1,000 assets are a rank-selected coverage envelope, not every project within the research market-cap thresholds. Assets outside it remain undiscovered unless separately added within budget. Eligibility and missing history apply after acquisition. Historical backfills do not move the point-in-time universe coverage start backward.

Hyperliquid requires a **weighted** bucket. The configured hourly cycle uses approximately 700 weight, including response-size increments for short funding requests; spread this over at least three minutes under the local 300-weight/minute ceiling. The documented provider ceiling is 1,200 weight/minute. Additional namespaces, books, pagination, or longer funding backfills require recalculation. [Weight rules](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits).

Coin Metrics local pacing is 30 calls/minute; DefiLlama 10; GeckoTerminal 5; DEX Screener 30 across both endpoint classes; optional FRED 5; tip/inflation 1. Unknown published quotas remain unknown. Failures and retries count locally. Shared pacing/monthly ceilings, `Retry-After`, request-purpose evidence and run/gap records are implemented and surfaced on Data Health with individual-series coverage. A finalization CoinGecko global probe returned HTTP 200 and was charged to the ledger. API reads never trigger backfills.

## Next implementation slice

Stage 1 software and local supervision are complete. The remaining operational
condition is always-on hosting with sustained coverage and a backup copy outside
the archive machine. The active market feed remains one top-100 page; expanding
to the 1,000-asset design requires verified Demo access. Broader fundamentals,
OI/stablecoins, macro and advanced metrics follow their individual gates.

Live normalization preserves irregular Hyperliquid TVL timestamps and flags them
instead of manufacturing daily bars. DEX Screener Base Uniswap v4 pairs can use
bytes32 pool IDs; token contracts still require their own valid chain identity.
These findings came from archived response inspection and successful bounded
retries; the original failures remain recorded quota evidence.
At Stage 1 finalization, of the 16 normalized series, 11 had healthy spacing/coverage and five flagged
irregular steps. Four of those retain missing historical fee/revenue dates;
successful current acquisition does not fill or conceal provider history gaps.

Stage 2's BTC core and signal-study primitive are implemented, including Coin Metrics MVRV and matched-date derived realized price. Venue leverage/capital context and other inputs still require their individual definitions and coverage checks. Perp-volume market-share sorting and inaccessible metrics remain excluded from initial interface commitments.
