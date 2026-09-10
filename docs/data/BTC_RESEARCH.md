# BTC research and signal studies

Open **BTC Cycles** (`/#btc`). The API reads archived data only. The worker runs
`coinmetrics:bitcoin:daily-history:v1` daily at 02:00 UTC using the existing
100-request monthly ceiling. Its four-metric full-history batch costs one request;
unexpected pagination is rejected visibly until acquisition and budget changes
are reviewed. The initial live acquisition used one request and returned 5,898
BTC prices. Supply has an earlier requested start; each metric has its own coverage.

## Date and availability conventions

Coin Metrics `PriceUSD` is the **end-of-day UTC price**, labeled by that day's
midnight. The original provider label is retained; the unfinished day is excluded.
Provider publication time stays unknown. CoinGecko daily prices are samples at
the timestamp itself. Other-asset studies therefore pair CoinGecko asset and BTC
samples, avoiding a one-day mismatch with Coin Metrics closes.

Pre-archive history is **historical reconstruction**. `GET /api/v1/btc/cycles`
accepts an optional guarded `asOf` selecting revisions archived by that cutoff.
It does not establish that each historical signal was available on its chart date.
An earlier-than-coverage cutoff returns 409; a future/invalid cutoff returns 400.
Metrics arriving later than price remain independently stale/unavailable. Matching
dates and positive denominators are required for derived realized price.

## Calculations and charts

- 50D/200D simple averages require contiguous daily prices. Bullish means price
  exceeds SMA200 and SMA200 exceeds its value 20 days earlier; bearish reverses
  both inequalities; equality/disagreement is transitional. Three identical daily
  candidates confirm a regime change. Gaps reset both history and confirmation.
- Completed weeks run Monday–Sunday UTC and require all seven daily observations.
  Weekly averages are SMA20, SMA200 and SMA-seeded EMA21. Weekly RSI14 uses Wilder
  smoothing. Completed weekly values carry through the unfinished week.
- Mayer = price / SMA200. MVRV is Coin Metrics `CapMrktCurUSD / CapRealUSD`.
  Derived realized price = `(CapMrktCurUSD / CapMVRVCur) / SplyCur`, on matching
  dates. MVRV and realized price share evidence; no independent-vote score exists.
- Annualized realized volatility uses the sample standard deviation of 30/90
  daily log returns multiplied by `sqrt(365)`. Missing returns suppress it.
- Drawdown uses the running maximum of observed closes within coverage. Recovery
  duration is the days from that high to the first recovered close; gaps suppress
  the duration. Daily rows retain recovery events and current days underwater.
- Halving overlays normalize the exact halving-day close to 100 and stop before
  the next halving. Missing anchors remain unavailable. About three completed
  comparable cycles are illustrations, with no target extrapolation or inference.

uPlot provides UTC date/value axes, linked cursors/zoom, legend toggles, log price
scale and PNG export. Preset range and scale persist under `btc-chart`. Price,
drawdown and MVRV share a time axis; the two cycle comparisons share days since
halving. PNG exports include visible series labels and source attribution.

## Study primitive

`POST /api/v1/signal-studies` takes `assetId` (default `bitcoin`), `signal`
(`bullish`, `bearish`, `transitional`, `custom`), optional `from`/`to` event dates,
and `eventDates` for custom studies. Dates are strict `YYYY-MM-DD`. ETH/SOL/HYPE
currently support custom dates; their available histories are shorter. Automatic
BTC events require a confirmed regime change from an established regime: initial
baselines and recovery from insufficient history do not emit transition events.

Each horizon uses exact calendar endpoints. BTC-relative return is
`(asset_end / asset_start) / (btc_end / btc_start) - 1`. Maximum adverse movement
is `min(0, min(path_price / event_price - 1))`; the entire daily path is required.
These are daily closes/samples, not intraday lows. Endpoint returns can remain
available when an interior gap prevents measuring adverse movement.

Results retain every event, missing and unmatured outcomes, negative-return rates,
10th/50th/90th percentile returns (linear interpolation), separate sample counts
for returns/relative/adverse outcomes, and counts of overlapping event-window
pairs. Overlap counts include all selected events, including unfinished windows.
There is no statistical significance, holdout or executable strategy claim. No
fees, slippage, funding or same-close execution is assumed.

Migration 0008 adds immutable `signal_studies`. Each run freezes source series
points, payload IDs/revision timestamps, series definitions, selected events,
methodology versions, input SHA-256 and results. Later provider revisions produce
a different new run without changing saved results. `GET /api/v1/signal-studies/:id`
retrieves the full record. The UI retains the ID in `/#btc?study=:id` and exports
the record as JSON. Requests for point-in-time study replay are rejected.

Studies are bounded synchronous computations (up to 1,000 custom event dates).
Long-running strategy jobs and an asynchronous Backtest Lab remain future work.

## Venue leverage and capital context

`GET /api/v1/btc/context` reads an independent, consistent database snapshot.
It does not acquire providers or affect the BTC chart/study request. Optional
`asOf` selects only archived revisions and snapshots; it refuses cutoffs before
any required context dataset's production coverage, including the capital catalog.
Absent current feeds remain independently unavailable. The context panels remain
usable before BTC price acquisition, and the BTC charts remain usable if context fails.

Native BTC identity is `['hyperliquid', '', 'BTC']`, restricted to an active
instrument in the archived native catalog. OI is in BTC, counted once. Estimated
notional multiplies native OI by the contemporaneous mark, labeled **USDT price
units**, with USDC collateral. The documented BTC price convention does not
establish a USD exchange rate; no USD notional or OI/market-cap ratio is reported.
The older book archive's `quoteCurrency: USDC` label does not capture this price/
collateral distinction; this context slice does not consume that book field.
[Hyperliquid contract specifications](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications).

The current hourly rate sampled with OI and the latest published hourly funding
event are separate metrics. The latter comes from the archived two-hour query;
its actual timestamp, including milliseconds, is retained. Positive funding
means longs pay shorts; negative funding reverses the direction. Neither metric
is annualized or presented as account cash flow. Sampled context is stale after
one hour; settled evidence after two hours, reflecting its acquisition window.
[Hyperliquid funding definition](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding).

Capital uses two independently metered daily DefiLlama jobs: `stablecoincharts/all`
for `totalCirculatingUSD.peggedUSD`, and `stablecoins?includePrices=true` for a
current catalog filtered to `pegType=peggedUSD`. The probe received 3,208 regular
daily rows and 425 catalog assets; the first production acquisition retained
3,207 completed daily values and 337 USD-pegged catalog members.
[Capability evidence](capability-capital-2026-09-09.json),
[DefiLlama API](https://api-docs.defillama.com/).

The normalized supply series has no asset identity and uses the explicit
`covered_usd_pegged_stablecoins` scope. Migration 0009 permits this aggregate
without creating a fake tradable asset. It appears in Data Health, including
gaps/revisions, and can be queried with
`GET /api/v1/series?seriesId=defillama%3Ausd-pegged%3Astablecoin_supply_usd%3Adaily%3Av1`.
The worker excludes the live UTC day and retains nulls and changed revisions.
The 30D percentage uses exactly matching calendar endpoints, with an unavailable
result for a missing or zero denominator; the absolute change is also exposed.
Charts materialize missing days as null and export with DefiLlama attribution.
Acquisition time is distinct from the last revision time.

This is provider-covered USD-valued circulating supply, not net capital inflows.
Coverage and valuation changes can affect the result. Historical constituents
are unavailable; today's separately sampled catalog is not applied to prior dates
or summed to reconstruct the historical aggregate. Non-USD pegs are excluded,
and missing catalog supply/prices stay unknown. Every metric exposes its scope,
freshness and archive coverage. Historical supply remains reconstruction, even
when an `asOf` cutoff selects its archived revisions.

The DefiLlama design budget adds one catalog call daily: 2,728 planned requests
in a 31-day month, below the 4,000 local ceiling. Actual configured DefiLlama jobs
require 558 calls per 31 days before probes/retries. No provider quota guarantee
or new paid access is assumed.

## Validation and local acceptance

`pnpm test`, `pnpm build`, PostgreSQL `test:db`, and web `test:e2e` cover the core
and context slices. The integrated totals are 62 unit/capability checks, 35 PostgreSQL cases
and eight browser scenarios. The browser fixture uses a separate schema and
synthetic histories; it does not write personal study records.

After building/migrating and restarting the worker, run:

```sh
node --env-file-if-exists=.env ops/verify-btc.mjs
node --env-file-if-exists=.env ops/verify-btc-context.mjs
```

This checks the local API, replay guard, worker run and actual series coverage,
then saves [core evidence](stage2-btc-2026-09-09.json) and
[context evidence](stage2-context-2026-09-09.json). The checks do not acquire data
or run the test suites. Always-on hosting, optional mining/macro inputs and
strategy evaluation remain open. Stage 3 Market Overview is next.

Sources: [Coin Metrics PriceUSD](https://raw.githubusercontent.com/coinmetrics/docs-website/master/asset-metrics/market/priceusd.md),
[Coin Metrics MVRV](https://raw.githubusercontent.com/coinmetrics/docs-website/master/asset-metrics/market/capmvrvcur.md),
[Coin Metrics data and CC BY-NC 4.0 license](https://github.com/coinmetrics/data),
[halving dates](https://bitcoin.org/en/halving), [uPlot](https://github.com/leeoniya/uPlot).
