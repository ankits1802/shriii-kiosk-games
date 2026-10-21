"""Generic evaluator for the shared exclusion rules (``shared.yaml`` ``exclusion_rules``).

Each rule is a conjunction of ``field op value`` clauses. Fields are resolved on a canonical trial and its
session; the vocabulary of field roots matches the dictionary tests (``payload``, ``condition``,
``timing``, ``context``, ``derived``, ``session``). Unknown fields raise, so a dictionary amendment that
introduces a new field cannot be silently ignored.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any

from shriii_scoring.canonical import SessionRecord, Trial
from shriii_scoring.dictionary import ExclusionRule

__all__ = ["ExclusionContext", "ExclusionOutcome", "apply_exclusions", "evaluate_rule", "ms_since_mentioning_prompt"]


@dataclass(frozen=True, slots=True)
class ExclusionContext:
    """Session-level inputs to exclusion rules."""

    session: SessionRecord
    quality_grade: str
    allow_synthetic: bool = False


@dataclass(frozen=True, slots=True)
class ExclusionOutcome:
    """Trials that survived, plus counts of exclusions by rule id."""

    kept: list[Trial]
    excluded_by_rule: Mapping[str, int]
    session_excluded_by: str | None


def ms_since_mentioning_prompt(trial: Trial) -> float | None:
    """Milliseconds from the end of the latest prompt that mentions the action to the committed response.

    Prompts that mention an optional action are listed in ``params.mentioning_lines``. ``None`` when no
    mentioning prompt preceded the response (the action is unprompted).
    """
    r = trial.response
    lines = set(trial.params.get("mentioning_lines") or ())
    if r is None or not lines:
        return None
    ends = [end for line, end in trial.prompt_ends if line in lines and end <= r.t_ms]
    if not ends:
        return None
    return r.t_ms - max(ends)


def _resolve(field: str, trial: Trial | None, ctx: ExclusionContext) -> Any:
    s = ctx.session
    if field == "session.quality_grade":
        return ctx.quality_grade
    if field == "context.synthetic":
        return s.synthetic
    if field == "derived.context_shift_present":
        if trial is None:
            return None
        module = s.modules.get(trial.module_id)
        return bool(module and module.shifts)
    if field == "condition.calibration_level" and trial is None:
        return s.calibration_level
    if trial is None:
        raise KeyError(f"field {field!r} needs a trial")
    r = trial.response
    resolvers: dict[str, Callable[[], Any]] = {
        "timing.scorable": lambda: trial.scorable,
        "timing.interrupted": lambda: trial.interrupted,
        "timing.timing_flag": lambda: trial.timing_flag,
        "payload.input_mode": lambda: None if r is None else r.input_mode,
        "payload.latency_ms": lambda: None if r is None else r.latency_ms,
        "condition.calibration_level": lambda: trial.calibration_level or s.calibration_level,
        "derived.ms_since_mentioning_prompt": lambda: ms_since_mentioning_prompt(trial),
        # Event-level fields are handled at canonicalisation (invalid placeholders) or per tap.
        "event_type": lambda: "trial",
        "payload.classification": lambda: None,
    }
    if field not in resolvers:
        raise KeyError(f"exclusion field {field!r} is not supported by the engine")
    return resolvers[field]()


def _compare(actual: Any, op: str, expected: Any) -> bool:
    if op == "eq":
        return bool(actual == expected)
    if op == "ne":
        return bool(actual != expected)
    if op == "in":
        return actual in (expected or ())
    if op == "not_in":
        return actual not in (expected or ())
    if actual is None:
        return False
    if op == "lt":
        return bool(actual < expected)
    if op == "le":
        return bool(actual <= expected)
    if op == "gt":
        return bool(actual > expected)
    if op == "ge":
        return bool(actual >= expected)
    raise ValueError(f"unsupported exclusion operator {op!r}")


def evaluate_rule(rule: ExclusionRule, trial: Trial | None, ctx: ExclusionContext) -> bool:
    """True when every clause of ``rule`` holds (the trial/session is excluded)."""
    return all(_compare(_resolve(c.field, trial, ctx), c.op, c.value) for c in rule.when)


def apply_exclusions(
    trials: Sequence[Trial],
    rule_ids: Iterable[str],
    rules: Mapping[str, ExclusionRule],
    ctx: ExclusionContext,
    latency_only: frozenset[str] = frozenset(),
) -> ExclusionOutcome:
    """Apply the listed rules; session-level rules exclude everything, trial-level rules filter rows.

    Rules in ``latency_only`` do not drop a trial: they return a copy with ``latency_valid = False`` so that
    latency aggregates ignore it while accuracy/choice parts of the indicator keep it.
    """
    selected = [rules[r] for r in rule_ids]
    for rule in selected:
        if rule.applies_to != "session":
            continue
        if rule.id == "synthetic_session" and ctx.allow_synthetic:
            continue
        if evaluate_rule(rule, None, ctx):
            return ExclusionOutcome(kept=[], excluded_by_rule={rule.id: len(trials)}, session_excluded_by=rule.id)
    trial_rules = [r for r in selected if r.applies_to in ("trial", "event") and r.id not in latency_only]
    masks = [r for r in selected if r.applies_to in ("trial", "event") and r.id in latency_only]
    counts: Counter[str] = Counter()
    kept: list[Trial] = []
    level_rules = [r for r in selected if r.applies_to == "session" and r.id == "level_not_fixed_l2"]
    for t in trials:
        hit = next((r.id for r in trial_rules if evaluate_rule(r, t, ctx)), None)
        if hit is None:
            # Calibration level is a session rule but trials carry their own level; check per trial too.
            hit = next((r.id for r in level_rules if evaluate_rule(r, t, ctx)), None)
        if hit is not None:
            counts[hit] += 1
            continue
        mask = next((r.id for r in masks if evaluate_rule(r, t, ctx)), None)
        if mask is not None:
            counts[f"{mask}:latency_masked"] += 1
            kept.append(replace(t, latency_valid=False))
        else:
            kept.append(t)
    return ExclusionOutcome(kept=kept, excluded_by_rule=dict(counts), session_excluded_by=None)
