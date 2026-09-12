"""Load the Stage A CSV exports, apply publication lags, as-of join onto BTC decision
days, and build the causal feature set for the score model. Everything here runs on
disk -- no Postgres, no network (docs/data/PLANS_MACRO_AND_ML.md, Stage B).

Terminology: "observed_on" is the date BCB/FRED stamp on a value. "available_on" is
observed_on + publication lag -- the first date a feature built from that value may be
used. A decision made at the close of day t may only see values with available_on < t
(strictly before, since t's own close is what we are deciding ahead of).
"""
from __future__ import annotations

import glob
import os
from dataclasses import dataclass

import numpy as np
import pandas as pd

# Publication lag applied to each macro series when used as a *feature* (not for accrual
# or BRL conversion, which use the raw value for day t -- see portfolio.py).
FEATURE_LAG_DAYS = {
    "cdi_daily_rate": 1,          # set a business day in advance by the Selic target
    "usd_brl_ptax_sell": 1,
    "real_yield_10y": 1,          # H.15, daily
    "broad_usd_index": 10,        # H.10, published weekly
    "nasdaq_composite_index": 1,
    # sp500_index is excluded on purpose: FRED's rolling 10-year window (Stage A),
    # display-only, never a feature.
}
FEAT_3Y_WINDOW_DAYS = 3 * 365
FG_MISSING_BEFORE = pd.Timestamp("2018-02-01")
REGIME_LEVELS = ["bullish", "bearish", "transitional"]


def _latest_export(data_dir: str, prefix: str) -> str:
    candidates = sorted(glob.glob(os.path.join(data_dir, f"{prefix}_*.csv")))
    if not candidates:
        raise FileNotFoundError(
            f"No {prefix}_<date>.csv in {data_dir}. Run "
            "`pnpm --filter @crypto-panel/api run export:ml-features` first."
        )
    return candidates[-1]


@dataclass
class RawData:
    btc: pd.DataFrame          # date-indexed: close, regime, mayer, sma200, mvrv, weekly_rsi, fear_greed
    macro_raw: pd.DataFrame    # date-indexed, one column per series, NaN on non-publication days, never filled
    btc_path: str
    macro_path: str


def load_raw(data_dir: str) -> RawData:
    btc_path = _latest_export(data_dir, "btc_signals")
    macro_path = _latest_export(data_dir, "macro_observations")

    btc = pd.read_csv(btc_path, parse_dates=["observedAt"])
    btc["date"] = btc["observedAt"].dt.tz_localize(None).dt.normalize()
    btc = btc.drop(columns=["observedAt"]).set_index("date").sort_index()
    btc = btc.rename(columns={"weeklyRsi": "weekly_rsi", "fearGreed": "fear_greed"})
    if btc.index.duplicated().any():
        raise ValueError("Duplicate BTC observation dates in export")

    long = pd.read_csv(macro_path, parse_dates=["observed_on"])
    macro_raw = long.pivot(index="observed_on", columns="series", values="value").sort_index()
    macro_raw.index.name = "date"
    return RawData(btc=btc, macro_raw=macro_raw, btc_path=btc_path, macro_path=macro_path)


def lagged_macro_features(macro_raw: pd.DataFrame, decision_dates: pd.DatetimeIndex) -> pd.DataFrame:
    """As-of join: for each decision date t, the latest value of each macro series whose
    available_on (observed_on + lag) is strictly before t. merge_asof requires a sorted
    numeric/datetime key on both sides and `allow_exact_matches=False` to enforce the
    strict inequality (a value published on the morning of t is not known at the close
    of t-1)."""
    out = pd.DataFrame(index=decision_dates)
    right_frame = pd.DataFrame({"date": decision_dates}).sort_values("date")
    for col in FEATURE_LAG_DAYS:
        if col not in macro_raw.columns:
            out[col] = np.nan
            continue
        lag = FEATURE_LAG_DAYS[col]
        series = macro_raw[col].dropna()
        left = pd.DataFrame({
            "available_on": series.index + pd.Timedelta(days=lag),
            "value": series.values,
        }).sort_values("available_on")
        merged = pd.merge_asof(
            right_frame, left, left_on="date", right_on="available_on",
            direction="backward", allow_exact_matches=False,
        )
        out[col] = merged["value"].values
    return out


def _rolling_percentile_rank(series: pd.Series, window_days: int) -> pd.Series:
    """Trailing-window percentile rank of the latest value against its own history,
    causal (uses only values up to and including the current row)."""
    return series.rolling(f"{window_days}D", min_periods=30).apply(
        lambda w: (w <= w.iloc[-1]).mean(), raw=False
    )


def build_feature_frame(raw: RawData) -> pd.DataFrame:
    """All columns here are causal at decision day t: BTC/regime/sentiment columns come
    straight from the backtest engine's own t-1 convention; macro columns already went
    through `lagged_macro_features`. Returns one row per BTC calendar day (BTC trades
    every day; macro features are forward-held from their last lagged availability)."""
    btc = raw.btc
    dates = btc.index

    # BRL conversion of the BTC return: PTAX is "frozen" on non-business days (it is not
    # republished), so the weekend/holiday FX move lands on the next business day's
    # return -- stated approximation, PLANS_MACRO_AND_ML.md. No lag here: this is a
    # realized return over [t-1, t], not a feature peeking past t.
    ptax = raw.macro_raw.get("usd_brl_ptax_sell")
    # dropna first: the pivoted macro frame's index is the union of every series'
    # observed dates, so a date another series published on but PTAX didn't (a BCB
    # holiday PTAX has no row for) already exists in `ptax`'s index *as NaN* --
    # reindex(method="ffill") only fills labels absent from the original index, so it
    # would silently leave that NaN in place without the dropna.
    ptax_ffill = ptax.dropna().reindex(dates, method="ffill") if ptax is not None else pd.Series(np.nan, index=dates)
    usdbrl_ret = ptax_ffill.pct_change(fill_method=None)
    btc_usd_ret = btc["close"].pct_change(fill_method=None)
    btc_brl_ret = (1 + btc_usd_ret) * (1 + usdbrl_ret) - 1
    close_brl = (1 + btc_brl_ret).cumprod()  # arbitrary base=1 BRL price index, for rolling stats only

    feat = pd.DataFrame(index=dates)
    feat["btc_brl_ret_1d"] = btc_brl_ret
    for n in (1, 7, 30, 90):
        feat[f"btc_logret_{n}d_brl"] = np.log1p(btc_brl_ret).rolling(n).sum()
    for n in (30, 90):
        feat[f"btc_vol_{n}d_brl"] = np.log1p(btc_brl_ret).rolling(n).std() * np.sqrt(365)

    feat["mayer_raw"] = btc["mayer"]
    feat["mayer_pct3y"] = _rolling_percentile_rank(btc["mayer"], FEAT_3Y_WINDOW_DAYS)
    feat["mvrv_raw"] = btc["mvrv"]
    feat["mvrv_pct3y"] = _rolling_percentile_rank(btc["mvrv"], FEAT_3Y_WINDOW_DAYS)
    feat["weekly_rsi"] = btc["weekly_rsi"]

    for level in REGIME_LEVELS:
        feat[f"regime_{level}"] = (btc["regime"] == level).astype(float)

    feat["fear_greed"] = btc["fear_greed"]
    feat["fear_greed_missing"] = (dates < FG_MISSING_BEFORE).astype(float)
    feat.loc[feat["fear_greed_missing"] == 1, "fear_greed"] = np.nan  # no imputation, ever

    macro = lagged_macro_features(raw.macro_raw, dates)
    feat["cdi_annualized_feature"] = (1 + macro["cdi_daily_rate"] / 100) ** 252 - 1
    feat["cdi_annualized_feature"] = feat["cdi_annualized_feature"].ffill()
    feat["cdi_90d_change"] = feat["cdi_annualized_feature"].diff(90)
    feat["usdbrl_30d_logret"] = np.log(macro["usd_brl_ptax_sell"].ffill()).diff(30)

    feat["dfii10_level"] = macro["real_yield_10y"].ffill()
    feat["dfii10_30d_change"] = feat["dfii10_level"].diff(30)
    dtwexbgs = macro["broad_usd_index"].ffill()
    feat["dtwexbgs_30d_change"] = dtwexbgs.diff(30)
    nasdaq = macro["nasdaq_composite_index"].ffill()
    feat["nasdaq_30d_logret"] = np.log(nasdaq).diff(30)
    nasdaq_1y_high = nasdaq.rolling(365, min_periods=30).max()
    feat["nasdaq_drawdown_1y"] = nasdaq / nasdaq_1y_high - 1

    feat["close_usd"] = btc["close"]
    feat["btc_brl_index"] = close_brl
    feat["regime"] = btc["regime"]
    return feat
