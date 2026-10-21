"""Style-trait session formulas (SCR-10): mean-adjusted variability, entropy, autocorrelation, post-loss.

Raw CV and ISD are not used as primary indicators: variability is the relative variability index (RVI,
Mestdagh et al., 2018), always on values detrended on trial index so that a linear fatigue/practice drift
does not inflate variability.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Sequence
from itertools import pairwise

import numpy as np

from shriii_scoring.canonical import Trial
from shriii_scoring.formulas.base import FormulaContext, IndicatorValue, latency, need_params, session_formula
from shriii_scoring.formulas.executive import balloon_pumps, gng_correct
from shriii_scoring.numerics import detrend, entropy_bits, lag1_autocorrelation, relative_variability_index


@session_formula("style.rvi_rt")
def rvi_rt(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """RVI of correct go RTs detrended on trial index; bounds [anticipation threshold, response window]."""
    rows = sorted(
        (
            (t.trial_index, lat)
            for t in trials
            if t.trial_type == "go" and gng_correct(t) and (lat := latency(t)) is not None
        ),
    )
    if len(rows) < ctx.params.i("rvi.min_values"):
        return IndicatorValue.empty(len(trials))
    windows = [t.response_window_ms for t in trials if t.response_window_ms]
    lo = ctx.params.f("rvi.rt_lower_ms")
    hi = float(max(windows)) if windows else max(r for _, r in rows) + 1.0
    hi = max(hi, *(r for _, r in rows))
    vals = detrend([r for _, r in rows], [i for i, _ in rows])
    rvi = relative_variability_index(list(vals), lo, hi)
    # min_valid_trials counts eligible trials (dictionary unit "trials"); the RT count is in details.
    return IndicatorValue(value=None if math.isnan(rvi) else rvi, n_valid=len(trials), details={"n_rts": len(rows)})


@session_formula("style.rvi_pumps")
def rvi_pumps(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """RVI of pumps on unexploded balloons (detrended on balloon order); bounds [0, max pumps]."""
    rows = []
    max_pumps = 0
    for t in sorted(trials, key=lambda t: t.trial_index):
        pumps, exploded, _ = balloon_pumps(t)
        max_pumps = max(max_pumps, int(need_params(t, "max_pumps")["max_pumps"]))
        if not exploded:
            rows.append((t.trial_index, pumps))
    if len(rows) < ctx.params.i("rvi.min_values"):
        return IndicatorValue.empty(len(rows))
    vals = detrend([float(p) for _, p in rows], [i for i, _ in rows])
    rvi = relative_variability_index(list(vals), 0.0, float(max_pumps))
    return IndicatorValue(value=None if math.isnan(rvi) else rvi, n_valid=len(rows))


@session_formula("style.rvi_inter_tap_interval")
def rvi_iti(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """RVI of intervals between consecutive on-target taps (exploratory restraint style indicator)."""
    taps = sorted(tp.pointer_t_ms for t in trials for tp in t.taps if tp.classification == "on_target")
    itis = [b - a for a, b in pairwise(taps) if b > a]
    if len(itis) < ctx.params.i("rvi.min_values"):
        return IndicatorValue.empty(len(trials))
    upper = ctx.params.f("rvi.inter_tap_upper_ms")
    rvi = relative_variability_index(list(detrend(itis)), 0.0, max(upper, *itis))
    return IndicatorValue(value=None if math.isnan(rvi) else rvi, n_valid=len(trials))


@session_formula("style.choice_entropy_repeats")
def choice_entropy(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Mean Shannon entropy (bits) of choices within repeated identical situations (``repeat_group_id``)."""
    groups: dict[str, list[str]] = defaultdict(list)
    for t in trials:
        gid = t.params.get("repeat_group_id")
        if gid and t.responded and t.response is not None and t.response.value is not None:
            groups[str(gid)].append(t.response.value)
    usable = {g: v for g, v in groups.items() if len(v) >= 2}
    n = sum(len(v) for v in usable.values())
    if not usable:
        return IndicatorValue.empty(0)
    return IndicatorValue(
        value=float(np.mean([entropy_bits(v) for v in usable.values()])), n_valid=n, details={"groups": len(usable)}
    )


def probe_segments(trials: Sequence[Trial], min_trials: int) -> dict[tuple[str, str], list[Trial]]:
    """Comparable probe segments keyed by (module, probe group); segments shorter than ``min_trials`` dropped."""
    segs: dict[tuple[str, str], list[Trial]] = defaultdict(list)
    for t in trials:
        segs[(t.module_id, t.probe_group_id or t.block)].append(t)
    return {k: sorted(v, key=lambda t: t.trial_index) for k, v in sorted(segs.items()) if len(v) >= min_trials}


@session_formula("style.lag1_autocorrelation")
def lag1(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Pooled lag-1 autocorrelation of detrended RTs over each module's contiguous probe run.

    ``n_valid`` counts comparable probe segments (as for the cross-segment indicator); autocorrelation pairs
    are formed within a module's probe run because probe groups can be as short as two trials, where a
    demeaned series has a lag-1 autocorrelation of exactly -1.
    """
    segs = probe_segments(trials, ctx.params.i("style.min_trials_per_segment"))
    runs: dict[str, list[float]] = defaultdict(list)
    for (module, _), ts in segs.items():
        runs[module].extend(lat for t in ts if (lat := latency(t)) is not None)
    series = [r for r in runs.values() if len(r) >= 3]
    r, pairs = lag1_autocorrelation(series, ctx.params.i("lag1.min_length_linear_detrend"))
    return IndicatorValue(value=None if math.isnan(r) else r, n_valid=len(segs), details={"pairs": pairs})


@session_formula("balloon.post_loss_adjustment")
def post_loss_adjustment(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Mean |pumps on the balloon after an explosion - person's mean unexploded pumps| / that mean."""
    ordered = sorted(trials, key=lambda t: t.trial_index)
    info = [balloon_pumps(t) for t in ordered]
    unexploded = [p for p, e, _ in info if not e]
    if not unexploded or float(np.mean(unexploded)) <= 0:
        return IndicatorValue.empty(0)
    mean = float(np.mean(unexploded))
    vals = [abs(info[i + 1][0] - mean) / mean for i in range(len(info) - 1) if info[i][1]]
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


@session_formula("igt.high_variance_share")
def high_variance_share(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share of second-half choices from the high-variance stalls (``params.high_variance_stalls``)."""
    ordered = [t for t in sorted(trials, key=lambda t: t.trial_index) if t.responded and t.response is not None]
    if not ordered:
        return IndicatorValue.empty(0)
    second = ordered[len(ordered) // 2 :]
    k = sum(
        1
        for t in second
        if t.response is not None
        and t.response.value in set(need_params(t, "high_variance_stalls")["high_variance_stalls"])
    )
    return IndicatorValue(value=k / len(second), n_valid=len(ordered), details={"k": k, "n": len(second)})
