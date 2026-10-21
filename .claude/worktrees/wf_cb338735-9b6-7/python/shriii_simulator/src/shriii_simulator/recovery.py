"""Parameter-recovery harness (QA-02, plan section 9.2).

Simulates persons with planted latents on two parallel occasions with identical latents (stability 1),
scores both with the real indicator engine, and checks for every scored indicator:

* recovery: ``r(construct-keyed estimate, planted latent) >= sqrt(parallel-form reliability) - tolerance``
  (the plan criterion; ``purity`` documents indicators whose true score is shared with another construct);
* model-based reliability of slope / model indicators versus the parallel-form reliability.

Caveat (recorded in reports): recovery shows the pipeline is internally correct; it is **not** evidence
that the games measure the traits. Only Stages 2-5 can show that.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from scipy.stats import rankdata
from shriii_scoring.engine import IndicatorEngine, ScoringResult

from shriii_simulator.params import SimParams, load_sim_params
from shriii_simulator.session import SimulatedStudy, simulate_study

__all__ = ["IndicatorRecovery", "RecoveryReport", "run_recovery"]

#: Indicators whose simulated true score loads on more than one construct by design (the same Tower
#: planning time feeds problem solving and initiative; dictionary note on method overlap).
SHARED_MEASURES: Mapping[str, float] = {
    "problem_solving.planning_time": math.sqrt(0.5),
    "initiative.planning_time_before_first_move": math.sqrt(0.5),
    # Road Home route planning time loads on initiative (.25) and problem solving (.15).
    "initiative.route_planning_time": 0.25 / math.sqrt(0.25**2 + 0.15**2),
}


@dataclass(frozen=True, slots=True)
class IndicatorRecovery:
    """Recovery statistics for one indicator."""

    indicator_id: str
    construct: str
    n: int
    r_latent: float
    parallel_reliability: float
    purity: float
    threshold: float
    passed: bool
    model_reliability: float | None


@dataclass(slots=True)
class RecoveryReport:
    """All indicators' recovery results plus the scoring runs."""

    pathway: str
    n_persons: int
    tolerance: float
    results: list[IndicatorRecovery]
    study: SimulatedStudy
    scoring: ScoringResult
    skipped: dict[str, str] = field(default_factory=dict)

    def by_id(self) -> dict[str, IndicatorRecovery]:
        return {r.indicator_id: r for r in self.results}

    @property
    def failures(self) -> list[IndicatorRecovery]:
        return [r for r in self.results if not r.passed]


def _corr(a: Sequence[float], b: Sequence[float], method: str = "spearman") -> float:
    x = np.asarray(a, dtype=float)
    y = np.asarray(b, dtype=float)
    if x.size < 3 or x.std() == 0 or y.std() == 0:
        return math.nan
    if method == "spearman":
        x, y = rankdata(x), rankdata(y)
    return float(np.corrcoef(x, y)[0, 1])


def run_recovery(
    n: int,
    pathway: Literal["A", "B"],
    *,
    seed: int,
    params: SimParams | None = None,
    tolerance: float = 0.05,
    min_n: int = 30,
    slot_form: str | None = None,
    engine: IndicatorEngine | None = None,
) -> RecoveryReport:
    """Run the two-occasion parallel-form recovery study for one pathway."""
    prm = params or load_sim_params()
    study = simulate_study(
        n,
        pathway,
        seed=seed,
        params=prm,
        occasions=2,
        stability=1.0,
        slot_form=slot_form,
        include_coplay=pathway == "A",
    )
    eng = engine or IndicatorEngine(pathways=(pathway,), allow_synthetic=True, partition_keys=("pathway", "mode"))
    result = eng.score(study.events, study.trial_params)
    occ_of = {s.session_id: s.occasion for s in study.sessions}
    person_of = {s.session_id: s.person for s in study.sessions}
    values: dict[str, dict[int, dict[str, float]]] = {}
    for row in result.rows:
        if row.status != "ok" or row.value is None:
            continue
        sign = 1.0 if row.direction == "higher_more" else -1.0
        values.setdefault(row.indicator_id, {}).setdefault(occ_of[row.session_id], {})[
            person_of[row.session_id].pid
        ] = sign * row.value
    model_rel: dict[str, float] = {}
    for pm in result.partition_models:
        rel = pm.details.get("model_reliability")
        if rel is not None and pm.partition.get("mode") == "pilot":
            model_rel[pm.indicator_id] = float(rel)
    latents = {p.pid: p for p in study.persons}
    constructs = {row.indicator_id: row.construct for row in result.rows}
    out: list[IndicatorRecovery] = []
    skipped: dict[str, str] = {}
    for ind, occ in sorted(values.items()):
        o1 = occ.get(1, {})
        o2 = occ.get(2, {})
        common = sorted(set(o1) & set(o2))
        if len(o1) < min_n or len(common) < min_n:
            skipped[ind] = f"n={len(o1)} (paired {len(common)}) below {min_n}"
            continue
        construct = constructs[ind]
        r_lat = _corr([o1[p] for p in sorted(o1)], [latents[p].z(construct) for p in sorted(o1)])
        rel = _corr([o1[p] for p in common], [o2[p] for p in common])
        purity = SHARED_MEASURES.get(ind, 1.0)
        threshold = purity * math.sqrt(max(rel, 0.0)) - tolerance if not math.isnan(rel) else math.nan
        out.append(
            IndicatorRecovery(
                indicator_id=ind,
                construct=construct,
                n=len(o1),
                r_latent=r_lat,
                parallel_reliability=rel,
                purity=purity,
                threshold=threshold,
                passed=bool(not math.isnan(r_lat) and r_lat >= threshold),
                model_reliability=model_rel.get(ind),
            )
        )
    return RecoveryReport(
        pathway=pathway, n_persons=n, tolerance=tolerance, results=out, study=study, scoring=result, skipped=skipped
    )


def summarise(report: RecoveryReport) -> list[dict[str, Any]]:
    """Plain records for printing / reports."""
    return [
        {
            "indicator": r.indicator_id,
            "n": r.n,
            "r_latent": round(r.r_latent, 3),
            "parallel_rel": round(r.parallel_reliability, 3),
            "threshold": round(r.threshold, 3),
            "model_rel": None if r.model_reliability is None else round(r.model_reliability, 3),
            "passed": r.passed,
        }
        for r in report.results
    ]
