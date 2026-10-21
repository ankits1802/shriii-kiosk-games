"""Decisiveness indicators (SCR-07): time to commit, reversals, information gathering, collect time."""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from shriii_scoring.canonical import Trial
from shriii_scoring.formulas.base import FormulaContext, IndicatorValue, latency, median, need_params, session_formula
from shriii_scoring.numerics import relative_variability_index


def collect_time_ms(t: Trial) -> float | None:
    """Time from the last pump (or balloon onset) to the collect tap; None if the balloon was not collected."""
    collects = [p for p in t.pumps if p.get("collected")]
    if not collects:
        return None
    t_collect = float(collects[0]["_t_ms"])
    pumps = [float(p["_t_ms"]) for p in t.pumps if not p.get("collected") and float(p["_t_ms"]) <= t_collect]
    ref = max(pumps) if pumps else (t.onset_ms if t.onset_ms is not None else t.start_ms)
    return t_collect - ref


@session_formula("balloon.time_to_collect")
def time_to_collect(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Median time from the last pump to the collect tap on collected balloons (ms)."""
    vals = [v for t in trials if (v := collect_time_ms(t)) is not None and v >= 0]
    return IndicatorValue(value=median(vals), n_valid=len(vals))


@session_formula("choice.time_to_commit")
def time_to_commit(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Median latency (ms, from the trial's latency anchor) of confirmed choices."""
    vals = [v for t in trials if (v := latency(t)) is not None]
    return IndicatorValue(value=median(vals), n_valid=len(vals))


@session_formula("choice.revisions_per_decision")
def revisions_per_decision(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Mean number of recorded revisions before the confirmed response."""
    vals = [float(len(t.response.revisions)) for t in trials if t.response is not None and t.responded]
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


def inspections(t: Trial) -> int:
    """'Inspect more' requests: on-target taps on a target whose id ends with ``inspect_more``."""
    return sum(
        1
        for tp in t.taps
        if tp.target_id is not None and tp.target_id.endswith("inspect_more") and tp.classification == "on_target"
    )


@session_formula("choice.inspect_more_rate")
def inspect_more_rate(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Mean 'inspect more' requests per decision beyond what the item requires."""
    vals = [
        float(max(0, inspections(t) - int(need_params(t, "required_inspections")["required_inspections"])))
        for t in trials
        if t.responded
    ]
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


@session_formula("style.rvi_decision_time")
def rvi_decision_time(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Relative variability index of decision times (collect times for balloons, latencies otherwise)."""
    vals: list[float] = []
    for t in trials:
        v = collect_time_ms(t) if t.trial_type == "balloon" else latency(t)
        if v is not None and v >= 0:
            vals.append(v)
    if len(vals) < ctx.params.i("rvi.min_values"):
        return IndicatorValue.empty(len(vals))
    rvi = relative_variability_index(vals, 0.0, ctx.params.f("rvi.decision_time_upper_ms"))
    return IndicatorValue(value=None if np.isnan(rvi) else rvi, n_valid=len(vals))
