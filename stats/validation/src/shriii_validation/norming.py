"""Weighted (post-stratified) percentile norms (VAL-11).

Pilot-based norms are published as provisional. Cells are age band x education band; weights come from
post-stratification to population cell shares (or raking to margins), are trimmed at
``norming.weight_trim_ratio`` x the median weight, and the Kish effective n is reported. Cells below
``norming.min_cell_n`` are suppressed, cells with effective n below ``norming.provisional_effective_n`` are
flagged provisional, and a percentile crossing blocks publication. Continuous norming (cNORM / GAMLSS with
age and education as continuous predictors) is delegated to the R backend.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from itertools import pairwise

import numpy as np
from numpy.typing import ArrayLike, NDArray

from shriii_validation.params import ValidationParams, load_validation_params
from shriii_validation.rbackend import RBackend, default_backend
from shriii_validation.results import EvidenceResult

__all__ = [
    "NormCell",
    "NormTable",
    "continuous_norms",
    "kish_effective_n",
    "percentile_norms",
    "percentile_rank",
    "poststratification_weights",
    "rake",
    "weighted_quantile",
]

FloatArray = NDArray[np.float64]


def kish_effective_n(weights: ArrayLike) -> float:
    """Kish effective sample size (sum w)^2 / sum w^2."""
    w = np.asarray(weights, dtype=float)
    return float(w.sum() ** 2 / np.sum(w**2)) if w.size else 0.0


def poststratification_weights(
    cells: ArrayLike,
    population_shares: Mapping[str, float],
    *,
    trim_ratio: float | None = None,
    params: ValidationParams | None = None,
) -> FloatArray:
    """Cell post-stratification weights ``share_pop / share_sample`` (mean 1), trimmed at ``trim_ratio`` x
    median and renormalised. Cells absent from the population table get weight 0."""
    prm = params or load_validation_params()
    tr = trim_ratio if trim_ratio is not None else prm.f("norming.weight_trim_ratio")
    c = np.asarray(cells).astype(str)
    labels, counts = np.unique(c, return_counts=True)
    sample_share = dict(zip(labels.tolist(), (counts / counts.sum()).tolist(), strict=True))
    total_pop = sum(population_shares.get(lb, 0.0) for lb in labels)
    w = np.array([population_shares.get(x, 0.0) / total_pop / sample_share[x] if total_pop > 0 else 0.0 for x in c])
    return _trim(w, tr)


def _trim(w: FloatArray, ratio: float) -> FloatArray:
    pos = w[w > 0]
    if pos.size == 0:
        return w
    cap = ratio * float(np.median(pos))
    w = np.minimum(w, cap)
    return w * (w.size / w.sum()) if w.sum() > 0 else w


def rake(
    margins_data: Mapping[str, ArrayLike],
    targets: Mapping[str, Mapping[str, float]],
    *,
    max_iter: int = 100,
    tol: float = 1e-8,
    trim_ratio: float | None = None,
    params: ValidationParams | None = None,
) -> FloatArray:
    """Iterative proportional fitting of weights to marginal population shares (e.g. age, gender, education,
    literacy, urban/rural), then trimming."""
    prm = params or load_validation_params()
    tr = trim_ratio if trim_ratio is not None else prm.f("norming.weight_trim_ratio")
    variables = list(margins_data)
    n = len(np.asarray(margins_data[variables[0]]))
    w = np.ones(n)
    cols = {v: np.asarray(margins_data[v]).astype(str) for v in variables}
    for _ in range(max_iter):
        change = 0.0
        for v in variables:
            for level, share in targets[v].items():
                mask = cols[v] == level
                cur = w[mask].sum() / w.sum()
                if cur > 0:
                    f = share / cur
                    w[mask] *= f
                    change = max(change, abs(f - 1))
        if change < tol:
            break
    return _trim(w * (n / w.sum()), tr)


def weighted_quantile(values: ArrayLike, weights: ArrayLike, q: float) -> float:
    """Weighted quantile (``q`` in [0, 1]) with linear interpolation of the weighted ECDF midpoints."""
    v = np.asarray(values, dtype=float)
    w = np.asarray(weights, dtype=float)
    ok = np.isfinite(v) & (w > 0)
    v, w = v[ok], w[ok]
    order = np.argsort(v)
    v, w = v[order], w[order]
    cum = (np.cumsum(w) - 0.5 * w) / w.sum()
    return float(np.interp(q, cum, v))


@dataclass(frozen=True, slots=True)
class NormCell:
    """One norm cell."""

    cell: str
    n: int
    effective_n: float
    percentiles: Mapping[int, float]
    provisional: bool
    suppressed: bool


@dataclass(frozen=True, slots=True)
class NormTable:
    """A versioned weighted norm table."""

    norm_table_version: str
    trait: str
    cells: tuple[NormCell, ...]
    pooled: NormCell
    publishable: bool
    warnings: tuple[str, ...]


def _cell(label: str, v: FloatArray, w: FloatArray, *, qs: Sequence[int], prov_n: float, min_n: int) -> NormCell:
    n = int(v.size)
    eff = kish_effective_n(w)
    if n < min_n:
        return NormCell(label, n, eff, {}, True, True)
    pct = {int(q): weighted_quantile(v, w, q / 100.0) for q in qs}
    return NormCell(label, n, eff, pct, eff < prov_n, False)


def percentile_norms(
    scores: ArrayLike,
    age_band: ArrayLike,
    edu_band: ArrayLike,
    weights: ArrayLike,
    *,
    trait: str,
    norm_table_version: str,
    params: ValidationParams | None = None,
) -> NormTable:
    """Weighted percentile norms by age band x education band (plus the pooled table)."""
    prm = params or load_validation_params()
    qs = [int(q) for q in prm.get("norming.percentiles")]
    prov_n = prm.f("norming.provisional_effective_n")
    min_n = prm.i("norming.min_cell_n")
    v = np.asarray(scores, dtype=float)
    w = np.asarray(weights, dtype=float)
    labels = np.array(
        [f"{a}|{e}" for a, e in zip(np.asarray(age_band).tolist(), np.asarray(edu_band).tolist(), strict=True)]
    )
    ok = np.isfinite(v) & (w > 0)
    cells = []
    warnings: list[str] = []
    for lb in sorted(set(labels[ok].tolist())):
        m = ok & (labels == lb)
        cell = _cell(lb, v[m], w[m], qs=qs, prov_n=prov_n, min_n=min_n)
        if not cell.suppressed:
            vals = [cell.percentiles[q] for q in qs]
            if any(b < a for a, b in pairwise(vals)):
                warnings.append(f"percentile crossing in cell {lb}")
        cells.append(cell)
    pooled = _cell("pooled", v[ok], w[ok], qs=qs, prov_n=prov_n, min_n=min_n)
    publishable = not any("crossing" in x for x in warnings)
    if not publishable:
        warnings.append("publication blocked: percentile crossing")
    return NormTable(norm_table_version, trait, tuple(cells), pooled, publishable, tuple(warnings))


def percentile_rank(score: float, cell: NormCell) -> float | None:
    """Approximate percentile rank by interpolating the cell's percentile points (None for suppressed cells)."""
    if cell.suppressed or not cell.percentiles:
        return None
    qs = sorted(cell.percentiles)
    vals = [cell.percentiles[q] for q in qs]
    return float(np.interp(score, vals, qs, left=min(qs) / 2.0, right=(100 + max(qs)) / 2.0))


def continuous_norms(
    scores: ArrayLike,
    age: ArrayLike,
    *,
    weights: ArrayLike | None = None,
    method: str = "cNORM",
    backend: RBackend | None = None,
) -> EvidenceResult:
    """Continuous norming (cNORM primary, GAMLSS alternative) through the R backend."""
    b = backend or default_backend()
    return b.continuous_norms(scores, age, weights=weights, method=method)
