#!/usr/bin/env python3
"""Entry point for the Stage B BTC signal research (docs/data/PLANS_MACRO_AND_ML.md).
Runs end to end with no Postgres, no Node app, no network access: everything comes from
the CSV exports under data/, produced once by
`pnpm --filter @crypto-panel/api run export:ml-features`.

Usage: python scripts/run_experiment.py [--data-dir DIR] [--out-dir DIR]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

SRC = Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(SRC))

import evaluate  # noqa: E402
import features  # noqa: E402
import labels  # noqa: E402
import model as model_mod  # noqa: E402
import portfolio  # noqa: E402
import walkforward  # noqa: E402

COST_HEADLINE_BPS = 25.0


def pooled_sharpe(series_list: list[pd.Series]) -> float:
    e = pd.concat(series_list).dropna()
    return float(e.mean() / e.std(ddof=1) * np.sqrt(365)) if e.std(ddof=1) > 0 else float("nan")


def run_model_class(model_class: str, feat: pd.DataFrame, label_series: pd.Series,
                     r_btc_brl: pd.Series, r_cdi: pd.Series) -> list[walkforward.FoldResult] | None:
    if model_class == "lightgbm" and not model_mod.HAS_LIGHTGBM:
        print("lightgbm not installed -- skipping the challenger, ridge stays the baseline of record")
        return None
    return walkforward.run_all_folds(feat, label_series, r_btc_brl, r_cdi, model_class=model_class,
                                      cost_bps=COST_HEADLINE_BPS)


def fold_table(folds: list[walkforward.FoldResult]) -> list[dict]:
    rows = []
    for f in folds:
        row = {"fold": f.label, "cuts": f.best_cuts, "band": f.best_band, **f.model_metrics}
        for name, m in f.baseline_metrics.items():
            row[f"{name}_sharpe"] = m["sharpe_vs_cdi"]
        row["random_timing_p"] = f.random_timing.get("p_value")
        rows.append(row)
    return rows


def go_no_go(pooled_delta_sharpe_ci: dict, random_timing: dict, fold_beats_majority: bool,
             cost_robust: bool, holdout_delta_not_negative: bool, dsr: dict) -> dict:
    criteria = {
        "1_beats_dca_and_constant_mix_majority_folds": fold_beats_majority,
        "2_bootstrap_ci_above_zero": pooled_delta_sharpe_ci["ci_low"] > 0,
        "3_random_timing_p_below_0.05": (random_timing.get("p_value") or 1.0) < 0.05,
        "4_holds_at_50_and_100bps": cost_robust,
        "5_holdout_delta_sharpe_not_negative": holdout_delta_not_negative,
    }
    verdict = all(criteria.values())
    return {"criteria": criteria, "go": verdict, "dsr": dsr,
            "note": "6_dsr_reported: no fixed cutoff, called out below if it doesn't support the headline"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default=str(Path(__file__).resolve().parent.parent / "data"))
    parser.add_argument("--out-dir", default=str(Path(__file__).resolve().parent.parent))
    args = parser.parse_args()

    raw = features.load_raw(args.data_dir)
    feat = features.build_feature_frame(raw)
    r_btc_brl = feat["btc_brl_ret_1d"]
    r_cdi = portfolio.daily_cdi_accrual(raw.macro_raw, feat.index)
    label_series = labels.forward_excess_return(r_btc_brl, r_cdi)

    ptax_first = raw.macro_raw["usd_brl_ptax_sell"].dropna().index.min()
    print(f"BTC signals: {raw.btc_path} ({len(raw.btc)} rows, {raw.btc.index.min().date()}..{raw.btc.index.max().date()})")
    print(f"Macro observations: {raw.macro_path}")
    print(f"USD/BRL PTAX archive starts {ptax_first.date()}.", end=" ")
    if ptax_first > walkforward.TRAIN_START:
        print(f"GAP: training starts {walkforward.TRAIN_START.date()}; BRL features/labels before "
              f"{ptax_first.date()} are NaN (PTAX backfill was still catching up -- see "
              "PLANS_MACRO_AND_ML.md). Re-export after it completes before trusting the earliest folds.")
    else:
        print("covers the full training window.")

    results: dict[str, list[walkforward.FoldResult]] = {}
    for mc in ("ridge", "lightgbm"):
        r = run_model_class(mc, feat, label_series, r_btc_brl, r_cdi)
        if r is not None:
            results[mc] = r

    pooled = {mc: pooled_sharpe([f.test_excess_return for f in folds]) for mc, folds in results.items()}
    winner = max(pooled, key=lambda k: (pooled[k] if np.isfinite(pooled[k]) else -np.inf))
    print(f"\nPooled walk-forward Sharpe-vs-CDI by model class: {pooled}")
    print(f"Selected model class: {winner}"
          + (" (ridge remains the baseline of record; lightgbm did not beat it out-of-sample)"
             if winner == "ridge" and "lightgbm" in pooled else ""))

    folds = results[winner]
    all_trials = [t for r in results.values() for f in r for t in f.trials]

    model_pooled = pd.concat([f.test_excess_return for f in folds])
    baseline_d_pooled = pd.concat([f.baseline_d_excess_return for f in folds])
    bootstrap = evaluate.bootstrap_delta_sharpe(model_pooled, baseline_d_pooled)

    fold_specs = [{"dates": f.test_w.index, "r_btc_brl": r_btc_brl.loc[f.test_w.index],
                   "r_cdi": r_cdi.loc[f.test_w.index], "target_w": f.test_w, "band": f.best_band,
                   "cost_bps": f.cost_bps} for f in folds]
    pooled_random_timing = evaluate.pooled_random_timing_test(fold_specs)

    dsr = evaluate.deflated_sharpe_ratio(model_pooled, [t["sharpe_vs_cdi"] for t in all_trials])

    fold_beats_majority = sum(
        1 for f in folds
        if f.model_metrics["sharpe_vs_cdi"] > f.baseline_metrics["monthly_dca"]["sharpe_vs_cdi"]
        and f.model_metrics["sharpe_vs_cdi"] > f.baseline_metrics["constant_mix_avg_w"]["sharpe_vs_cdi"]
    ) > len(folds) / 2

    # Criterion 4, operationalized on the mean of per-fold Sharpes (cost_sensitivity is
    # computed per fold, not pooled, since cost is a fold-local rerun of that fold's w):
    avg_sharpe_50 = np.nanmean([f.cost_sensitivity["50bps"]["sharpe_vs_cdi"] for f in folds])
    avg_sharpe_100 = np.nanmean([f.cost_sensitivity["100bps"]["sharpe_vs_cdi"] for f in folds])
    avg_d_sharpe = np.nanmean([f.baseline_metrics["constant_mix_avg_w"]["sharpe_vs_cdi"] for f in folds])
    cost_robust = bool(avg_sharpe_50 > avg_d_sharpe and avg_sharpe_100 > avg_d_sharpe)

    holdout = walkforward.run_holdout(feat, label_series, r_btc_brl, r_cdi, winner, cost_bps=COST_HEADLINE_BPS)
    holdout_delta = holdout.model_metrics["sharpe_vs_cdi"] - holdout.baseline_metrics["constant_mix_avg_w"]["sharpe_vs_cdi"]

    verdict = go_no_go(bootstrap, pooled_random_timing, fold_beats_majority, cost_robust,
                        holdout_delta >= 0, dsr)

    out_dir = Path(args.out_dir)
    date = pd.Timestamp.now().strftime("%Y-%m-%d")
    trials_path = out_dir / f"trial_log_{date}.csv"
    pd.DataFrame(all_trials).to_csv(trials_path, index=False)

    report = {
        "selected_model_class": winner, "pooled_sharpe_by_model_class": pooled,
        "folds": fold_table(folds), "bootstrap_delta_sharpe_vs_constant_mix": bootstrap,
        "pooled_random_timing_test": pooled_random_timing, "deflated_sharpe_ratio": dsr,
        "holdout": {"label": holdout.label, "model_metrics": holdout.model_metrics,
                    "baseline_metrics": holdout.baseline_metrics, "delta_sharpe_vs_constant_mix": holdout_delta},
        "cost_sensitivity_avg_sharpe": {"25bps": float(np.nanmean([f.model_metrics["sharpe_vs_cdi"] for f in folds])),
                                         "50bps": float(avg_sharpe_50), "100bps": float(avg_sharpe_100)},
        "verdict": verdict, "n_trials_total": len(all_trials),
        "data_coverage": {"ptax_first_observed": str(ptax_first.date()),
                           "btc_first_observed": str(raw.btc.index.min().date())},
    }
    report_path = out_dir / f"report_{date}.json"
    report_path.write_text(json.dumps(report, indent=2, default=str))

    print(f"\nGo/no-go verdict: {'GO' if verdict['go'] else 'NO-GO'}")
    for k, v in verdict["criteria"].items():
        print(f"  [{'x' if v else ' '}] {k}")
    print(f"Deflated Sharpe Ratio: {dsr['dsr']:.4f} over {dsr['n_trials']} trials, {dsr['n_obs']} pooled OOS days")
    print(f"Wrote {report_path}")
    print(f"Wrote {trials_path}")


if __name__ == "__main__":
    main()
