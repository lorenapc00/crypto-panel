# Crypto Panel

Personal crypto market-intelligence dashboard. English/USD, dark terminal UI,
top-100 market coverage, shared demo watchlists, source attribution and freshness
metadata. It is a free beta and does not provide investment advice.

## Run

```bash
pnpm install
docker compose up -d postgres
pnpm --filter @crypto-panel/api db:migrate
# Initial snapshots and daily price/rolling-volume history for BTC, ETH, SOL and HYPE
pnpm --filter @crypto-panel/api ingest:market
pnpm dev:api # API: http://127.0.0.1:3100
pnpm dev     # Web: http://127.0.0.1:5174
```

The Crypto Panel deliberately uses ports 3100 (API) and 5174 (web), so it can
run alongside another local project, which uses 3000 and 5173. Authentication is
currently deferred; the API exposes a temporary shared demo workspace.

## Data model and first asset profiles

PostgreSQL stores assets, source definitions, metric definitions, market
observations, raw provider payloads and immutable daily-series revisions. Legacy
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
triggering a backfill. Market/fundamental API reads still fetch live until the
worker is implemented. Provider failures leave archived history intact.

### Schema upgrades and database tests

`db:migrate` applies numbered SQL files from `apps/api/migrations/` atomically,
serializes concurrent runs, and records checksums in `schema_migrations`. It
adopts existing unversioned databases and preserves legacy candle values without
relabeling them. Add a new migration for future changes; do not edit applied
files. Run migrations before starting the updated API. Deployments must include
the `migrations/` directory alongside `src/` or compiled `dist/`.

`pnpm test` runs local unit tests and asserts API test execution counts. Run
PostgreSQL integration tests explicitly against the local development database:

```bash
TEST_DATABASE_URL=postgres://crypto_panel:crypto_panel_dev@127.0.0.1:5432/crypto_panel pnpm --filter @crypto-panel/api test:db
```

Each database test creates and removes its own random schema. Tests cover fresh
and legacy upgrades, rollback, concurrent migrations, immutable revisions,
cutoff replay, scope checks, and populated stale-history refresh. One-off price
backfills are labeled historical reconstruction; they do not create production
replay coverage. Repository `asOf` reads reject dates without declared coverage.

## Fundamentals and tokenomics

The ingest command also fetches DefiLlama fundamentals where the metric scope
is appropriate: Ethereum and Solana use chain aggregates, while HYPE uses the
Hyperliquid protocol aggregate. Chain fees are never presented as token revenue.
The product derives circulating/max-supply coverage from CoinGecko snapshots,
but does not label the remainder as a future unlock or emission forecast. A
verified event-level unlock source must be connected before such events appear.

## Investment research roadmap

Development follows [INVESTMENT_RESEARCH_PLAN.md](INVESTMENT_RESEARCH_PLAN.md).
Stage 0 produced a [data capability manifest](docs/data/CAPABILITY_MANIFEST.md)
with dated endpoint evidence, unavailable-feed decisions, and a quota budget.
The first stage 1 slice adds the migration/archive foundation and corrected
daily asset history. The scheduled discovery archive and new research workspaces
are still planned work.

```bash
# Read-only provider checks; saves .reports/capabilities.json (requires network)
pnpm research:probe
# Optional: repeat selected checks
pnpm research:probe --only cg-global,cm-btc-core-batch
# Recalculate proposed provider budgets, without network calls
pnpm research:budget
```

The probe optionally uses exported `COINGECKO_DEMO_API_KEY` and `FRED_API_KEY`.
It does not load `.env`. Manual daily-history ingestion also supports the Demo
key; older market/fundamental adapters do not yet use it.
See the manifest for result classifications, scope, and remaining stage 1 work.
