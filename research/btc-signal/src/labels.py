"""30-day forward BRL log excess-return target (docs/data/PLANS_MACRO_AND_ML.md, Stage B).
The horizon N=30 is fixed in advance; changing it would count as an extra config tried
(see evaluate.py's trial log). Labels use the *realized* future path -- that is what
makes them labels and not features; walkforward.py is responsible for purging any
training window whose label window overlaps a test fold.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

HORIZON_DAYS = 30


def forward_excess_return(btc_brl_ret_1d: pd.Series, cdi_daily_accrual: pd.Series,
                           horizon: int = HORIZON_DAYS) -> pd.Series:
    """log((1+R_btc_brl,h)/(1+R_cdi,h)) over the h days *after* each date t, i.e. the
    window (t, t+h]. The last `horizon` rows of the input are NaN (no future path yet) --
    walkforward.py's purge removes exactly these from training, not this function."""
    r_btc = np.log1p(btc_brl_ret_1d)
    r_cdi = np.log1p(cdi_daily_accrual)
    fwd_btc = r_btc.shift(-1).rolling(horizon).sum().shift(-(horizon - 1))
    fwd_cdi = r_cdi.shift(-1).rolling(horizon).sum().shift(-(horizon - 1))
    return fwd_btc - fwd_cdi
