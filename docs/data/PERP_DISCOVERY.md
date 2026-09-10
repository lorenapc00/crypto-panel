# Perp discovery: composition, formulas and gates

Stage 4 delivers the perp discovery workspace: `GET /api/v1/perp/projects`
(methodology `perp-projects:v1`), `GET /api/v1/perp/listings`
(`perp-listings:v1`), `GET /api/v1/perp/alerts` with a `POST` acknowledgement,
and the `#perp` page. Every figure is read from the archive; the routes never
contact a provider and accept an optional guarded `asOf` cutoff.

Stage 4 adds one acquisition feed, `defillama:perp-open-interest:v1`, inside the
open-interest slot the stage 0 budget already reserved. Perp volume remains
gated: `/overview/derivatives` and `/summary/derivatives/hyperliquid` returned
HTTP 402.

## Perp DEX Projects

| Block | Source and scope | Formula |
|---|---|---|
| Universe | DefiLlama `Derivatives` catalog category ∪ the covered open-interest universe | A provider category, not a verified perp-DEX taxonomy. It includes non-perpetual derivatives and may omit perp venues the provider files elsewhere. |
| Covered open interest | DefiLlama open-interest dimension, USD | Per-protocol `total24h` is the current open-interest value, not a 24-hour flow. The 7D and 30D changes are recomputed from the archived `total7DaysAgo` and `total30DaysAgo` endpoints; the provider percentages travel alongside them. **The provider convention counts both sides of each contract.** |
| Covered-universe aggregate | `defillama:covered-perp-open-interest:perp_open_interest_usd:daily:v1` | Archived `totalDataChart` on completed UTC days. 7D and 30D changes need both exact calendar endpoints. Covered membership changes over time, so this is not a fixed-universe index. |
| Share of covered | Same snapshot | Protocol value ÷ the sum of covered values in that snapshot. A protocol with no reported value is uncovered, never zero. |
| Economics | Individually verified DefiLlama protocol histories only | Trailing 30-day sums over contiguous completed daily values against the preceding contiguous 30 days. Retained fee share is revenue ÷ fees over the same window. The fee rate per unit of volume stays unavailable while volume is gated. |
| Venue link | Curated, immutable `perp_venue_links` | Links a protocol id to a venue namespace this archive also reads directly. Venue-native open interest keeps its own units and is never merged with the provider figure. |
| Token | Provider `gecko_id` resolved against the archived market snapshot | `live-token` when that asset is archived, `provider-linked-token` when only the link exists, otherwise `unknown`. A missing link is **not** proof of a pre-token protocol. Terms, unlocks and value capture stay unavailable. |
| Lifecycle | `discovery_first_seen` and `discovery_events` | Protocol launch, token launch and first observation are separate fields. Only first observation is populated. |

Sorting is by verified milestone, with this archive's first observation as an
explicit fallback and protocol id as the tie-break. Volume market-share sorting
stays disabled. The 180-day early-project filter is offered and returns nothing,
because no connected free feed publishes launch dates; the response explains
that rather than presenting undated protocols as new.

## New Perp Listings

| Block | Source and scope | Formula |
|---|---|---|
| Markets | Hyperliquid metadata/context across the eleven budgeted namespaces | Identity is venue + namespace + instrument name. A namespace outside the budget is uncovered, not empty. |
| Listing classification | Immutable archived event log | The most recent event decides: `venue-new-to-archive`, `relisted`, `returned-to-catalog`, `delisted`, `catalog-absent` or `archive-baseline`. The first ingestion of a namespace is a baseline and never a listing. |
| Time since listing | `discovery_first_seen` | Detection time in this archive. Verified trading start, announcement and delisting timestamps are unavailable: the venue metadata carries none. |
| Open interest | Venue context | Native underlying units. Estimated quote notional is native OI × mark price in the venue's quote units, with no USD peg conversion and no double counting. The 24-hour change needs an archived snapshot at that offset; the previous archived snapshot is reported separately with its own time. |
| Funding | Venue context and settled funding archive | The context rate is a current sample for its stated hourly interval. Settled hourly funding is separate evidence and is never account cash flow. Annualization is presentation. |
| Premium | Venue context | `mark / oracle − 1` in basis points from one observation; the provider's own premium field travels with it. |
| Liquidity | Archived order books where they exist | Spread, depth and estimated impact at $1K and $10K notionals come only from an archived book. Otherwise the row says so and shows the provider impact prices as a venue sample. |
| Underlying | Curated, immutable `perp_underlying_links` | Asset class is `crypto` only where a verified link exists; everything else stays `unknown`, and pre-market status stays `unknown`. Spot returns versus BTC use archived daily samples and are kept strictly separate from funded perpetual profit and loss. |
| Namespace collisions | Cross-namespace comparison of base symbols | The same underlying in several namespaces is flagged as related events, not independent samples. |

The default screen selects markets first observed inside the window, relisted or
returned to the catalog, with a verified crypto underlying or the venue's native
namespace, still present in the latest archived catalog. Baseline markets,
delisted markets, markets absent from the latest catalog and unresolved
non-native underlyings are excluded **and counted**, never deleted; the full
archived catalog remains available with `screen=all&underlying=all`.

## Alerts

Alerts are derived from the immutable `discovery_events` archive, so reading or
acknowledging one cannot change its evidence and a baseline ingestion can never
raise a listing alert. `discovery_alert_reads` stores only the read time. Alerts
cover namespace catalogs, budgeted instrument catalogs, covered open-interest
membership and `Derivatives` protocol catalog changes. No order is ever placed.

## Current coverage limits

On 2026-09-10 the archived universe held 471 perp-universe protocols, 127 of
them in the covered open-interest set and 103 with a reported value; the covered
aggregate reached $25.37B on 2026-09-09 with 2,023 daily values from 2021-02-25.
All 517 archived Hyperliquid markets were still at their archive baseline, so
there were no listing events and no alerts; 201 already carried the venue
delisting flag at that baseline. Four markets have a verified crypto underlying
and one has an archived order book. Non-native namespaces are largely equities,
indices, FX and commodities, and stay out of the default screen because no
provider field declares an asset class. See
[dated evidence](stage4-perp-2026-09-10.json).
