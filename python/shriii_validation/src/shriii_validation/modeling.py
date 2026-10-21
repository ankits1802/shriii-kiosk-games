"""Model-training and norm-generation entry points used by the API worker.

* :func:`train_model` - one registered predictive model: nested, participant-grouped cross-validation
  (no participant on both sides of any split) on the development rows, then a single evaluation of the
  tuned model on an untouched holdout cohort.
* :func:`generate_norms` - provisional norms for one trait: the unit-weighted construct-keyed z composite
  (standardisation parameters recorded so the release pack can reproduce it), weighted quantile
  cut-points, SEM = SD x sqrt(1 - reliability), Kish effective n, age x education percentile cells with
  provisional / suppressed flags, and the ``gates.yaml`` SEM-based band-width check.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from itertools import pairwise
from typing import Any, Literal, cast

import numpy as np
import pandas as pd

from shriii_validation._version import VALIDATION_ALGORITHM_VERSION
from shriii_validation.analysis import ENGINE, _clean, _f, frame_sha256
from shriii_validation.frame import INDICATOR_PREFIX, IndicatorInfo, composite, values
from shriii_validation.norming import kish_effective_n, percentile_norms, weighted_quantile
from shriii_validation.params import load_gates, load_validation_params
from shriii_validation.prediction import (
    ModelName,
    fit_final_model,
    fold_assignments,
    grouped_cv,
    holdout_metrics,
)
from shriii_validation.results import _versions

__all__ = ["MODEL_ALIASES", "generate_norms", "train_model"]

MODEL_ALIASES: dict[str, ModelName] = {
    "ridge": "ridge",
    "elastic_net": "elastic_net",
    "random_forest": "random_forest",
    "xgboost": "xgboost",
    "gradient_boosting": "xgboost",
}


def _model_name(algorithm: str) -> ModelName:
    try:
        return MODEL_ALIASES[algorithm]
    except KeyError as exc:
        raise ValueError(f"unsupported algorithm {algorithm!r}; expected one of {sorted(MODEL_ALIASES)}") from exc


def train_model(
    frame: pd.DataFrame,
    *,
    features: Sequence[str],
    target: str,
    algorithm: str,
    params: Mapping[str, Any] | None = None,
    holdout_cohort: str | None = None,
) -> dict[str, Any]:
    """Participant-grouped nested CV plus an untouched holdout cohort (when ``holdout_cohort`` is given).

    Returns ``engine``, ``cv_metrics`` (``{metric: {mean, sd, ci_low, ci_high}}`` where ``mean`` is the
    pooled out-of-fold value and ``sd`` the fold-to-fold SD), ``holdout_metrics``, ``predictions``
    (out-of-fold and holdout, keyed by ``research_id``), ``n_train``, ``n_holdout`` and ``details``.
    """
    p = dict(params or {})
    prm = load_validation_params()
    model = _model_name(algorithm)
    feats = list(features)
    missing = [c for c in [*feats, target, "research_id"] if c not in frame.columns]
    if missing:
        raise ValueError(f"snapshot lacks columns: {missing}")
    if target in feats:
        raise ValueError("the target cannot be a feature (leakage)")
    data = frame.copy()
    data[target] = pd.to_numeric(data[target], errors="coerce")
    data = data[data[target].notna()].reset_index(drop=True)
    if holdout_cohort is not None and "cohort_id" in data.columns:
        is_hold = data["cohort_id"].astype(str) == str(holdout_cohort)
    else:
        is_hold = pd.Series(False, index=data.index)
    train, hold = data[~is_hold].reset_index(drop=True), data[is_hold].reset_index(drop=True)
    groups = train["research_id"].astype(str).to_numpy()
    n_groups = int(np.unique(groups).size)
    if n_groups < 3:
        raise ValueError(f"grouped CV needs at least 3 participants with the target; found {n_groups}")
    outer = max(2, min(int(p.get("n_splits", prm.i("prediction.outer_folds"))), n_groups))
    smallest_train = n_groups - math.ceil(n_groups / outer)
    inner = max(2, min(int(p.get("inner_folds", prm.i("prediction.inner_folds"))), smallest_train))
    seed = int(p.get("seed", 0))
    n_boot = int(p.get("n_boot", prm.i("prediction.bootstrap_resamples")))
    x = train[feats].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
    y = train[target].to_numpy(dtype=float)
    rep = grouped_cv(
        x,
        y,
        groups,
        model=model,
        features=feats,
        outer_folds=outer,
        inner_folds=inner,
        n_boot=n_boot,
        seed=seed,
        params=prm,
    )
    folds = fold_assignments(groups, outer)
    cv_metrics: dict[str, dict[str, float | None]] = {}
    for key, er in (("r2", rep.cv_r2), ("mae", rep.cv_mae), ("rmse", rep.cv_rmse)):
        cv_metrics[key] = {
            "mean": _f(er.estimate),
            "sd": _f(er.details.get("fold_sd")),
            "ci_low": _f(er.ci_low),
            "ci_high": _f(er.ci_high),
            "fold_mean": _f(er.details.get("fold_mean")),
        }
    occ = train["occasion_id"].astype(str).tolist() if "occasion_id" in train.columns else [None] * len(train)
    predictions: list[dict[str, Any]] = [
        {
            "research_id": str(groups[i]),
            "occasion_id": occ[i],
            "fold": int(folds[i]),
            "split": "cv",
            "predicted": float(rep.oof_pred[i]),
            "observed": float(y[i]),
        }
        for i in range(len(train))
        if math.isfinite(float(rep.oof_pred[i]))
    ]
    holdout: dict[str, float | None] = {}
    holdout_details: dict[str, Any] = {}
    if len(hold) > 1:
        est, best = fit_final_model(x, y, groups, model=model, inner_folds=inner, seed=seed, params=prm)
        xh = hold[feats].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
        yh = hold[target].to_numpy(dtype=float)
        gh = hold["research_id"].astype(str).to_numpy()
        metrics, pred = holdout_metrics(est, xh, yh, gh, train_groups=groups, n_boot=n_boot, seed=seed, params=prm)
        holdout = {k: _f(v.estimate) for k, v in metrics.items()}
        holdout_details = {
            "best_params": best,
            "ci": {k: [_f(v.ci_low), _f(v.ci_high)] for k, v in metrics.items()},
            "n_groups": int(np.unique(gh).size),
        }
        hocc = hold["occasion_id"].astype(str).tolist() if "occasion_id" in hold.columns else [None] * len(hold)
        predictions += [
            {
                "research_id": str(gh[i]),
                "occasion_id": hocc[i],
                "fold": None,
                "split": "holdout",
                "predicted": float(pred[i]),
                "observed": float(yh[i]),
            }
            for i in range(len(hold))
        ]
    return {
        "engine": ENGINE,
        "cv_metrics": cv_metrics,
        "holdout_metrics": holdout,
        "predictions": predictions,
        "n_train": len(train),
        "n_holdout": len(hold),
        "details": _clean(
            {
                "model": model,
                "algorithm_requested": algorithm,
                "cv_scheme": {
                    "kind": "nested_group_k_fold",
                    "groups": "research_id",
                    "outer_folds": outer,
                    "inner_folds": inner,
                },
                "n_groups_train": n_groups,
                "best_params_by_fold": rep.best_params,
                "fold_metrics": rep.fold_metrics,
                "holdout": holdout_details,
                "leakage_check": "assert_no_group_leakage on every split",
                "provenance": {
                    "algorithm_version": VALIDATION_ALGORITHM_VERSION,
                    "computed_at": datetime.now(UTC).isoformat(),
                    "frame_sha256": frame_sha256(frame),
                    "library_versions": dict(_versions()),
                    "seed": seed,
                },
            }
        ),
    }


def generate_norms(
    frame: pd.DataFrame,
    *,
    indicator_ids: Sequence[str],
    directions: Mapping[str, str],
    reliability: float,
    quantiles: Sequence[float],
    ci_level: float,
    weights: str | None = None,
    trait: str = "trait",
    norm_table_version: str = "draft",
    gates: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Provisional norms for one trait (see the module docstring).

    ``weights`` names a frame column of post-stratification weights (default: equal weights). The norms
    are provisional when the Kish effective n is below ``norming.provisional_effective_n``.
    """
    if not 0 <= reliability < 1:
        raise ValueError("reliability must be in [0, 1)")
    if not all(0 < q < 1 for q in quantiles) or list(quantiles) != sorted(quantiles):
        raise ValueError("quantiles must be increasing and inside (0, 1)")
    prm = load_validation_params()
    g = gates if gates is not None else load_gates()[0]
    sem_rule = cast(Mapping[str, Any], g["trait_gate"]["norms"]["sem_rule"])
    infos = [
        IndicatorInfo(
            i, i.split(".")[0], -1 if str(directions.get(i, "")).endswith("less") else 1, True, False, None, None, ()
        )
        for i in indicator_ids
        if INDICATOR_PREFIX + i in frame.columns
    ]
    if not infos:
        raise ValueError("no indicator columns for this trait in the snapshot")
    comp, standardisation = composite(frame, infos)
    mask = comp.notna().to_numpy()
    if weights is not None:
        if weights not in frame.columns:
            raise ValueError(f"weights column {weights!r} is not in the snapshot")
        w_all = values(frame[weights])
        mask &= np.isfinite(w_all) & (w_all > 0)
    else:
        w_all = np.ones(len(frame))
    v, w = comp.to_numpy(dtype=float)[mask], w_all[mask]
    if v.size < 10:
        raise ValueError("fewer than 10 composites; cannot build norms")
    cuts = [weighted_quantile(v, w, float(q)) for q in quantiles]
    mean_w = float(np.average(v, weights=w))
    sd = float(math.sqrt(np.average((v - mean_w) ** 2, weights=w) * v.size / max(1, v.size - 1)))
    sem = sd * math.sqrt(1 - reliability)
    eff_n = kish_effective_n(w)
    provisional = eff_n < prm.f("norming.provisional_effective_n")
    widths = [b - a for a, b in pairwise(cuts)]
    min_width_sem = float(sem_rule.get("min_band_width_sem", 2.0))
    narrow = [float(x / sem) for x in widths if sem > 0 and x / sem < min_width_sem]
    cells: list[dict[str, Any]] = []
    if {"age_band", "edu_band"} <= set(frame.columns):
        table = percentile_norms(
            v,
            frame.loc[mask, "age_band"].astype(str).to_numpy(),
            frame.loc[mask, "edu_band"].astype(str).to_numpy(),
            w,
            trait=trait,
            norm_table_version=norm_table_version,
            params=prm,
        )
        cells = [
            {
                "cell": c.cell,
                "n": c.n,
                "effective_n": c.effective_n,
                "provisional": c.provisional,
                "suppressed": c.suppressed,
                "percentiles": {str(k): val for k, val in c.percentiles.items()},
            }
            for c in table.cells
        ]
    method: Literal["unit_weighted_z_weighted_quantiles", "unit_weighted_z_empirical_quantiles"] = (
        "unit_weighted_z_weighted_quantiles" if weights is not None else "unit_weighted_z_empirical_quantiles"
    )
    return {
        "engine": ENGINE,
        "cut_points": cuts,
        "sem": sem,
        "effective_n": round(eff_n),
        "method": method,
        "provisional": bool(provisional),
        "details": _clean(
            {
                "indicators": [i.id for i in infos if i.id in standardisation],
                "standardisation": standardisation,
                "composite_sd": sd,
                "composite_mean": mean_w,
                "reliability": reliability,
                "quantiles": list(quantiles),
                "ci_level": ci_level,
                "n": int(v.size),
                "kish_effective_n": eff_n,
                "provisional_effective_n": prm.f("norming.provisional_effective_n"),
                "band_width_sem": [x / sem if sem > 0 else None for x in widths],
                "bands_narrower_than_min_sem": narrow,
                "min_band_width_sem": min_width_sem,
                "cells_age_x_education": cells,
                "provenance": {
                    "algorithm_version": VALIDATION_ALGORITHM_VERSION,
                    "computed_at": datetime.now(UTC).isoformat(),
                    "frame_sha256": frame_sha256(frame),
                    "validation_params_sha256": prm.sha256,
                },
            }
        ),
    }
