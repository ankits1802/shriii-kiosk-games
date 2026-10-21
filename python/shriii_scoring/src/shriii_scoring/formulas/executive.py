"""Executive indicators (SCR-04, SCR-09): go/no-go, EZ-diffusion, BART, effort, taps."""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np

from shriii_scoring.canonical import Trial
from shriii_scoring.formulas.base import (
    FormulaContext,
    IndicatorValue,
    latency,
    need_params,
    rng_for,
    session_formula,
)
from shriii_scoring.numerics import ez_diffusion

__all__ = ["balloon_pumps", "gng_correct"]


def gng_correct(t: Trial) -> bool:
    """Go: a serve response; no-go: withholding. Kiosk correctness wins when present."""
    c = t.correct
    if c is not None:
        return bool(c)
    return t.responded if t.trial_type == "go" else not t.responded


def _is_commission(t: Trial) -> bool:
    return t.trial_type == "nogo" and t.responded


def _is_omission(t: Trial) -> bool:
    return t.trial_type == "go" and not t.responded


@session_formula("gng.commission_rate")
def commission_rate(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Proportion of no-go trials with a serve response."""
    nogo = [t for t in trials if t.trial_type == "nogo"]
    k = sum(_is_commission(t) for t in nogo)
    n = len(nogo)
    return IndicatorValue(value=k / n if n else None, n_valid=n, details={"k": k, "n": n})


def _ez_arrays(trials: Sequence[Trial]) -> tuple[np.ndarray, np.ndarray]:
    """(correct flags, correct go-RT in seconds or NaN) per trial."""
    correct = np.array([gng_correct(t) for t in trials], dtype=bool)
    rts = np.full(len(trials), np.nan)
    for i, t in enumerate(trials):
        if correct[i] and t.trial_type == "go":
            lat = latency(t)
            if lat is not None:
                rts[i] = lat / 1000.0
    return correct, rts


def _ez_from_arrays(correct: np.ndarray, rts: np.ndarray) -> tuple[float, float, float, int, bool] | None:
    n = int(correct.size)
    if n == 0:
        return None
    valid = rts[np.isfinite(rts)]
    if valid.size < 2:
        return None
    ez = ez_diffusion(float(correct.mean()), float(np.var(valid, ddof=1)), float(np.mean(valid)), n=n)
    if math.isnan(ez.drift):
        return None
    return ez.drift, ez.boundary, ez.nondecision, n, ez.edge_corrected


@session_formula("ezdiffusion.drift_nogo")
def ez_drift(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """EZ-diffusion drift from overall go/no-go accuracy and correct go-RT moments (s = 0.1).

    The boundary (caution) is returned in ``details`` as a style indicator and never mixed into
    self-control. The SE is a within-person bootstrap over trials (200 resamples, seeded by session).
    """
    correct, rts = _ez_arrays(trials)
    est = _ez_from_arrays(correct, rts)
    if est is None:
        return IndicatorValue.empty(len(trials), "ez_undefined")
    drift, boundary, ter, n, edge = est
    rng = rng_for(ctx.session.session_id, ctx.spec.id)
    boots: list[float] = []
    for _ in range(200):
        idx = rng.integers(0, n, n)
        b = _ez_from_arrays(correct[idx], rts[idx])
        if b is not None:
            boots.append(b[0])
    se = float(np.std(boots, ddof=1)) if len(boots) > 10 else None
    flags = ("edge_corrected",) if edge else ()
    return IndicatorValue(
        value=drift,
        n_valid=n,
        se=se,
        flags=flags,
        details={"boundary": boundary, "nondecision_s": ter},
    )


@session_formula("gng.error_type_shift")
def error_type_shift(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Commission share of errors under pressure minus without pressure ((k + .5) / (n + 1) per block)."""

    def share(ts: Sequence[Trial]) -> tuple[float, int]:
        comm = sum(_is_commission(t) for t in ts)
        errors = comm + sum(_is_omission(t) for t in ts)
        return (comm + 0.5) / (errors + 1.0), errors

    off = [t for t in trials if t.phase != "pressure"]
    on = [t for t in trials if t.phase == "pressure"]
    if not off or not on:
        return IndicatorValue.empty(len(trials), "missing_pressure_contrast")
    s_off, e_off = share(off)
    s_on, e_on = share(on)
    return IndicatorValue(value=s_on - s_off, n_valid=len(trials), details={"errors_off": e_off, "errors_on": e_on})


@session_formula("gng.post_feedback_recovery")
def post_feedback_recovery(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Accuracy on the trials after scripted negative feedback minus the person's overall accuracy.

    Feedback trials carry ``params.feedback = "negative"``; the window length is
    ``feedback_recovery.window_trials``. ``n_valid`` counts feedback events with a complete window.
    """
    window = ctx.params.i("feedback_recovery.window_trials")
    ordered = sorted(trials, key=lambda t: t.trial_index)
    if not ordered:
        return IndicatorValue.empty(0)
    acc = [gng_correct(t) for t in ordered]
    baseline = float(np.mean(acc))
    post: list[float] = []
    events = 0
    for i, t in enumerate(ordered):
        if need_params(t, "feedback").get("feedback") != "negative":
            continue
        nxt = acc[i + 1 : i + 1 + window]
        if len(nxt) == window:
            events += 1
            post.append(float(np.mean(nxt)))
    if not post:
        return IndicatorValue.empty(0, "no_feedback_events")
    return IndicatorValue(value=float(np.mean(post)) - baseline, n_valid=events, details={"baseline": baseline})


def balloon_pumps(t: Trial) -> tuple[int, bool, bool]:
    """(pumps, exploded, collected) for one balloon trial from its pump events."""
    pumps = [p for p in t.pumps if not p.get("collected")]
    exploded = any(p.get("exploded") for p in t.pumps)
    collected = any(p.get("collected") for p in t.pumps)
    return len(pumps), exploded, collected


@session_formula("balloon.adjusted_pumps")
def adjusted_pumps(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Mean pumps on balloons that did not explode (Lejuez et al., 2002); n = unexploded balloons."""
    vals = [p for p, exploded, _ in map(balloon_pumps, trials) if not exploded]
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


@session_formula("balloon.explosion_rate")
def explosion_rate(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Proportion of balloons that exploded; n = balloons."""
    n = len(trials)
    k = sum(balloon_pumps(t)[1] for t in trials)
    return IndicatorValue(value=k / n if n else None, n_valid=n, details={"k": k, "n": n})


@session_formula("effort.completion_rate")
def effort_completion(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Proportion of effortful holds completed (Wait-or-Now: chosen 'hard' options; Road Home: all holds)."""
    done = 0
    n = 0
    for t in trials:
        if t.trial_type == "effort_choice" and (t.response is None or t.response.value != "hard"):
            continue
        if not t.holds:
            if t.trial_type == "effort_hold":
                n += 1
            continue
        n += 1
        done += any(h.completed for h in t.holds)
    return IndicatorValue(value=done / n if n else None, n_valid=n, details={"k": done, "n": n})


def _premature(tap_class: str, offset: float | None, threshold: float) -> bool:
    if tap_class in ("premature", "during_isi"):
        return True
    return tap_class == "on_target" and offset is not None and 0.0 <= offset < threshold


IGNORED_TAPS = frozenset({"multi_touch_interference", "filtered_palm"})


@session_formula("taps.premature_rate")
def premature_rate(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Taps < 150 ms after the anchor or during the ISI, per trial (threshold from shared.yaml)."""
    n = len(trials)
    k = sum(
        _premature(tp.classification, tp.anchor_offset_ms, ctx.anticipatory_ms)
        for t in trials
        for tp in t.taps
        if tp.classification not in IGNORED_TAPS
    )
    return IndicatorValue(value=k / n if n else None, n_valid=n, details={"taps": k})


@session_formula("taps.extra_rate")
def extra_rate(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Taps beyond the first committed response (classification ``extra``), per trial."""
    n = len(trials)
    k = sum(1 for t in trials for tp in t.taps if tp.classification == "extra")
    return IndicatorValue(value=k / n if n else None, n_valid=n, details={"taps": k})
