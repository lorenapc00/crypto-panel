"""Allocation rule: score percentile -> target BTC share of wealth, through a monotone
bucket rule, tuned by grid search over cutoffs and the no-trade band
(docs/data/PLANS_MACRO_AND_ML.md, Stage B). This is direct policy search over a rule with
a handful of parameters -- a close relative of reinforcement learning, but with no value
function, no learned simulator, no PPO/DQN.
"""
from __future__ import annotations

from itertools import combinations
from typing import Iterable

import numpy as np
import pandas as pd

import portfolio

DEFAULT_PERCENTILE_LEVELS = (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)
DEFAULT_BAND_GRID = (0.0, 0.05, 0.1, 0.15, 0.2)
BUCKETS = (0.0, 0.25, 0.5, 0.75, 1.0)


def score_percentile(train_scores: pd.Series, eval_scores: pd.Series) -> pd.Series:
    """ECDF rank of `eval_scores` against the *training-fold* score distribution only --
    the plan's explicit requirement that "percentile cutoffs come from training-fold
    scores only." `eval_scores` may be the training fold itself (in-sample rank) or a
    later test/tuning fold (out-of-sample rank against a fixed, already-seen
    distribution); either way the reference distribution never includes the rows being
    ranked unless they were already in `train_scores`."""
    ref = np.sort(train_scores.dropna().values)
    if len(ref) == 0:
        return pd.Series(np.nan, index=eval_scores.index)
    ranks = np.searchsorted(ref, eval_scores.values, side="right") / len(ref)
    return pd.Series(ranks, index=eval_scores.index).where(eval_scores.notna())


def default_cut_grid(levels: Iterable[float] = DEFAULT_PERCENTILE_LEVELS) -> list[tuple[float, float, float]]:
    return [cuts for cuts in combinations(sorted(levels), 3)]


def apply_policy(percentile_scores: pd.Series, cuts: tuple[float, float, float]) -> pd.Series:
    return portfolio.target_w_from_score_bucket(percentile_scores, cuts, BUCKETS)


def grid_search(dates: pd.DatetimeIndex, r_btc_brl: pd.Series, r_cdi: pd.Series, percentile_scores: pd.Series,
                 cut_grid: list[tuple[float, float, float]] | None = None,
                 band_grid: Iterable[float] = DEFAULT_BAND_GRID, cost_bps: float = 25.0) -> tuple[dict, list[dict]]:
    """Grid search on the *inner tuning window only* (the caller passes tuning-window
    dates/returns/scores, never the test fold). Every point tried is returned as a trial
    log entry for the Deflated Sharpe Ratio accounting in evaluate.py, regardless of
    which one is ultimately selected."""
    cut_grid = cut_grid or default_cut_grid()
    trials = []
    best, best_score = None, -np.inf
    for cuts in cut_grid:
        w = apply_policy(percentile_scores, cuts)
        for band in band_grid:
            sim = portfolio.simulate(dates, r_btc_brl, r_cdi, w, band=band, cost_bps=cost_bps)
            metrics = portfolio.summary_metrics(sim)
            trial = {"cuts": cuts, "band": band, **metrics}
            trials.append(trial)
            score = metrics["sharpe_vs_cdi"]
            score = -np.inf if np.isnan(score) else score
            if best is None or score > best_score:
                best, best_score = trial, score
    return best, trials
