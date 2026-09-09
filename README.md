# Crypto Panel

Authenticated crypto market-intelligence dashboard. English/USD, dark terminal UI,
top-100 market coverage, private watchlists, source attribution and freshness
metadata. It is a free beta and does not provide investment advice.

## Run

```bash
pnpm install
docker compose up -d postgres
pnpm --filter @crypto-panel/api db:migrate
# Initial snapshots and OHLCV for BTC, ETH, SOL and HYPE
pnpm --filter @crypto-panel/api ingest:market
pnpm dev:api # API: http://127.0.0.1:3100
pnpm dev     # Web: http://127.0.0.1:5174
```

The Crypto Panel deliberately uses ports 3100 (API) and 5174 (web), so it can
run alongside another local project, which uses 3000 and 5173. Authentication is
currently deferred; the API exposes a temporary shared demo workspace.

## Data model and first asset profiles

PostgreSQL stores assets, source definitions, metric definitions, immutable
market observations and OHLCV candles. The initial asset profiles are Bitcoin,
Ethereum, Solana and Hyperliquid (HYPE), available by selecting an asset in the
market table. Each response includes its provider, observation time, coverage
and stale status.

The first source is CoinGecko. The ingestion command can be safely rerun:
duplicate readings from the same source and observation time are ignored.
CoinGecko rate limits can delay OHLCV acquisition; already persisted snapshots
remain available and are explicitly marked stale if the live provider fails.

## Fundamentals and tokenomics

The ingest command also fetches DefiLlama fundamentals where the metric scope
is appropriate: Ethereum and Solana use chain aggregates, while HYPE uses the
Hyperliquid protocol aggregate. Chain fees are never presented as token revenue.
The product derives circulating/max-supply coverage from CoinGecko snapshots,
but does not label the remainder as a future unlock or emission forecast. A
verified event-level unlock source must be connected before such events appear.
