"""Proportions with Wilson intervals, calibration curves and operating points."""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from statistics import NormalDist
from typing import Any


def wilson(k: int, n: int, level: float = 0.95) -> tuple[float | None, float | None, float | None]:
    """Point estimate and Wilson score interval for k successes out of n."""
    if n == 0:
        return None, None, None
    z = NormalDist().inv_cdf(0.5 + level / 2)
    p = k / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return p, max(0.0, center - half), min(1.0, center + half)


def proportion(k: int, n: int, level: float = 0.95) -> dict[str, Any]:
    p, lo, hi = wilson(k, n, level)
    return {"n": n, "k": k, "p": _r6(p), "ci_low": _r6(lo), "ci_high": _r6(hi)}


def _r6(v: float | None) -> float | None:
    return None if v is None else round(v, 6)


@dataclass(frozen=True, slots=True)
class Scored:
    """One trial's outcome: engine label/score and whether a correct label exists (keyword trial)."""

    label: str | None
    score: float | None
    truth: str | None  # None for keyword-free trials

    def accepted(self, threshold: float) -> bool:
        return self.label is not None and self.score is not None and self.score >= threshold

    def correct(self, threshold: float) -> bool:
        return self.accepted(threshold) and self.label == self.truth


def calibration(trials: Iterable[Scored]) -> list[dict[str, Any]]:
    """Precision and recall of accepted labels at each distinct score threshold (ascending)."""
    items = list(trials)
    n_kw = sum(1 for t in items if t.truth is not None)
    thresholds = sorted({t.score for t in items if t.label is not None and t.score is not None})
    rows = []
    for thr in thresholds:
        acc = [t for t in items if t.accepted(thr)]
        correct = sum(1 for t in acc if t.label == t.truth)
        rows.append(
            {
                "threshold": round(thr, 6),
                "precision": round(correct / len(acc), 6) if acc else None,
                "recall": round(correct / n_kw, 6) if n_kw else 0.0,
                "n": len(acc),
            }
        )
    return rows


def monotone_precision(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Make precision non-decreasing in threshold, conservatively: a looser threshold never claims more
    precision than any stricter one (running minimum from the strict end), so tiers are ordered."""
    out = [dict(r) for r in rows]
    floor = 1.0
    for r in reversed(out):
        if r["precision"] is not None:
            floor = min(floor, r["precision"])
            r["precision"] = floor
    return out


def operating_threshold(rows: list[dict[str, Any]], min_precision: float, min_n: int = 1) -> float | None:
    """Lowest threshold whose (raw) precision meets ``min_precision`` with at least ``min_n`` accepted trials."""
    for r in rows:
        if r["precision"] is not None and r["precision"] >= min_precision and r["n"] >= min_n:
            return float(r["threshold"])
    return None


def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    pos = (len(s) - 1) * q / 100
    lo, hi = math.floor(pos), math.ceil(pos)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)
