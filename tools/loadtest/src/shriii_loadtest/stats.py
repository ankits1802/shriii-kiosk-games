"""Latency statistics (exact percentiles over all samples; no histogram bucketing error)."""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

__all__ = ["LatencySummary", "percentile", "summarise"]


def percentile(sorted_values: Sequence[float], q: float) -> float:
    """Linear-interpolated percentile (``numpy.percentile(method='linear')``) of pre-sorted values."""
    if not sorted_values:
        return math.nan
    if not 0 <= q <= 100:
        raise ValueError("q must be within 0..100")
    pos = (len(sorted_values) - 1) * q / 100.0
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return float(sorted_values[lo])
    return float(sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo))


@dataclass(frozen=True, slots=True)
class LatencySummary:
    n: int
    p50: float
    p90: float
    p95: float
    p99: float
    max: float
    mean: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "n": self.n,
            "p50_ms": round(self.p50, 1),
            "p90_ms": round(self.p90, 1),
            "p95_ms": round(self.p95, 1),
            "p99_ms": round(self.p99, 1),
            "max_ms": round(self.max, 1),
            "mean_ms": round(self.mean, 1),
        }


def summarise(latencies_ms: Iterable[float]) -> LatencySummary:
    values = sorted(latencies_ms)
    if not values:
        nan = math.nan
        return LatencySummary(0, nan, nan, nan, nan, nan, nan)
    return LatencySummary(
        n=len(values),
        p50=percentile(values, 50),
        p90=percentile(values, 90),
        p95=percentile(values, 95),
        p99=percentile(values, 99),
        max=values[-1],
        mean=sum(values) / len(values),
    )
