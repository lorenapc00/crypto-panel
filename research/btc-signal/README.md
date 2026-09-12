# BTC signal research (Stage B)

Python-only, offline research project, isolated from the Node/TS app. No Postgres
connection, no network call, no production code change. Full design and decisions:
`docs/data/PLANS_MACRO_AND_ML.md`. This is Phase 1 of that plan: a walk-forward report
with a go/no-go verdict, not a shipped feature.

## Repro steps

1. From the repo root, export the archive once (or re-run to refresh):
   ```
   pnpm --filter @crypto-panel/api run export:ml-features
   ```
   Writes `data/btc_signals_<date>.csv` and `data/macro_observations_<date>.csv`. Both
   are gitignored; re-run whenever you want fresher data (`run_experiment.py` always
   picks the most recent dated pair).
2. Python 3.10+ (tested on 3.10.12; the system `/usr/bin/python3` on this machine is
   3.9, which `lightgbm`'s type hints don't support -- use a newer interpreter, e.g.
   Homebrew's `python@3.10`):
   ```
   python3.10 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt scipy
   ```
   On macOS, LightGBM also needs OpenMP: `brew install libomp` (ridge, the baseline of
   record, works without it; `model.py` degrades gracefully and skips the LightGBM
   challenger if the import fails for any reason, including a missing `libomp.dylib`).
3. ```
   python scripts/run_experiment.py
   ```
   Runs end to end with no Postgres, no Node app, no network access. Writes
   `report_<date>.json` (full walk-forward report: per-fold metrics, baselines,
   bootstrap CI, random-timing test, Deflated Sharpe Ratio, holdout, go/no-go verdict)
   and `trial_log_<date>.csv` (every grid-search config tried, both model classes). Both
   are gitignored -- regenerable outputs, not source.

## Known data caveat: PTAX backfill

As of 2026-09-11, the BCB USD/BRL PTAX archive (`apps/api/src/feeds/bcb.ts`) had only
backfilled to 2016-09-26 (CDI was already complete back to 2010-01-04 -- same chunking
logic, just a day or two behind in the worker's own daily schedule). `run_experiment.py`
prints the actual PTAX coverage start it found and warns if it's later than the training
start (2014-01-01); BRL-denominated features and labels are `NaN` before PTAX coverage
begins, which `model.py`'s training mask already drops. **Re-export after the backfill
catches up and re-run before trusting the 2017 fold's training window**, which currently
loses about three years of its own training rows to this gap. Folds from 2019 onward are
unaffected (their training windows start well after 2016-09-26).

## Result recorded 2026-09-11 (first full run, ridge vs. lightgbm, 25bps headline cost)

**Verdict: NO-GO.** A documented negative result, which the plan's exit criteria
anticipated as the most likely outcome. Per the criteria in
`docs/data/PLANS_MACRO_AND_ML.md`:

| # | Criterion | Result |
|---|---|---|
| 1 | Beats monthly DCA and constant-mix in a majority of 9 folds | **fails** |
| 2 | Pooled bootstrap 90% CI of ΔSharpe vs. constant-mix entirely above 0 | **fails** -- CI was `[-1.08, -0.31]`, entirely *below* 0 |
| 3 | Random-timing test p < 0.05 | **fails** -- pooled p = 0.905 |
| 4 | Criteria 1-2 hold at 50bps and 100bps | **fails** -- mean fold Sharpe at 100bps (-0.047) no longer beats constant-mix |
| 5 | Holdout ΔSharpe vs. constant-mix not negative | passes (+2.55), but this alone doesn't overturn 1-4 |
| 6 | Deflated Sharpe Ratio reported | DSR ≈ 0.0000 over 7,460 trials (both model classes, all 9 folds' grid searches) -- the pooled Sharpe doesn't survive the multiple-testing correction at all |

Pooled walk-forward Sharpe-vs-CDI: ridge -0.35, LightGBM -0.83 -- ridge stayed the
selected model (the challenger did not beat it out-of-sample, so per the plan it's never
adopted). Two of the nine folds (2023, the partial 2025) landed at a constant 0%
allocation (percentile scores never crossed the lowest grid-search cutoff that fold),
giving an undefined (0/0) Sharpe -- not a bug, the same "rarely invested can look good on
Sharpe" problem the constant-mix guardrail exists to catch, just manifesting as "never
invested, no Sharpe to speak of" instead.

**Read this as**: on this 2017-2025 walk-forward protocol, a ridge/LightGBM score over
these BTC + CDI/PTAX + US-macro features, allocated through a percentile-bucket rule, did
not find a cost-surviving timing edge over simply holding a constant average exposure.
The holdout year alone looking good is exactly the kind of single-window result the
per-fold and bootstrap reporting exists to keep from being overinterpreted.

## Design notes worth knowing before reading the report

- **(b) monthly DCA and (c) buy-and-hold share the same time-weighted excess-return
  series** once capital is deployed (`evaluate.py` module docstring). The objective is
  time-weighted, so a contribution's timing/size changes money-weighted IRR and ending
  wealth (reported separately) but not the Sharpe the exit criteria are judged on.
  (b2) DCA-spread is the baseline that actually differs, because it holds new
  contributions partly in cash for a few business days each month.
- **No taxes modeled** (Brazil: 15% on BTC gains when monthly sales exceed R$35k; 15-22.5%
  IR on CDI-indexed fixed income by holding period) -- stated gap, matters because the
  policy can sell.
- **No PPO/DQN, no value function, no learned simulator.** The allocation layer
  (`policy.py`) is a rule with a handful of parameters tuned by walk-forward grid search
  -- direct policy search, not RL.
- **Backfilled FRED history is latest-revised, not point-in-time.** Stage A's
  `series/vintagedates` probe found 0 vintages for `SP500` (excluded from features for
  this and its 10-year-window reason) and a revision count consistent with "mostly
  extension, not correction" for `DFII10`/`DTWEXBGS`/`NASDAQCOM` -- treated as a minor
  caveat per that probe, not re-verified with ALFRED vintages in this phase.

## Layout

See `docs/data/PLANS_MACRO_AND_ML.md` ("Repo layout" under Stage B) for the module map:
`src/features.py` (load + lag + as-of join + causal features), `src/labels.py` (30d
forward BRL excess return), `src/portfolio.py` (accounting), `src/policy.py` (score ->
allocation rule + grid search), `src/model.py` (ridge/LightGBM), `src/walkforward.py`
(folds, purge, tuning window, holdout), `src/evaluate.py` (baselines, bootstrap,
random-timing, DSR), `scripts/run_experiment.py` (entry point).
