"""Data-quality flag engine (SCR-12): per-session flags, grade and validity booleans.

Flags are heuristics that protect validity; they are never punitive and never shown to players. Flagged
sessions get only a thank-you report (``valid_for_report = false``). Thresholds live in
``data/scoring_params.yaml`` (``quality``) and ``stats/measurement-model/gates.yaml`` (differential exclusion).

Private-report (dice / luck token) responses are deliberately excluded from every careless-responding
check: an individual's private reports must never feed any individual classification (plan section 1,
non-negotiable 6).
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from shriii_scoring.canonical import SessionRecord, Trial
from shriii_scoring.params import ScoringParams

__all__ = ["DifferentialExclusion", "SessionQuality", "assess_session", "differential_exclusion"]

Grade = Literal["usable", "caution", "exclude"]

CHOICE_TRIAL_TYPES = frozenset(
    {
        "sort",
        "choice",
        "weigh_decision",
        "fork_choice",
        "probe",
        "tone_choice",
        "delay_choice",
        "effort_choice",
        "bribe",
        "overpayment",
        "gamble_inspection",
    }
)
PRIVATE_TRIAL_TYPES = frozenset({"report", "luck_token"})


@dataclass(frozen=True, slots=True)
class SessionQuality:
    """Quality assessment of one session."""

    session_id: str
    flags: tuple[str, ...]
    grade: Grade
    valid_for_validation: bool
    valid_for_report: bool
    details: Mapping[str, Any] = field(default_factory=dict)


def _responses_in_order(trials: Iterable[Trial]) -> list[Trial]:
    return sorted(
        (t for t in trials if t.scorable and t.trial_type not in PRIVATE_TRIAL_TYPES and t.response is not None),
        key=lambda t: t.response.seq if t.response else t.seq_min,
    )


def _longest_fast_run(trials: Sequence[Trial], fast_ms: float) -> tuple[int, int, int]:
    longest = run = fast = n = 0
    for t in trials:
        r = t.response
        if r is None or r.latency_ms is None or r.input_mode == "timeout":
            run = 0
            continue
        n += 1
        if 0 <= r.latency_ms < fast_ms:
            run += 1
            fast += 1
            longest = max(longest, run)
        else:
            run = 0
    return longest, fast, n


def _same_position_share(trials: Sequence[Trial], grid: int) -> tuple[float, int]:
    cells: Counter[tuple[int, int]] = Counter()
    for t in trials:
        r = t.response
        if t.trial_type not in CHOICE_TRIAL_TYPES or r is None or r.touch_xy is None or r.input_mode == "timeout":
            continue
        x, y = r.touch_xy
        cells[(min(int(x * grid), grid - 1), min(int(y * grid), grid - 1))] += 1
    n = sum(cells.values())
    if n == 0:
        return 0.0, 0
    return max(cells.values()) / n, n


def _zero_variance_modules(session: SessionRecord, min_trials: int) -> list[str]:
    hits: list[str] = []
    for mid, m in sorted(session.modules.items()):
        trials = [t for t in m.trials if t.scorable and t.trial_type not in PRIVATE_TRIAL_TYPES]
        lat = [t.response.latency_ms for t in trials if t.response and t.response.latency_ms is not None]
        if len(lat) >= min_trials and len(set(lat)) == 1:
            hits.append(f"{mid}:latency")
        choices = [
            t.response.value for t in trials if t.trial_type in CHOICE_TRIAL_TYPES and t.responded and t.response
        ]
        if len(choices) >= min_trials and len(set(choices)) == 1:
            hits.append(f"{mid}:choice")
        contrib = [c.get("contributed_tokens") for t in trials for c in t.contributions]
        if len(contrib) >= min_trials and len(set(contrib)) == 1:
            hits.append(f"{mid}:contribution")
    return hits


def assess_session(session: SessionRecord, params: ScoringParams) -> SessionQuality:
    """Compute flags, grade and validity for one canonical session."""
    q = "quality."
    flags: set[str] = set()
    details: dict[str, Any] = {}
    ordered = _responses_in_order(session.trials)
    longest, fast, n_lat = _longest_fast_run(ordered, params.f(q + "careless.fast_rt_ms"))
    details["fast_run_longest"] = longest
    details["fast_share"] = fast / n_lat if n_lat else 0.0
    if longest >= params.i(q + "careless.fast_run_length") or (
        n_lat and fast / n_lat >= params.f(q + "careless.fast_share_exclude")
    ):
        flags.add("careless_fast_runs")
    share, n_pos = _same_position_share(ordered, params.i(q + "careless.position_grid"))
    details["same_position_share"] = share
    if n_pos >= params.i(q + "careless.same_position_min_trials") and share >= params.f(
        q + "careless.same_position_share"
    ):
        flags.add("careless_same_position")
    zv = _zero_variance_modules(session, params.i(q + "careless.zero_variance_min_trials"))
    details["zero_variance"] = zv
    if zv:
        flags.add("careless_zero_variance")
    if session.walkaway_prompts > 0:
        flags.add("walkaway")
    if session.abandoned:
        flags.add("abandoned")
    if any(m.ended_reason in ("walkaway", "time_cap", "withdrawn", "error") for m in session.modules.values()):
        flags.add("module_incomplete")
    if session.asr_confidences:
        low = sum(1 for c in session.asr_confidences if c < params.f(q + "asr.low_confidence"))
        details["asr_low_share"] = low / len(session.asr_confidences)
        if low / len(session.asr_confidences) >= params.f(q + "asr.low_confidence_share"):
            flags.add("asr_low_confidence")
    trial_events = sum(len(t.event_times) for t in session.trials)
    flagged = sum(1 for t in session.trials if t.timing_flag != "ok")
    n_trials = len(session.trials)
    timing_share = flagged / n_trials if n_trials else 0.0
    details["timing_flag_share"] = timing_share
    details["trial_events"] = trial_events
    if timing_share >= params.f(q + "device.timing_flag_share_exclude"):
        flags.add("device_timing_exclude")
    elif timing_share >= params.f(q + "device.timing_flag_share_caution"):
        flags.add("device_timing_caution")
    profile = session.timing_profile or ""
    if any(profile.startswith(p) for p in params.strs(q + "device.uncertified_profile_prefixes")):
        flags.add("device_uncertified_timing")
    if session.onlooker_reports > 0:
        flags.add("possible_assistance")
    linked = (session.session_context or {}).get("linked_prior_session_token")
    if session.mode != "retest" and (session.played_before == "yes" or linked):
        flags.add("repeat_play")
    if session.seq_gaps:
        flags.add("seq_gap")
    if session.seq_conflicts:
        flags.add("seq_conflict")
    excl = set(params.strs(q + "grades.exclude"))
    caution = set(params.strs(q + "grades.caution"))
    grade: Grade = "exclude" if flags & excl else "caution" if flags & caution else "usable"
    return SessionQuality(
        session_id=session.session_id,
        flags=tuple(sorted(flags)),
        grade=grade,
        valid_for_validation=grade not in set(params.strs(q + "valid_for_validation_excludes")),
        valid_for_report=grade not in set(params.strs(q + "valid_for_report_excludes")),
        details=details,
    )


@dataclass(frozen=True, slots=True)
class DifferentialExclusion:
    """Exclusion rates by group for one grouping variable, and the fairness warning (SCR-12 AC)."""

    grouping: str
    rates: Mapping[str, float]
    counts: Mapping[str, int]
    max_difference_pp: float
    threshold_pp: float
    warning: bool
    suppressed_groups: tuple[str, ...]


def differential_exclusion(
    qualities: Sequence[SessionQuality],
    groups: Mapping[str, Mapping[str, str | None]],
    groupings: Sequence[str],
    threshold_pp: float,
    min_cell_n: int,
) -> list[DifferentialExclusion]:
    """Compare exclusion rates (grade ``exclude``) across groups; cells with n < ``min_cell_n`` are suppressed.

    ``groups`` maps session_id -> {grouping: group label}. ``threshold_pp`` comes from ``gates.yaml``
    (``battery_gate.differential_exclusion_max_pp``) and ``min_cell_n`` from ``quality.fairness_cell_min_n``.
    """
    out: list[DifferentialExclusion] = []
    for g in groupings:
        n: dict[str, int] = defaultdict(int)
        ex: dict[str, int] = defaultdict(int)
        for q in qualities:
            label = groups.get(q.session_id, {}).get(g)
            if label is None or label == "prefer_not_to_say":
                continue
            n[label] += 1
            ex[label] += q.grade == "exclude"
        rates = {k: ex[k] / n[k] for k in sorted(n) if n[k] >= min_cell_n}
        suppressed = tuple(sorted(k for k in n if n[k] < min_cell_n))
        diff = (max(rates.values()) - min(rates.values())) * 100.0 if len(rates) >= 2 else 0.0
        out.append(
            DifferentialExclusion(
                grouping=g,
                rates=rates,
                counts={k: n[k] for k in sorted(n)},
                max_difference_pp=diff if not math.isnan(diff) else 0.0,
                threshold_pp=threshold_pp,
                warning=diff > threshold_pp,
                suppressed_groups=suppressed,
            )
        )
    return out
