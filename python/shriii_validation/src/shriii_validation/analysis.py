"""Analysis entry point for snapshot frames: ``run_analysis(analysis, frame, params=..., context=...)``.

This is the interface the API worker calls (``apps/api`` ``adapters/validation.py``). Each analysis turns a
de-identified snapshot frame (see :mod:`shriii_validation.frame`) into :class:`ResultRecord` rows (observed
estimate, CI, N, threshold from ``gates.yaml``, pass/fail where a gate rule applies, exclusions and
provenance) using the reference implementations in this package:

==========================  ===============================================================================
``descriptives``            distribution, missingness, floor/ceiling per measure (pooled and per language)
``reliability``             test-retest ICC(A,1) per measure and construct composite (B1, with SEM, SDC,
                            Bland-Altman, practice effect); composite omega / alpha per construct (B2)
``construct_validity``      pre-registered ``hypotheses.yaml`` (convergent lower-bound tests with the family
                            corrections, r_contrast-CV discriminant pattern, nomological), plus exploratory
                            indicator x criterion correlations
``mtmm``                    multitrait-multimethod matrix (game composite vs self-report), Campbell-Fiske
``factor_structure``        parallel analysis, ML EFA (oblimin), CFA per construct and joint (semopy),
                            redundancy
``measurement_invariance``  configural -> metric -> scalar multi-group CFA per grouping with a partial
                            scalar search bounded by ``max_freed_parameter_share`` (B4)
``dif``                     regression DIF per indicator (2-df nested F, delta R^2, BH-FDR, Jodoin-Gierl
                            classes) with an external criterion or rest-composite matching variable
``fairness``                TOST equivalence of means, Cleary differential prediction, group calibration,
                            missingness disparity, device-familiarity effects, differential exclusion
``incremental_validity``    the four spec 6.4 comparisons with nested participant-grouped CV, incremental
                            CV R^2 (pre-declared primary model), hierarchical delta R^2, untouched holdout
==========================  ===============================================================================

Gate thresholds are read from ``gates.yaml``; analysis conventions from ``data/validation_params.yaml``.
Observed correlations only feed gates. Group-level-only indicators never enter these individual analyses.
Results that cannot be computed carry ``status`` ``insufficient`` / ``not_available`` and no pass/fail.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import warnings
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any, cast, get_args

import numpy as np
import pandas as pd
from numpy.typing import NDArray

from shriii_validation._version import VALIDATION_ALGORITHM_VERSION
from shriii_validation.fairness import (
    calibration_by_group,
    device_familiarity_effect,
    differential_prediction,
    disparity,
    linear_dif,
    tost_two_sample,
)
from shriii_validation.frame import (
    CRITERION_PREFIX,
    INDICATOR_PREFIX,
    AnalysisContext,
    IndicatorInfo,
    PreparedFrame,
    composite,
    coverage,
    prepare_frame,
    resolve_context,
    values,
)
from shriii_validation.params import ValidationParams, load_validation_params
from shriii_validation.prediction import (
    ModelName,
    PredictionReport,
    fit_final_model,
    hierarchical_regression,
    holdout_metrics,
    predictive_comparisons,
)
from shriii_validation.rbackend import default_backend
from shriii_validation.reliability import cronbach_alpha, mcdonald_omega, retest_reliability
from shriii_validation.results import EvidenceResult, _versions
from shriii_validation.structure import cfa, efa, measurement_invariance, parallel_analysis, redundancy
from shriii_validation.validity import benjamini_hochberg, correlation, evaluate_hypotheses, mtmm

__all__ = [
    "ANALYSES",
    "ENGINE",
    "AnalysisReport",
    "ResultRecord",
    "canonical_analysis",
    "frame_sha256",
    "run_analysis",
]

ENGINE = f"shriii_validation-{VALIDATION_ALGORITHM_VERSION}"
MODEL_NAMES: tuple[str, ...] = get_args(ModelName)
FloatArray = NDArray[np.float64]

ANALYSES: tuple[str, ...] = (
    "descriptives",
    "reliability",
    "construct_validity",
    "mtmm",
    "factor_structure",
    "measurement_invariance",
    "dif",
    "fairness",
    "incremental_validity",
)
_ALIASES = {
    "validity": "construct_validity",
    "convergent_validity": "construct_validity",
    "structure": "factor_structure",
    "invariance": "measurement_invariance",
    "prediction": "incremental_validity",
    "predictive_validity": "incremental_validity",
}
# gates.yaml grouping names -> snapshot design columns (None: not part of analysis snapshots).
GROUPING_COLUMNS: dict[str, str | None] = {
    "language": "language",
    "literacy": "literacy_band",
    "education": "edu_band",
    "age_band": "age_band",
    "gender": "gender",
    "device_familiarity": "device_familiarity",
    "site_mode": "site_mode",
    "input_mode": None,
    "variant_form": None,
    "timing_profile": None,
}


@dataclass(slots=True)
class ResultRecord:
    """One persisted statistical result (``validation.statistical_results``)."""

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
    exclusions: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = json.loads(json.dumps(asdict(self), default=_json_default))
        return out


@dataclass(slots=True)
class AnalysisReport:
    """Everything one analysis produced: rows, frame-level exclusions, notes and provenance."""

    analysis: str
    engine: str
    results: list[ResultRecord]
    exclusions: dict[str, Any]
    provenance: dict[str, Any]
    notes: list[str] = field(default_factory=list)

    def __iter__(self) -> Iterator[ResultRecord]:
        return iter(self.results)

    def __len__(self) -> int:
        return len(self.results)


def _json_default(o: Any) -> Any:
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return str(o)


def _clean(value: Any) -> Any:
    """JSON-safe copy (NaN/inf -> None, numpy -> python, tuples -> lists)."""
    if isinstance(value, Mapping):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if isinstance(value, np.ndarray):
        return [_clean(v) for v in value.tolist()]
    if isinstance(value, np.generic):
        return _clean(value.item())
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return value


def _f(x: Any) -> float | None:
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def canonical_analysis(analysis: str) -> str:
    """The canonical analysis name (aliases resolved); raises ``ValueError`` for unknown analyses."""
    name = _ALIASES.get(analysis, analysis)
    if name not in ANALYSES:
        raise ValueError(f"unknown analysis {analysis!r}; expected one of {', '.join(ANALYSES)}")
    return name


def frame_sha256(frame: pd.DataFrame) -> str:
    """Content hash of a frame (columns, dtypes and values, row order included)."""
    h = hashlib.sha256()
    h.update(json.dumps([str(c) for c in frame.columns]).encode())
    if len(frame):
        h.update(pd.util.hash_pandas_object(frame, index=False).to_numpy().tobytes())
    return h.hexdigest()


# ---------------------------------------------------------------- helpers


@dataclass(slots=True)
class _Run:
    """Per-call state shared by the analysis functions."""

    ctx: AnalysisContext
    prm: ValidationParams
    params: Mapping[str, Any]
    frame: PreparedFrame
    seed: int
    notes: list[str] = field(default_factory=list)

    def p(self, key: str, default: Any) -> Any:
        v = self.params.get(key)
        return default if v is None else v

    @property
    def min_coverage(self) -> float:
        return float(self.p("min_coverage", 0.80))

    def individual_indicators(self, frame: pd.DataFrame | None = None) -> list[IndicatorInfo]:
        df = self.frame.baseline if frame is None else frame
        out = []
        for col in self.frame.indicator_columns:
            info = self.ctx.indicators.get(col[len(INDICATOR_PREFIX) :])
            if info is None:
                info = IndicatorInfo(
                    col[len(INDICATOR_PREFIX) :],
                    col[len(INDICATOR_PREFIX) :].split(".")[0],
                    1,
                    False,
                    False,
                    None,
                    None,
                    (),
                )
            if not info.group_only and col in df.columns:
                out.append(info)
        return out

    def constructs_with(self, min_indicators: int, frame: pd.DataFrame | None = None) -> dict[str, list[IndicatorInfo]]:
        """Constructs with at least ``min_indicators`` gate-eligible indicators at ``min_coverage``."""
        df = self.frame.baseline if frame is None else frame
        by: dict[str, list[IndicatorInfo]] = {}
        for info in self.individual_indicators(df):
            if info.gate_eligible and coverage(df, info.column) >= self.min_coverage:
                by.setdefault(info.construct, []).append(info)
        return {c: v for c, v in sorted(by.items()) if len(v) >= min_indicators}


def _subgroups(
    df: pd.DataFrame, column: str = "language", *, pooled: bool = True
) -> Iterator[tuple[dict[str, Any], pd.DataFrame]]:
    if pooled:
        yield {}, df
    if column in df.columns:
        for label in sorted({str(v) for v in df[column].dropna().unique()}):
            yield {column: label}, df[df[column].astype(str) == label]


def _record(
    er: EvidenceResult,
    *,
    subject: str,
    subject_kind: str,
    metric: str,
    subgroup: Mapping[str, Any] | None = None,
    threshold: float | None = None,
    passed: bool | None = None,
    hypothesis_id: str | None = None,
    exploratory: bool = True,
    details: Mapping[str, Any] | None = None,
    rows_available: int | None = None,
) -> ResultRecord:
    d: dict[str, Any] = dict(er.details)
    d.update(details or {})
    d["status"] = er.status
    if er.warnings:
        d["warnings"] = list(er.warnings)
    if er.assumptions:
        d["assumptions"] = [asdict(a) for a in er.assumptions]
    prov: dict[str, Any] = {}
    if er.provenance is not None:
        prov = {
            "analysis": er.provenance.analysis,
            "algorithm_version": er.provenance.algorithm_version,
            "inputs_sha256": er.provenance.inputs_sha256,
            "seed": er.provenance.seed,
            "params": dict(er.provenance.params),
        }
    exclusions: dict[str, Any] = {}
    if rows_available is not None:
        exclusions = {
            "rows_available": int(rows_available),
            "rows_used": int(er.n),
            "rows_excluded_missing": max(0, int(rows_available) - int(er.n)),
        }
    return ResultRecord(
        subject=subject,
        subject_kind=subject_kind,
        metric=metric,
        estimate=_f(er.estimate),
        ci_low=_f(er.ci_low),
        ci_high=_f(er.ci_high),
        ci_level=_f(er.ci_level),
        n=int(er.n),
        method=er.method,
        threshold=threshold,
        passed=passed if er.status == "ok" else None,
        hypothesis_id=hypothesis_id,
        exploratory=exploratory,
        subgroup=dict(subgroup or {}),
        details=_clean(d),
        exclusions=exclusions,
        provenance=_clean(prov),
    )


def _keyed_matrix(df: pd.DataFrame, inds: Sequence[IndicatorInfo]) -> FloatArray:
    return np.column_stack([ind.sign * values(df[ind.column]) for ind in inds])


def _safe_name(text: str) -> str:
    return re.sub(r"\W", "_", text)


# ---------------------------------------------------------------- descriptives


def _descriptives(run: _Run) -> list[ResultRecord]:
    p = run.frame
    flag_share = float(run.ctx.gates.get("quality", {}).get("floor_ceiling_flag_share", 0.15))
    out: list[ResultRecord] = []
    for sub, df in _subgroups(p.baseline):
        for col in p.measure_columns:
            s = pd.to_numeric(df[col], errors="coerce")
            v = s.dropna()
            n = int(v.size)
            kind = "indicator" if col.startswith(INDICATOR_PREFIX) else "criterion"
            subject = col.split("__", 1)[1]
            missing = float(1 - n / len(df)) if len(df) else None
            if n == 0:
                out.append(
                    ResultRecord(
                        subject,
                        kind,
                        "mean",
                        None,
                        None,
                        None,
                        None,
                        0,
                        "descriptive",
                        subgroup=sub,
                        details={"status": "insufficient", "missing_share": missing},
                        exclusions={"rows_available": len(df), "rows_used": 0, "rows_excluded_missing": len(df)},
                    )
                )
                continue
            mn, mx = float(v.min()), float(v.max())
            floor, ceiling = float((v == mn).mean()), float((v == mx).mean())
            sd = float(v.std(ddof=1)) if n > 1 else None
            se = sd / math.sqrt(n) if sd is not None else None
            lo = hi = None
            if se is not None and n > 1:
                from scipy import stats  # noqa: PLC0415

                tq = float(stats.t.ppf(0.975, n - 1))
                lo, hi = float(v.mean()) - tq * se, float(v.mean()) + tq * se
            out.append(
                ResultRecord(
                    subject=subject,
                    subject_kind=kind,
                    metric="mean",
                    estimate=float(v.mean()),
                    ci_low=lo,
                    ci_high=hi,
                    ci_level=0.95 if lo is not None else None,
                    n=n,
                    method="descriptive_t_ci",
                    subgroup=sub,
                    details=_clean(
                        {
                            "status": "ok",
                            "sd": sd,
                            "median": float(v.median()),
                            "min": mn,
                            "max": mx,
                            "skew": _f(v.skew()) if n > 2 else None,
                            "missing_share": missing,
                            "floor_share": floor,
                            "ceiling_share": ceiling,
                            "floor_ceiling_flag": bool(max(floor, ceiling) > flag_share and mn != mx),
                            "floor_ceiling_flag_share": flag_share,
                        }
                    ),
                    exclusions={"rows_available": len(df), "rows_used": n, "rows_excluded_missing": len(df) - n},
                )
            )
    return out


# ---------------------------------------------------------------- reliability


def _retest_measures(run: _Run, t1: pd.DataFrame, t2: pd.DataFrame) -> list[tuple[str, str, pd.Series, pd.Series]]:
    """(subject, kind, values at occasion 1, values at occasion 2) indexed by research_id."""
    a = t1.set_index("research_id")
    b = t2.set_index("research_id")
    out: list[tuple[str, str, pd.Series, pd.Series]] = []
    for col in run.frame.measure_columns:
        kind = "indicator" if col.startswith(INDICATOR_PREFIX) else "criterion"
        out.append((col.split("__", 1)[1], kind, a[col], b[col]))
    by: dict[str, list[IndicatorInfo]] = {}
    for info in run.individual_indicators(t1):
        if info.gate_eligible:
            by.setdefault(info.construct, []).append(info)
    for construct, inds in sorted(by.items()):
        c1, _ = composite(t1, inds)
        c2, _ = composite(t2, inds, reference=t1)
        out.append(
            (construct, "construct", pd.Series(c1.to_numpy(), index=a.index), pd.Series(c2.to_numpy(), index=b.index))
        )
    return out


def _reliability(run: _Run) -> list[ResultRecord]:
    tg = run.ctx.gates["trait_gate"]
    rt, rl = tg["retest"], tg["reliability"]
    level = float(run.p("ci_level", rt.get("ci_level", 0.95)))
    min_pairs = int(rt["min_pairs_per_cell"])
    point_min, pooled_min, lb_min = (
        float(rt["point_min"]),
        float(rt.get("pooled_language_point_min", rt["point_min"])),
        float(rt["lower_bound_min"]),
    )
    practice = float(run.ctx.gates.get("quality", {}).get("practice_effect_d_flag", 0.30))
    occasions = [str(o) for o in (run.params.get("occasions") or run.frame.occasions[:2])]
    out: list[ResultRecord] = []
    rows = run.frame.all_rows
    if len(occasions) == 2 and all(o in run.frame.occasions for o in occasions):
        t1 = rows[rows["occasion_id"] == occasions[0]].drop_duplicates("research_id", keep="last")
        t2 = rows[rows["occasion_id"] == occasions[1]].drop_duplicates("research_id", keep="last")
        languages = sorted({str(v) for v in t1.get("language", pd.Series(dtype=str)).dropna().unique()})
        lang_of = t1.set_index("research_id")["language"].astype(str) if "language" in t1.columns else None
        for subject, kind, s1, s2 in _retest_measures(run, t1, t2):
            ids = s1.index.intersection(s2.index)
            cells: list[tuple[dict[str, Any], pd.Index]] = [({}, ids)]
            if lang_of is not None:
                cells += [({"language": lang}, ids[lang_of.reindex(ids).to_numpy() == lang]) for lang in languages]
            for sub, cell_ids in cells:
                a = s1.reindex(cell_ids).to_numpy(dtype=float)
                b = s2.reindex(cell_ids).to_numpy(dtype=float)
                rr = retest_reliability(a, b, ci_level=level, min_pairs=min_pairs, practice_d_flag=practice)
                icc = rr["icc_a1"]
                pooled = not sub and len(languages) > 1
                thr = pooled_min if pooled else point_min
                passed = bool(icc.est >= thr and icc.lo >= lb_min) if icc.ok and icc.ci_low is not None else None
                extra = {
                    "occasions": occasions,
                    "lower_bound_min": lb_min,
                    "min_pairs_per_cell": min_pairs,
                    "pooled_across_languages": pooled,
                    "icc_c1": _f(rr["icc_c1"].estimate),
                    "pearson_r_never_for_gates": _f(rr["pearson"].estimate),
                    "sem": _f(rr["sem"].estimate),
                    "sdc": _f(rr["sdc"].estimate),
                    "bland_altman": {
                        "mean_difference": _f(rr["bland_altman"].estimate),
                        "loa_low": _f(rr["bland_altman"].ci_low),
                        "loa_high": _f(rr["bland_altman"].ci_high),
                    },
                    "practice_effect": {
                        "mean_change": _f(rr["practice_effect"].estimate),
                        **{k: _clean(v) for k, v in rr["practice_effect"].details.items()},
                    },
                }
                out.append(
                    _record(
                        icc,
                        subject=subject,
                        subject_kind=kind,
                        metric="icc_a1",
                        subgroup=sub,
                        threshold=thr,
                        passed=passed,
                        details=extra,
                        rows_available=int(np.sum(np.isfinite(a) | np.isfinite(b))),
                    )
                )
    else:
        run.notes.append(f"test-retest skipped: needs two occasions, snapshot has {run.frame.occasions}")
    # Composite internal consistency per construct (B2: composite_omega).
    n_boot = int(run.p("n_boot", 500))
    for construct, inds in run.constructs_with(2).items():
        for sub, df in _subgroups(run.frame.baseline):
            x = _keyed_matrix(df, inds)
            if len(inds) >= 3:
                er = mcdonald_omega(x, ci_level=float(rl.get("ci_level", 0.95)), n_boot=n_boot, seed=run.seed)
                metric = "omega_total"
            else:
                er = cronbach_alpha(x, ci_level=float(rl.get("ci_level", 0.95)))
                metric = "alpha"
            passed = (
                bool(er.est >= float(rl["point_min"]) and er.lo >= float(rl["lower_bound_min"]))
                if er.ok and er.ci_low is not None
                else None
            )
            out.append(
                _record(
                    er,
                    subject=construct,
                    subject_kind="construct",
                    metric=metric,
                    subgroup=sub,
                    threshold=float(rl["point_min"]),
                    passed=passed,
                    details={"indicators": [i.id for i in inds], "lower_bound_min": float(rl["lower_bound_min"])},
                    rows_available=len(df),
                )
            )
    run.notes.append(
        "split-half reliability of raw indicators needs trial-level data and is produced by the scoring engine; "
        "criterion-scale alpha/omega needs item-level responses (not in analysis snapshots)"
    )
    return out


# ---------------------------------------------------------------- construct validity


def _pathways(run: _Run, df: pd.DataFrame) -> list[str | None]:
    if run.params.get("pathway") or run.ctx.pathway:
        return [str(run.params.get("pathway") or run.ctx.pathway)]
    if "pathway" in df.columns:
        found = sorted({str(v) for v in df["pathway"].dropna().unique()})
        if found:
            return list(found)
    return [None]


def _construct_validity(run: _Run) -> list[ResultRecord]:
    defaults = run.ctx.hypotheses.get("defaults", {})
    level = float(run.p("ci_level", defaults.get("ci_level", 0.95)))
    n_boot = int(run.p("n_boot", defaults.get("bootstrap_resamples", 2000)))
    threshold = float(run.ctx.gates["trait_gate"]["convergent"]["lower_bound_gt"])
    out: list[ResultRecord] = []
    base = run.frame.baseline
    for pw in _pathways(run, base):
        dpw = base[base["pathway"].astype(str) == pw] if pw is not None and "pathway" in base.columns else base
        inds = run.individual_indicators(dpw)
        for sub0, df in _subgroups(dpw):
            sub = {**({"pathway": pw} if pw else {}), **sub0}
            indicators = {i.id: values(df[i.column]) for i in inds}
            criteria = {c[len(CRITERION_PREFIX) :]: values(df[c]) for c in run.frame.criterion_columns}
            signs = {i.id: i.sign for i in inds}
            results = evaluate_hypotheses(
                run.ctx.hypotheses,
                indicators,
                criteria,
                indicator_signs=signs,
                pathway=pw,
                ci_level=level,
                n_boot=n_boot,
                seed=run.seed,
            )
            for h in results:
                spec: Mapping[str, Any] = next(
                    (x for x in run.ctx.hypotheses.get("hypotheses", []) if x["id"] == h.hypothesis_id), {}
                )
                metric = {
                    "discriminant_pattern": "r_contrast_cv",
                    "retest_stability": "icc_a1",
                    "group_level": "group_estimate",
                }.get(h.kind, "pearson_r")
                sign = int(h.details.get("expected_sign") or 0)
                status = h.status
                details = {
                    "status": status,
                    "family": h.family,
                    "kind": h.kind,
                    "construct": h.construct,
                    "criterion": spec.get("criterion"),
                    "p": _f(h.p),
                    "p_adjusted": _f(h.p_adjusted),
                    "expected_sign": spec.get("expected_sign"),
                    "sign_correct": (bool(h.estimate * sign > 0) if h.estimate is not None and sign else None),
                    "lower_bound_gt": threshold,
                    **_clean(dict(h.details)),
                }
                if h.warnings:
                    details["warnings"] = list(h.warnings)
                r0 = spec.get("r0")
                out.append(
                    ResultRecord(
                        subject=f"{h.construct}~{spec.get('criterion') or 'pattern'}",
                        subject_kind="hypothesis",
                        metric=metric,
                        estimate=_f(h.estimate),
                        ci_low=_f(h.ci_low),
                        ci_high=_f(h.ci_high),
                        ci_level=level if h.estimate is not None else None,
                        n=int(h.n),
                        method=f"evaluate_hypotheses:{h.kind}",
                        threshold=_f(r0) if r0 is not None else None,
                        passed=h.passed if status == "ok" else None,
                        hypothesis_id=h.hypothesis_id,
                        exploratory=h.hypothesis_id not in run.ctx.confirmatory_ids or bool(sub0),
                        subgroup=sub,
                        details=_clean(details),
                        exclusions={
                            "rows_available": len(df),
                            "rows_used": int(h.n),
                            "rows_excluded_missing": max(0, len(df) - int(h.n)),
                        },
                        provenance={"hypotheses_version": str(run.ctx.hypotheses.get("version")), "n_boot": n_boot},
                    )
                )
            # Exploratory indicator x convergent-criterion correlations (construct-keyed, observed only).
            for info in inds:
                for crit in info.convergent_criteria:
                    col = CRITERION_PREFIX + crit
                    if col not in df.columns:
                        continue
                    x = info.sign * values(df[info.column])
                    y = values(df[col])
                    er = correlation(x, y, ci_level=level)
                    rho = correlation(x, y, kind="spearman", ci_level=level)
                    exp = run.ctx.expected_sign(info.construct, crit)
                    passed = None
                    if er.ok and exp and er.ci_low is not None and er.ci_high is not None:
                        bound = er.lo if exp > 0 else -er.hi
                        passed = bool(er.est * exp > 0 and bound > threshold)
                    out.append(
                        _record(
                            er,
                            subject=f"{info.id}~{crit}",
                            subject_kind="indicator_criterion",
                            metric="pearson_r",
                            subgroup=sub,
                            threshold=threshold,
                            passed=passed,
                            exploratory=True,
                            details={
                                "construct": info.construct,
                                "expected_sign": exp,
                                "spearman_rho": _f(rho.estimate),
                                "observed_only": True,
                            },
                            rows_available=len(df),
                        )
                    )
    run.notes.append("observed correlations only; disattenuated statistics never feed gates")
    return out


# ---------------------------------------------------------------- MTMM


def _mtmm(run: _Run) -> list[ResultRecord]:
    out: list[ResultRecord] = []
    for sub, df in _subgroups(run.frame.baseline):
        data: dict[str, FloatArray] = {}
        traits: dict[str, str] = {}
        methods: dict[str, str] = {}
        used_criteria: set[str] = set()
        for construct in sorted({i.construct for i in run.individual_indicators(df)}):
            inds = run.ctx.construct_indicators(construct, list(df.columns))
            crit = next(
                (
                    c
                    for c in run.ctx.convergent_criteria(construct)
                    if CRITERION_PREFIX + c in df.columns and c not in used_criteria
                ),
                None,
            )
            if not inds or crit is None:
                continue
            comp, _ = composite(df, inds)
            sign = run.ctx.expected_sign(construct, crit) or 1
            data[f"game:{construct}"] = values(comp)
            data[f"self_report:{crit}"] = sign * values(df[CRITERION_PREFIX + crit])
            traits[f"game:{construct}"] = traits[f"self_report:{crit}"] = construct
            methods[f"game:{construct}"], methods[f"self_report:{crit}"] = "game", "self_report"
            used_criteria.add(crit)
        if len(set(traits.values())) < 2:
            out.append(
                ResultRecord(
                    "battery",
                    "battery",
                    "mtmm",
                    None,
                    None,
                    None,
                    None,
                    len(df),
                    "campbell_fiske_mtmm",
                    subgroup=sub,
                    details={
                        "status": "insufficient",
                        "reason": "fewer than two traits with a game composite and a criterion",
                    },
                )
            )
            continue
        res = mtmm(data, traits, methods)
        names = list(res.variables)
        matrix = {a: {b: _f(res.matrix[i, j]) for j, b in enumerate(names)} for i, a in enumerate(names)}
        for va, vb, r in res.validity_diagonal:
            trait = traits[va]
            er = correlation(data[va], data[vb])
            out.append(
                _record(
                    er,
                    subject=trait,
                    subject_kind="construct",
                    metric="validity_diagonal_r",
                    subgroup=sub,
                    passed=res.campbell_fiske.get(trait),
                    details={
                        "variables": [va, vb],
                        "r_matrix_entry": _f(r),
                        "campbell_fiske_criterion": (
                            "validity diagonal exceeds heterotrait-heteromethod values in its row and column"
                        ),
                    },
                    rows_available=len(df),
                )
            )
        for label, block in (
            ("heterotrait_monomethod", res.heterotrait_monomethod),
            ("heterotrait_heteromethod", res.heterotrait_heteromethod),
        ):
            rs = [abs(r) for _, _, r in block if math.isfinite(r)]
            out.append(
                ResultRecord(
                    "battery",
                    "battery",
                    f"{label}_mean_abs_r",
                    _f(float(np.mean(rs))) if rs else None,
                    None,
                    None,
                    None,
                    len(df),
                    "campbell_fiske_mtmm",
                    subgroup=sub,
                    details=_clean(
                        {"status": "ok" if rs else "insufficient", "pairs": [[a, b, r] for a, b, r in block]}
                    ),
                )
            )
        out.append(
            ResultRecord(
                "battery",
                "battery",
                "mtmm_matrix",
                None,
                None,
                None,
                None,
                len(df),
                "pairwise_pearson",
                subgroup=sub,
                details=_clean(
                    {
                        "status": "ok",
                        "variables": names,
                        "traits": traits,
                        "methods": methods,
                        "matrix": matrix,
                        "n_pairwise_min": float(np.min(res.n_pairwise)),
                    }
                ),
            )
        )
    return out


# ---------------------------------------------------------------- factor structure


def _cfa(df: pd.DataFrame, factors: Mapping[str, Sequence[str]], run: _Run) -> EvidenceResult:
    with warnings.catch_warnings():
        # semopy divides by the model df when computing RMSEA; a just-identified model has df = 0.
        warnings.simplefilter("ignore", RuntimeWarning)
        return cfa(df, factors, params=run.prm)


def _factor_structure(run: _Run) -> list[ResultRecord]:
    df0 = run.frame.baseline
    inds = [
        i for i in run.individual_indicators(df0) if i.gate_eligible and coverage(df0, i.column) >= run.min_coverage
    ]
    out: list[ResultRecord] = []
    if len(inds) < 3:
        out.append(
            ResultRecord(
                "battery",
                "battery",
                "parallel_analysis",
                None,
                None,
                None,
                None,
                len(df0),
                "horn",
                details={
                    "status": "insufficient",
                    "reason": f"{len(inds)} indicators at coverage >= {run.min_coverage}",
                },
            )
        )
        return out
    names = {i.id: _safe_name(i.id) for i in inds}
    df = pd.DataFrame({names[i.id]: i.sign * values(df0[i.column]) for i in inds})
    complete = df.dropna()
    pa = parallel_analysis(complete.to_numpy(), seed=run.seed, params=run.prm)
    out.append(
        _record(
            pa,
            subject="battery",
            subject_kind="battery",
            metric="parallel_analysis_n_factors",
            details={"indicators": [i.id for i in inds]},
            rows_available=len(df0),
        )
    )
    n_factors = int(run.p("n_factors", max(1, int(pa.details.get("n_factors", 1) or 1))))
    n_factors = max(1, min(n_factors, len(inds) - 1))
    er = efa(complete, n_factors, params=run.prm)
    reverse = {v: k for k, v in names.items()}
    efa_details = {"n_factors": n_factors, "variable_names": reverse}
    out.append(
        _record(
            er,
            subject="battery",
            subject_kind="battery",
            metric="efa_proportion_variance",
            details=efa_details,
            rows_available=len(df0),
        )
    )
    min_ind = run.prm.i("structure.min_indicators_for_cfa")
    factors: dict[str, list[str]] = {}
    for construct, cinds in run.constructs_with(min_ind).items():
        factors[_safe_name(construct)] = [names[i.id] for i in cinds if i.id in names]
        res = _cfa(df, {_safe_name(construct): factors[_safe_name(construct)]}, run)
        dof = (res.details.get("fit") or {}).get("DoF")
        out.append(
            _record(
                res,
                subject=construct,
                subject_kind="construct",
                metric="cfa_cfi",
                details={
                    "variable_names": reverse,
                    "model": "one_factor",
                    # Three indicators on one factor leave no degrees of freedom: fit is not testable.
                    "just_identified": dof is not None and float(dof) == 0.0,
                },
                rows_available=len(df0),
            )
        )
    if len(factors) >= 2:
        res = _cfa(df, factors, run)
        out.append(
            _record(
                res,
                subject="battery",
                subject_kind="battery",
                metric="cfa_cfi",
                details={"variable_names": reverse, "model": "correlated_constructs"},
                rows_available=len(df0),
            )
        )
    elif not factors:
        run.notes.append(
            f"CFA skipped: no construct has >= {min_ind} gate-eligible indicators at coverage >= {run.min_coverage}"
        )
    for pair in redundancy(df, params=run.prm):
        out.append(
            ResultRecord(
                f"{reverse[pair['a']]}|{reverse[pair['b']]}",
                "indicator_pair",
                "redundancy_r",
                _f(pair["r"]),
                None,
                None,
                None,
                int(df[[pair["a"], pair["b"]]].dropna().shape[0]),
                "pearson_redundancy",
                details=_clean(
                    {
                        "status": "ok",
                        "r_disattenuated": pair["r_disattenuated"],
                        "redundancy_r": run.prm.f("structure.redundancy_r"),
                    }
                ),
            )
        )
    return out


# ---------------------------------------------------------------- measurement invariance


def _groupings(run: _Run, default: Sequence[str]) -> list[str]:
    g = run.params.get("groupings") or run.params.get("grouping") or list(default)
    if g == "required":
        return [str(x) for x in run.ctx.gates["trait_gate"]["invariance"]["required_groupings"]]
    return [str(g)] if isinstance(g, str) else [str(x) for x in g]


def _group_column(name: str) -> str | None:
    return GROUPING_COLUMNS.get(name, name)


def _invariance_for(
    run: _Run,
    grouping: str,
    column: str,
    construct: str,
    inds: Sequence[IndicatorInfo],
    *,
    max_share: float,
    small_n: int,
) -> list[ResultRecord]:
    df = run.frame.baseline
    variables = [i.id for i in inds]
    factors = {construct: variables}
    groups: dict[str, FloatArray] = {}
    sizes: dict[str, int] = {}
    for label in sorted({str(v) for v in df[column].dropna().unique()}):
        x = _keyed_matrix(df[df[column].astype(str) == label], inds)
        x = x[np.all(np.isfinite(x), axis=1)]
        sizes[label] = int(x.shape[0])
        if x.shape[0] >= len(variables) + 2:
            groups[label] = x
    sub = {"grouping": grouping}
    if len(groups) < 2:
        return [
            ResultRecord(
                construct,
                "construct",
                "invariance_level",
                None,
                None,
                None,
                None,
                sum(sizes.values()),
                "multigroup_ml_cfa",
                subgroup=sub,
                details={
                    "status": "insufficient",
                    "group_sizes": sizes,
                    "reason": "fewer than two groups with complete data",
                },
            )
        ]
    small = sorted(g for g, n in sizes.items() if n < small_n)
    notes: dict[str, Any] = {"group_sizes": sizes, "indicators": variables}
    if small:
        alt = default_backend().bayesian_approximate_invariance(None, construct, grouping)
        notes["small_groups"] = small
        notes["small_group_method"] = {"method": alt.method, "status": alt.status, "message": list(alt.warnings)}
    res = measurement_invariance(groups, variables, factors, max_freed_share=max_share, params=run.prm)
    freed: list[str] = []
    budget = math.floor(max_share * len(variables))
    while (
        not res["scalar"].details.get("passed")
        and res["metric"].details.get("invariance_holds_through_this_level")
        and len(freed) < budget
    ):
        best: tuple[float, str, dict[str, EvidenceResult]] | None = None
        for v in variables:
            if v in freed:
                continue
            trial = measurement_invariance(
                groups, variables, factors, free_intercepts=[*freed, v], max_freed_share=max_share, params=run.prm
            )
            cfi = trial["scalar"].estimate if trial["scalar"].estimate is not None else -math.inf
            if best is None or cfi > best[0]:
                best = (cfi, v, trial)
        if best is None:
            break
        freed.append(best[1])
        res = best[2]
    out: list[ResultRecord] = []
    for level in ("configural", "metric", "scalar"):
        er = res[level]
        out.append(
            _record(
                er,
                subject=construct,
                subject_kind="construct",
                metric=f"cfi_{level}",
                subgroup=sub,
                passed=bool(er.details.get("passed")),
                details=notes,
                rows_available=len(df),
            )
        )
    holds = {
        lv: bool(res[lv].details.get("invariance_holds_through_this_level"))
        for lv in ("configural", "metric", "scalar")
    }
    level_reached = (
        "scalar"
        if holds["scalar"]
        else ("metric" if holds["metric"] else ("configural" if holds["configural"] else "none"))
    )
    if level_reached == "scalar" and freed:
        level_reached = "partial_scalar"
    out.append(
        ResultRecord(
            construct,
            "construct",
            "invariance_level",
            None,
            None,
            None,
            None,
            int(sum(len(x) for x in groups.values())),
            "multigroup_ml_cfa_chen2007",
            passed=holds["scalar"],
            subgroup=sub,
            details=_clean(
                {
                    "status": "ok",
                    "level": level_reached,
                    "freed_intercepts": freed,
                    "freed_share": len(freed) / len(variables),
                    "max_freed_parameter_share": max_share,
                    **notes,
                }
            ),
            exclusions={
                "rows_available": len(df),
                "rows_used": int(sum(len(x) for x in groups.values())),
                "rows_excluded_missing": len(df) - int(sum(len(x) for x in groups.values())),
            },
        )
    )
    return out


def _measurement_invariance(run: _Run) -> list[ResultRecord]:
    inv = run.ctx.gates["trait_gate"]["invariance"]
    max_share = float(inv.get("max_freed_parameter_share", 0.20))
    small_n = int(inv.get("small_group_n", 200))
    min_ind = run.prm.i("structure.min_indicators_for_cfa")
    factors = run.params.get("factors")
    if factors:
        constructs = {
            str(c): [run.ctx.indicators[str(i)] for i in ids if str(i) in run.ctx.indicators]
            for c, ids in dict(factors).items()
        }
    else:
        constructs = run.constructs_with(min_ind)
    out: list[ResultRecord] = []
    for grouping in _groupings(run, ["language"]):
        column = _group_column(grouping)
        if column is None or column not in run.frame.baseline.columns:
            out.append(
                ResultRecord(
                    "battery",
                    "battery",
                    "invariance_level",
                    None,
                    None,
                    None,
                    None,
                    0,
                    "multigroup_ml_cfa",
                    subgroup={"grouping": grouping},
                    details={
                        "status": "not_available",
                        "reason": f"grouping {grouping!r} is not a snapshot design column",
                    },
                )
            )
            continue
        if not constructs:
            out.append(
                ResultRecord(
                    "battery",
                    "battery",
                    "invariance_level",
                    None,
                    None,
                    None,
                    None,
                    len(run.frame.baseline),
                    "multigroup_ml_cfa",
                    subgroup={"grouping": grouping},
                    details={
                        "status": "insufficient",
                        "reason": (
                            f"no construct has >= {min_ind} gate-eligible indicators at coverage >= {run.min_coverage}"
                        ),
                    },
                )
            )
        for construct, inds in constructs.items():
            out += _invariance_for(run, grouping, column, construct, inds, max_share=max_share, small_n=small_n)
    out.append(
        ResultRecord(
            "criterion_scales",
            "battery",
            "criterion_invariance",
            None,
            None,
            None,
            None,
            0,
            "item_level_mgcfa",
            details={
                "status": "not_available",
                "reason": (
                    "VAL-08a criterion-scale invariance needs item-level responses, which analysis snapshots "
                    "do not carry; fail closed"
                ),
            },
        )
    )
    run.notes.append(
        "multi-group CFA is the package's ML implementation with mean structure "
        "(semopy has no multi-group equality constraints)"
    )
    return out


# ---------------------------------------------------------------- DIF


def _matching(run: _Run, df: pd.DataFrame, info: IndicatorInfo, mode: str) -> tuple[FloatArray | None, str]:
    if mode in ("auto", "criterion"):
        for crit in info.convergent_criteria or tuple(run.ctx.convergent_criteria(info.construct)):
            col = CRITERION_PREFIX + crit
            if col in df.columns and coverage(df, col) > 0.5:
                sign = run.ctx.expected_sign(info.construct, crit) or 1
                return sign * values(df[col]), f"criterion:{crit}"
        if mode == "criterion":
            return None, "no criterion available"
    rest = [i for i in run.ctx.construct_indicators(info.construct, list(df.columns)) if i.id != info.id]
    if rest:
        comp, _ = composite(df, rest)
        return values(comp), "rest_composite:" + ",".join(i.id for i in rest)
    return None, "no matching variable"


def _dif(run: _Run) -> list[ResultRecord]:
    jg = run.prm.get("dif.jodoin_gierl")
    alpha = run.prm.f("dif.fdr_alpha")
    mode = str(run.p("matching", "auto"))
    out: list[ResultRecord] = []
    base = run.frame.baseline
    for grouping in _groupings(run, ["language"]):
        column = _group_column(grouping)
        if column is None or column not in base.columns:
            out.append(
                ResultRecord(
                    "battery",
                    "battery",
                    "unresolved_large_dif",
                    None,
                    None,
                    None,
                    None,
                    0,
                    "linear_dif",
                    subgroup={"grouping": grouping},
                    details={"status": "not_available", "reason": f"{grouping!r} not in snapshot"},
                )
            )
            continue
        labels = sorted({str(v) for v in base[column].dropna().unique()})
        if len(labels) < 2:
            out.append(
                ResultRecord(
                    "battery",
                    "battery",
                    "unresolved_large_dif",
                    None,
                    None,
                    None,
                    None,
                    len(base),
                    "linear_dif",
                    subgroup={"grouping": grouping},
                    details={"status": "insufficient", "reason": "fewer than two groups"},
                )
            )
            continue
        reference = str(run.params.get("reference") or labels[0])
        large_total = 0
        for focal in [lb for lb in labels if lb != reference]:
            df = base[base[column].astype(str).isin([reference, focal])]
            g = df[column].astype(str).to_numpy()
            pending: list[tuple[IndicatorInfo, dict[str, Any], str, dict[str, Any]]] = []
            for info in run.individual_indicators(df):
                theta, how = _matching(run, df, info, mode)
                y = values(df[info.column])
                if theta is None:
                    continue
                ok = np.isfinite(y) & np.isfinite(theta)
                counts = {lb: int(np.sum(ok & (g == lb))) for lb in (reference, focal)}
                if min(counts.values()) < 10 or np.nanstd(y[ok]) == 0:
                    continue
                (row,) = linear_dif(y, g, theta, items=[info.id], focal=focal, alpha=alpha)
                uniform = _uniform_shift(y[ok], theta[ok], (g[ok] == focal).astype(float))
                pending.append((info, dict(row), how, {"group_counts": counts, **uniform}))
            if not pending:
                continue
            adj, rej = benjamini_hochberg([float(r["p_combined"]) for _, r, _, _ in pending], alpha)
            large = 0
            for (info, row, how, extra), p_adj, rj in zip(pending, adj, rej, strict=True):
                d = float(row["delta_r2"])
                cls = "A" if not rj or d < float(jg["moderate"]) else ("B" if d < float(jg["large"]) else "C")
                large += int(cls == "C")
                out.append(
                    ResultRecord(
                        subject=info.id,
                        subject_kind="indicator",
                        metric="dif_delta_r2",
                        estimate=_f(d),
                        ci_low=None,
                        ci_high=None,
                        ci_level=None,
                        n=int(row["n"]),
                        method="regression_dif_nested_f_bh_fdr",
                        threshold=float(jg["large"]),
                        passed=cls != "C",
                        subgroup={"grouping": grouping, "reference": reference, "focal": focal},
                        details=_clean(
                            {
                                "status": "ok",
                                "F_combined": row["F_combined"],
                                "p_combined": row["p_combined"],
                                "p_fdr": p_adj,
                                "significant_fdr": bool(rj),
                                "class": cls,
                                "jodoin_gierl": dict(jg),
                                "matching": how,
                                **extra,
                            }
                        ),
                        exclusions={
                            "rows_available": len(df),
                            "rows_used": int(row["n"]),
                            "rows_excluded_missing": len(df) - int(row["n"]),
                        },
                    )
                )
            large_total += large
        out.append(
            ResultRecord(
                "battery",
                "battery",
                "unresolved_large_dif",
                float(large_total),
                None,
                None,
                None,
                len(base),
                "regression_dif_nested_f_bh_fdr",
                passed=large_total == 0,
                subgroup={"grouping": grouping},
                details={"status": "ok", "reference": reference, "matching_mode": mode},
            )
        )
    run.notes.append(
        "DIF matching: external convergent criterion when available (independent of module-level game DIF), "
        "else rest composite"
    )
    return out


def _uniform_shift(y: FloatArray, theta: FloatArray, focal: FloatArray) -> dict[str, Any]:
    """Uniform DIF effect: focal-group coefficient at equal matching score, in SD units of the indicator."""
    from scipy import stats  # noqa: PLC0415

    n = y.size
    xm = np.column_stack([np.ones(n), theta, focal])
    b = np.linalg.lstsq(xm, y, rcond=None)[0]
    r = y - xm @ b
    sigma2 = float(r @ r) / max(1, n - 3)
    cov = sigma2 * np.linalg.pinv(xm.T @ xm)
    se = math.sqrt(max(cov[2, 2], 0.0))
    sd = float(np.std(y, ddof=1)) or 1.0
    tq = float(stats.t.ppf(0.975, max(1, n - 3)))
    return {
        "uniform_shift_sd": float(b[2]) / sd,
        "uniform_shift_sd_ci": [(float(b[2]) - tq * se) / sd, (float(b[2]) + tq * se) / sd],
    }


# ---------------------------------------------------------------- fairness


def _fairness(run: _Run) -> list[ResultRecord]:
    base = run.frame.baseline
    min_n = int(run.ctx.gates.get("quality", {}).get("fairness_cell_min_n", 30))
    diff_max = float(run.ctx.gates["battery_gate"].get("differential_exclusion_max_pp", 5.0))
    bound_d = float(run.p("tost_bound_d", run.prm.f("fairness.tost_bound_d")))
    out: list[ResultRecord] = []
    primary = [
        h for h in run.ctx.hypotheses.get("hypotheses", []) if h.get("family") == "primary" and h.get("criterion")
    ]
    for grouping in _groupings(run, ["language"]):
        column = _group_column(grouping)
        if column is None or column not in base.columns:
            out.append(
                ResultRecord(
                    "battery",
                    "battery",
                    "fairness",
                    None,
                    None,
                    None,
                    None,
                    0,
                    "fairness",
                    subgroup={"grouping": grouping},
                    details={"status": "not_available", "reason": f"{grouping!r} not in snapshot"},
                )
            )
            continue
        labels = sorted({str(v) for v in base[column].dropna().unique()})
        g_all = base[column].astype(str)
        sizes = {lb: int((g_all == lb).sum()) for lb in labels}
        reportable = [lb for lb in labels if sizes[lb] >= min_n]
        sub0 = {"grouping": grouping}
        if len(reportable) < 2:
            out.append(
                ResultRecord(
                    "battery",
                    "battery",
                    "fairness",
                    None,
                    None,
                    None,
                    None,
                    len(base),
                    "fairness",
                    subgroup=sub0,
                    details={"status": "insufficient", "group_sizes": sizes, "fairness_cell_min_n": min_n},
                )
            )
        reference = str(run.params.get("reference") or (reportable[0] if reportable else ""))
        for info in run.individual_indicators(base):
            y = values(base[info.column])
            # Missingness disparity (a form of differential exclusion at the indicator level).
            er = disparity(np.isnan(y).astype(float), g_all.to_numpy(), threshold_pp=diff_max, min_cell_n=min_n)
            out.append(
                _record(
                    er,
                    subject=info.id,
                    subject_kind="indicator",
                    metric="missing_rate_difference_pp",
                    subgroup=sub0,
                    threshold=diff_max,
                    passed=not bool(er.details.get("exceeds_threshold")),
                    rows_available=len(base),
                )
            )
            finite = y[np.isfinite(y)]
            if finite.size < 10 or float(np.std(finite)) == 0.0:
                continue  # no distribution to compare (constant or nearly empty indicator)
            for focal in [lb for lb in reportable if lb != reference]:
                a, b = y[(g_all == focal).to_numpy()], y[(g_all == reference).to_numpy()]
                tost = tost_two_sample(a, b, bound=bound_d, bound_type="d", params=run.prm)
                out.append(
                    _record(
                        tost,
                        subject=info.id,
                        subject_kind="indicator",
                        metric="mean_difference_tost",
                        subgroup={**sub0, "reference": reference, "focal": focal},
                        threshold=bound_d,
                        passed=bool(tost.details.get("equivalent")),
                        details={"bound_d": bound_d},
                        rows_available=sizes.get(focal, 0) + sizes.get(reference, 0),
                    )
                )
            if grouping == "language" and "device_familiarity" in base.columns:
                fam = base["device_familiarity"].astype(str).to_numpy()
                ok = np.isfinite(y) & (base["device_familiarity"].notna().to_numpy())
                if ok.sum() >= 10:
                    er = device_familiarity_effect(y[ok], fam[ok], bound_d=bound_d, params=run.prm)
                    out.append(
                        _record(
                            er,
                            subject=info.id,
                            subject_kind="indicator",
                            metric="device_familiarity_eta2",
                            subgroup={"grouping": "device_familiarity"},
                            rows_available=len(base),
                        )
                    )
        # Cleary differential prediction and calibration for the primary convergent pairs.
        for h in primary:
            crit_col = CRITERION_PREFIX + str(h["criterion"])
            inds = [
                run.ctx.indicators[i]
                for i in h.get("indicators", [])
                if i in run.ctx.indicators and run.ctx.indicators[i].column in base.columns
            ]
            if crit_col not in base.columns or not inds:
                continue
            comp, _ = composite(base, inds)
            x, y = values(comp), values(base[crit_col])
            for focal in [lb for lb in reportable if lb != reference]:
                mask = g_all.isin([reference, focal]).to_numpy()
                er = differential_prediction(y[mask], x[mask], g_all.to_numpy()[mask], focal=focal)
                out.append(
                    _record(
                        er,
                        subject=f"{h['construct']}~{h['criterion']}",
                        subject_kind="hypothesis",
                        metric="slope_difference",
                        subgroup={**sub0, "reference": reference, "focal": focal},
                        hypothesis_id=str(h["id"]),
                        passed=er.details.get("conclusion") == "no_differential_prediction",
                        rows_available=int(mask.sum()),
                    )
                )
            ok = np.isfinite(x) & np.isfinite(y)
            if ok.sum() >= 10:
                slope, intercept = np.polyfit(x[ok], y[ok], 1)
                pred = np.where(np.isfinite(x), intercept + slope * x, np.nan)
                for label, er in calibration_by_group(y, pred, g_all.to_numpy(), min_n=min_n).items():
                    out.append(
                        _record(
                            er,
                            subject=f"{h['construct']}~{h['criterion']}",
                            subject_kind="hypothesis",
                            metric="calibration_slope",
                            subgroup={**sub0, column: label},
                            hypothesis_id=str(h["id"]),
                            threshold=1.0,
                            rows_available=sizes.get(label, 0),
                        )
                    )
    # Differential exclusion across languages from the snapshot manifest (battery gate A3).
    out += _differential_exclusion(run, diff_max, min_n)
    return out


def _differential_exclusion(run: _Run, diff_max: float, min_n: int) -> list[ResultRecord]:
    excl = run.ctx.snapshot_exclusions
    by_lang = excl.get("by_reason_language") or {}
    base = run.frame.all_rows
    if "language" not in base.columns:
        return []
    included = {str(k): int(v) for k, v in base["language"].astype(str).value_counts().items()}
    excluded: dict[str, int] = {}
    for reason, counts in by_lang.items():
        if reason in ("synthetic", "other_pathway"):
            continue  # design exclusions, not quality exclusions
        for lang, k in dict(counts).items():
            excluded[str(lang)] = excluded.get(str(lang), 0) + int(k)
    langs = sorted(set(included) | {k for k in excluded if k not in ("None", "nan")})
    rates = {}
    for lang in langs:
        tot = included.get(lang, 0) + excluded.get(lang, 0)
        if tot >= min_n:
            rates[lang] = excluded.get(lang, 0) / tot
    if len(rates) < 2:
        return [
            ResultRecord(
                "battery",
                "battery",
                "differential_exclusion_pp",
                None,
                None,
                None,
                None,
                sum(included.values()),
                "manifest_exclusion_rates",
                subgroup={"grouping": "language"},
                threshold=diff_max,
                details={"status": "insufficient", "included": included, "excluded": excluded},
            )
        ]
    diff = (max(rates.values()) - min(rates.values())) * 100
    return [
        ResultRecord(
            "battery",
            "battery",
            "differential_exclusion_pp",
            diff,
            None,
            None,
            None,
            sum(included.values()),
            "manifest_exclusion_rates",
            threshold=diff_max,
            passed=diff <= diff_max,
            subgroup={"grouping": "language"},
            details=_clean({"status": "ok", "rates": rates, "included": included, "excluded": excluded}),
        )
    ]


# ---------------------------------------------------------------- predictive / incremental validity


def _instrument_family(column: str) -> str:
    """Instrument of a ``crit__<instrument>.<scale>`` column, with short forms mapped to their source
    (``criterion.shared_items`` in the scoring parameters, e.g. BFI-2-XS items are BFI-2-S items)."""
    from shriii_scoring.params import load_params  # noqa: PLC0415

    instrument = column[len(CRITERION_PREFIX) :].split(".", 1)[0]
    for shared in load_params().get("criterion.shared_items"):
        if str(shared["instrument"]) == instrument:
            return str(shared["source"])
    return instrument


def _default_criterion(run: _Run, columns: Sequence[str]) -> str | None:
    for h in run.ctx.hypotheses.get("hypotheses", []):
        if h.get("family") == "primary" and h.get("criterion") and CRITERION_PREFIX + str(h["criterion"]) in columns:
            return CRITERION_PREFIX + str(h["criterion"])
    return None


def _incremental_validity(run: _Run) -> list[ResultRecord]:
    base = run.frame.baseline
    cols = list(base.columns)
    outcome = run.params.get("outcome")
    criterion = run.params.get("criterion") or _default_criterion(run, cols)
    min_feat_cov = float(run.p("min_feature_coverage", 0.5))
    game = list(
        run.params.get("game_features")
        or [
            i.column
            for i in run.individual_indicators(base)
            if i.gate_eligible and coverage(base, i.column) >= min_feat_cov
        ]
    )
    # Default battery: other instruments only. Scales of the target's own instrument (subscales of a total,
    # or a short form sharing its items) would predict it by construction.
    target_families = {_instrument_family(c) for c in (outcome, criterion) if c}
    battery = list(
        run.params.get("battery_features")
        or [
            c
            for c in run.frame.criterion_columns
            if c not in (outcome, criterion)
            and _instrument_family(c) not in target_families
            and coverage(base, c) >= run.min_coverage
        ]
    )
    for name, col in (("outcome", outcome), ("criterion", criterion)):
        if col is not None and col not in cols:
            raise KeyError(f"{name} column {col!r} is not in the snapshot")
    leak = {outcome, criterion} & set(game + battery)
    if leak - {None}:
        raise ValueError(f"target columns cannot be features (leakage): {sorted(str(x) for x in leak - {None})}")
    requested = [str(m) for m in run.p("models", ("ridge", "elastic_net", "random_forest", "xgboost"))]
    unknown = sorted(set(requested) - set(MODEL_NAMES))
    if unknown or not requested:
        raise ValueError(f"unsupported models {unknown}; expected a non-empty subset of {list(MODEL_NAMES)}")
    models = tuple(cast(ModelName, m) for m in requested)
    n_boot = int(run.p("n_boot", run.prm.i("prediction.bootstrap_resamples")))
    data: dict[str, Any] = {"research_id": base["research_id"].astype(str).to_numpy()}
    for c in {*game, *battery, *(x for x in (outcome, criterion) if x)}:
        data[c] = values(base[c])
    res = predictive_comparisons(
        data,
        participant="research_id",
        game_features=game,
        battery_features=battery,
        criterion=criterion,
        outcome=outcome,
        models=models,
        seed=run.seed,
        n_boot=n_boot,
        params=run.prm,
    )
    out: list[ResultRecord] = []
    targets = {
        "criterion_from_game": criterion,
        "outcome_from_battery": outcome,
        "outcome_from_game": outcome,
        "outcome_from_game_and_battery": outcome,
    }
    feats = {
        "criterion_from_game": game,
        "outcome_from_battery": battery,
        "outcome_from_game": game,
        "outcome_from_game_and_battery": [*game, *battery],
    }
    for key, value in res.items():
        if key == "incremental_cv_r2":
            assert isinstance(value, EvidenceResult)
            out.append(
                _record(
                    value,
                    subject="game_plus_battery_vs_battery",
                    subject_kind="comparison",
                    metric="incremental_cv_r2",
                    details={"outcome": outcome},
                    rows_available=len(base),
                )
            )
            continue
        if isinstance(value, EvidenceResult):
            out.append(
                _record(
                    value, subject=key, subject_kind="comparison", metric="cv_r2", details={"target": targets.get(key)}
                )
            )
            continue
        for model, rep in value.items():
            out.append(_cv_record(rep, key, model, targets[key], len(base), primary=model == models[0]))
    # Hierarchical delta R^2 (battery block, then game block) on complete cases, participant-clustered CI.
    if outcome and game and battery:
        hr = hierarchical_regression(
            values(base[outcome]),
            [base[battery].to_numpy(dtype=float), base[game].to_numpy(dtype=float)],
            base["research_id"].astype(str).to_numpy(),
            names=["battery", "game"],
            n_boot=n_boot,
            seed=run.seed,
            params=run.prm,
        )
        for er in hr:
            out.append(
                _record(
                    er,
                    subject=f"block:{er.details.get('block', 'all')}",
                    subject_kind="comparison",
                    metric="delta_r2",
                    details={"outcome": outcome},
                    rows_available=len(base),
                )
            )
    out += _holdout(run, feats, targets, models[0], n_boot)
    return out


def _cv_record(
    rep: PredictionReport, key: str, model: str, target: str | None, rows: int, *, primary: bool
) -> ResultRecord:
    details = {
        "target": target,
        "model": model,
        "primary_model": primary,
        "features": list(rep.features),
        "n_groups": rep.n_groups,
        "mae": {
            "estimate": _f(rep.cv_mae.estimate),
            "ci_low": _f(rep.cv_mae.ci_low),
            "ci_high": _f(rep.cv_mae.ci_high),
        },
        "rmse": {
            "estimate": _f(rep.cv_rmse.estimate),
            "ci_low": _f(rep.cv_rmse.ci_low),
            "ci_high": _f(rep.cv_rmse.ci_high),
        },
        "fold_metrics": rep.fold_metrics,
        "best_params": rep.best_params,
        "grouping": "research_id (participant)",
    }
    return _record(
        rep.cv_r2,
        subject=key,
        subject_kind="comparison",
        metric="cv_r2",
        subgroup={"model": model},
        details=details,
        rows_available=rows,
    )


def _holdout(
    run: _Run, feats: Mapping[str, Sequence[str]], targets: Mapping[str, str | None], model: ModelName, n_boot: int
) -> list[ResultRecord]:
    hold = run.frame.holdout
    if run.frame.occasion is not None and "occasion_id" in hold.columns:
        hold = hold[hold["occasion_id"].astype(str) == run.frame.occasion]
    if len(hold) < 3:
        run.notes.append(f"no holdout evaluation: {len(hold)} holdout rows")
        return []
    base = run.frame.baseline
    out: list[ResultRecord] = []
    for key, target in targets.items():
        f = list(feats[key])
        if target is None or not f or target not in hold.columns or any(c not in hold.columns for c in f):
            continue
        y = values(base[target])
        ok = np.isfinite(y)
        if ok.sum() < run.prm.i("prediction.min_n"):
            continue
        est, best = fit_final_model(
            base[f].to_numpy(dtype=float)[ok],
            y[ok],
            base["research_id"].astype(str).to_numpy()[ok],
            model=model,
            seed=run.seed,
            params=run.prm,
        )
        metrics, _ = holdout_metrics(
            est,
            hold[f].to_numpy(dtype=float),
            values(hold[target]),
            hold["research_id"].astype(str).to_numpy(),
            train_groups=base["research_id"].astype(str).to_numpy()[ok],
            n_boot=n_boot,
            seed=run.seed,
            params=run.prm,
        )
        er = metrics["r2"]
        out.append(
            _record(
                er,
                subject=key,
                subject_kind="comparison",
                metric="holdout_r2",
                subgroup={"model": model, "split": "holdout"},
                details={
                    "target": target,
                    "best_params": best,
                    "mae": _f(metrics["mae"].estimate),
                    "rmse": _f(metrics["rmse"].estimate),
                },
                rows_available=len(hold),
            )
        )
    return out


# ---------------------------------------------------------------- entry point


_DISPATCH: dict[str, Callable[[_Run], list[ResultRecord]]] = {
    "descriptives": _descriptives,
    "reliability": _reliability,
    "construct_validity": _construct_validity,
    "mtmm": _mtmm,
    "factor_structure": _factor_structure,
    "measurement_invariance": _measurement_invariance,
    "dif": _dif,
    "fairness": _fairness,
    "incremental_validity": _incremental_validity,
}


def run_analysis(
    analysis: str,
    frame: pd.DataFrame,
    *,
    params: Mapping[str, Any] | None = None,
    context: Mapping[str, Any] | None = None,
) -> AnalysisReport:
    """Run one analysis on a snapshot frame (see the module docstring for the analyses and conventions).

    ``params`` are analysis options (``ci_level``, ``occasion``/``occasions``, ``groupings``, ``reference``,
    ``outcome``, ``criterion``, ``models``, ``n_boot``, ``min_coverage``, ``seed``, ...). ``context`` carries the
    dictionary, ``gates``, ``hypotheses``, the confirmatory ``hypothesis_ids``, ``snapshot_exclusions`` and
    ``provenance``; missing entries are read from the versioned repository files.
    """
    name = canonical_analysis(analysis)
    prm_doc = load_validation_params()
    p = dict(params or {})
    ctx = resolve_context(context)
    prepared = prepare_frame(frame, ctx, p)
    run = _Run(ctx=ctx, prm=prm_doc, params=p, frame=prepared, seed=int(p.get("seed", 0)))
    results = _DISPATCH[name](run) if len(prepared.all_rows) or name == "descriptives" else []
    if not len(prepared.all_rows):
        run.notes.append("snapshot has no analysable rows")
    provenance: dict[str, Any] = {
        "analysis": name,
        "engine": ENGINE,
        "algorithm_version": VALIDATION_ALGORITHM_VERSION,
        "computed_at": datetime.now(UTC).isoformat(),
        "frame_sha256": frame_sha256(frame),
        "params": _clean(p),
        "validation_params_sha256": prm_doc.sha256,
        "library_versions": dict(_versions()),
        "context_sources": dict(ctx.sources),
        "gates_version": str(ctx.gates.get("version")),
        "hypotheses_version": str(ctx.hypotheses.get("version")),
        **_clean(dict(ctx.provenance)),
    }
    shared_prov: dict[str, Any] = {
        **_clean(dict(ctx.provenance)),
        **{k: provenance[k] for k in ("analysis", "algorithm_version", "frame_sha256")},
    }
    for r in results:
        r.provenance = {**shared_prov, **r.provenance}
    return AnalysisReport(name, ENGINE, results, _clean(prepared.exclusions), provenance, run.notes)
