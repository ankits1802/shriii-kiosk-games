"""Effort- and delay-discounting design study (VAL-02; indicator review of ``self_control.effort_discount``).

The v0 Wait-or-Now effort block offers four fixed choices (hard amounts 5, 6, 8, 10 at 2.5 s of holding
versus 2 coins for no effort). Under the simulator's hyperbolic chooser most people take every hard
option, so their log k is bounded on one side only and the estimate collapses onto the population prior
(model-based reliability ~ .05 in the wave-1 recovery run). This module compares candidate designs on the
same chooser with the same estimator the engine uses (:func:`shriii_scoring.formulas.models.fit_discounting_eb`):

* ``fixed``: an explicit list of hard amounts (the v0 design and wider fixed grids);
* ``titrated``: an adjusting-amount staircase on the hard amount (the next offer goes down after a hard
  choice and up after an easy choice; the step halves at each reversal), optionally as two interleaved
  staircases that start low and high.

For each design it simulates two parallel occasions per person (same latent log k, fresh choice noise)
and reports r(estimate, true log k), the parallel-form reliability and the model-based reliability. The
designs and their session-time costs are configured in ``data/val02.yaml``. It does not need the event
pipeline, so a full design grid runs in seconds.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
from shriii_scoring.formulas.models import fit_discounting_eb
from shriii_scoring.params import load_params

from shriii_simulator.common import sigmoid, staircase_step
from shriii_simulator.params import SimParams, load_sim_params
from shriii_simulator.studies import corr

__all__ = ["DesignResult", "EffortDesign", "run_design_study", "simulate_effort_choices"]


@dataclass(frozen=True, slots=True)
class EffortDesign:
    """One effort-discounting schedule."""

    name: str
    kind: str  # fixed | titrated
    amounts: tuple[float, ...] = ()
    trials: int = 0
    staircases: int = 1
    start_amounts: tuple[float, ...] = (6.0,)
    start_step: float = 2.0
    min_amount: float = 2.5
    max_amount: float = 12.0
    easy_amount: float = 2.0
    hard_effort: float = 2.5

    @property
    def n_choices(self) -> int:
        return len(self.amounts) if self.kind == "fixed" else self.trials

    @classmethod
    def from_mapping(cls, name: str, m: Mapping[str, Any]) -> EffortDesign:
        return cls(
            name=name,
            kind=str(m["kind"]),
            amounts=tuple(float(a) for a in m.get("amounts", ())),
            trials=int(m.get("trials", 0)),
            staircases=int(m.get("staircases", 1)),
            start_amounts=tuple(float(a) for a in m.get("start_amounts", (6.0,))),
            start_step=float(m.get("start_step", 2.0)),
            min_amount=float(m.get("min_amount", 2.5)),
            max_amount=float(m.get("max_amount", 12.0)),
            easy_amount=float(m.get("easy_amount", 2.0)),
            hard_effort=float(m.get("hard_effort", 2.5)),
        )


def simulate_effort_choices(
    design: EffortDesign, log_k: float, beta: float, rng: np.random.Generator
) -> tuple[list[float], list[float], list[float], list[float], list[int]]:
    """Choices of one hyperbolic chooser (same choice rule as ``modules_b.wait_or_now``)."""
    sa: list[float] = []
    sc: list[float] = []
    la: list[float] = []
    lc: list[float] = []
    y: list[int] = []
    k = math.exp(log_k)
    if design.kind == "fixed":
        offers: list[float] | None = list(design.amounts)
    elif design.kind == "titrated":
        offers = None
    else:
        raise ValueError(f"unknown design kind {design.kind!r}")
    n_stairs = max(1, design.staircases)
    amount = [design.start_amounts[i % len(design.start_amounts)] for i in range(n_stairs)]
    step = [design.start_step] * n_stairs
    direction = [0] * n_stairs
    for i in range(design.n_choices):
        s = i % n_stairs
        offer = offers[i] if offers is not None else round(amount[s], 2)
        v_hard = offer / (1.0 + k * design.hard_effort)
        hard = bool(rng.random() < sigmoid(beta * (v_hard - design.easy_amount) / offer))
        sa.append(design.easy_amount)
        sc.append(0.0)
        la.append(offer)
        lc.append(design.hard_effort)
        y.append(int(hard))
        if offers is None:
            amount[s], step[s], direction[s] = staircase_step(
                amount[s], step[s], direction[s], hard, lo=design.min_amount, hi=design.max_amount
            )
    return sa, sc, la, lc, y


@dataclass(frozen=True, slots=True)
class DesignResult:
    """Recovery statistics for one design."""

    design: str
    n_choices: int
    n_persons: int
    r_true: float
    parallel_reliability: float
    model_reliability: float | None
    share_all_hard: float
    share_all_easy: float


def run_design_study(
    designs: Sequence[EffortDesign],
    *,
    n: int,
    seed: int,
    sim_params: SimParams | None = None,
) -> list[DesignResult]:
    """Simulate ``n`` persons on two parallel occasions per design; log k from the simulator's effort model."""
    prm = sim_params or load_sim_params()
    scoring = load_params()
    d = "discounting."
    rng = np.random.default_rng(seed)
    z = rng.normal(size=n)
    true_log_k = prm.f(d + "effort_log_k") - prm.f(d + "effort_log_k_self_control") * z
    beta = prm.f(d + "beta")
    out: list[DesignResult] = []
    for design in designs:
        drng = np.random.default_rng([seed, abs(hash(design.name)) % (2**32)])
        est: dict[int, dict[str, float]] = {}
        rel_model: float | None = None
        all_hard = all_easy = 0
        for occ in (1, 2):
            data = {f"p{i:05d}": simulate_effort_choices(design, float(true_log_k[i]), beta, drng) for i in range(n)}
            if occ == 1:
                all_hard = sum(1 for v in data.values() if all(v[4]))
                all_easy = sum(1 for v in data.values() if not any(v[4]))
            res = fit_discounting_eb(data, scoring)
            est[occ] = {pid: f.log_k for pid, f in res["fits"].items()}
            if occ == 1:
                rel_model = res["model_reliability"]
        pids = sorted(set(est[1]) & set(est[2]))
        idx = [int(p[1:]) for p in pids]
        out.append(
            DesignResult(
                design=design.name,
                n_choices=design.n_choices,
                n_persons=len(pids),
                r_true=corr([est[1][p] for p in pids], [float(true_log_k[i]) for i in idx]),
                parallel_reliability=corr([est[1][p] for p in pids], [est[2][p] for p in pids]),
                model_reliability=rel_model,
                share_all_hard=all_hard / n,
                share_all_easy=all_easy / n,
            )
        )
    return out
