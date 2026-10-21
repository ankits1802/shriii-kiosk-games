"""Predictive and incremental validity (VAL-10; spec section 6.4).

The four comparisons of the spec: (1) criterion scores from game features; (2) outcomes from the battery;
(3) outcomes from game features; (4) outcomes from game + battery (incremental validity, the key result).
All cross-validation is grouped by participant (GroupKFold) with nested inner GroupKFold tuning; every
split is checked by :func:`assert_no_group_leakage`. Models: ridge, elastic net, random forest, XGBoost.
Hierarchical regression gives delta R^2 with a participant-clustered bootstrap CI. A participant-level
holdout cohort can be split off once and kept untouched for final confirmation.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from numpy.typing import ArrayLike, NDArray
from scipy import stats

from shriii_validation.params import ValidationParams, load_validation_params
from shriii_validation.results import EvidenceResult, make_provenance

__all__ = [
    "LeakageError",
    "ModelName",
    "PredictionReport",
    "assert_no_group_leakage",
    "grouped_cv",
    "hierarchical_regression",
    "holdout_split",
    "predictive_comparisons",
]

ModelName = Literal["ridge", "elastic_net", "random_forest", "xgboost"]
FloatArray = NDArray[np.float64]


class LeakageError(AssertionError):
    """A participant appears in both the training and the test partition."""


def assert_no_group_leakage(train_groups: ArrayLike, test_groups: ArrayLike) -> None:
    """Fail loudly when any participant id appears on both sides of a split."""
    overlap = set(np.asarray(train_groups).tolist()) & set(np.asarray(test_groups).tolist())
    if overlap:
        raise LeakageError(f"{len(overlap)} participant(s) in both train and test, e.g. {sorted(overlap)[:3]}")


def holdout_split(
    groups: ArrayLike, *, fraction: float = 0.2, salt: str = "shriii-holdout"
) -> tuple[NDArray[np.bool_], NDArray[np.bool_]]:
    """Deterministic participant-level holdout: a participant is in the holdout when the SHA-256 of
    ``salt + id`` falls below ``fraction`` (stable across re-runs and data additions). Returns masks
    (development, holdout)."""
    g = np.asarray(groups).astype(str)
    hold = np.array([int(hashlib.sha256((salt + x).encode()).hexdigest()[:12], 16) / 16**12 < fraction for x in g])
    assert_no_group_leakage(g[~hold], g[hold])
    return ~hold, hold


def _model(name: ModelName, seed: int) -> tuple[Any, dict[str, list[Any]]]:
    from sklearn.ensemble import RandomForestRegressor  # noqa: PLC0415 - heavy, loaded on demand
    from sklearn.impute import SimpleImputer  # noqa: PLC0415 - heavy, loaded on demand
    from sklearn.linear_model import ElasticNet, Ridge  # noqa: PLC0415 - heavy, loaded on demand
    from sklearn.pipeline import Pipeline  # noqa: PLC0415 - heavy, loaded on demand
    from sklearn.preprocessing import StandardScaler  # noqa: PLC0415 - heavy, loaded on demand

    pre = [("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())]
    if name == "ridge":
        return Pipeline([*pre, ("model", Ridge())]), {"model__alpha": [0.1, 1.0, 10.0, 100.0]}
    if name == "elastic_net":
        return (
            Pipeline([*pre, ("model", ElasticNet(max_iter=10000, random_state=seed))]),
            {"model__alpha": [0.01, 0.1, 1.0], "model__l1_ratio": [0.2, 0.5, 0.8]},
        )
    if name == "random_forest":
        return (
            Pipeline([*pre, ("model", RandomForestRegressor(n_estimators=200, random_state=seed, n_jobs=1))]),
            {"model__max_depth": [3, 6, None], "model__min_samples_leaf": [5, 20]},
        )
    from xgboost import XGBRegressor  # noqa: PLC0415 - heavy, loaded on demand

    return (
        Pipeline([*pre, ("model", XGBRegressor(n_estimators=200, random_state=seed, n_jobs=1, verbosity=0))]),
        {"model__max_depth": [2, 4], "model__learning_rate": [0.05, 0.2]},
    )


def _metrics(y: FloatArray, pred: FloatArray) -> dict[str, float]:
    resid = y - pred
    ss_res = float(resid @ resid)
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    return {
        "r2": 1 - ss_res / ss_tot if ss_tot > 0 else math.nan,
        "mae": float(np.mean(np.abs(resid))),
        "rmse": float(math.sqrt(np.mean(resid**2))),
    }


@dataclass(frozen=True, slots=True)
class PredictionReport:
    """Grouped, nested cross-validation result for one model and feature set."""

    model: str
    features: tuple[str, ...]
    n: int
    n_groups: int
    cv_r2: EvidenceResult
    cv_mae: EvidenceResult
    cv_rmse: EvidenceResult
    fold_metrics: list[dict[str, float]]
    oof_pred: FloatArray = field(repr=False)
    best_params: list[dict[str, Any]] = field(default_factory=list)


def grouped_cv(
    x: ArrayLike,
    y: ArrayLike,
    groups: ArrayLike,
    *,
    model: ModelName = "ridge",
    features: Sequence[str] = (),
    outer_folds: int | None = None,
    inner_folds: int | None = None,
    n_boot: int | None = None,
    seed: int = 0,
    params: ValidationParams | None = None,
) -> PredictionReport:
    """Nested, participant-grouped cross-validation. Out-of-fold metrics carry a participant-clustered
    bootstrap CI; fold-to-fold SD is in details."""
    from sklearn.model_selection import GridSearchCV, GroupKFold  # noqa: PLC0415 - heavy, loaded on demand

    prm = params or load_validation_params()
    of = outer_folds or prm.i("prediction.outer_folds")
    inf = inner_folds or prm.i("prediction.inner_folds")
    nb = n_boot or prm.i("prediction.bootstrap_resamples")
    xm = np.asarray(x, dtype=float)
    if xm.ndim == 1:
        xm = xm[:, None]
    yv = np.asarray(y, dtype=float)
    gv = np.asarray(groups).astype(str)
    ok = np.isfinite(yv)
    xm, yv, gv = xm[ok], yv[ok], gv[ok]
    oof = np.full(yv.size, np.nan)
    folds: list[dict[str, float]] = []
    best: list[dict[str, Any]] = []
    outer = GroupKFold(n_splits=of)
    for tr, te in outer.split(xm, yv, gv):
        assert_no_group_leakage(gv[tr], gv[te])
        est, grid = _model(model, seed)
        inner = GroupKFold(n_splits=inf)
        search = GridSearchCV(est, grid, cv=inner, scoring="neg_mean_squared_error")
        search.fit(xm[tr], yv[tr], groups=gv[tr])
        pred = search.predict(xm[te])
        oof[te] = pred
        folds.append(_metrics(yv[te], pred))
        best.append(dict(search.best_params_))
    overall = _metrics(yv, oof)
    rng = np.random.default_rng(seed)
    uniq = np.unique(gv)
    idx_by_group = {g: np.flatnonzero(gv == g) for g in uniq}
    boots: dict[str, list[float]] = {"r2": [], "mae": [], "rmse": []}
    for _ in range(nb):
        pick = rng.choice(uniq, uniq.size, replace=True)
        ii = np.concatenate([idx_by_group[g] for g in pick])
        m = _metrics(yv[ii], oof[ii])
        for k, values in boots.items():
            values.append(m[k])
    prov = make_provenance(f"grouped_cv:{model}", xm, yv, seed=seed, params={"outer": of, "inner": inf})

    def res(k: str) -> EvidenceResult:
        lo, hi = np.nanpercentile(boots[k], [2.5, 97.5])
        return EvidenceResult(
            f"cv_{k}",
            overall[k],
            float(lo),
            float(hi),
            0.95,
            int(yv.size),
            f"nested_group_kfold_{model}",
            details={
                "fold_mean": float(np.mean([f[k] for f in folds])),
                "fold_sd": float(np.std([f[k] for f in folds], ddof=1)),
            },
            provenance=prov,
        )

    return PredictionReport(
        model, tuple(features), int(yv.size), int(uniq.size), res("r2"), res("mae"), res("rmse"), folds, oof, best
    )


def hierarchical_regression(
    y: ArrayLike,
    blocks: Sequence[ArrayLike],
    groups: ArrayLike,
    *,
    names: Sequence[str] | None = None,
    n_boot: int | None = None,
    seed: int = 0,
    min_n: int | None = None,
    params: ValidationParams | None = None,
) -> list[EvidenceResult]:
    """Nested OLS models adding one block at a time (e.g. demographics -> self-report -> game traits).
    For each step: delta R^2 with a participant-clustered bootstrap CI and the F-change test. Refuses to
    run below ``prediction.min_n`` (VAL-10 AC)."""
    prm = params or load_validation_params()
    need = min_n if min_n is not None else prm.i("prediction.min_n")
    nb = n_boot or prm.i("prediction.bootstrap_resamples")
    yv = np.asarray(y, dtype=float)
    mats = [np.asarray(b, dtype=float).reshape(yv.size, -1) for b in blocks]
    gv = np.asarray(groups).astype(str)
    ok = np.isfinite(yv) & np.all(np.column_stack([np.all(np.isfinite(m), axis=1) for m in mats]), axis=1)
    yv, gv = yv[ok], gv[ok]
    mats = [m[ok] for m in mats]
    labels = list(names) if names is not None else [f"block_{i}" for i in range(len(mats))]
    prov = make_provenance("hierarchical_regression", yv, *mats, seed=seed)
    if yv.size < need:
        return [
            EvidenceResult.unavailable(
                "delta_r2",
                "hierarchical_ols",
                f"n={yv.size} below the pre-declared {need}",
                n=int(yv.size),
                status="insufficient",
                provenance=prov,
            )
        ]

    def r2(cols: list[FloatArray], idx: NDArray[np.int64]) -> tuple[float, int]:
        xm = np.column_stack([np.ones(idx.size), *[c[idx] for c in cols]]) if cols else np.ones((idx.size, 1))
        b = np.linalg.lstsq(xm, yv[idx], rcond=None)[0]
        r = yv[idx] - xm @ b
        tss = float(np.sum((yv[idx] - yv[idx].mean()) ** 2))
        return (1 - float(r @ r) / tss if tss > 0 else 0.0), xm.shape[1]

    all_idx = np.arange(yv.size)
    uniq = np.unique(gv)
    by_g = {g: np.flatnonzero(gv == g) for g in uniq}
    rng = np.random.default_rng(seed)
    samples = [np.concatenate([by_g[g] for g in rng.choice(uniq, uniq.size, replace=True)]) for _ in range(nb)]
    out: list[EvidenceResult] = []
    prev_cols: list[FloatArray] = []
    for name, m in zip(labels, mats, strict=True):
        cols = [*prev_cols, m]
        r2_prev, k_prev = r2(prev_cols, all_idx)
        r2_new, k_new = r2(cols, all_idx)
        delta = r2_new - r2_prev
        df1, df2 = k_new - k_prev, yv.size - k_new
        f = (delta / df1) / ((1 - r2_new) / df2) if df1 > 0 and r2_new < 1 else math.nan
        boots = [r2(cols, s)[0] - r2(prev_cols, s)[0] for s in samples]
        lo, hi = np.percentile(boots, [2.5, 97.5])
        out.append(
            EvidenceResult(
                "delta_r2",
                delta,
                float(lo),
                float(hi),
                0.95,
                int(yv.size),
                "hierarchical_ols_cluster_bootstrap",
                details={
                    "block": name,
                    "r2": r2_new,
                    "F_change": f,
                    "df1": df1,
                    "df2": df2,
                    "p_F_change": float(stats.f.sf(f, df1, df2)) if math.isfinite(f) else math.nan,
                },
                provenance=prov,
            )
        )
        prev_cols = cols
    return out


def predictive_comparisons(
    data: Mapping[str, ArrayLike],
    *,
    participant: str,
    game_features: Sequence[str],
    battery_features: Sequence[str],
    criterion: str | None,
    outcome: str | None,
    models: Sequence[ModelName] = ("ridge", "elastic_net", "random_forest", "xgboost"),
    seed: int = 0,
    min_n: int | None = None,
    n_boot: int | None = None,
    params: ValidationParams | None = None,
) -> dict[str, dict[str, PredictionReport] | EvidenceResult]:
    """The four spec section 6.4 comparisons, each with every model, plus the incremental CV R^2 of
    (game + battery) over battery alone per model. Refuses to run below ``prediction.min_n``."""
    prm = params or load_validation_params()
    need = min_n if min_n is not None else prm.i("prediction.min_n")
    groups = np.asarray(data[participant]).astype(str)

    def cols(names: Sequence[str]) -> FloatArray:
        return np.column_stack([np.asarray(data[c], dtype=float) for c in names])

    out: dict[str, dict[str, PredictionReport] | EvidenceResult] = {}
    plan: list[tuple[str, Sequence[str], str | None]] = [
        ("criterion_from_game", game_features, criterion),
        ("outcome_from_battery", battery_features, outcome),
        ("outcome_from_game", game_features, outcome),
        ("outcome_from_game_and_battery", [*game_features, *battery_features], outcome),
    ]
    for key, feats, target in plan:
        if target is None or not feats:
            out[key] = EvidenceResult.unavailable(key, "grouped_cv", "target or features not supplied")
            continue
        y = np.asarray(data[target], dtype=float)
        if int(np.isfinite(y).sum()) < need:
            out[key] = EvidenceResult.unavailable(
                key,
                "grouped_cv",
                f"n below the pre-declared {need}",
                n=int(np.isfinite(y).sum()),
                status="insufficient",
            )
            continue
        out[key] = {
            m: grouped_cv(cols(feats), y, groups, model=m, features=feats, seed=seed, n_boot=n_boot, params=prm)
            for m in models
        }
    full = out.get("outcome_from_game_and_battery")
    batt = out.get("outcome_from_battery")
    if isinstance(full, dict) and isinstance(batt, dict) and outcome is not None:
        # The primary model is the first one listed (pre-declared), never the one with the largest gain:
        # picking the maximum difference across models would capitalise on chance. The CI is a paired,
        # participant-clustered bootstrap of the out-of-fold R^2 difference (same rows, same resamples).
        y_all = np.asarray(data[outcome], dtype=float)
        ok = np.isfinite(y_all)
        yv, gv = y_all[ok], groups[ok]
        uniq = np.unique(gv)
        by_g = {g: np.flatnonzero(gv == g) for g in uniq}
        nb = n_boot or prm.i("prediction.bootstrap_resamples")
        rng = np.random.default_rng(seed)
        samples = [np.concatenate([by_g[g] for g in rng.choice(uniq, uniq.size, replace=True)]) for _ in range(nb)]
        inc: dict[str, dict[str, float]] = {}
        for m in models:
            of, ob = full[m].oof_pred, batt[m].oof_pred
            diff = _metrics(yv, of)["r2"] - _metrics(yv, ob)["r2"]
            boots = np.array([_metrics(yv[s], of[s])["r2"] - _metrics(yv[s], ob[s])["r2"] for s in samples])
            lo, hi = np.nanpercentile(boots, [2.5, 97.5])
            inc[m] = {"delta_cv_r2": float(diff), "ci_low": float(lo), "ci_high": float(hi)}
        primary = models[0]
        out["incremental_cv_r2"] = EvidenceResult(
            "incremental_cv_r2",
            inc[primary]["delta_cv_r2"],
            inc[primary]["ci_low"],
            inc[primary]["ci_high"],
            0.95,
            full[primary].n,
            "cv_r2_difference_game_plus_battery_minus_battery_paired_cluster_bootstrap",
            details={"by_model": inc, "primary_model": primary},
            provenance=make_provenance("incremental_cv_r2", yv, seed=seed, params={"models": list(models)}),
        )
    return out
