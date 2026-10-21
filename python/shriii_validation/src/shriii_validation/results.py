"""Typed results for layer 4 evidence: estimate, CI, n, method, assumptions/warnings and provenance.

Every analysis returns an :class:`EvidenceResult` (or a mapping of them). Results never hide failures: an
analysis that cannot run returns ``status="insufficient"`` or ``"not_available"`` with a message; it
never returns a number that could be mistaken for evidence.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from functools import cache
from importlib import metadata
from typing import Any, Literal

import numpy as np

from shriii_validation._version import VALIDATION_ALGORITHM_VERSION

__all__ = [
    "AssumptionCheck",
    "EvidenceResult",
    "Provenance",
    "Status",
    "hash_inputs",
    "make_provenance",
]

Status = Literal["ok", "insufficient", "not_available", "failed"]
_LIBS = ("numpy", "scipy", "pandas", "statsmodels", "scikit-learn", "xgboost", "semopy", "factor_analyzer", "pingouin")


@dataclass(frozen=True, slots=True)
class AssumptionCheck:
    """One assumption check: what was tested, the statistic, and whether it held."""

    name: str
    passed: bool
    statistic: float | None = None
    detail: str = ""


@dataclass(frozen=True, slots=True)
class Provenance:
    """How a result was produced (inputs hash, algorithm and library versions, seed, parameters)."""

    analysis: str
    algorithm_version: str
    computed_at: str
    inputs_sha256: str
    seed: int | None
    params: Mapping[str, Any]
    library_versions: Mapping[str, str | None]


@dataclass(frozen=True, slots=True)
class EvidenceResult:
    """A single evidence estimate (reliability, correlation, effect, fit index, ...)."""

    analysis: str
    estimate: float | None
    ci_low: float | None
    ci_high: float | None
    ci_level: float | None
    n: int
    method: str
    status: Status = "ok"
    assumptions: tuple[AssumptionCheck, ...] = ()
    warnings: tuple[str, ...] = ()
    details: Mapping[str, Any] = field(default_factory=dict)
    provenance: Provenance | None = None

    @property
    def ok(self) -> bool:
        return self.status == "ok" and self.estimate is not None and math.isfinite(self.estimate)

    @property
    def est(self) -> float:
        """The estimate as a float (raises when the result carries none)."""
        if self.estimate is None:
            raise ValueError(f"{self.analysis}: no estimate ({self.status}: {'; '.join(self.warnings)})")
        return float(self.estimate)

    @property
    def lo(self) -> float:
        """Lower CI bound as a float (raises when missing)."""
        if self.ci_low is None:
            raise ValueError(f"{self.analysis}: no CI")
        return float(self.ci_low)

    @property
    def hi(self) -> float:
        """Upper CI bound as a float (raises when missing)."""
        if self.ci_high is None:
            raise ValueError(f"{self.analysis}: no CI")
        return float(self.ci_high)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        out: dict[str, Any] = json.loads(json.dumps(d, default=_json_default))
        return out

    @staticmethod
    def unavailable(
        analysis: str,
        method: str,
        message: str,
        *,
        n: int = 0,
        status: Status = "not_available",
        provenance: Provenance | None = None,
    ) -> EvidenceResult:
        """A result that carries no estimate, only the reason."""
        return EvidenceResult(
            analysis=analysis,
            estimate=None,
            ci_low=None,
            ci_high=None,
            ci_level=None,
            n=n,
            method=method,
            status=status,
            warnings=(message,),
            provenance=provenance,
        )


def _json_default(o: Any) -> Any:
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    return str(o)


def hash_inputs(*arrays: Any) -> str:
    """SHA-256 over the numeric content of the inputs (row order included)."""
    h = hashlib.sha256()
    for a in arrays:
        if a is None:
            h.update(b"none")
            continue
        try:
            arr = np.asarray(a, dtype=float)
            h.update(np.ascontiguousarray(np.nan_to_num(arr, nan=-9.87654321e300)).tobytes())
            h.update(str(arr.shape).encode())
        except (TypeError, ValueError):
            h.update(json.dumps(a, sort_keys=True, default=str).encode())
    return h.hexdigest()


@cache
def _versions() -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for lib in _LIBS:
        try:
            out[lib] = metadata.version(lib)
        except metadata.PackageNotFoundError:
            out[lib] = None
    return out


def make_provenance(
    analysis: str, *inputs: Any, seed: int | None = None, params: Mapping[str, Any] | None = None
) -> Provenance:
    """Build a :class:`Provenance` record for an analysis."""
    return Provenance(
        analysis=analysis,
        algorithm_version=VALIDATION_ALGORITHM_VERSION,
        computed_at=datetime.now(UTC).isoformat(),
        inputs_sha256=hash_inputs(*inputs),
        seed=seed,
        params=dict(params or {}),
        library_versions=dict(_versions()),
    )


def finite(values: Sequence[float] | np.ndarray) -> np.ndarray:
    """Float array with NaN/inf removed."""
    arr = np.asarray(values, dtype=float)
    return arr[np.isfinite(arr)]
