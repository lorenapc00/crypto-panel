# Archive worker

Stage 1 software finalized 2026-09-09. Local Mac supervision and verified daily
backups are installed; always-on hosting and sustained uptime remain an open
operational condition. The worker uses PostgreSQL and the existing API dependencies.
See [operation/restore procedures](../../ops/README.md) and
[finalization evidence](stage1-finalization-2026-09-09.json).

[Local startup evidence](worker-start-2026-09-09.json) records the first successful
run: 15 healthy datasets, 8,208 protocol entries, 517 instrument entries across
eleven namespaces, and 20 pools per chain, with no observed request failures.
Coverage began between 13:34 and 13:36 UTC on 2026-09-09, independently per dataset.

The [snapshot upgrade evidence](worker-snapshots-2026-09-09.json) records 26 healthy
acquisition datasets after applying migration 0004 and restarting locally on
2026-09-09 São Paulo time (2026-09-10 UTC). All eleven new jobs acquired data;
the API returned the 100-asset page, global overview and four priority profiles.
The restart also recorded earlier downtime: 11 missed hourly intervals on each
Hyperliquid dataset and 135/136 missed Base/Solana pool intervals. Healthy current
acquisition does not erase historical gaps or establish supervised uptime.

## Run and recover

Stop the older worker before applying new migrations, building, and starting the
updated worker. Stage 1 now includes migrations through `0007_alert_evidence.sql`.
An older binary does not contain the new job definitions. Legacy observations
are preserved read-only; the first successful new snapshot begins its coverage.


```bash
pnpm --filter @crypto-panel/api db:migrate
pnpm --filter @crypto-panel/api worker
```

Use the same `DATABASE_URL` as the API. No provider key is required for the discovery feeds. Scheduled CoinGecko
market/global requests optionally use an exported `COINGECKO_DEMO_API_KEY`; the
worker does not load `.env`. The acquisition universe remains the first 100 assets. Run in a separate terminal, or under the host's service manager
with automatic restart. SIGINT/SIGTERM finishes the current bounded request and
stops. Schema migration remains an explicit deployment step. Both source and
compiled deployments need `docs/data/quota-budget.json` at its repository-relative
location; deployments also need the existing SQL migrations directory.

`worker:once` schedules current slots and drains immediately available work. It
does not sleep through quota deferrals or retry delays. Deferred runs persist for
the next invocation. Use continuous `worker` for ongoing acquisition.

The queue uses UTC slots and database time. Startup does not backfill earlier
catalog slots. On restart, elapsed slots are recorded as gaps and only the latest
current slot is queued. Each claimed run has a 90-second lease and each request
has a 20-second timeout. Expired leases recover with a new token; the old worker
cannot commit membership or coverage. Snapshot, lifecycle events, coverage and
successful run completion commit together. SQL errors stop the process so the
supervisor can restart it; unresolved reservations remain visible and charged.

## Active scope

| Dataset IDs | Schedule | Coverage |
|---|---|---|
| `defillama:protocols:v1` | Daily | Returned protocol catalog, token links and catalog TVL samples; token stage remains unknown |
| `hyperliquid:namespaces:v1` | Hourly | Full returned namespace catalog, including uncovered namespaces |
| `hyperliquid:instruments:{namespace}:v1` | Hourly | Native (`native` in dataset ID, empty namespace in provider request), xyz, flx, vntl, hyna, km, abcd, cash, para, mkts, io |
| `geckoterminal:pools:{chain}:v1` | Five minutes | First page, up to 20 pools each on Solana and Base; sampled coverage |
| `coingecko:market:top100:v1` | Hourly | Exact first-page membership, null values and provider asset update times; missing from this page does not prove delisting |
| `coingecko:global:v1` | Hourly | Provider-global USD market cap, reported volume and BTC/ETH percentages |
| `defillama:{asset}:{metric}:snapshot:v1` | Daily | ETH/SOL chain TVL and scoped fees; Hyperliquid protocol TVL, fees and retained revenue (seven feeds) |
| `mempool:bitcoin:tip:v1` | Hourly | Tip height and derived subsidy era |
| `solana-rpc:solana:inflation:v1` | Hourly | Observed annualized inflation parameter; not realized net issuance |
| `coingecko:{asset}:daily-history:v1` | Daily, 00:15 UTC | BTC/ETH/SOL/HYPE daily USD price and sampled trailing-24-hour volume; historical reconstruction before archive coverage |
| `coinmetrics:bitcoin:daily-history:v1` | Daily, 02:00 UTC | BTC PriceUSD, CapMrktCurUSD, CapMVRVCur and SplyCur; complete history in one quota-controlled batch, with original UTC day labels and independent metric coverage |
| `defillama:{asset}:{metric}:daily-history:v1` | Daily, 00:30 UTC | Eight histories: ETH/SOL chain fees/TVL and Hyperliquid protocol fees/revenue/holder revenue/TVL |
| `hyperliquid:book:BTC:v1` | Hourly | Native BTC top-20 book, spread/depth and estimated impact in USDC; no assumed USD peg |
| `hyperliquid:funding:BTC:v1` | Hourly | Last two hours of settled native BTC funding rates, hourly interval; not account cash flows |
| `dexscreener:{chain}:{pairs\|orders}:slot{0..19}:v1` | Hourly | Up to 20 distinct sampled base tokens per chain, using a pool snapshot at most one hour old |

There are 121 scheduled definitions, including 80 spot enrichment slots. An empty
slot is skipped without HTTP or replay coverage. CoinGecko produces eight series,
DefiLlama another eight, and Coin Metrics four (20 total). Historical Hyperliquid TVL contains irregular timestamps;
these are preserved and flagged, never shifted to fabricate regular daily bars.
Base Uniswap v4 pool IDs may be bytes32; pair identity is stored separately from
token contract addresses. Pair liquidity and risk fields remain unknown when
missing, and paid orders/boosts remain explicitly promotional evidence.

The eleven instrument namespaces match the stage 0 budget. Newly reported
namespaces appear in `coverage_notes.uncoveredNamespaces`; they do not silently
expand acquisition. Missing configured namespaces are reported separately.
Review coverage and the budget before changing the allowlist or intervals; use
new dataset versions when methodology changes.

Protocol entities are separate from token identities. Missing CoinGecko links
do not establish pre-token status. Instruments preserve venue, namespace, exact
provider name, catalog index, contract metadata and collateral token index.
Underlying asset and crypto/non-crypto classification remain unresolved.

OI remains in underlying units. Estimated quote notional is OI × mark price;
quote currency is unresolved, so it is not presented as USD. Funding is a current
rate sample with the documented hourly interval, not a settled cash flow. Missing
impact prices and order books remain null. Pool keys use chain and contract
address, preserving Solana case and canonicalizing Base address case. Provider
pool creation, first observation and unknown token launch remain distinct.

These adapters use the provider contracts checked during implementation:
[Hyperliquid metadata/context API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals),
[Hyperliquid weights](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits),
[GeckoTerminal API guidance](https://apiguide.geckoterminal.com/), and
[DefiLlama route manifest](https://raw.githubusercontent.com/DefiLlama/api-docs/main/llms.txt).
Snapshot contracts were also checked against [CoinGecko markets](https://docs.coingecko.com/reference/coins-markets),
[CoinGecko global](https://docs.coingecko.com/reference/crypto-global), and
[Solana inflation RPC](https://solana.com/docs/rpc/http/getinflationrate).
GeckoTerminal requests pin `Accept: application/json;version=20230302`.

## Quotas and failure handling

The worker reads `docs/data/quota-budget.json` on startup and stores its hash
with each active provider's limits. All worker processes share PostgreSQL token
buckets, UTC calendar-month counters and provider backoff. Small bucket capacity
spreads calls rather than allowing a minute's entire allowance in one burst.
Hyperliquid catalog/context requests reserve weight 20 each, BTC books 2 and
two-hour funding windows 21; other scheduled jobs reserve one unit. Each HTTP attempt also consumes one monthly request, including
errors and retries. A reservation followed by a crash is conservatively charged.

429, 408, 5xx and network failures retry with exponential delay and jitter, up to
three HTTP attempts per slot. `Retry-After` seconds and dates take precedence when
longer. Backoff applies to sibling jobs from the same provider. Monthly exhaustion
defers until the next UTC month; elapsed acquisition slots still become gaps.
Permanent HTTP failures and malformed responses fail the slot without inventing
empty membership. Raw response text, its hash, endpoint, POST body, request/receipt
times and HTTP result remain available for diagnosis.

Quota scope is **all scheduled feeds, manual daily history and capability-probe CLI requests**.
External requests record purpose and sanitized endpoint and share the same counters
and backoff. The active CoinGecko schedule is 1,612 calls in 31 days before retries,
within the broader design budget. DefiLlama catalog, seven fundamental snapshots
and eight normalized histories share one provider bucket and monthly counter
(496 requests/31 days before retries). The local limits are not a claim about undocumented provider
guarantees. The current GeckoTerminal FAQ states 30/minute; this worker retains
the existing conservative 5/minute ceiling. [Provider FAQ](https://apiguide.geckoterminal.com/faq)

## Replay, lifecycle and health

The first successful scheduled snapshot starts that dataset's forward archive.
Catalog entities receive baseline records, not new-listing notifications.
Global, fundamental and issuance samples do not emit entity lifecycle events. Later
new identities receive `first_observed`; the system never substitutes provider
history or current metadata for an earlier public listing date. Explicit
instrument flag changes produce `delisted`/`relisted`. Catalog disappearance
produces `catalog_absent`, not proof of delisting; reappearance may be `returned`.
Sampled pools never acquire closure/relisting events from sample absence.

`GET /api/v1/discovery/archive?dataset=...&asOf=...` selects the snapshot recorded
and observed by the cutoff, with its members, lifecycle events, provenance and
coverage. A cutoff before the first successful archive receives HTTP 409; a
future or malformed cutoff receives HTTP 400. Omitting `asOf` returns the latest
forward-tracking snapshot. Missing intervals remain explicit even after recovery.
The response describes one acquisition snapshot, not a historical token launch
database or an executable backtest.

`GET /api/v1/data-health` reads persisted job status, last successful observations,
expected and latest observed spacing, coverage starts, coverage notes, monthly
requests, recent errors/unfinished requests and missed intervals. Gap detection
latency is seconds from the first missing slot's scheduled time to detection.
Staleness continues to be visible while the worker is down; new gap records are
written when scheduling resumes. The Data Health page also includes individual
series, detected intervals, current missing and resolved historical gaps, worker
heartbeats, database size and the latest checksum/restore-verified backup.

For a headless health read without starting the API, use
`pnpm --filter @crypto-panel/api worker --health`. This reads persisted health and
exits without scheduling or fetching.

Coin Metrics multi-cycle BTC history is scheduled and supports the [BTC research
and study primitive](BTC_RESEARCH.md). Not yet scheduled: macro, broad fundamentals,
additional OI/stablecoin series and strategy backtests. These follow the product sequence and individual
feed gates. Watchlists, notes/revisions, screens/preferences and threshold alerts
now persist in PostgreSQL. API reads are stored-only.
`/assets` and `/overview` accept `asOf`; pre-coverage requests return 409.
Former market members retain a stale research profile without changing current
breadth. Unknown values stay null; no legacy observation fallback changes scope.
Provider failures degrade each fundamental independently. Provider observation
time and acquisition time are separate; fee summaries have unknown observation
and publication times. Snapshot health measures acquisition timing; individual
series expose both acquisition freshness and latest completed observation.

## Validation

`pnpm test` includes provider-schema and retry-delay tests.
`TEST_DATABASE_URL=... pnpm --filter @crypto-panel/api test:db` exercises isolated
PostgreSQL schemas, including concurrent claims/reservations, restart recovery,
quota month rollover, shared backoff, baseline and lifecycle transitions,
immutable replay, sampled-pool absence and gap detection. No test writes fixture
membership into the application schema.

After correcting an adapter, `worker --retry-failed` requeues failed slots that
are still current and below the three-attempt cap. It never resets usage or
overwrites failure evidence. `node ops/verify-local.mjs --restart-test` exercises
graceful termination and launchd recovery and saves `.reports/stage1-verification.json`.
