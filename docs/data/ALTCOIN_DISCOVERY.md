# Broader altcoin research: composition, formulas and gates

Stage 5 delivers the Altcoin Discovery workspace: `GET /api/v1/altcoin/emerging`
(methodology `emerging-projects:v1`), `GET /api/v1/altcoin/launches`
(`spot-launches:v1`), and the `#altcoin` page. Every figure is read from the
archive; the routes never contact a provider and accept an optional guarded
`asOf` cutoff. A feed whose production coverage starts after the cutoff is
refused for its own block instead of being reconstructed.

**No new acquisition feed is added.** Emerging Projects compose the hourly
CoinGecko market snapshot and the four priority daily price and volume series
already archived since stage 1. Spot Launches compose the Solana and Base
new-pool samples and the DEX Screener pair and promotion enrichment that have
been sampling since stage 1. Migration `0011` adds only curated, immutable
`asset_universe_exclusions` and `spot_quote_tokens` reference tables.

## Emerging Projects

| Block | Source and scope | Formula |
|---|---|---|
| Universe | The archived CoinGecko tracked page — the provider's first rank-selected 100 assets | The budgeted 1,000-asset acquisition universe stays gated on verified Demo access, so this is the tail of the top 100, **not** a survey of the $10M–$2B market-cap band. |
| Eligibility | Editable research defaults, not validated thresholds | Market cap $10M–$2B, ≥ 90 contiguous archived daily samples, a 30-day median of daily sampled trailing-24-hour volume ≥ $1M, and no curated exclusion. Each check reports `pass`, `fail` or `unknown` separately. An asset with no archived daily series is `unknown`, never `fail`, and never enters the eligible screen. |
| Identity exclusions | Curated, immutable `asset_universe_exclusions` | Stablecoins, tokenized funds, commodity-backed tokens and wrapped duplicates. A wrapped duplicate names the canonical asset it would double count. A bare symbol collision against the archived DefiLlama USD-pegged catalog is **flagged for review only** — the ticker `M` names a stablecoin and a memecoin alike — and never excludes an asset on its own. |
| Returns | Archived daily price samples; the BTC benchmark uses the same source and sampling time | Return = last completed daily sample ÷ the sample exactly 7, 30 or 90 days earlier − 1. BTC-relative return compounds: (1 + asset) ÷ (1 + BTC) − 1. BTC against itself is zero, not null. Both endpoint dates must exist. |
| Risk | Contiguous archived daily samples | Realized volatility is the annualized standard deviation of daily log returns. Maximum drawdown is the deepest peak-to-trough fall inside the trailing 90 contiguous days; recovery counts days from that trough back to the prior peak and stays unavailable while the drawdown is open. Correlation and OLS beta use only the daily returns the asset and BTC actually share. Every measure is unavailable, never approximate, on an incomplete window. |
| Liquidity | Archived market snapshot and daily volume samples | Reported turnover is provider trailing-24-hour volume ÷ market cap. The 30-day median and the 7-over-30 acceleration use archived daily volume samples at a consistent boundary. These are instantaneous samples of a rolling window, not traded daily volumes; consecutive samples overlap. |
| Dilution | Archived market snapshot | Circulating / total / max supply, FDV ÷ market cap, circulating share of total and of max. A low circulating share indicates potential future dilution, **not** a scheduled unlock. Event-level tokenomics stays gated, so no unlock date is inferred. |
| Attention | Cross-sectional percentiles within the eligible universe on each date | 40% of the 90D BTC-relative return percentile, 30% of the 30D, 30% of the 7-over-30 volume-acceleration percentile. A missing component leaves the asset unranked, never partially scored. |
| Value capture / peers | Gated | Holder revenue exists only for individually verified Ethereum, Solana and Hyperliquid feeds; sector comparison needs verified asset-sector mappings. Ten curated prototype classifications produce no sector-relative figure. |

The list is sorted by archived 30-day BTC-relative return, **not** by Attention.
Attention stays out of prime interface space with its caveat: its three
components are heavily correlated, so it behaves closer to a single momentum
factor than to three independent votes, and no signal study has yet tested it
against an equal-weight eligible-universe benchmark. A young-projects filter is
not offered because no connected free feed publishes verified asset launch
dates; overlooked older projects stay discoverable through the all-tracked-assets
screen.

## Spot Launches

| Block | Source and scope | Formula |
|---|---|---|
| Universe | GeckoTerminal first page of new pools on Solana and Base, ≤ 20 per chain every five minutes, plus DEX Screener enrichment | A sampled radar with declared coverage. A pool that appears and leaves between two samples is never observed. |
| Token identity | Chain + base-token contract address across every pool ever sampled | A newly created pool for an already-observed token does not make that token new. Base addresses are lower-cased; a Uniswap v4 pool ID is a bytes32 identifier and is never treated as a contract address. |
| First observation | `discovery_first_seen`, earliest across all of a token's pools | This archive's detection time for the token. A later pool never resets it, and neither a pool creation time nor a first observation is a verified token launch date. |
| Liquidity | Summed across a token's sampled pools in the newest snapshot containing it | A pool reporting no liquidity keeps the total partial and is counted separately. Unknown liquidity stays `unknown`, never zero, and never meets the minimum unless the operator opts in explicitly. Base pools frequently report no value. |
| Liquidity change | Every contributing pool's own previous archived observation | Stated only when every pool in the current sum has an earlier observation; otherwise the comparison would mix pool memberships. The actual elapsed hours are reported, never assumed to be 24. |
| Attention | Sampled pool activity | Reported 24-hour volume, turnover against observed liquidity, and buy-versus-sell transaction imbalance. Transaction counts are not distinct traders and are trivially inflatable. High turnover or a buy-heavy imbalance is not a positive investment signal. |
| Risk status | Reported separately from attention | Every contract-level check — contract powers, mint/freeze authority, sell restrictions, deployer holdings, holder concentration, liquidity withdrawal — is `unknown`. No unverified check becomes a passing result, and no token is described as safe. The default shortlist excludes unresolved critical flags; no free check is connected, so this currently removes nothing, which is a coverage gap and not a clean bill of health. |
| Promotion | DEX Screener paid orders and boosts | Archived as promotion, reported separately from trading data, never treated as demand. |
| Quote reference | Curated, immutable `spot_quote_tokens` | A pool is priced in its quote token. A base token paired only against an unrecognised quote has no verified USD reference. Recognising a quote token is not a safety or liquidity claim. |

Sorting is by first observation in this archive, then observed liquidity, then a
stable key tie-break. The default screen shows tokens first observed within 30
days that meet the $100K observed-liquidity default.

## Replay

A cutoff selects the snapshots and revisions archived by then. Adding a later
snapshot does not change an earlier point-in-time answer: the tracked-page
membership, the daily-series revisions and the sampled pool memberships are all
selected as of the cutoff. A cutoff before a configured feed's production
coverage is refused explicitly for that feed's block; an unconfigured feed is
unavailable, which is a different thing.

## Sources

- <https://docs.coingecko.com/reference/coins-markets>
- <https://docs.coingecko.com/demo/reference/coins-id-market-chart>
- <https://api-docs.defillama.com/>
- <https://api.geckoterminal.com/docs/index.html>
- <https://docs.dexscreener.com/api/reference>
