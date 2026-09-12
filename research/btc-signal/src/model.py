"""Score model: ridge regression (baseline of record) and LightGBM (challenger, adopted
only if it beats ridge out-of-sample under the identical protocol -- see
walkforward.py). All preprocessing statistics (imputer median, scaler mean/std) are fit
on the training fold only and applied unchanged to the test fold, so no test-fold
information leaks into the model.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

try:
    from lightgbm import LGBMRegressor
    HAS_LIGHTGBM = True
except Exception:  # pragma: no cover - e.g. missing libomp on macOS, not just an absent package
    HAS_LIGHTGBM = False


def ridge_pipeline(alpha: float = 10.0) -> Pipeline:
    """Features are standardized on training-fold statistics (plan requirement). Median
    imputation (also training-fold-only) covers indicator warm-up windows and any gap in
    the macro as-of join; it is never applied using test-fold values."""
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("ridge", Ridge(alpha=alpha)),
    ])


def lightgbm_pipeline(**lgbm_kwargs) -> Pipeline:
    if not HAS_LIGHTGBM:
        raise ImportError("lightgbm is not installed; ridge remains the baseline of record")
    defaults = dict(n_estimators=200, max_depth=4, learning_rate=0.03, min_child_samples=20,
                     subsample=0.8, colsample_bytree=0.8, random_state=0, verbosity=-1)
    defaults.update(lgbm_kwargs)
    # LightGBM splits natively on missing values; no imputer/scaler needed or wanted.
    return Pipeline([("lgbm", LGBMRegressor(**defaults))])


def fit(model_class: str, X_train: pd.DataFrame, y_train: pd.Series, **kwargs) -> Pipeline:
    mask = y_train.notna()
    X_fit, y_fit = X_train.loc[mask], y_train.loc[mask]
    pipe = ridge_pipeline(**kwargs) if model_class == "ridge" else lightgbm_pipeline(**kwargs)
    pipe.fit(X_fit, y_fit)
    return pipe


def predict(pipe: Pipeline, X: pd.DataFrame) -> pd.Series:
    return pd.Series(pipe.predict(X), index=X.index)
