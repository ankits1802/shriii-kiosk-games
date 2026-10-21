"""Flexibility indicators (SCR-06): perseveration, reacquisition, reversal and rule compliance.

Switch points come only from ``context_shift`` events; a module without its shift event yields status
``missing_context_shift`` (an error, never inferred from phases).
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Sequence

import numpy as np

from shriii_scoring.canonical import Trial
from shriii_scoring.formulas.base import FormulaContext, IndicatorValue, need_params, session_formula


def _module_has_shift(trials: Sequence[Trial], ctx: FormulaContext) -> bool:
    mods = {t.module_id for t in trials} or {ctx.spec.module_id}
    return all(bool(ctx.session.modules.get(m) and ctx.session.modules[m].shifts) for m in mods)


def _missing_shift(n: int) -> IndicatorValue:
    return IndicatorValue.empty(n, "missing_context_shift", status="missing_context_shift")


def trials_to_criterion(correct: Sequence[bool], run: int) -> tuple[int, bool]:
    """1-based position of the trial completing the first run of ``run`` consecutive correct responses.

    Returns ``(len(correct) + 1, False)`` when the criterion is never reached.
    """
    streak = 0
    for i, c in enumerate(correct, start=1):
        streak = streak + 1 if c else 0
        if streak >= run:
            return i, True
    return len(correct) + 1, False


def _sort_perseverative(t: Trial) -> bool:
    p = need_params(t, "rule", "previous_rule", "matches")
    if t.response is None or t.response.value is None or p["previous_rule"] is None:
        return False
    matches = p["matches"]
    value = t.response.value
    return bool(value == matches.get(p["previous_rule"]) and value != matches.get(p["rule"]))


@session_formula("card_sort.perseverative_error_rate")
def perseverative_errors(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share of post-switch sorts that follow the previous rule but not the current one."""
    if not _module_has_shift(trials, ctx):
        return _missing_shift(len(trials))
    post = [t for t in trials if t.post_shift]
    k = sum(_sort_perseverative(t) for t in post)
    n = len(post)
    return IndicatorValue(value=k / n if n else None, n_valid=n, details={"k": k, "n": n})


def _reacquisition(trials: Sequence[Trial], ctx: FormulaContext, correct_fn: Callable[[Trial], bool]) -> IndicatorValue:
    if not _module_has_shift(trials, ctx):
        return _missing_shift(len(trials))
    run = ctx.params.i("reacquisition.consecutive_correct")
    by_shift: dict[int, list[Trial]] = defaultdict(list)
    for t in trials:
        if t.post_shift:
            by_shift[t.shift_ordinal].append(t)
    vals: list[float] = []
    reached_all = True
    n = 0
    for _, ts in sorted(by_shift.items()):
        ts.sort(key=lambda t: t.trial_index)
        n += len(ts)
        pos, reached = trials_to_criterion([correct_fn(t) for t in ts], run)
        reached_all &= reached
        vals.append(float(pos))
    if not vals:
        return IndicatorValue.empty(0)
    flags = () if reached_all else ("criterion_not_reached",)
    return IndicatorValue(value=float(np.mean(vals)), n_valid=n, flags=flags, details={"per_shift": vals})


@session_formula("card_sort.trials_to_reacquire")
def card_sort_reacquire(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Mean trials after each switch until the reacquisition criterion (consecutive correct sorts)."""
    return _reacquisition(trials, ctx, lambda t: bool(t.correct))


def _fork_correct(t: Trial) -> bool:
    p = need_params(t, "rule_option")
    return t.response is not None and t.response.value == p["rule_option"]


@session_formula("reversal.perseverative_error_rate")
def reversal_errors(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share of post-reversal choices that follow the old rule."""
    if not _module_has_shift(trials, ctx):
        return _missing_shift(len(trials))
    post = [t for t in trials if t.post_shift]
    k = sum(
        1
        for t in post
        if t.response is not None and t.response.value == need_params(t, "old_rule_option")["old_rule_option"]
    )
    n = len(post)
    return IndicatorValue(value=k / n if n else None, n_valid=n, details={"k": k, "n": n})


@session_formula("reversal.trials_to_reacquire")
def reversal_reacquire(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Trials after the reversal until the reacquisition criterion of rule-consistent choices."""
    return _reacquisition(trials, ctx, _fork_correct)


@session_formula("rule.compliance_post_shift")
def rule_compliance(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share of decisions after the announced new rule that comply with it."""
    if not _module_has_shift(trials, ctx):
        return _missing_shift(len(trials))
    post = [t for t in trials if t.post_shift]
    k = sum(
        1
        for t in post
        if t.response is not None
        and t.response.value in set(need_params(t, "compliant_responses")["compliant_responses"])
    )
    n = len(post)
    return IndicatorValue(value=k / n if n else None, n_valid=n, details={"k": k, "n": n})
