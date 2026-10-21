"""Formula registry: every dictionary ``formula.ref`` resolves to exactly one tested function.

Three formula kinds:

* ``session`` - pure function of one session's selected, eligible trials -> :class:`IndicatorValue`;
* ``batch``   - model-based person estimates fitted across all sessions of a partition (random slopes,
  empirical-Bayes discounting, location-scale) -> {session_id: IndicatorValue};
* ``group``   - group-level estimators (private reports) that never produce individual values.
"""

from __future__ import annotations

import math
import zlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np

from shriii_scoring.canonical import SessionRecord, Trial
from shriii_scoring.dictionary import Dictionary, IndicatorSpec
from shriii_scoring.params import ScoringParams

__all__ = [
    "REGISTRY",
    "BatchContext",
    "BatchUnit",
    "FormulaContext",
    "FormulaDef",
    "GroupValue",
    "IndicatorValue",
    "MissingTrialParamsError",
    "batch_formula",
    "group_formula",
    "latency",
    "median",
    "need_params",
    "rng_for",
    "session_formula",
]

FormulaKind = Literal["session", "batch", "group"]


class MissingTrialParamsError(RuntimeError):
    """Raised when solver / scheduler output (``GameTrialSpec.params``) needed by a formula is missing."""


@dataclass(frozen=True, slots=True)
class IndicatorValue:
    """Result of a formula for one session (``value`` in the dictionary unit, before transformation)."""

    value: float | None
    n_valid: int
    se: float | None = None
    flags: tuple[str, ...] = ()
    details: Mapping[str, Any] = field(default_factory=dict)
    status: str | None = None

    @staticmethod
    def empty(n_valid: int = 0, *flags: str, status: str | None = None) -> IndicatorValue:
        return IndicatorValue(value=None, n_valid=n_valid, flags=tuple(flags), status=status)


@dataclass(frozen=True, slots=True)
class GroupValue:
    """A group-level estimate (never joinable to individuals)."""

    estimate: float | None
    ci_low: float | None
    ci_high: float | None
    n_participants: int
    n_reports: int
    details: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class FormulaContext:
    """Inputs available to a session formula."""

    spec: IndicatorSpec
    session: SessionRecord
    dictionary: Dictionary
    params: ScoringParams
    game_configs: Mapping[str, Mapping[str, Any]]
    anticipatory_ms: float


@dataclass(frozen=True, slots=True)
class BatchUnit:
    """One session's eligible trials for a batch formula."""

    session: SessionRecord
    trials: Sequence[Trial]


@dataclass(slots=True)
class BatchContext:
    """Inputs available to batch / group formulas for one partition."""

    spec: IndicatorSpec
    dictionary: Dictionary
    params: ScoringParams
    game_configs: Mapping[str, Mapping[str, Any]]
    anticipatory_ms: float
    partition: Mapping[str, Any]
    cache: dict[str, Any]
    partition_details: dict[str, Any] = field(default_factory=dict)


SessionFn = Callable[[Sequence[Trial], FormulaContext], IndicatorValue]
BatchFn = Callable[[Sequence[BatchUnit], BatchContext], dict[str, IndicatorValue]]
GroupFn = Callable[[Sequence[BatchUnit], BatchContext], GroupValue]


@dataclass(frozen=True, slots=True)
class FormulaDef:
    ref: str
    kind: FormulaKind
    fn: Callable[..., Any]
    doc: str


REGISTRY: dict[str, FormulaDef] = {}


def _register(ref: str, kind: FormulaKind, fn: Callable[..., Any]) -> None:
    if ref in REGISTRY:
        raise ValueError(f"formula {ref!r} registered twice")
    REGISTRY[ref] = FormulaDef(ref=ref, kind=kind, fn=fn, doc=(fn.__doc__ or "").strip())


def session_formula(*refs: str) -> Callable[[SessionFn], SessionFn]:
    def deco(fn: SessionFn) -> SessionFn:
        for r in refs:
            _register(r, "session", fn)
        return fn

    return deco


def batch_formula(*refs: str) -> Callable[[BatchFn], BatchFn]:
    def deco(fn: BatchFn) -> BatchFn:
        for r in refs:
            _register(r, "batch", fn)
        return fn

    return deco


def group_formula(*refs: str) -> Callable[[GroupFn], GroupFn]:
    def deco(fn: GroupFn) -> GroupFn:
        for r in refs:
            _register(r, "group", fn)
        return fn

    return deco


# ---------------------------------------------------------------- shared helpers


def latency(t: Trial) -> float | None:
    """Committed response latency in ms (None for timeouts, missing or negative barge-in latencies)."""
    r = t.response
    if not t.latency_valid or r is None or r.input_mode == "timeout" or r.latency_ms is None or r.latency_ms < 0:
        return None
    return r.latency_ms


def median(values: Sequence[float]) -> float | None:
    return float(np.median(values)) if values else None


def need_params(t: Trial, *keys: str) -> Mapping[str, Any]:
    """Return ``t.params`` after checking the solver/scheduler keys exist (SCR-05: fail fast)."""
    missing = [k for k in keys if k not in t.params]
    if missing:
        raise MissingTrialParamsError(
            f"session {t.session_id} trial {t.trial_id} ({t.trial_type}) is missing GameTrialSpec.params {missing}"
        )
    return t.params


def rng_for(*parts: str) -> np.random.Generator:
    """Deterministic RNG seeded from identifiers (for within-session bootstrap SEs)."""
    seed = zlib.crc32("|".join(parts).encode("utf-8"))
    return np.random.default_rng(seed)


def safe_mean(values: Sequence[float]) -> float | None:
    vals = [v for v in values if v is not None and not math.isnan(v)]
    return float(np.mean(vals)) if vals else None
