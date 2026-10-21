"""Social and moral indicators (SCR-08) and tone indicators (SCR-09).

All marked ``sensitivity=high`` in the dictionary. Private-report estimators are group level only: the
group formulas return a :class:`GroupValue` that has no participant or session key, so dice outputs can
never be joined to individual tables (schema-level separation, SCR-08 AC).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

import numpy as np

from shriii_scoring.canonical import Trial
from shriii_scoring.formulas.base import (
    BatchContext,
    BatchUnit,
    FormulaContext,
    GroupValue,
    IndicatorValue,
    group_formula,
    session_formula,
)


def contribution_share(t: Trial) -> float | None:
    """Contributed share of the endowment in one round (last contribution event of the round)."""
    if not t.contributions:
        return None
    c = t.contributions[-1]
    endowment = float(c.get("endowment_tokens") or 0)
    if endowment <= 0:
        return None
    return float(c.get("contributed_tokens") or 0) / endowment


def _partner(t: Trial) -> tuple[str | None, bool]:
    ptype = t.partner_type
    is_error = False
    for a in t.partner_actions:
        ptype = str(a.get("partner_type") or ptype)
        is_error = is_error or bool(a.get("is_error"))
    return ptype, is_error


def _rounds(trials: Sequence[Trial]) -> list[tuple[Trial, float]]:
    out = [(t, s) for t in sorted(trials, key=lambda t: t.trial_index) if (s := contribution_share(t)) is not None]
    return out


@session_formula("public_goods.mean_contribution")
def mean_contribution(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Mean contributed share of the endowment across rounds."""
    vals = [s for _, s in _rounds(trials)]
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


def _post_partner(trials: Sequence[Trial], predicate: str) -> tuple[list[float], list[float]]:
    rounds = _rounds(trials)
    post: list[float] = []
    other: list[float] = []
    for i, (_, share) in enumerate(rounds):
        if i == 0:
            other.append(share)
            continue
        ptype, is_error = _partner(rounds[i - 1][0])
        hit = is_error if predicate == "error" else (ptype == "free_rider" and not is_error)
        (post if hit else other).append(share)
    return post, other


@session_formula("public_goods.post_defection_maintenance")
def post_defection(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share maintained after free-rider rounds relative to the person's own baseline:
    ``(mean share after a free rider + c) / (mean share in the other rounds + c)`` with smoothing ``c``
    (``public_goods.ratio_smoothing``). 1 = fully maintained; the difference is in ``details``."""
    post, other = _post_partner(trials, "defection")
    if not post or not other:
        return IndicatorValue.empty(len(post))
    c = ctx.params.f("public_goods.ratio_smoothing")
    ratio = (float(np.mean(post)) + c) / (float(np.mean(other)) + c)
    return IndicatorValue(value=ratio, n_valid=len(post), details={"difference": float(np.mean(post) - np.mean(other))})


@session_formula("public_goods.post_error_contribution")
def post_error(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share after the scripted partner-error round minus the mean share in the other rounds (single event)."""
    post, other = _post_partner(trials, "error")
    if not post or not other:
        return IndicatorValue.empty(len(post))
    return IndicatorValue(value=float(np.mean(post) - np.mean(other)), n_valid=len(post))


@session_formula("public_goods.unprompted_share_rate")
def unprompted_share(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share of rounds whose contribution was made before any prompt (``contribution.unprompted``)."""
    rounds = [t for t in trials if t.contributions]
    k = sum(1 for t in rounds if t.contributions[-1].get("unprompted"))
    n = len(rounds)
    return IndicatorValue(value=k / n if n else None, n_valid=n, details={"k": k, "n": n})


@session_formula("coplay.turn_waiting_rate")
def turn_waiting(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share of partner turns the player waits through without interrupting (player slot 1's view)."""
    partner_turns = 0
    waited = 0
    for t in trials:
        starts = [e for e in t.turn_events if e.get("kind") == "turn_start"]
        if not starts or int(starts[0].get("player_slot", 1)) == 1:
            continue
        partner_turns += 1
        interrupted = any(e.get("kind") == "interruption" and int(e.get("player_slot", 1)) == 1 for e in t.turn_events)
        waited += not interrupted
    return IndicatorValue(value=waited / partner_turns if partner_turns else None, n_valid=partner_turns)


@session_formula("coplay.interruption_rate")
def interruptions(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Interruptions by player slot 1 per partner turn."""
    partner_turns = 0
    count = 0
    for t in trials:
        starts = [e for e in t.turn_events if e.get("kind") == "turn_start"]
        if not starts or int(starts[0].get("player_slot", 1)) == 1:
            continue
        partner_turns += 1
        count += sum(1 for e in t.turn_events if e.get("kind") == "interruption" and int(e.get("player_slot", 1)) == 1)
    return IndicatorValue(value=count / partner_turns if partner_turns else None, n_valid=partner_turns)


@session_formula("coplay.credit_share")
def coplay_credit(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Mean share of credit given to the partner after joint outcomes (1 - self share)."""
    vals = [
        1.0 - float(c["self_share"])
        for t in trials
        for c in t.credit_allocations
        if c.get("allocation_context") == "coplay_outcome"
    ]
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


@session_formula("credit.self_share_success")
def credit_taking(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Mean self-allocated credit after the shared discovery of fraud."""
    vals = [
        float(c["self_share"])
        for t in trials
        for c in t.credit_allocations
        if c.get("allocation_context") == "fraud_found"
    ]
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


@session_formula("credit.blame_shift_failure")
def blame_shifting(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share of own-error dilemmas in which blame goes to the assistant or to chance."""
    allocs = [c for t in trials for c in t.credit_allocations if c.get("allocation_context") == "assistant_mistake"]
    k = sum(1 for c in allocs if c.get("target") in ("assistant", "chance"))
    n = len(allocs)
    return IndicatorValue(value=k / n if n else None, n_valid=n, details={"k": k, "n": n})


@session_formula("credit.cross_dilemma_consistency")
def accountability_consistency(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """1 - 2 * SD of per-dilemma accountability (credit dilemmas: 1 - self share; blame: self share).

    Accountability values lie in [0, 1] so their SD is at most .5; the index is 1 when every dilemma gets
    the same accountability and 0 at maximal inconsistency. Requires >= 3 dilemmas of each type.
    """
    credit = [
        1.0 - float(c["self_share"])
        for t in trials
        for c in t.credit_allocations
        if c.get("allocation_context") == "fraud_found"
    ]
    blame = [
        float(c["self_share"])
        for t in trials
        for c in t.credit_allocations
        if c.get("allocation_context") == "assistant_mistake"
    ]
    vals = credit + blame
    if len(credit) < 3 or len(blame) < 3:
        return IndicatorValue.empty(len(vals), "fewer_than_3_per_type")
    return IndicatorValue(value=1.0 - 2.0 * float(np.std(vals, ddof=0)), n_valid=len(vals))


def _rate(trials: Sequence[Trial], code: str) -> IndicatorValue:
    answered = [t for t in trials if t.responded and t.response is not None]
    k = sum(1 for t in answered if t.response is not None and t.response.value == code)
    n = len(answered)
    return IndicatorValue(value=k / n if n else None, n_valid=n, details={"k": k, "n": n})


@session_formula("dilemma.bribe_acceptance_rate")
def bribe_acceptance(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share of bribe offers accepted (restricted; never an individual dishonesty classification)."""
    return _rate(trials, "accept")


@session_formula("dilemma.overpayment_return_rate")
def overpayment_return(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share of overpayments returned."""
    return _rate(trials, "return")


@session_formula("dilemma.gamble_rate")
def gamble_rate(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share of gamble-inspection choices that skip inspection for the larger reward."""
    return _rate(trials, "gamble")


def tone_ordinal(t: Trial, ctx: FormulaContext | BatchContext) -> float | None:
    """Ordinal tone of a tone-choice response (``tone.ordinal`` map), None when not answered."""
    if not t.responded or t.response is None or t.response.value is None:
        return None
    mapping = ctx.params.get("tone.ordinal")
    v = mapping.get(t.response.value)
    return None if v is None else float(v)


@session_formula("tone.after_unfair_loss")
def tone_after_unfair_loss(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Ordinal tone chosen after the scripted unfair-loss round (single event; exploratory)."""
    vals = [v for t in trials if (v := tone_ordinal(t, ctx)) is not None]
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


@session_formula("tone.after_provocation")
def tone_after_provocation(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Mean ordinal tone on rude-run trials with a hostile customer (level >= ``tone.hostile_level_min``)."""
    hostile = ctx.params.i("tone.hostile_level_min")
    vals = [
        v
        for t in trials
        if t.shift_kind == "rude_customer_run"
        and (t.customer_tone_level or 0) >= hostile
        and (v := tone_ordinal(t, ctx)) is not None
    ]
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


# ---------------------------------------------------------------- group level only (private reports)


def _reports(units: Sequence[BatchUnit], ctx: BatchContext) -> list[list[int]]:
    """Reported values per participant (participants below ``min_reports_per_participant`` are dropped)."""
    min_reports = ctx.params.i("private_report.min_reports_per_participant")
    per: list[list[int]] = []
    for u in units:
        vals = [int(r["reported_value"]) for t in u.trials for r in t.reports]
        if vals and len(vals) >= min_reports:
            per.append(vals)
    return per


def _suppressed(per: list[list[int]], ctx: BatchContext) -> GroupValue | None:
    """Small-cell suppression: no estimate over fewer than ``min_group_participants`` participants."""
    min_group = ctx.params.i("private_report.min_group_participants")
    if len(per) >= min_group:
        return None
    return GroupValue(
        None,
        None,
        None,
        len(per),
        sum(len(p) for p in per),
        details={"suppressed_small_group": True, "min_group_participants": min_group},
    )


def _bootstrap_group(
    per: list[list[int]], stat: Callable[[list[int]], float], seed: int, reps: int = 2000
) -> tuple[float, float]:
    rng = np.random.default_rng(seed)
    n = len(per)
    boots = []
    for _ in range(reps):
        idx = rng.integers(0, n, n)
        sample = [v for i in idx for v in per[i]]
        boots.append(stat(sample))
    lo, hi = np.percentile(boots, [2.5, 97.5])
    return float(lo), float(hi)


@group_formula("group.dice_overreport_rate")
def dice_overreport(units: Sequence[BatchUnit], ctx: BatchContext) -> GroupValue:
    """Observed share of high reports minus the fair-die expectation (true outcomes are never logged).

    Participant-clustered bootstrap CI. Group level only: no participant key exists in the output, and
    groups smaller than ``private_report.min_group_participants`` are suppressed.
    """
    high = {int(v) for v in ctx.params.get("private_report.high_values")}
    faces = ctx.params.i("private_report.faces")
    expected = len(high) / faces
    per = _reports(units, ctx)
    flat = [v for p in per for v in p]
    if not flat:
        return GroupValue(None, None, None, 0, 0)
    if (small := _suppressed(per, ctx)) is not None:
        return small

    def stat(sample: list[int]) -> float:
        return sum(1 for v in sample if v in high) / len(sample) - expected

    lo, hi = _bootstrap_group(per, stat, seed=len(flat))
    return GroupValue(stat(flat), lo, hi, len(per), len(flat), details={"expected_high_share": expected})


@group_formula("group.dice_distribution_skew")
def dice_skew(units: Sequence[BatchUnit], ctx: BatchContext) -> GroupValue:
    """Kullback-Leibler divergence (bits) of the reported-value distribution from uniform, with a
    participant-clustered bootstrap CI; the mean report minus the fair expectation is in ``details``."""
    faces = ctx.params.i("private_report.faces")
    per = _reports(units, ctx)
    flat = [v for p in per for v in p]
    if not flat:
        return GroupValue(None, None, None, 0, 0)
    if (small := _suppressed(per, ctx)) is not None:
        return small

    def stat(sample: list[int]) -> float:
        counts = np.bincount(np.asarray(sample) - 1, minlength=faces).astype(float)
        p = counts / counts.sum()
        nz = p > 0
        return float(np.sum(p[nz] * np.log2(p[nz] * faces)))

    lo, hi = _bootstrap_group(per, stat, seed=len(flat) + 1)
    mean_shift = float(np.mean(flat)) - (faces + 1) / 2.0
    return GroupValue(stat(flat), lo, hi, len(per), len(flat), details={"mean_shift": mean_shift})
