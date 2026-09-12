"""Baselines, uncertainty (circular block bootstrap), the random-timing control, and the
Deflated Sharpe Ratio (docs/data/PLANS_MACRO_AND_ML.md, Stage B exit criteria).

Modeling note on baselines (b)/(c), disclosed rather than glossed over: because the
objective is a *time-weighted* daily excess return, "monthly DCA buy-and-hold" and
"lump-sum buy-and-hold" share the identical w_t=1 path once capital is deployed -- a
contribution's size and timing change money-weighted IRR/ending wealth (reported
separately) but not the per-unit-of-wealth return stream Sharpe is computed on. They are
kept as separate reported baselines because their *illustrative* wealth paths differ, but
expect their Sharpe-vs-CDI to coincide. (b2) DCA-spread is the baseline that actually
differs in time-weighted terms, because it leaves new contributions partly in cash (at
w<1) for a few business days each month.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats

import portfolio

SPREAD_DAYS = 5  # business days over which (b2) ramps a month's contribution into BTC


def buy_hold_w(dates: pd.DatetimeIndex) -> pd.Series:
    return pd.Series(1.0, index=dates)


def cdi_only_w(dates: pd.DatetimeIndex) -> pd.Series:
    return pd.Series(0.0, index=dates)


def constant_mix_w(dates: pd.DatetimeIndex, avg_w: float) -> pd.Series:
    return pd.Series(avg_w, index=dates)


def dca_spread_w(dates: pd.DatetimeIndex, spread_days: int = SPREAD_DAYS) -> pd.Series:
    """Ramps 0 -> 1 over the first `spread_days` business days of each calendar month as
    that month's contribution is deployed gradually, then holds at 1 until the next
    month's contribution restarts the ramp -- the mechanical, recurring cash drag that
    distinguishes it from (b)'s immediate full deployment."""
    w = np.ones(len(dates))
    months = dates.to_series().dt.to_period("M")
    for _, idx in months.groupby(months).groups.items():
        positions = dates.get_indexer(idx)
        business_count = 0
        for j, pos in enumerate(positions):
            business_count += 1
            w[pos] = min(1.0, business_count / spread_days)
    return pd.Series(w, index=dates)


def baseline_suite(dates: pd.DatetimeIndex, avg_w: float) -> dict[str, pd.Series]:
    return {
        "cdi_only": cdi_only_w(dates),
        "monthly_dca": buy_hold_w(dates),
        "dca_spread": dca_spread_w(dates),
        "buy_hold": buy_hold_w(dates),
        "constant_mix_avg_w": constant_mix_w(dates, avg_w),
    }


def random_timing_test(dates: pd.DatetimeIndex, r_btc_brl: pd.Series, r_cdi: pd.Series, target_w: pd.Series,
                        band: float, cost_bps: float, observed_sharpe: float,
                        n_shuffles: int = 1000, seed: int = 0) -> dict:
    """Shuffles the model's target-w values within the fold -- same bucket mix (multiset
    of weights), random order -- and re-runs the identical simulation. Tests whether the
    score carries timing information beyond how much the policy is invested on average.
    p-value = fraction of shuffles whose Sharpe-vs-CDI is >= the observed one."""
    rng = np.random.default_rng(seed)
    values = target_w.values.copy()
    shuffled_sharpes = np.empty(n_shuffles)
    for i in range(n_shuffles):
        rng.shuffle(values)
        w = pd.Series(values, index=target_w.index)
        sim = portfolio.simulate(dates, r_btc_brl, r_cdi, w, band=band, cost_bps=cost_bps)
        shuffled_sharpes[i] = portfolio.summary_metrics(sim)["sharpe_vs_cdi"]
    valid = shuffled_sharpes[~np.isnan(shuffled_sharpes)]
    # Degenerate fold (the model held w=0 the whole period, so every shuffle of that
    # constant array is still constant -> zero variance -> Sharpe undefined for all of
    # them): report nan rather than let an empty-slice warning leak out of this module.
    p_value = float((valid >= observed_sharpe).mean()) if len(valid) else float("nan")
    shuffled_mean = float(valid.mean()) if len(valid) else float("nan")
    return {"p_value": p_value, "n_shuffles": n_shuffles, "shuffled_sharpe_mean": shuffled_mean}


def pooled_random_timing_test(fold_specs: list[dict], n_shuffles: int = 1000, seed: int = 0) -> dict:
    """The walk-forward-wide version of `random_timing_test`: each fold's target-w values
    are shuffled independently within that fold (same bucket mix per fold, as the plan
    specifies), but the resulting daily excess returns from every fold are pooled into
    one series per shuffle before computing a single Sharpe -- giving one p-value for the
    whole 9-fold study (exit criterion 3), not nine separate ones. `fold_specs` is a list
    of {"dates", "r_btc_brl", "r_cdi", "target_w", "band", "cost_bps"} per fold."""
    rng = np.random.default_rng(seed)
    observed = pd.concat([
        portfolio.simulate(f["dates"], f["r_btc_brl"], f["r_cdi"], f["target_w"], f["band"], f["cost_bps"])["excess_return"]
        for f in fold_specs
    ])
    observed_sharpe = observed.mean() / observed.std(ddof=1) * np.sqrt(365) if observed.std(ddof=1) > 0 else np.nan

    shuffled_sharpes = np.empty(n_shuffles)
    for i in range(n_shuffles):
        pooled = []
        for f in fold_specs:
            values = f["target_w"].values.copy()
            rng.shuffle(values)
            w = pd.Series(values, index=f["target_w"].index)
            sim = portfolio.simulate(f["dates"], f["r_btc_brl"], f["r_cdi"], w, f["band"], f["cost_bps"])
            pooled.append(sim["excess_return"])
        e = pd.concat(pooled)
        shuffled_sharpes[i] = e.mean() / e.std(ddof=1) * np.sqrt(365) if e.std(ddof=1) > 0 else np.nan
    valid = shuffled_sharpes[~np.isnan(shuffled_sharpes)]
    p_value = float((valid >= observed_sharpe).mean()) if len(valid) else float("nan")
    return {"p_value": p_value, "observed_sharpe": float(observed_sharpe), "n_shuffles": n_shuffles,
            "shuffled_sharpe_mean": float(np.nanmean(shuffled_sharpes))}


def _circular_block_resample(n: int, block_size: int, rng: np.random.Generator) -> np.ndarray:
    n_blocks = int(np.ceil(n / block_size))
    starts = rng.integers(0, n, size=n_blocks)
    idx = np.concatenate([np.arange(s, s + block_size) % n for s in starts])[:n]
    return idx


def bootstrap_delta_sharpe(e_model: pd.Series, e_baseline: pd.Series, block_size: int = 30,
                            n_resamples: int = 5000, ci: float = 0.90, seed: int = 0) -> dict:
    """Circular block bootstrap of pooled out-of-sample days: resample paired
    (model, baseline) days in 30-day blocks so day-to-day correlation within a block
    survives the resample, then take the Sharpe difference on each resample."""
    paired = pd.concat([e_model, e_baseline], axis=1).dropna()
    m, b = paired.iloc[:, 0].values, paired.iloc[:, 1].values
    n = len(paired)
    rng = np.random.default_rng(seed)
    deltas = np.empty(n_resamples)
    for i in range(n_resamples):
        idx = _circular_block_resample(n, block_size, rng)
        ms, bs = m[idx], b[idx]
        sharpe_m = ms.mean() / ms.std(ddof=1) * np.sqrt(365) if ms.std(ddof=1) > 0 else np.nan
        sharpe_b = bs.mean() / bs.std(ddof=1) * np.sqrt(365) if bs.std(ddof=1) > 0 else np.nan
        deltas[i] = sharpe_m - sharpe_b
    valid = deltas[~np.isnan(deltas)]
    lower, upper = np.percentile(valid, [(1 - ci) / 2 * 100, (1 + ci) / 2 * 100])
    point = float(m.mean() / m.std(ddof=1) * np.sqrt(365) - b.mean() / b.std(ddof=1) * np.sqrt(365)) \
        if m.std(ddof=1) > 0 and b.std(ddof=1) > 0 else float("nan")
    return {"point_estimate": point, "ci_low": float(lower), "ci_high": float(upper), "ci": ci,
            "n_resamples": n_resamples, "block_size": block_size, "n_days": n}


EULER_MASCHERONI = 0.5772156649


def deflated_sharpe_ratio(selected_daily_returns: pd.Series, trial_annualized_sharpes: list[float]) -> dict:
    """Bailey & Lopez de Prado (2014). `trial_annualized_sharpes` is every config's Sharpe
    from the trial log (grid search + model-class choice), including the selected one;
    more trials and more variance among them raise the bar the selected Sharpe must
    clear. Uses the selected strategy's own skew/kurtosis, since DSR corrects for
    non-normality of returns, not just multiple testing."""
    r = selected_daily_returns.dropna().values
    n = len(r)
    if n < 3:
        return {"dsr": float("nan"), "sr0": float("nan"), "n_trials": len(trial_annualized_sharpes), "n_obs": n}
    sr_hat_daily = r.mean() / r.std(ddof=1) if r.std(ddof=1) > 0 else 0.0
    skew = float(stats.skew(r))
    kurt = float(stats.kurtosis(r, fisher=False))  # Pearson convention (normal = 3), matches the DSR formula

    trials = np.array([s for s in trial_annualized_sharpes if np.isfinite(s)])
    n_trials = max(len(trials), 1)
    var_sr = float(np.var(trials / np.sqrt(365), ddof=1)) if len(trials) > 1 else 0.0
    if var_sr > 0 and n_trials > 1:
        sr0_daily = np.sqrt(var_sr) * (
            (1 - EULER_MASCHERONI) * stats.norm.ppf(1 - 1 / n_trials)
            + EULER_MASCHERONI * stats.norm.ppf(1 - 1 / (n_trials * np.e))
        )
    else:
        sr0_daily = 0.0
    denom = np.sqrt(max(1 - skew * sr_hat_daily + (kurt - 1) / 4 * sr_hat_daily ** 2, 1e-12))
    z = (sr_hat_daily - sr0_daily) * np.sqrt(n - 1) / denom
    dsr = float(stats.norm.cdf(z))
    return {"dsr": dsr, "sr0_annualized": float(sr0_daily * np.sqrt(365)), "sr_hat_annualized": float(sr_hat_daily * np.sqrt(365)),
            "n_trials": n_trials, "n_obs": n, "skew": skew, "kurtosis_pearson": kurt}


def cost_sensitivity(dates: pd.DatetimeIndex, r_btc_brl: pd.Series, r_cdi: pd.Series, target_w: pd.Series,
                      band: float, cost_levels_bps: tuple[float, ...] = (25.0, 50.0, 100.0)) -> dict:
    out = {}
    for bps in cost_levels_bps:
        sim = portfolio.simulate(dates, r_btc_brl, r_cdi, target_w, band=band, cost_bps=bps)
        out[f"{int(bps)}bps"] = portfolio.summary_metrics(sim)
    return out
