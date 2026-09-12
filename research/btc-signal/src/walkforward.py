"""Expanding-window folds, 30-day purge, inner tuning window, holdout
(docs/data/PLANS_MACRO_AND_ML.md, Stage B). Ties features -> model -> policy ->
portfolio -> evaluate together one fold at a time; nothing here looks at a test fold's
rows before that fold's own evaluation step.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

import evaluate
import model as model_mod
import policy
import portfolio

TRAIN_START = pd.Timestamp("2014-01-01")
PURGE_DAYS = 30
TUNING_WINDOW_DAYS = 365
COST_SENSITIVITY_BPS = (25.0, 50.0, 100.0)
FEATURE_COLUMNS_EXCLUDE = {"close_usd", "btc_brl_index", "regime", "btc_brl_ret_1d"}

TEST_FOLDS = [(pd.Timestamp(f"{y}-01-01"), pd.Timestamp(f"{y}-12-31")) for y in range(2017, 2025)] + [
    (pd.Timestamp("2025-01-01"), pd.Timestamp("2025-09-10")),
]
# Not in TEST_FOLDS: run via run_fold(..., test_start=HOLDOUT[0], test_end=HOLDOUT[1]) once,
# after every modeling decision (features, horizon, model class, grid search ranges) is
# frozen from the 9 folds above. Its own cutoffs/band still come from its own
# pre-holdout inner tuning window -- the same mechanic as every other fold, not a
# special case -- because "used exactly once" means the holdout *data* is touched only
# once, not that tuning is skipped.
HOLDOUT = (pd.Timestamp("2025-09-11"), pd.Timestamp("2026-09-10"))


@dataclass
class FoldResult:
    label: str
    model_class: str
    best_cuts: tuple
    best_band: float
    model_metrics: dict
    baseline_metrics: dict[str, dict]
    random_timing: dict
    cost_sensitivity: dict
    n_tuning_trials: int
    test_excess_return: pd.Series  # for pooled bootstrap later
    baseline_d_excess_return: pd.Series
    test_w: pd.Series = field(default_factory=lambda: pd.Series(dtype=float))  # for the pooled random-timing test
    cost_bps: float = 25.0
    trials: list[dict] = field(default_factory=list)


def feature_columns(feat: pd.DataFrame) -> list[str]:
    return [c for c in feat.columns if c not in FEATURE_COLUMNS_EXCLUDE]


def run_fold(feat: pd.DataFrame, label_series: pd.Series, r_btc_brl: pd.Series, r_cdi: pd.Series,
             test_start: pd.Timestamp, test_end: pd.Timestamp, model_class: str = "ridge",
             cost_bps: float = 25.0, label: str | None = None) -> FoldResult:
    purged_train_end = test_start - pd.Timedelta(days=PURGE_DAYS + 1)
    train_mask = (feat.index >= TRAIN_START) & (feat.index <= purged_train_end)
    test_mask = (feat.index >= test_start) & (feat.index <= test_end)
    if train_mask.sum() < 365:
        raise ValueError(f"Training window before {test_start.date()} has under a year of rows after purge")

    cols = feature_columns(feat)
    X_train, y_train = feat.loc[train_mask, cols], label_series.loc[train_mask]
    pipe = model_mod.fit(model_class, X_train, y_train)
    train_scores = model_mod.predict(pipe, X_train)

    tuning_start = purged_train_end - pd.Timedelta(days=TUNING_WINDOW_DAYS - 1)
    tuning_dates = train_scores.index[(train_scores.index >= tuning_start) & (train_scores.index <= purged_train_end)]
    tuning_scores = train_scores.loc[tuning_dates]
    tuning_pct = policy.score_percentile(train_scores, tuning_scores)
    fold_label = label or f"{test_start.date()}..{test_end.date()}"
    best, trials = policy.grid_search(tuning_dates, r_btc_brl.loc[tuning_dates], r_cdi.loc[tuning_dates], tuning_pct,
                                       cost_bps=cost_bps)
    for t in trials:
        t["fold"] = fold_label
        t["model_class"] = model_class

    X_test = feat.loc[test_mask, cols]
    test_scores = model_mod.predict(pipe, X_test)
    test_pct = policy.score_percentile(train_scores, test_scores)
    test_dates = feat.index[test_mask]
    test_w = policy.apply_policy(test_pct, best["cuts"])
    sim = portfolio.simulate(test_dates, r_btc_brl.loc[test_dates], r_cdi.loc[test_dates], test_w,
                              band=best["band"], cost_bps=cost_bps)
    model_metrics = portfolio.summary_metrics(sim)

    baselines_w = evaluate.baseline_suite(test_dates, model_metrics["avg_w"])
    baseline_metrics = {}
    baseline_sims = {}
    for name, w in baselines_w.items():
        b_sim = portfolio.simulate(test_dates, r_btc_brl.loc[test_dates], r_cdi.loc[test_dates], w,
                                    band=0.0, cost_bps=cost_bps)
        baseline_sims[name] = b_sim
        baseline_metrics[name] = portfolio.summary_metrics(b_sim)

    random_timing = evaluate.random_timing_test(
        test_dates, r_btc_brl.loc[test_dates], r_cdi.loc[test_dates], test_w, best["band"], cost_bps,
        observed_sharpe=model_metrics["sharpe_vs_cdi"])
    cost_sensitivity = evaluate.cost_sensitivity(test_dates, r_btc_brl.loc[test_dates], r_cdi.loc[test_dates], test_w,
                                                  best["band"], COST_SENSITIVITY_BPS)

    return FoldResult(
        label=fold_label, model_class=model_class,
        best_cuts=best["cuts"], best_band=best["band"], model_metrics=model_metrics,
        baseline_metrics=baseline_metrics, random_timing=random_timing, cost_sensitivity=cost_sensitivity,
        n_tuning_trials=len(trials),
        test_excess_return=sim["excess_return"], baseline_d_excess_return=baseline_sims["constant_mix_avg_w"]["excess_return"],
        test_w=test_w, cost_bps=cost_bps, trials=trials,
    )


def run_all_folds(feat: pd.DataFrame, label_series: pd.Series, r_btc_brl: pd.Series, r_cdi: pd.Series,
                   model_class: str = "ridge", cost_bps: float = 25.0, folds=TEST_FOLDS) -> list[FoldResult]:
    return [run_fold(feat, label_series, r_btc_brl, r_cdi, start, end, model_class, cost_bps)
            for start, end in folds]


def run_holdout(feat: pd.DataFrame, label_series: pd.Series, r_btc_brl: pd.Series, r_cdi: pd.Series,
                model_class: str, cost_bps: float = 25.0) -> FoldResult:
    start, end = HOLDOUT
    return run_fold(feat, label_series, r_btc_brl, r_cdi, start, end, model_class, cost_bps,
                     label=f"holdout {start.date()}..{end.date()}")
