"""Daily BRL wealth simulation: target BTC share of wealth, no-trade band, turnover cost,
business-day CDI accrual. Ports the accounting discipline of
apps/api/src/backtest/portfolio.ts (no look-ahead, cost on every trade, no forward-fill
of prices) to Python; nothing is shared code-wise, the stacks stay separate
(docs/data/PLANS_MACRO_AND_ML.md, Stage B).

Timing convention: `target_w[t]` is the allocation *decided* using information available
by the close of day t-1 (the score model and policy only ever see lagged features). It is
applied to day t's realized return. A rebalance trade, if the no-trade band doesn't
absorb it, is priced at the start of day t and its cost is charged against day t's
return.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

ANNUALIZATION_DAYS = 365
CDI_BUSINESS_DAYS_PER_YEAR = 252


def daily_cdi_accrual(macro_raw: pd.DataFrame, dates: pd.DatetimeIndex) -> pd.Series:
    """Decimal daily CDI return over every calendar day in `dates`: the published
    business-day rate (percent) where BCB has a value, **zero on every other day**
    (weekends, Brazilian holidays) -- CDI is not forward-filled; it simply does not
    accrue when there is no business day. A date after the last archived observation
    is left NaN rather than assumed zero, so a caller can't silently run past coverage."""
    raw = macro_raw.get("cdi_daily_rate")
    if raw is None:
        return pd.Series(np.nan, index=dates)
    raw = raw.dropna()
    covered = dates <= raw.index.max()
    pct = raw.reindex(dates).fillna(0.0).where(covered, np.nan)
    return pct / 100.0


def target_w_from_score_bucket(score: pd.Series, cuts: tuple[float, float, float],
                                buckets: tuple[float, ...] = (0.0, 0.25, 0.5, 0.75, 1.0)) -> pd.Series:
    """Monotone percentile-bucket rule: a score percentile (passed in, already computed
    against *training-fold-only* cutoffs so test-fold rows never influence them) maps to
    one of the five target weights through three ascending cutpoints, e.g. a score below
    `cuts[0]` -> w=0, between `cuts[0]` and `cuts[1]` -> w=0.25, ... above `cuts[2]` ->
    w=1.0."""
    c1, c2, c3 = cuts
    idx = np.searchsorted([c1, c2, c3], score.values, side="right")
    return pd.Series(np.array(buckets)[idx], index=score.index)


def simulate(dates: pd.DatetimeIndex, r_btc_brl: pd.Series, r_cdi: pd.Series, target_w: pd.Series,
             band: float = 0.0, cost_bps: float = 25.0) -> pd.DataFrame:
    """Core objective simulation (no contributions -- time-weighted daily returns only,
    so folds stay independent of accumulated holdings, per the plan). Returns one row per
    date with the realized exposure `w`, turnover, the BRL excess return `e_t`
    (= w*(r_btc_brl - r_cdi) - cost), and the total BRL return `r_t` (= r_cdi + e_t)."""
    r_btc_brl = r_btc_brl.reindex(dates)
    r_cdi = r_cdi.reindex(dates)
    target_w = target_w.reindex(dates)
    cost = cost_bps / 10_000.0

    w = np.empty(len(dates))
    turnover = np.empty(len(dates))
    prev = float(target_w.iloc[0]) if pd.notna(target_w.iloc[0]) else 0.0
    for i, t in enumerate(target_w.values):
        tgt = prev if pd.isna(t) else float(t)
        delta = tgt - prev
        if abs(delta) >= band:
            w[i] = tgt
            turnover[i] = abs(delta)
        else:
            w[i] = prev
            turnover[i] = 0.0
        prev = w[i]

    excess = pd.Series(w, index=dates) * (r_btc_brl - r_cdi) - cost * pd.Series(turnover, index=dates)
    total = r_cdi + excess
    return pd.DataFrame({
        "w": w, "delta_w": np.r_[w[0] - (target_w.iloc[0] if pd.notna(target_w.iloc[0]) else w[0]), np.diff(w)],
        "turnover": turnover, "excess_return": excess.values, "total_return": total.values,
    }, index=dates)


def summary_metrics(sim: pd.DataFrame) -> dict:
    """Sharpe of daily BRL excess return over CDI, annualized by sqrt(365) (crypto trades
    every day, so the excess-return series itself has 365 observations/year); plus the
    always-reported, non-objective descriptors."""
    e = sim["excess_return"].dropna()
    sharpe = float(e.mean() / e.std(ddof=1) * np.sqrt(ANNUALIZATION_DAYS)) if e.std(ddof=1) > 0 else np.nan
    wealth = (1 + sim["total_return"].fillna(0)).cumprod()
    running_max = wealth.cummax()
    max_dd = float((wealth / running_max - 1).min())
    n_years = len(sim) / ANNUALIZATION_DAYS
    cagr = float(wealth.iloc[-1] ** (1 / n_years) - 1) if n_years > 0 and wealth.iloc[-1] > 0 else np.nan
    return {
        "sharpe_vs_cdi": sharpe, "mean_excess_return": float(e.mean()), "n_days": int(len(e)),
        "ending_wealth_index": float(wealth.iloc[-1]), "cagr": cagr, "max_drawdown": max_dd,
        "avg_w": float(sim["w"].mean()), "turnover_total": float(sim["turnover"].sum()),
    }


def illustrative_wealth_path(dates: pd.DatetimeIndex, r_btc_brl: pd.Series, r_cdi: pd.Series, target_w: pd.Series,
                              band: float = 0.0, cost_bps: float = 25.0, monthly_contribution: float = 10_000.0) -> pd.Series:
    """Display-only BRL wealth path with R$10,000 credited to the CDI cash leg on day 1 of
    each month, using the same w_t. Does not enter the objective (that's `simulate`
    above) -- a reader should not mistake ending wealth here for a Sharpe input."""
    sim = simulate(dates, r_btc_brl, r_cdi, target_w, band, cost_bps)
    wealth = 0.0
    path = []
    for date, ret in zip(dates, sim["total_return"]):
        if date.day == 1 or (date == dates[0]):
            wealth += monthly_contribution
        wealth *= (1 + (0.0 if pd.isna(ret) else ret))
        path.append(wealth)
    return pd.Series(path, index=dates)
