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

## Validation and local acceptance

`pnpm test`, `pnpm build`, PostgreSQL `test:db`, and web `test:e2e` cover the core
slice. The integrated totals are 56 unit/capability checks, 32 PostgreSQL cases
and five browser scenarios. The browser fixture uses a separate schema and
synthetic histories; it does not write personal study records.

After building/migrating and restarting the worker, run:

```sh
node --env-file-if-exists=.env ops/verify-btc.mjs
```

This checks the local API, replay guard, worker run and actual series coverage,
then saves [dated evidence](stage2-btc-2026-09-09.json). It does not acquire data
or run the test suites. Always-on hosting, venue leverage/capital panels and
strategy evaluation remain open.

Sources: [Coin Metrics PriceUSD](https://raw.githubusercontent.com/coinmetrics/docs-website/master/asset-metrics/market/priceusd.md),
[Coin Metrics MVRV](https://raw.githubusercontent.com/coinmetrics/docs-website/master/asset-metrics/market/capmvrvcur.md),
[Coin Metrics data and CC BY-NC 4.0 license](https://github.com/coinmetrics/data),
[halving dates](https://bitcoin.org/en/halving), [uPlot](https://github.com/leeoniya/uPlot).
