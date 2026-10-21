"""Adapter boundary for analyses that need R (lavaan/semTools, mirt, cNORM/GAMLSS).

R is not installed on the development machine (BUILD_DECISIONS: Python now, R later). Every method of the
:class:`RBackend` protocol has a Python-side contract; :class:`UnavailableRBackend` returns explicit
``not_available`` results with an actionable message, never silent fallbacks. A future ``RscriptBackend``
implements the same protocol through Dagster Pipes / Rscript.
"""

from __future__ import annotations

import shutil
from collections.abc import Mapping, Sequence
from typing import Any, Protocol, runtime_checkable

from shriii_validation.results import EvidenceResult

__all__ = ["RBackend", "UnavailableRBackend", "default_backend", "r_available"]


def r_available() -> bool:
    """True when an ``Rscript`` executable is on PATH."""
    return shutil.which("Rscript") is not None


@runtime_checkable
class RBackend(Protocol):
    """Analyses delegated to R packages."""

    name: str

    def invariance_lavaan(
        self, data: Any, model: str, group: str, *, estimator: str, ordered: Sequence[str], partial: Mapping[str, Any]
    ) -> EvidenceResult: ...

    def irt_dif_mirt(self, responses: Any, group: Sequence[str], *, anchors: Sequence[str]) -> EvidenceResult: ...

    def continuous_norms(self, scores: Any, age: Any, *, weights: Any, method: str) -> EvidenceResult: ...

    def bayesian_approximate_invariance(self, data: Any, model: str, group: str) -> EvidenceResult: ...


class UnavailableRBackend:
    """Backend used when R is missing: every call returns ``not_available`` with the reason."""

    name = "unavailable"

    def __init__(self, reason: str | None = None) -> None:
        self.reason = reason or (
            "R is not installed; this analysis needs the R backend (lavaan/semTools, mirt or cNORM/GAMLSS). "
            "Install R with the pinned renv library (VAL-01) and use an RscriptBackend."
        )

    def _na(self, analysis: str, method: str) -> EvidenceResult:
        return EvidenceResult.unavailable(analysis, method, self.reason)

    def invariance_lavaan(
        self,
        data: Any,
        model: str,
        group: str,
        *,
        estimator: str = "MLR",
        ordered: Sequence[str] = (),
        partial: Mapping[str, Any] | None = None,
    ) -> EvidenceResult:
        return self._na("measurement_invariance", f"lavaan_semTools_{estimator}")

    def irt_dif_mirt(self, responses: Any, group: Sequence[str], *, anchors: Sequence[str] = ()) -> EvidenceResult:
        return self._na("irt_dif", "mirt_multipleGroup")

    def continuous_norms(self, scores: Any, age: Any, *, weights: Any = None, method: str = "cNORM") -> EvidenceResult:
        return self._na("continuous_norms", method)

    def bayesian_approximate_invariance(self, data: Any, model: str, group: str) -> EvidenceResult:
        return self._na("bayesian_approximate_invariance", "blavaan")


def default_backend() -> RBackend:
    """The configured backend (currently always :class:`UnavailableRBackend`; reports whether R exists)."""
    if r_available():
        return UnavailableRBackend("Rscript found but the RscriptBackend adapter is not configured in this build.")
    return UnavailableRBackend()
