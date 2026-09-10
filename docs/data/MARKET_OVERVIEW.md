# Market Overview: composition, formulas and gates

Stage 3 delivers the Market Overview workspace: `GET /api/v1/market/overview`
(methodology `market-overview:v1`) and the redesigned `#overview` page. Every
figure is read from the archive. The route never contacts a provider, and it
accepts an optional guarded `asOf` cutoff.

## Blocks and their scope

| Block | Source and scope | Formula |
|---|---|---|
| Provider global | CoinGecko `/global` hourly snapshot; provider coverage, USD | Provider totals and market-cap percentages, stored verbatim. Never a sum of the tracked page. |
| Reported volume trend | Same hourly snapshots, sampled from this archive onward | One point per archived snapshot of the provider's rolling 24h volume. Changes compare the latest sample with the archived sample nearest 24 hours or 7 days earlier, within 90 minutes. |
| Breadth | CoinGecko rank-selected first page, up to 100 assets | Advancing/declining/unchanged/unknown counts over the exact membership of the latest archived snapshot, using provider 24h percentage changes. |
| Above own averages | Assets with archived CoinGecko daily price samples | Latest completed daily sample against its own 50-day and 200-day trailing average, each requiring a complete contiguous window. Assets without one are **uncovered**, never "below". |
| BTC regime | Coin Metrics Community daily closes (CC BY-NC 4.0) | The Stage 2 `btc-trend:v1` confirmed regime, Mayer Multiple, MVRV, drawdown, realized volatility and weekly RSI, displayed side by side rather than merged. |
| Liquidity | DefiLlama covered USD-pegged supply; CoinGecko reported volume | Supply 30D change compares the latest completed UTC day with the value exactly 30 days earlier; an absent or non-positive comparison stays unavailable. |
| Relative performance | Archived CoinGecko daily samples for asset and BTC benchmark | Return = last completed sample / the sample exactly 7, 30 or 90 days earlier − 1. BTC-relative return compounds: `(1 + asset) / (1 + BTC) − 1`. BTC against itself is zero. |
| Provider-reported movers | Tracked page only | Provider-reported 24h percentages. An asset is a leader or a laggard, never both. |
| Notable changes | Confirmed BTC regime transitions, saved threshold crossings, tracked-page membership events | Membership events are archived-page changes, not listings, delistings or launches. |
| Sector leadership | Curated prototype taxonomy | **Gated.** Classified/unclassified counts and share of classified market cap only. No sector-relative returns or multiples. |

## Rules this page keeps

- Every aggregate declares its own coverage. A top-N figure is never labeled global.
- Missing inputs stay unavailable; nothing is forward-filled or interpolated.
- Each block reads its own feed. A failed acquisition marks that block degraded
  and stale while the other blocks continue to serve archived values.
- Under `asOf`, a feed whose production coverage starts after the cutoff is
  refused explicitly for its own block and listed in
  `methodology.replayRefusals`. The whole request returns HTTP 409 only when no
  feed covers the cutoff. Cutoffs in the future return HTTP 400.
- Percentages above trailing averages report `above / covered`, so partial daily
  coverage cannot masquerade as tracked-page participation.

## Current coverage limits

Daily price archives exist for the four priority assets, so above-average
participation and relative performance cover 4 of 100 tracked assets. The hourly
global sample series begins when this archive began sampling, so 24-hour and
7-day volume changes stay unavailable until enough samples exist. Sector
leadership stays gated until asset-sector mappings and historical membership are
verified. [Dated local execution evidence](stage3-overview-2026-09-10.json).
