"""Thin adapter over the ``shriii_validation`` entry points (layer 4 evidence).

* :func:`run_analysis` -> ``shriii_validation.run_analysis(analysis, frame, params=..., context=...)``
* :func:`train_model` -> ``shriii_validation.train_model(frame, features=..., target=..., ...)``
* :func:`generate_norms` -> ``shriii_validation.generate_norms(frame, indicator_ids=..., ...)``

There is no reference fallback: when the engine is not importable every call raises
:class:`AdapterUnavailableError` (code ``adapter_unavailable``) and the job fails permanently, so no
unvalidated number is ever persisted. Thresholds are read by the engine from
``stats/measurement-model/gates.yaml``, which the worker passes in the context together with the dictionary
and ``hypotheses.yaml``.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from types import ModuleType
from typing import Any

import pandas as pd

from shriii_api.adapters.scoring import AdapterUnavailableError

ADAPTER_UNAVAILABLE = "adapter_unavailable"
STATIC_ANALYSES: tuple[str, ...] = (
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
    exclusions: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class AnalysisOutput:
    results: list[ResultRow]
    engine: str
    notes: list[str] = field(default_factory=list)
    exclusions: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ModelOutput:
    engine: str
    cv_metrics: dict[str, dict[str, float | None]]
    holdout_metrics: dict[str, float | None]
    predictions: list[dict[str, Any]]
    n_train: int
    n_holdout: int
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class NormOutput:
    engine: str
    cut_points: list[float]
    sem: float
    effective_n: int
    method: str
    details: dict[str, Any]
    provisional: bool = True


def _engine() -> ModuleType:
    try:
        return importlib.import_module("shriii_validation")
    except ImportError as exc:
        raise AdapterUnavailableError(f"{ADAPTER_UNAVAILABLE}: shriii_validation is not installed ({exc})") from exc


def _entry(name: str) -> Callable[..., Any]:
    fn = getattr(_engine(), name, None)
    if not callable(fn):
        raise AdapterUnavailableError(f"{ADAPTER_UNAVAILABLE}: shriii_validation has no entry point {name!r}")
    return fn  # type: ignore[no-any-return]


def engine_version() -> str:
    """``shriii_validation-<algorithm version>`` (or ``unavailable``)."""
    try:
        return str(_engine().ENGINE)
    except (AdapterUnavailableError, AttributeError):
        return "unavailable"


def analyses() -> tuple[str, ...]:
    """Analyses the engine supports (the static list when the engine cannot be imported)."""
    try:
        return tuple(str(a) for a in _engine().ANALYSES)
    except (AdapterUnavailableError, AttributeError):
        return STATIC_ANALYSES


def _row(r: Any) -> ResultRow:
    data = r.to_dict() if hasattr(r, "to_dict") else dict(r)
    names = set(ResultRow.__dataclass_fields__)
    return ResultRow(**{k: v for k, v in data.items() if k in names})


def run_analysis(
    analysis: str,
    frame: pd.DataFrame,
    *,
    params: Mapping[str, Any],
    context: Mapping[str, Any],
) -> AnalysisOutput:
    """Run one analysis on a snapshot frame with the validation engine."""
    report = _entry("run_analysis")(analysis, frame, params=dict(params), context=dict(context))
    return AnalysisOutput(
        results=[_row(r) for r in report.results],
        engine=str(report.engine),
        notes=list(report.notes),
        exclusions=dict(report.exclusions),
        provenance=dict(report.provenance),
    )


def train_model(
    frame: pd.DataFrame,
    *,
    features: Sequence[str],
    target: str,
    algorithm: str,
    params: Mapping[str, Any],
    holdout_cohort: str | None,
) -> ModelOutput:
    """Participant-grouped nested CV (no leakage) plus an untouched holdout cohort when given."""
    out = _entry("train_model")(
        frame,
        features=list(features),
        target=target,
        algorithm=algorithm,
        params=dict(params),
        holdout_cohort=holdout_cohort,
    )
    return ModelOutput(**dict(out))


def generate_norms(
    frame: pd.DataFrame,
    *,
    indicator_ids: Sequence[str],
    directions: Mapping[str, str],
    reliability: float,
    quantiles: Sequence[float],
    ci_level: float,
    gates: Mapping[str, Any],
    trait: str,
    norm_table_version: str,
    weights: str | None = None,
) -> NormOutput:
    """Provisional norms (composite, weighted cut-points, SEM, effective n, cells)."""
    out = _entry("generate_norms")(
        frame,
        indicator_ids=list(indicator_ids),
        directions=dict(directions),
        reliability=reliability,
        quantiles=list(quantiles),
        ci_level=ci_level,
        weights=weights,
        trait=trait,
        norm_table_version=norm_table_version,
        gates=dict(gates),
    )
    return NormOutput(**dict(out))


def evaluate_gates(rows: Sequence[Mapping[str, Any]], **kwargs: Any) -> dict[str, Any]:
    """Trait and battery gate evaluation from persisted results (evaluate-only unless told otherwise)."""
    out = _entry("evaluate_gates")(list(rows), **kwargs)
    return dict(out)
