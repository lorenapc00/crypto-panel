# Backtest Lab: modes, formulas and the replay horizon

Stage 6 delivers the Backtest Lab workspace and the `#backtest` page. It adds no
provider feed. Migration `0012` adds only `backtest_runs`, a queued, append-only
run ledger. Runs are executed by the archive worker and then frozen: an identical
template version and parameter set over the same archive reproduces an identical
result, and the create route returns the stored run instead of recomputing it.

Three modes:

| Mode | Route | What it does |
|---|---|---|
| Historical replay | `GET /api/v1/backtest/replay?asOf=` | The eligible universe, BTC regime and discovery counts exactly as archived at the cutoff. Each workspace refuses independently when the cutoff predates its coverage. |
| Signal study | `POST /api/v1/signal-studies` (unchanged from stage 2) | Event date to forward 1/7/30/90/180/365-day return versus BTC, with sample count and maximum adverse movement. The primitive UI moved here from BTC Cycles. |
| Strategy test | `POST /api/v1/backtest/runs`, `GET /api/v1/backtest/runs/:id` | Apply a saved selection and execution rule and compare with benchmarks. |

## Strategy test: what is built and what is deferred

Two engines are available, both over the fully backfillable Coin Metrics daily
BTC price history: **BTC regime filter vs BTC buy-and-hold**
(`btc-regime-strategy:v1`, a binary all-in / all-out position on the confirmed
regime) and the **custom strategy engine** (`portfolio-strategy:v1`, a portfolio
simulator with cash, contributions and composable rules — see below).

Four templates are listed as **deferred** and the create route refuses them with a
coverage gate: the weekly top-10 Emerging Projects attention basket, the early
spot-launch signal study, the perp DEX project adoption study, and the new perp
listing event study. Every altcoin, perp and launch dataset began archiving in
stage 1 and is still measured in days, so none has the point-in-time replay
coverage these studies require. They land in a later stage.

## BTC regime filter formula

| Element | Rule |
|---|---|
| Signal | The confirmed daily regime (§3 of the research plan): bullish when the completed close exceeds the 200D SMA and that average exceeds its value 20 days earlier, with three confirmed daily observations required to change the displayed regime. |
| Position for day *t* | `1` (hold BTC) when the confirmed regime of the **completed day t-1** is in the active set, otherwise `0`. The rule never reads a close before it is used to trade. |
| Active set | `bullish`, or optionally `bullish` + `transitional`. |
| Idle leg | Held flat at a 0% return. No Treasury-bill or money-market yield is credited. |
| Execution cost | A flat per-side basis-point assumption charged on each regime switch. Default 25 bps; the result always also reports 50 and 100 bps. No slippage, spread, market impact or partial-fill model. |
| Missing close | A day with no completed close is dropped from both the strategy and benchmark series and counted; a disappeared observation is never forward-filled. |
| Window start | The first day that already carries a decided regime, so the strategy is never long by default at the open. |
| Benchmark | Always-invested BTC, close-to-close. |

Reported per side: total return, CAGR, realized volatility (annualized sample
standard deviation of daily returns), Sharpe and Sortino at a 0% risk-free rate,
and maximum drawdown against the running equity peak. Also: entries, exits,
trades per year, share of days exposed, and a chronological holdout.

**Walk-forward and holdout.** The regime rule fits no parameters, so walk-forward
is satisfied by construction. The result still splits the window chronologically
(default final 30% held out) and reports in-sample and holdout statistics
separately, per the research plan's §4 requirement to retain an untouched final
evaluation period.

**Limitations carried on every run.** Close-to-close historical reconstruction
from archived revisions; downloading a value today does not prove it was
published then. About one full regime cycle is covered — descriptive, not a
walk-forward-validated or statistically significant result. Regime changes need
three confirmed daily observations, so entries and exits lag the close.

## Custom strategy engine (`portfolio-strategy:v1`)

A portfolio simulator. It tracks a **cash balance** and **BTC units**, adds
**external contributions** on a schedule, and applies your own entry and exit
rules. Every decision reads the completed prior day's signals and executes at the
current day's close (no look-ahead); a missing close is skipped, never
forward-filled. Every buy and sell pays a flat per-side basis-point cost.

Spec (template `custom-strategy`, request body `params`):

```jsonc
{
  "startCapitalUsd": 0,
  "contribution": { "amountUsd": 500, "cadence": "monthly"|"weekly", "day": 1 },
  "entry": {
    "trigger": "on-contribution"|"monthly"|"weekly",   // when to consider deploying cash
    "day": 1,                                           // for monthly/weekly
    "guard": <Condition>,                               // only buy while this holds ({type:"none"} = ungated)
    "size": {"type":"all-cash"|"fixed"|"pct-cash", "value"?: n},
    "redeploy": "immediate"|"scheduled"                 // deploy the moment a blocking guard turns true, or wait
  },
  "exit": { "trigger": <Condition>, "size": {"type":"all"|"pct", "value"?: n} },
  "costBps": 25, "from": null, "to": null, "holdoutPct": 30
}
```

`Condition` vocabulary (shared by `entry.guard` — evaluated as state — and
`exit.trigger` — fires on the rising edge, so one crossing is one sell):

| type | fields | meaning |
|---|---|---|
| `none` | — | always true (guard) / never fires (exit) |
| `regime-in` | `regimes[]` | the confirmed regime is in the set |
| `regime-leave` | `regimes[]` | the confirmed regime is not in the set |
| `new-ath` | — | the close set a fresh all-time high (fires on every new high) |
| `drawdown-from-ath` | `op` (`gte`/`lte`), `pct` | close is that far below the running ATH |
| `mayer` | `op`, `value` | Mayer multiple (close / 200D SMA) vs a level |
| `price-vs-sma200` | `side` (`above`/`below`) | close vs the 200D SMA |
| `weekly-rsi` | `op`, `value` | completed-week Wilder RSI vs a level |
| `mvrv` | `op`, `value` | Coin Metrics MVRV vs a level |
| `fear-greed` | `op`, `value` | Alternative.me Crypto Fear & Greed Index (0-100) vs a level; `null` before this archive's or the provider's own coverage (2018-02-01), never satisfied |

A threshold condition on a day whose input is not yet archived (early Mayer/RSI/MVRV)
is simply false — it never blocks a guard nor fires a trigger on missing data.

### Worked examples (live local run, 2011-02-24 → 2026-09-09, $500/month)

| strategy | headline IRR | max drawdown | vs plain DCA |
|---|---|---|---|
| Monthly DCA + hold | 93.4% | −91.8% | (this *is* the DCA benchmark) |
| Monthly DCA + sell when the bullish regime reverts | 87.6% | **−76.1%** | −6 pts IRR, −16 pts drawdown; 56.7% time in market |
| Monthly DCA + sell at every new ATH | **40.6%** | −81.6% | selling into a long bull and rebuying higher is costly |

### Benchmarks and metrics

Every run reports the strategy against two benchmarks on the same contribution
schedule: **`dcaHold`** (every dollar buys BTC the moment it is deployable, never
sells — a plain buy-every-contribution strategy equals this exactly) and
**`lumpSum`** (the starting capital *plus every future contribution* invested on
day one and held — hindsight capital, shown only for contrast).

The headline for a contribution strategy is the **money-weighted return (IRR)**:
the annualized rate that discounts the contribution cash-flows to the ending
equity. A simple CAGR is not defined when external cash arrives over time; it is
reported only for the no-contribution (lump-sum) case, alongside Sharpe and
Sortino. Also reported: ending equity, total contributed, profit ($ and %),
maximum drawdown (against a peak that **steps up with each contribution**, so it
reflects market declines and not the pace of contributions), time in market,
average invested and cash-drag fractions, a full trade ledger, 25/50/100 bps cost
sensitivity, and a chronological in-sample / holdout split of the same run.

## Reproducibility

`POST /api/v1/backtest/runs` freezes `{ templateKey, methodologyVersion, params,
datasetCoverageStart }` and hashes it with SHA-256. A `succeeded` run with a
matching hash is returned as-is (`reproduced: true`) rather than recomputed. A
completed run is immutable: the `backtest_runs` row rejects any update once its
status is terminal, and rejects any change to its identity or input columns
before that. The stored `result` carries a `dataset` fingerprint — series id,
first and last observed dates, completed-price count and replay-coverage start.

## The replay horizon

No free source provides historical altcoin universe membership or historical
metric vintages. Historical replay therefore works only for dates after this
system began archiving each dataset. `GET /api/v1/backtest/replay` refuses each
workspace whose coverage starts after the cutoff, listing the refusal rather than
returning a reconstruction, and `GET /api/v1/backtest/templates` returns the full
per-series and per-dataset coverage-start table. For everything except BTC price
history this remains a forward-tracking product.

## Expanded evidence stays gated

Stage 6's "additional on-chain, unlock, ETF and derivatives feeds as verified
access permits" adds nothing: the stage 0 capability manifest gated event-level
tokenomics/unlocks (no verified feed), ETF and exchange flows, futures basis,
liquidations and options data, and macro inputs behind a free FRED key and
vintage checks. None became accessible. `tokenomics_events` stays empty and the
`/analytics/*` routes stay explicitly unavailable.

## DCA Matrix (`#dca-matrix`)

`GET /api/v1/backtest/dca-matrix` (guarded `asOf`) runs the same custom strategy
engine (`portfolio-strategy:v1`) over a fixed 9x9 grid of entry guards and exit
triggers (`apps/api/src/backtest/matrix.ts`) — monthly $1,000 DCA, 25bps cost,
30% holdout, from 2018-01-01 — and returns one summary per cell, not the full
per-run payload (equity curves, ledgers), which would be ~80x too heavy for a
table this size. It is a live, re-runnable view of the sweep that produced the
"fixed thresholds don't survive cross-cycle validation" finding recorded in
`docs/data/PLANS_MACRO_AND_ML.md` (Stage B context) — the frontend tints each
cell against the DCA-hold benchmark over the same window and opens a full
breakdown, including the out-of-sample segment, on click.

## Sources

- Coin Metrics Community API — BTC `PriceUSD`, daily. CC BY-NC 4.0.
- Research plan §4 "Backtest Lab" and §5 backtesting requirements.
- <https://docs.glassnode.com/data/point-in-time-metrics> — point-in-time methodology.
