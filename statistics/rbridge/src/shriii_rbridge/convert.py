"""Conversions between Python inputs, shriiipsy requests and :class:`EvidenceResult` objects."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from shriii_validation.results import AssumptionCheck, EvidenceResult, Provenance, Status

from shriii_rbridge._version import RESULT_SCHEMA

__all__ = ["as_dataframe", "result_from_json", "write_parquet"]

_STATUSES: frozenset[str] = frozenset({"ok", "insufficient", "not_available", "failed"})


def as_dataframe(data: Any, columns: Sequence[str] | None = None) -> pd.DataFrame:
    """Coerce a pandas / polars frame, a mapping of columns or a 2-D array into a pandas DataFrame."""
    if isinstance(data, pd.DataFrame):
        df = data.copy()
    elif hasattr(data, "to_pandas") and callable(data.to_pandas):  # polars / pyarrow tables
        df = data.to_pandas()
    elif isinstance(data, Mapping):
        df = pd.DataFrame({str(k): v if isinstance(v, np.ndarray) else list(v) for k, v in data.items()})
    else:
        arr = np.asarray(data)
        if arr.ndim != 2:
            raise ValueError("data must be a DataFrame, a mapping of columns or a 2-D array")
        names = list(columns) if columns is not None else [f"V{i + 1}" for i in range(arr.shape[1])]
        if len(names) != arr.shape[1]:
            raise ValueError("number of column names does not match the array width")
        return pd.DataFrame(arr, columns=[str(c) for c in names])
    df.columns = [str(c) for c in df.columns]
    if columns is not None:
        missing = [c for c in columns if c not in df.columns]
        if missing:
            raise KeyError(f"columns not found: {missing}")
        df = df[list(columns)]
    return df.reset_index(drop=True)


def write_parquet(df: pd.DataFrame, path: Path) -> Path:
    """Write ``df`` as Parquet that nanoparquet (R) reads: categoricals and objects become strings."""
    out = df.copy()
    for col in out.columns:
        s = out[col]
        if isinstance(s.dtype, pd.CategoricalDtype):
            out[col] = s.astype(str).where(s.notna(), None)
        elif s.dtype == object:
            out[col] = s.map(lambda v: None if v is None or (isinstance(v, float) and math.isnan(v)) else str(v))
        elif pd.api.types.is_bool_dtype(s):
            out[col] = s.astype("int64")
    out.to_parquet(path, engine="pyarrow", index=False)
    return path


def _finite_or_none(v: Any) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _assumptions(raw: Any) -> tuple[AssumptionCheck, ...]:
    if not isinstance(raw, list):
        return ()
    out = []
    for a in raw:
        if isinstance(a, Mapping):
            out.append(
                AssumptionCheck(
                    name=str(a.get("name", "")),
                    passed=bool(a.get("passed", False)),
                    statistic=_finite_or_none(a.get("statistic")),
                    detail=str(a.get("detail", "")),
                )
            )
    return tuple(out)


def _provenance(raw: Any) -> Provenance | None:
    if not isinstance(raw, Mapping):
        return None
    seed = raw.get("seed")
    params = raw.get("params")
    libs = raw.get("library_versions")
    return Provenance(
        analysis=str(raw.get("analysis", "")),
        algorithm_version=str(raw.get("algorithm_version", "")),
        computed_at=str(raw.get("computed_at", "")),
        inputs_sha256=str(raw.get("inputs_sha256") or ""),
        seed=int(seed) if isinstance(seed, (int, float)) else None,
        params=dict(params) if isinstance(params, Mapping) else {},
        library_versions={str(k): (None if v is None else str(v)) for k, v in libs.items()}
        if isinstance(libs, Mapping)
        else {},
    )


def result_from_json(raw: Mapping[str, Any], *, extra_details: Mapping[str, Any] | None = None) -> EvidenceResult:
    """Build an :class:`EvidenceResult` from a shriiipsy response (fail closed on schema mismatch)."""
    schema = raw.get("schema")
    if schema != RESULT_SCHEMA:
        return EvidenceResult.unavailable(
            str(raw.get("analysis", "unknown")),
            "shriiipsy",
            f"unexpected shriiipsy result schema {schema!r} (expected {RESULT_SCHEMA})",
            status="failed",
        )
    status_raw = str(raw.get("status", "failed"))
    status: Status = status_raw if status_raw in _STATUSES else "failed"  # type: ignore[assignment]
    details_raw = raw.get("details")
    details: dict[str, Any] = dict(details_raw) if isinstance(details_raw, Mapping) else {}
    if extra_details:
        details.update(extra_details)
    warnings_raw = raw.get("warnings") or []
    warnings = tuple(str(w) for w in (warnings_raw if isinstance(warnings_raw, list) else [warnings_raw]))
    n_raw = raw.get("n")
    estimate = _finite_or_none(raw.get("estimate"))
    if status == "ok" and estimate is None:
        status = "failed"
        warnings = (*warnings, "R backend reported ok without a finite estimate")
    return EvidenceResult(
        analysis=str(raw.get("analysis", "unknown")),
        estimate=estimate,
        ci_low=_finite_or_none(raw.get("ci_low")),
        ci_high=_finite_or_none(raw.get("ci_high")),
        ci_level=_finite_or_none(raw.get("ci_level")),
        n=int(n_raw) if isinstance(n_raw, (int, float)) else 0,
        method=str(raw.get("method", "")),
        status=status,
        assumptions=_assumptions(raw.get("assumptions")),
        warnings=warnings,
        details=details,
        provenance=_provenance(raw.get("provenance")),
    )
