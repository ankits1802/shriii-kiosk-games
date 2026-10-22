"""Building blocks for measurement-science simulation studies (VAL-02 and estimator comparisons).

* :class:`StudyEngine` is the real :class:`~shriii_scoring.engine.IndicatorEngine` with three study-only
  knobs: score a subset of indicators, truncate every scored block to its first ``fraction`` of trials
  (the same trials a shorter block in the game config would have produced), and lower ``min_valid_trials``
  to 1 so that reliability can be traced below the production minimums. Scoring parameters can be
  overridden (e.g. ``models.binary_outcome_model``) without editing the packaged YAML.
* :func:`parallel_stats` scores a two-occasion parallel-form study (identical latents, stability 1) and
  returns, per indicator, ``r(estimate, latent)``, the parallel-form reliability, the partition's
  model-based reliability and the median number of valid units.

Nothing here is used in production scoring.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, replace
from typing import Any, Literal

import numpy as np
import shriii_scoring.engine as _engine_module
from scipy.stats import rankdata
from shriii_scoring.canonical import SessionRecord, Trial, canonicalise
from shriii_scoring.dictionary import IndicatorSpec, Pathway
from shriii_scoring.engine import IndicatorEngine, ScoringResult
from shriii_scoring.params import ScoringParams, load_params

from shriii_simulator.params import SimParams, load_sim_params
from shriii_simulator.population import CONSTRUCTS
from shriii_simulator.session import B_SLOTS, SimulatedStudy, simulate_study

__all__ = [
    "IndicatorStat",
    "StudyEngine",
    "corr",
    "parallel_stats",
    "simulate_parallel",
    "with_scoring_overrides",
]


def with_scoring_overrides(params: ScoringParams, overrides: Mapping[str, Any]) -> ScoringParams:
    """Copy of ``params`` with dotted-path overrides (the copy's sha256 is marked as overridden)."""
    if not overrides:
        return params

    def _set(node: Mapping[str, Any], parts: Sequence[str], value: Any) -> dict[str, Any]:
        out = dict(node)
        if len(parts) == 1:
            out[parts[0]] = value
        else:
            child = node.get(parts[0])
            if not isinstance(child, Mapping):
                raise KeyError(".".join(parts))
            out[parts[0]] = _set(child, parts[1:], value)
        return out

    data: Mapping[str, Any] = params.data
    for key, value in overrides.items():
        params.get(key)  # fail loudly on unknown keys
        data = _set(data, key.split("."), value)
    tag = ",".join(f"{k}={v}" for k, v in sorted(overrides.items()))
    return replace(params, data=data, sha256=f"{params.sha256}+overrides({tag})")


class StudyEngine(IndicatorEngine):
    """Indicator engine for simulation studies (indicator subset, block truncation, minimum override)."""

    def __init__(
        self,
        *,
        pathways: Sequence[Pathway],
        fraction: float = 1.0,
        indicators: Iterable[str] | None = None,
        min_valid_override: int | None = 1,
        scoring_overrides: Mapping[str, Any] | None = None,
        partition_keys: Sequence[str] = ("pathway", "mode"),
    ) -> None:
        if not 0.0 < fraction <= 1.0:
            raise ValueError("fraction must be in (0, 1]")
        super().__init__(
            pathways=pathways,
            params=with_scoring_overrides(load_params(), scoring_overrides or {}),
            allow_synthetic=True,
            partition_keys=partition_keys,
        )
        self.fraction = fraction
        keep = set(indicators) if indicators is not None else None
        for p, d in list(self.dictionaries.items()):
            specs: dict[str, IndicatorSpec] = {}
            for iid, spec in d.indicators.items():
                if keep is not None and iid not in keep:
                    continue
                specs[iid] = replace(spec, min_valid_count=min_valid_override) if min_valid_override else spec
            self.dictionaries[p] = replace(d, indicators=specs)

    def _select(self, session: SessionRecord, spec: IndicatorSpec) -> list[Trial]:
        trials = super()._select(session, spec)
        if self.fraction >= 1.0:
            return trials
        lengths: dict[tuple[str, str], int] = defaultdict(int)
        for m in {t.module_id for t in trials}:
            for t in session.modules[m].trials:
                lengths[(m, t.block)] += 1
        return [t for t in trials if t.block_pos < max(1, math.ceil(self.fraction * lengths[(t.module_id, t.block)]))]


@dataclass(frozen=True, slots=True)
class IndicatorStat:
    """Parallel-form statistics for one indicator under one study condition."""

    indicator_id: str
    construct: str
    n_persons: int
    median_n_valid: float
    r_latent: float
    parallel_reliability: float
    model_reliability: float | None
    method: str | None
    best_other_construct: str | None = None
    r_best_other: float = math.nan


def corr(a: Sequence[float], b: Sequence[float], method: Literal["spearman", "pearson"] = "spearman") -> float:
    x = np.asarray(a, dtype=float)
    y = np.asarray(b, dtype=float)
    if x.size < 3 or x.std() == 0 or y.std() == 0:
        return math.nan
    if method == "spearman":
        x, y = rankdata(x), rankdata(y)
    return float(np.corrcoef(x, y)[0, 1])


def simulate_parallel(
    n: int,
    pathway: Literal["A", "B"],
    *,
    seed: int,
    params: SimParams | None = None,
    slot_form: str | None = None,
) -> SimulatedStudy:
    """Two parallel occasions with identical latents (stability 1), as in the recovery harness."""
    return simulate_study(
        n,
        pathway,
        seed=seed,
        params=params or load_sim_params(),
        occasions=2,
        stability=1.0,
        slot_form=slot_form,
        include_coplay=pathway == "A",
    )


_CANONICAL: dict[int, tuple[SimulatedStudy, list[SessionRecord]]] = {}


@contextmanager
def _cached_canonical(study: SimulatedStudy) -> Iterator[None]:
    """Canonicalise a study once and reuse it across scoring variants (canonicalisation dominates the cost
    of scoring a handful of indicators; formulas only read the canonical trials)."""
    key = id(study)
    if key not in _CANONICAL or _CANONICAL[key][0] is not study:
        _CANONICAL.clear()
        _CANONICAL[key] = (study, canonicalise(study.events, study.trial_params))
    sessions = _CANONICAL[key][1]
    original = getattr(_engine_module, "canonicalise")  # noqa: B009 - module attribute patched below
    setattr(_engine_module, "canonicalise", lambda *_a, **_k: sessions)  # noqa: B010
    try:
        yield
    finally:
        setattr(_engine_module, "canonicalise", original)  # noqa: B010


def parallel_stats(
    study: SimulatedStudy, engine: IndicatorEngine, *, min_n: int = 20
) -> tuple[dict[str, IndicatorStat], ScoringResult]:
    """Score ``study`` with ``engine`` and summarise every indicator with at least ``min_n`` paired persons."""
    with _cached_canonical(study):
        result = engine.score(study.events, study.trial_params)
    occ_of = {s.session_id: s.occasion for s in study.sessions}
    person_of = {s.session_id: s.person for s in study.sessions}
    values: dict[str, dict[int, dict[str, float]]] = {}
    n_valid: dict[str, list[int]] = defaultdict(list)
    constructs: dict[str, str] = {}
    for row in result.rows:
        constructs[row.indicator_id] = row.construct
        if row.status != "ok" or row.value is None:
            continue
        sign = 1.0 if row.direction == "higher_more" else -1.0
        occ = occ_of[row.session_id]
        values.setdefault(row.indicator_id, {}).setdefault(occ, {})[person_of[row.session_id].pid] = sign * row.value
        if occ == 1:
            n_valid[row.indicator_id].append(row.n_valid)
    model_rel: dict[str, tuple[float | None, str | None]] = {}
    for pm in result.partition_models:
        if pm.partition.get("mode", "pilot") == "pilot":
            rel = pm.details.get("model_reliability")
            model_rel[pm.indicator_id] = (None if rel is None else float(rel), pm.details.get("method"))
    latents = {p.pid: p for p in study.persons}
    out: dict[str, IndicatorStat] = {}
    for ind, occ_values in sorted(values.items()):
        o1, o2 = occ_values.get(1, {}), occ_values.get(2, {})
        common = sorted(set(o1) & set(o2))
        if len(common) < min_n:
            continue
        construct = constructs[ind]
        rel_model, method = model_rel.get(ind, (None, None))
        others = [
            (c, corr([o1[p] for p in sorted(o1)], [latents[p].z(c) for p in sorted(o1)]))
            for c in CONSTRUCTS
            if c != construct
        ]
        best_c, best_r = max(others, key=lambda cr: -1.0 if math.isnan(cr[1]) else abs(cr[1]))
        out[ind] = IndicatorStat(
            indicator_id=ind,
            construct=construct,
            n_persons=len(o1),
            median_n_valid=float(np.median(n_valid[ind])) if n_valid[ind] else math.nan,
            r_latent=corr([o1[p] for p in sorted(o1)], [latents[p].z(construct) for p in sorted(o1)]),
            parallel_reliability=corr([o1[p] for p in common], [o2[p] for p in common]),
            model_reliability=rel_model,
            method=method,
            best_other_construct=best_c,
            r_best_other=best_r,
        )
    return out, result


def slot_forms(pathway: str) -> list[str | None]:
    """Session forms needed to see every indicator of a pathway (B: one study per planned-missingness slot)."""
    return list(B_SLOTS) if pathway == "B" else [None]
