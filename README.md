# Crypto Panel

Personal crypto market-intelligence dashboard. English/USD, dark terminal UI,
top-100 market coverage, persistent personal research state, source attribution and freshness
metadata. It is a free beta and does not provide investment advice.

## Run

Start Docker Desktop before running the database commands. Keep the API and web
development servers running in separate terminals.

```bash
pnpm install
docker compose up -d postgres
pnpm --filter @crypto-panel/api db:migrate
# Run in a separate terminal; wait for the first successful market snapshot
pnpm --filter @crypto-panel/api worker
# Optional immediate refresh; the worker also schedules these four histories daily
pnpm --filter @crypto-panel/api ingest:market
pnpm dev:api # API: http://127.0.0.1:3100
pnpm dev     # Web: http://127.0.0.1:5174
```

The Crypto Panel deliberately uses ports 3100 (API) and 5174 (web), so it can
run alongside another local project, which uses 3000 and 5173. This is one personal
workspace stored in PostgreSQL. The API binds to loopback by default. Optional
`WORKSPACE_TOKEN` protects API access with a bearer token entered in the web app;
the browser keeps that token only for its session. `WEB_ORIGINS` accepts a
comma-separated origin allowlist. The fake development session endpoint is removed.

API reads require PostgreSQL and persisted worker snapshots. Run migrations and
start the worker before loading the interface. A feed with no successful archive
shows unavailable; a failed or late feed retains its stored values with stale
metadata. No API read fetches a provider or starts a backfill. Daily charts appear
after the first scheduled or explicit history acquisition. Database outages return an API error;
there is no live-provider fallback.

## Data model and first asset profiles

PostgreSQL stores assets, source definitions, metric definitions, market
membership snapshots, raw provider payloads and immutable daily-series revisions.
Legacy snapshot observations remain read-only and are excluded from API/replay reads. Legacy
OHLCV rows are preserved in the read-only `legacy_candles` quarantine table.
The initial asset profiles are Bitcoin,
Ethereum, Solana and Hyperliquid (HYPE), available by selecting an asset in the
market table. Each response includes its provider, observation time, coverage
and stale status.

The first source is CoinGecko. Manual ingestion refreshes daily history when the
newest completed UTC sample is stale; current history is skipped. To check
revisions immediately, append `--force-history` to `ingest:market`. Changed
values append revisions, unchanged values are deduplicated, and each response
retains its provenance. Price and reported trailing-24-hour volume are separate
series. Returns use calendar dates; indicators require contiguous daily history
and RSI uses Wilder smoothing. Opening an asset page reads stored history without
triggering a backfill. Market/global, verified fundamentals and issuance
snapshots and daily histories run in the shared worker queue. Provider failures
leave archived history intact. Manual ingestion and probe CLI requests share the
same persisted quota counters and backoff as the worker.

Watchlists, saved screens, filters, chart ranges and thesis notes survive reloads
and API restarts. Notes retain dated revisions. The Research page manages price,
market-cap and 24-hour-change threshold conditions; the first valid observation
sets a baseline, and later false-to-true crossings create evidence-backed alerts.
Missing/stale inputs never create synthetic alerts. Taxonomy holds ten curated,
versioned classifications; other assets remain unclassified.

### Schema upgrades and database tests

`db:migrate` applies numbered SQL files from `apps/api/migrations/` atomically,
serializes concurrent runs, and records checksums in `schema_migrations`. It
adopts existing unversioned databases and preserves legacy candle values without
relabeling them. Add a new migration for future changes; do not edit applied
files. Run migrations before starting the updated API. Deployments must include
the `migrations/` directory alongside `src/` or compiled `dist/`.

### Applying code changes to the running worker

The `worker` and `dev:api` processes do **not** hot-reload compiled code. The
supervised worker installed by `ops/` runs `apps/api/dist/worker.js`, so after
changing any worker or backtest code you must rebuild **and restart the worker**,
or queued work (scheduled jobs, backtest runs) sits unprocessed:

```bash
pnpm --filter @crypto-panel/api build
# Restart the supervised LaunchAgent worker (launchd KeepAlive respawns it):
launchctl kickstart -k gui/$(id -u)/local.cryptopanel.worker
# Or, if running the worker manually, stop it and start it again:
pnpm --filter @crypto-panel/api worker
```

`pnpm dev:api` reloads `src/` on save via `tsx watch`, so API-only changes need
no manual restart; the worker does not watch.

`pnpm test` runs local unit tests and asserts API test execution counts. Run
PostgreSQL integration tests explicitly against the local development database:

```bash
TEST_DATABASE_URL=postgres://crypto_panel:crypto_panel_dev@127.0.0.1:5432/crypto_panel pnpm --filter @crypto-panel/api test:db
# One-time browser installation, then isolated browser tests (PostgreSQL required)
pnpm --filter @crypto-panel/web exec playwright install chromium
pnpm --filter @crypto-panel/web test:e2e
```

Each database test creates and removes its own random schema. Tests cover fresh
and legacy upgrades, rollback, concurrent migrations, immutable revisions,
cutoff replay, scope checks, and populated stale-history refresh. One-off price
backfills are labeled historical reconstruction; they do not create production
replay coverage. Repository `asOf` reads reject dates without declared coverage.
Validation through Stage 6 Backtest Lab passes 121 unit/capability checks, 63 PostgreSQL cases and
nineteen browser scenarios. Browser fixtures use a separate temporary schema and ports
3101/5175; they do not add research records to the personal workspace.

## Fundamentals and tokenomics

The worker archives seven verified DefiLlama metric snapshots daily: Ethereum and Solana use chain aggregates, while HYPE uses the
Hyperliquid protocol aggregate. Chain fees are never presented as token revenue.
BTC tip/subsidy and the Solana inflation parameter are archived hourly; neither
is presented as realized net issuance. The product derives circulating/max-supply coverage from CoinGecko snapshots,
but does not label the remainder as a future unlock or emission forecast. A
verified event-level unlock source must be connected before such events appear.
Eight normalized fundamental histories preserve provider timestamps and revisions,
including holder revenue as a separate metric. Irregular historical TVL spacing
is flagged on Data Health. Native BTC book depth is denominated in USDC, and
settled hourly funding rates are archived without implying account cash flows.

## Investment research roadmap

Development follows [INVESTMENT_RESEARCH_PLAN.md](INVESTMENT_RESEARCH_PLAN.md).
Stage 0 produced a [data capability manifest](docs/data/CAPABILITY_MANIFEST.md)
with dated endpoint evidence, unavailable-feed decisions, and a quota budget.
Stage 1 adds the migration/archive foundation, corrected daily history, and a
scheduled discovery archive. The worker collects protocol catalogs daily,
Hyperliquid namespaces and instrument contexts hourly, and the first 20 new
pools on Solana and Base every five minutes. Initial catalog snapshots establish
baselines; first observation never invents a historical listing or token-launch
date. Quotas, retry delays, leases and missing intervals persist across restarts.

See the [worker runbook](docs/data/DISCOVERY_WORKER.md) for coverage, supervision
and replay semantics. `worker:once` drains immediately available work and exits;
quota-delayed jobs remain queued. Keep `worker` running to accumulate coverage.
The API exposes stored `GET /api/v1/data-health` and
`GET /api/v1/discovery/archive?dataset=hyperliquid%3Ainstruments%3Anative%3Av1`
with optional `asOf`. The Data Health page shows per-job and per-series freshness,
intervals, missing/resolved gaps, replay starts, quota/error counts, worker
heartbeats, storage size and the latest verified backup. Market coverage remains one top-100
page; the 1,000-asset expansion is still gated. Global totals use a separate
CoinGecko `/global` snapshot, while breadth retains exact tracked-page membership.
`/assets`, `/overview` and `/market/overview` accept guarded `asOf` cutoffs; other asset routes remain
current-state reads. `/api/v1/series` accepts `asset`, `metric`, optional interval
in seconds, `seriesId`, `from`, `to` and guarded `asOf` queries.

The 123 scheduled job definitions include four priority daily charts, eight
fundamental histories, a selected BTC book/funding pair, and up to 40 sampled
Solana/Base token pair/promotion lookups per hour. Empty token slots skip without
consuming quota or starting replay coverage. Paid promotion stays separate from
trading evidence, and unverified contract risks remain unknown. The additional
Coin Metrics daily BTC batch archives price, current-supply market cap, MVRV and
supply under the existing quota budget. Two daily DefiLlama jobs add covered
USD-pegged supply history and its separately sampled current asset catalog.

Open **BTC Cycles** for long-term interactive charts, daily/weekly averages,
three-day-confirmed regimes, valuation, drawdown and halving comparisons. Range
and log-scale settings persist; charts export as PNG. The signal-study primitive
evaluates BTC regime transitions or custom event dates across the four priority
assets, with six forward horizons, BTC-relative returns, downside and coverage
counts. Study inputs/results are immutable and reopen by ID; exports include the
archived revisions. These are descriptive historical reconstructions, without
executable strategy or statistical-significance claims. See [BTC methodology and
API details](docs/data/BTC_RESEARCH.md) and [local execution evidence](docs/data/stage2-btc-2026-09-09.json).
BTC Cycles also surfaces native Hyperliquid BTC open interest, estimated notional
in documented USDT price units with USDC collateral, and separate sampled and
settled hourly funding. Capital context shows covered USD-pegged stablecoin
supply, exact 30D changes, an attributed chart/export and current catalog coverage.
Historical constituents remain unavailable; supply changes are not measured net
inflows. Each feed reports its own freshness, provenance and replay start.
`GET /api/v1/btc/context` reads archived data with an optional guarded `asOf`.
Aggregate histories can use `/api/v1/series?seriesId=...` without an asset identifier.
BTC Cycles also charts the archived Alternative.me Crypto Fear & Greed Index —
full history and a per-halving-cycle overlay (`GET /api/v1/btc/sentiment`) — with
only the raw 0-100 value stored; the provider's published history starts
2018-02-01, so the 2012/2016 halving cycles show partial or no data. The same
indicator is available as a `fear-greed` threshold condition in the Backtest Lab
custom-strategy rule builder. See [capability probe](docs/data/CAPABILITY_MANIFEST.md#alternativeme-crypto-fear--greed-index-checked-2026-09-10)
and [dated evidence](docs/data/stage6c-fear-greed-2026-09-10.json).
[Context execution evidence](docs/data/stage2-context-2026-09-09.json) records
3,207 completed supply days and 337 current USD-pegged catalog members.
Open **Market Overview** for composed market conditions: provider-global
aggregates, sampled hourly market-cap/volume/dominance charts, tracked-page
breadth, the share of covered assets above their own 50D/200D averages, the BTC
regime summary, covered stablecoin supply and its exact 30D change, BTC-relative
7D/30D/90D performance, provider-reported movers and notable changes. Sector
leadership stays gated at curated classification coverage. Each figure opens its
own formula, scope, freshness and provenance. `GET /api/v1/market/overview`
reads only stored data and accepts a guarded `asOf`; a feed whose coverage starts
after the cutoff is refused for its own block instead of being reconstructed. See
[Market Overview methodology](docs/data/MARKET_OVERVIEW.md) and
[dated execution evidence](docs/data/stage3-overview-2026-09-10.json).

Open **Perp Discovery** for the two perp research views. *Perp DEX Projects*
composes the DefiLlama `Derivatives` catalog and the covered open-interest
universe with per-protocol open interest, share of that covered universe,
recomputed 7D/30D changes, catalog TVL, trailing 30-day fees and revenue for
individually verified protocols, curated venue links, why-watch reasons,
contradictory evidence and risk flags. *New Perp Listings* tracks the archived
Hyperliquid catalogs: listing classification, time since first observation,
native open-interest units with an estimated quote notional, funding and its
settlement interval, mark/oracle premium, order-book spread and impact where a
book is archived, and underlying spot returns versus BTC for verified links only.
A first catalog ingestion is a baseline, never a listing, and lifecycle alerts
derive from the immutable event log, so acknowledging one cannot change its
evidence. Reported perp volume, volume market share, protocol and token launch
dates and token terms stay visibly gated. `GET /api/v1/perp/projects`,
`GET /api/v1/perp/listings` and `GET /api/v1/perp/alerts` read only stored data
and accept a guarded `asOf`. See [perp methodology](docs/data/PERP_DISCOVERY.md)
and [dated execution evidence](docs/data/stage4-perp-2026-09-10.json).

Open **Altcoin Discovery** for the two broader research views. *Emerging
Projects* composes the archived CoinGecko tracked page with the four priority
daily price and volume series: BTC-relative 7D/30D/90D returns, 30D/90D realized
volatility, maximum drawdown with recovery, BTC correlation and beta, a 30-day
volume median and 7-over-30 acceleration, and supply/FDV dilution. Every research
default reports pass, fail or unknown separately, an unknown check is never a
pass, and stablecoins, tokenized funds, commodity-backed tokens and wrapped
duplicates are excluded through curated immutable rows while a peg-catalog symbol
collision is only flagged. The 40/30/30 Attention percentile score stays out of
prime interface space with its unvalidated-v0 caveat. *Spot Launches* composes
the Solana and Base new-pool samples with DEX Screener pair and promotion
enrichment: tokens are deduplicated by chain and contract across every pool ever
sampled so a later pool never makes an old token new, unknown pool liquidity
stays unknown and off the default shortlist, and paid boosts are labelled
promotion. The 1,000-asset universe expansion, verified launch dates, token value
capture and sector-peer comparison stay visibly gated. `GET /api/v1/altcoin/emerging`
and `GET /api/v1/altcoin/launches` read only stored data and accept a guarded
`asOf`. See [altcoin methodology](docs/data/ALTCOIN_DISCOVERY.md) and
[dated execution evidence](docs/data/stage5-altcoin-2026-09-10.json).

Open **Backtest Lab** for three modes. *Historical replay* composes the archived
Market Overview, Emerging Projects, Spot Launches and Perp workspaces at a chosen
`asOf` date and refuses each workspace whose coverage starts after that date;
a cutoff before the BTC regime's own coverage is refused outright. *Signal study*
is the stage 2 primitive, relocated here from BTC Cycles. *Strategy test* has two
engines over the full Coin Metrics BTC price history. **BTC regime filter vs BTC
buy-and-hold** holds BTC only while the confirmed daily regime is bullish
(optionally also transitional), otherwise sits flat. **Custom strategy** is a
portfolio simulator: a starting lump sum and a recurring contribution, your own
entry rule (trigger + optional indicator guard — regime, new ATH, drawdown from
ATH, Mayer multiple, price vs 200D SMA, weekly RSI, MVRV, Fear & Greed Index — + size) and exit rule,
compared against buy-every-dollar DCA and a hindsight lump sum, with a
money-weighted return (IRR), a trade ledger and a chronological holdout. Every
signal reads the completed prior day and executes next-day with no look-ahead; a
flat per-side basis-point cost is charged on each trade and reported at 25/50/100
bps. Runs are queued in `backtest_runs`, executed by the worker, then frozen; an
identical template version and parameter set returns the stored result instead of
recomputing (SHA-256 input hash). The attention-basket, early-launch and
perp-project/listing templates are listed as deferred until replay coverage
accrues; expanded on-chain, unlock, ETF and derivatives feeds stay gated exactly
as stage 0 left them. `GET /api/v1/backtest/templates`, `GET /api/v1/backtest/replay?asOf=`
and `POST`/`GET /api/v1/backtest/runs` read only stored data. **The worker must be
running for a submitted run to leave `queued`.** See
[Backtest Lab methodology](docs/data/BACKTEST_LAB.md) and
[dated execution evidence](docs/data/stage6-backtest-2026-09-10.json).

See [archive operation and restore procedures](ops/README.md) for local Mac
supervision, a Linux service template and seven-copy daily backup retention.
The local worker and backup LaunchAgents are installed and a restore is verified.
Continuous hosting remains an operational requirement: this Mac must stay awake,
logged in and running Docker. Local backups need a separate-machine copy for
protection against machine loss. [Dated verification](docs/data/stage1-finalization-2026-09-09.json).

```bash
# Provider reads with persisted quota accounting (requires PostgreSQL and network)
# Saves .reports/capabilities.json
pnpm research:probe
# Optional: repeat selected checks
pnpm research:probe --only cg-global,cm-btc-core-batch
# Recalculate proposed provider budgets, without network calls
pnpm research:budget
```

The probe optionally uses exported `COINGECKO_DEMO_API_KEY` and `FRED_API_KEY`.
CLI commands do not load `.env` automatically; the generated services explicitly
load the repository `.env` when present. Manual and scheduled CoinGecko requests
send the optional Demo key as a header. Apply migrations before running probes.
See the manifest for result classifications, scope, and remaining stage 1 work.
