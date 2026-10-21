"""Thin adapter over ``shriii_validation`` with transparent reference fallbacks.

Probed entry point: ``shriii_validation.run_analysis(analysis, frame, params=..., context=...)``
returning an iterable of result objects/dicts shaped like :class:`ResultRow`. When it is missing, a
small reference implementation covers ``descriptives``, ``construct_validity`` (observed Pearson r
with Fisher-z CIs against the dictionary's convergent criteria; confirmatory lower-bound tests are
Holm-corrected with ``shriii_validation.validity``) and ``reliability`` (test-retest ICC(A,1), McGraw &
Wong 1996, with its F-based CI; no verdict below ``min_pairs_per_cell``). Everything else (fairness/DIF/invariance,
factor structure, ...) raises :class:`AdapterUnavailableError` rather than producing unvalidated numbers.
Thresholds always come from ``scoring/gates.yaml``.
"""

from __future__ import annotations

import importlib
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd  # type: ignore[import-untyped]
from scipy import stats
from shriii_validation.validity import holm, lower_bound_test

from shriii_api.adapters.scoring import AdapterUnavailableError

FALLBACK_ENGINE = "api-fallback-validation-0.1.0"
INDICATOR_PREFIX = "ind__"
CRITERION_PREFIX = "crit__"


@dataclass(slots=True)
class ResultRow:
    subject: str
    subject_kind: str
    metric: str
    estimate: float | None
    ci_low: float | None
    ci_high: float | None
    ci_level: float | None
    n: int | None
    method: str
    threshold: float | None = None
    passed: bool | None = None
    hypothesis_id: str | None = None
    exploratory: bool = True
    subgroup: dict[str, Any] = field(default_factory=dict)
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class AnalysisOutput:
    results: list[ResultRow]
    engine: str
    notes: list[str] = field(default_factory=list)


def _finite(x: float | None) -> float | None:
    if x is None:
        return None
    xf = float(x)
    return xf if math.isfinite(xf) else None


def fisher_ci(r: float, n: int, level: float = 0.95) -> tuple[float | None, float | None]:
    if n <= 3 or not math.isfinite(r) or abs(r) >= 1:
        return None, None
    z = math.atanh(r)
    half = float(stats.norm.ppf(0.5 + level / 2)) / math.sqrt(n - 3)
    return math.tanh(z - half), math.tanh(z + half)


def icc_a1(data: np.ndarray, level: float = 0.95) -> tuple[float, float, float]:
    """ICC(A,1): two-way random effects, absolute agreement, single measurement; (icc, lo, hi).

    ``data`` is n subjects x k occasions without missing values.
    """
    n, k = data.shape
    if n < 3 or k < 2:
        raise ValueError("ICC needs at least 3 subjects and 2 occasions")
    grand = data.mean()
    ss_rows = k * float(((data.mean(axis=1) - grand) ** 2).sum())
    ss_cols = n * float(((data.mean(axis=0) - grand) ** 2).sum())
    ss_total = float(((data - grand) ** 2).sum())
    ss_err = ss_total - ss_rows - ss_cols
    msr = ss_rows / (n - 1)
    msc = ss_cols / (k - 1)
    mse = ss_err / ((n - 1) * (k - 1))
    icc = (msr - mse) / (msr + (k - 1) * mse + k * (msc - mse) / n)
    alpha = 1 - level
    a = k * icc / (n * (1 - icc))
    b = 1 + k * icc * (n - 1) / (n * (1 - icc))
    v = (a * msc + b * mse) ** 2 / ((a * msc) ** 2 / (k - 1) + (b * mse) ** 2 / ((n - 1) * (k - 1)))
    f_l = float(stats.f.ppf(1 - alpha / 2, n - 1, v))
    f_u = float(stats.f.ppf(1 - alpha / 2, v, n - 1))
    lo = n * (msr - f_l * mse) / (f_l * (k * msc + (k * n - k - n) * mse) + n * msr)
    hi = n * (f_u * msr - mse) / (k * msc + (k * n - k - n) * mse + n * f_u * msr)
    return icc, lo, hi


def _descriptives(frame: pd.DataFrame, gates: Mapping[str, Any]) -> list[ResultRow]:
    flag_share = float(gates.get("quality", {}).get("floor_ceiling_flag_share", 0.15))
    rows: list[ResultRow] = []
    for col in frame.columns:
        if not (col.startswith(INDICATOR_PREFIX) or col.startswith(CRITERION_PREFIX)):
            continue
        series = pd.to_numeric(frame[col], errors="coerce").dropna()
        n = int(series.size)
        kind = "indicator" if col.startswith(INDICATOR_PREFIX) else "criterion"
        subject = col.split("__", 1)[1]
        if n == 0:
            rows.append(ResultRow(subject, kind, "n", 0.0, None, None, None, 0, "count"))
            continue
        mn, mx = float(series.min()), float(series.max())
        floor = float((series == mn).mean())
        ceiling = float((series == mx).mean())
        details = {
            "sd": _finite(float(series.std(ddof=1))) if n > 1 else None,
            "min": mn,
            "max": mx,
            "missing_share": float(1 - n / len(frame)) if len(frame) else None,
            "floor_share": floor,
            "ceiling_share": ceiling,
            "floor_ceiling_flag": max(floor, ceiling) > flag_share and mn != mx,
        }
        rows.append(
            ResultRow(subject, kind, "mean", float(series.mean()), None, None, None, n, "descriptive", details=details)
        )
    return rows


def _construct_validity(
    frame: pd.DataFrame, context: Mapping[str, Any], gates: Mapping[str, Any], level: float
) -> list[ResultRow]:
    convergent = gates.get("trait_gate", {}).get("convergent", {})
    threshold = float(convergent.get("lower_bound_gt", 0.10))
    indicators: Sequence[Mapping[str, Any]] = context.get("indicators", [])
    constructs: Mapping[str, Mapping[str, Any]] = context.get("constructs", {})
    confirmatory_ids = set(context.get("hypothesis_ids", []))
    rows: list[ResultRow] = []
    for ind in indicators:
        col = INDICATOR_PREFIX + ind["id"]
        if col not in frame.columns or ind.get("group_only"):
            continue
        sign = -1.0 if str(ind.get("direction", "")).endswith("less") else 1.0
        relations = constructs.get(ind["construct"], {}).get("criterion_relations", {})
        for relation in relations.get("convergent", []):
            crit_col = CRITERION_PREFIX + relation["criterion"]
            if crit_col not in frame.columns:
                continue
            pair = frame[[col, crit_col]].apply(pd.to_numeric, errors="coerce").dropna()
            n = len(pair)
            if n < 4 or pair[col].nunique() < 2 or pair[crit_col].nunique() < 2:
                continue
            r = float(np.corrcoef(sign * pair[col], pair[crit_col])[0, 1])
            lo, hi = fisher_ci(r, n, level)
            rho = float(stats.spearmanr(sign * pair[col], pair[crit_col]).statistic)
            expected = relation.get("expected_sign")
            exp_sign = 1.0 if expected == "positive" else -1.0 if expected == "negative" else None
            passed: bool | None = None
            p_lower: float | None = None
            if exp_sign is not None and lo is not None and hi is not None:
                bound = lo if exp_sign > 0 else -hi
                passed = (r * exp_sign > 0) and bound > threshold
                p_lower = lower_bound_test(r, n, threshold, expected_sign=int(exp_sign))
            hid = relation.get("hypothesis_id")
            rows.append(
                ResultRow(
                    subject=f"{ind['id']}~{relation['criterion']}",
                    subject_kind="indicator_criterion",
                    metric="pearson_r",
                    estimate=_finite(r),
                    ci_low=_finite(lo),
                    ci_high=_finite(hi),
                    ci_level=level,
                    n=n,
                    method="pearson_fisher_z (construct-keyed)",
                    threshold=threshold,
                    passed=passed,
                    hypothesis_id=hid,
                    exploratory=hid not in confirmatory_ids,
                    details={
                        "spearman_rho": _finite(rho),
                        "expected_sign": expected,
                        "construct": ind["construct"],
                        "p_lower_bound": p_lower,
                    },
                )
            )
    _holm_confirmatory(rows, convergent, level)
    return rows


def _holm_confirmatory(rows: list[ResultRow], convergent: Mapping[str, Any], level: float) -> None:
    """Gate rule B3: the confirmatory lower-bound tests are Holm-corrected as one family.

    Each test is one-sided (H0: sign * rho <= lower_bound_gt) at alpha = (1 - ci_level) / 2, which is the
    unadjusted equivalent of "CI lower bound > threshold". ``passed`` of a confirmatory row requires the
    correct sign and a Holm rejection; exploratory rows keep the unadjusted CI rule (they never feed gates).
    """
    if str(convergent.get("correction", "holm")).lower() != "holm":
        raise ValueError(f"unsupported multiplicity correction {convergent.get('correction')!r}")
    family = [r for r in rows if not r.exploratory and r.details.get("p_lower_bound") is not None]
    if not family:
        return
    alpha = (1.0 - level) / 2.0
    adjusted, rejected = holm([float(r.details["p_lower_bound"]) for r in family], alpha=alpha)
    for row, p_adj, rej in zip(family, adjusted, rejected, strict=True):
        sign_ok = row.estimate is not None and row.estimate * _sign(row) > 0
        row.details["p_holm"] = float(p_adj)
        row.details["holm_alpha"] = alpha
        row.details["holm_family_size"] = len(family)
        row.passed = bool(rej) and sign_ok
        row.method += " + holm"


def _sign(row: ResultRow) -> float:
    expected = row.details.get("expected_sign")
    return 1.0 if expected == "positive" else -1.0 if expected == "negative" else 0.0


def _reliability(
    frame: pd.DataFrame, params: Mapping[str, Any], gates: Mapping[str, Any], level: float
) -> list[ResultRow]:
    retest = gates.get("trait_gate", {}).get("retest", {})
    point_min = float(retest.get("point_min", 0.60))
    lb_min = float(retest.get("lower_bound_min", 0.40))
    min_pairs = int(retest.get("min_pairs_per_cell", 30))
    occasions: list[str] = list(params.get("occasions") or sorted(frame["occasion_id"].dropna().unique())[:2])
    if len(occasions) != 2:
        raise ValueError("test-retest reliability needs exactly two occasions")
    rows: list[ResultRow] = []
    cols = [c for c in frame.columns if c.startswith(INDICATOR_PREFIX) or c.startswith(CRITERION_PREFIX)]
    for col in cols:
        wide = frame.pivot_table(index="research_id", columns="occasion_id", values=col, aggfunc="first")
        if not set(occasions) <= set(wide.columns):
            continue
        data = wide[occasions].apply(pd.to_numeric, errors="coerce").dropna().to_numpy(dtype=float)
        if data.shape[0] < 3 or np.allclose(data.std(axis=0), 0):
            continue
        icc, lo, hi = icc_a1(data, level)
        r = float(np.corrcoef(data[:, 0], data[:, 1])[0, 1])
        kind = "indicator" if col.startswith(INDICATOR_PREFIX) else "criterion"
        rows.append(
            ResultRow(
                subject=col.split("__", 1)[1],
                subject_kind=kind,
                metric="icc_a1",
                estimate=_finite(icc),
                ci_low=_finite(lo),
                ci_high=_finite(hi),
                ci_level=level,
                n=int(data.shape[0]),
                method="icc_a1_mcgraw_wong",
                threshold=point_min,
                # Below min_pairs_per_cell the estimate is descriptive only: no pass/fail (gate rule B1).
                passed=bool(icc >= point_min and lo >= lb_min) if data.shape[0] >= min_pairs else None,
                details={
                    "pearson_r": _finite(r),
                    "occasions": occasions,
                    "lower_bound_min": lb_min,
                    "min_pairs_per_cell": min_pairs,
                    "status": "ok" if data.shape[0] >= min_pairs else "insufficient",
                },
            )
        )
    return rows


def run_analysis(
    analysis: str,
    frame: pd.DataFrame,
    *,
    params: Mapping[str, Any],
    context: Mapping[str, Any],
    gates: Mapping[str, Any],
) -> AnalysisOutput:
    """Run one analysis on a snapshot frame."""
    try:
        module = importlib.import_module("shriii_validation")
        fn = getattr(module, "run_analysis", None)
    except ImportError:
        fn = None
    if callable(fn):
        raw = fn(analysis, frame, params=dict(params), context=dict(context))
        version = str(getattr(module, "__version__", "unknown"))
        results = [r if isinstance(r, ResultRow) else ResultRow(**dict(r)) for r in raw]
        return AnalysisOutput(results=results, engine=f"shriii_validation-{version}")
    level = float(params.get("ci_level", 0.95))
    if analysis == "descriptives":
        return AnalysisOutput(_descriptives(frame, gates), FALLBACK_ENGINE)
    if analysis == "construct_validity":
        return AnalysisOutput(
            _construct_validity(frame, context, gates, level),
            FALLBACK_ENGINE,
            notes=["observed r only; disattenuated statistics never feed gates"],
        )
    if analysis == "reliability":
        return AnalysisOutput(_reliability(frame, params, gates, level), FALLBACK_ENGINE)
    raise AdapterUnavailableError(f"analysis '{analysis}' requires shriii_validation (no reference fallback)")


# ---------------------------------------------------------------- predictive models


@dataclass(slots=True)
class ModelOutput:
    engine: str
    cv_metrics: dict[str, dict[str, float | None]]
    holdout_metrics: dict[str, float | None]
    predictions: list[dict[str, Any]]
    n_train: int
    n_holdout: int


def train_model(
    frame: pd.DataFrame,
    *,
    features: Sequence[str],
    target: str,
    algorithm: str,
    params: Mapping[str, Any],
    holdout_cohort: str | None,
) -> ModelOutput:
    """Participant-grouped CV (no leakage) plus an untouched holdout cohort when given."""
    try:
        module = importlib.import_module("shriii_validation")
        fn = getattr(module, "train_model", None)
    except ImportError:
        fn = None
    if callable(fn):
        out = fn(
            frame,
            features=list(features),
            target=target,
            algorithm=algorithm,
            params=dict(params),
            holdout_cohort=holdout_cohort,
        )
        return out if isinstance(out, ModelOutput) else ModelOutput(**dict(out))

    from sklearn.ensemble import GradientBoostingRegressor  # noqa: PLC0415
    from sklearn.impute import SimpleImputer  # noqa: PLC0415
    from sklearn.linear_model import RidgeCV  # noqa: PLC0415
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score  # noqa: PLC0415
    from sklearn.model_selection import GroupKFold  # noqa: PLC0415
    from sklearn.pipeline import make_pipeline  # noqa: PLC0415
    from sklearn.preprocessing import StandardScaler  # noqa: PLC0415

    missing = [c for c in [*features, target] if c not in frame.columns]
    if missing:
        raise ValueError(f"snapshot lacks columns: {missing}")
    data = frame.dropna(subset=[target]).copy()
    is_holdout = (data.get("cohort_id") == holdout_cohort) if holdout_cohort else pd.Series(False, index=data.index)
    train, hold = data[~is_holdout], data[is_holdout]
    groups = train["research_id"].to_numpy()
    n_splits = int(params.get("n_splits", 5))
    n_splits = max(2, min(n_splits, len(np.unique(groups))))
    if len(np.unique(groups)) < 2:
        raise ValueError("need at least two participants for grouped CV")

    def make() -> Any:
        if algorithm == "ridge":
            return make_pipeline(SimpleImputer(), StandardScaler(), RidgeCV(alphas=np.logspace(-3, 3, 13)))
        if algorithm == "gradient_boosting":
            return make_pipeline(SimpleImputer(), GradientBoostingRegressor(random_state=int(params.get("seed", 0))))
        raise ValueError(f"unsupported algorithm {algorithm}")

    x = train[list(features)].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
    y = pd.to_numeric(train[target], errors="coerce").to_numpy(dtype=float)
    folds: dict[str, list[float]] = {"r2": [], "mae": [], "rmse": []}
    preds: list[dict[str, Any]] = []
    for fold, (tr, te) in enumerate(GroupKFold(n_splits=n_splits).split(x, y, groups)):
        model = make().fit(x[tr], y[tr])
        p = model.predict(x[te])
        folds["r2"].append(float(r2_score(y[te], p)) if len(te) > 1 else float("nan"))
        folds["mae"].append(float(mean_absolute_error(y[te], p)))
        folds["rmse"].append(float(math.sqrt(mean_squared_error(y[te], p))))
        for idx, value in zip(te, p, strict=True):
            row = train.iloc[int(idx)]
            preds.append(
                {
                    "research_id": str(row["research_id"]),
                    "occasion_id": row.get("occasion_id"),
                    "fold": fold,
                    "split": "cv",
                    "predicted": float(value),
                    "observed": float(y[idx]),
                }
            )
    cv = {
        k: {"mean": _finite(float(np.nanmean(v))), "sd": _finite(float(np.nanstd(v, ddof=1))) if len(v) > 1 else None}
        for k, v in folds.items()
    }
    holdout: dict[str, float | None] = {}
    if len(hold) > 1:
        final = make().fit(x, y)
        xh = hold[list(features)].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
        yh = pd.to_numeric(hold[target], errors="coerce").to_numpy(dtype=float)
        ph = final.predict(xh)
        holdout = {
            "r2": _finite(float(r2_score(yh, ph))),
            "mae": _finite(float(mean_absolute_error(yh, ph))),
            "rmse": _finite(float(math.sqrt(mean_squared_error(yh, ph)))),
        }
        for i, value in enumerate(ph):
            row = hold.iloc[i]
            preds.append(
                {
                    "research_id": str(row["research_id"]),
                    "occasion_id": row.get("occasion_id"),
                    "fold": None,
                    "split": "holdout",
                    "predicted": float(value),
                    "observed": float(yh[i]),
                }
            )
    return ModelOutput(FALLBACK_ENGINE, cv, holdout, preds, len(train), len(hold))


# ---------------------------------------------------------------- norms


@dataclass(slots=True)
class NormOutput:
    engine: str
    cut_points: list[float]
    sem: float
    effective_n: int
    method: str
    details: dict[str, Any]


def generate_norms(
    frame: pd.DataFrame,
    *,
    indicator_ids: Sequence[str],
    directions: Mapping[str, str],
    reliability: float,
    quantiles: Sequence[float],
    ci_level: float,
) -> NormOutput:
    """Provisional norms: unit-weighted z composite, empirical quantile cut-points, SEM = SD*sqrt(1-r)."""
    try:
        module = importlib.import_module("shriii_validation")
        fn = getattr(module, "generate_norms", None)
    except ImportError:
        fn = None
    if callable(fn):
        out = fn(
            frame,
            indicator_ids=list(indicator_ids),
            directions=dict(directions),
            reliability=reliability,
            quantiles=list(quantiles),
            ci_level=ci_level,
        )
        return out if isinstance(out, NormOutput) else NormOutput(**dict(out))
    if not 0 <= reliability < 1:
        raise ValueError("reliability must be in [0, 1)")
    cols = [INDICATOR_PREFIX + i for i in indicator_ids if INDICATOR_PREFIX + i in frame.columns]
    if not cols:
        raise ValueError("no indicator columns for this trait in the snapshot")
    z = pd.DataFrame(index=frame.index)
    for col in cols:
        s = pd.to_numeric(frame[col], errors="coerce")
        sd = float(s.std(ddof=1))
        if not sd or not math.isfinite(sd):
            continue
        sign = -1.0 if str(directions.get(col[len(INDICATOR_PREFIX) :], "")).endswith("less") else 1.0
        z[col] = sign * (s - s.mean()) / sd
    composite = z.mean(axis=1, skipna=True).dropna()
    if len(composite) < 10:
        raise ValueError("fewer than 10 composites; cannot build norms")
    cuts = [float(composite.quantile(q)) for q in quantiles]
    sd = float(composite.std(ddof=1))
    return NormOutput(
        engine=FALLBACK_ENGINE,
        cut_points=cuts,
        sem=sd * math.sqrt(1 - reliability),
        effective_n=len(composite),
        method="unit_weighted_z_empirical_quantiles",
        details={
            "indicators": [c[len(INDICATOR_PREFIX) :] for c in z.columns],
            "composite_sd": sd,
            "reliability": reliability,
            "quantiles": list(quantiles),
        },
    )
