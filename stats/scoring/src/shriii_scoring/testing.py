"""Test support: build canonical trials and formula contexts directly (hand-computed formula fixtures)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from shriii_scoring.canonical import ContextShift, Hold, ModuleRecord, RawTap, Response, SessionRecord, Trial
from shriii_scoring.dictionary import Dictionary, IndicatorSpec, load_dictionary
from shriii_scoring.formulas.base import FormulaContext
from shriii_scoring.params import ScoringParams, load_params

__all__ = ["make_context", "make_response", "make_session", "make_tap", "make_trial"]


def make_response(
    value: str | None,
    *,
    latency: float | None = 500.0,
    correct: bool | None = None,
    t: float = 0.0,
    revisions: Sequence[str] = (),
    xy: tuple[float, float] | None = (0.5, 0.5),
    input_mode: str | None = None,
) -> Response:
    mode = input_mode or ("timeout" if latency is None or value is None else "touch")
    return Response(
        seq=0,
        t_ms=t,
        value=value if mode != "timeout" else None,
        correctness=correct,
        input_mode=mode,
        latency_ms=None if mode == "timeout" else latency,
        latency_anchor="visual_onset",
        barge_in=False,
        hold_ms=None,
        tap_count=0 if mode == "timeout" else 1,
        revisions=tuple((r, t) for r in revisions),
        touch_xy=None if mode == "timeout" else xy,
        asr_confidence=None,
    )


def make_tap(
    classification: str, *, t: float = 0.0, offset: float | None = None, target: str | None = "target"
) -> RawTap:
    return RawTap(
        seq=0,
        t_ms=t,
        target_id=target,
        pointer_t_ms=t,
        anchor_offset_ms=offset,
        classification=classification,
        touch_xy=(0.5, 0.5),
        trial_id=None,
    )


def make_trial(
    trial_type: str,
    *,
    module: str = "m",
    block: str = "main",
    index: int = 0,
    phase: str = "main",
    response: Response | None = None,
    params: Mapping[str, Any] | None = None,
    onset: float = 0.0,
    end: float | None = None,
    outcome: str | None = None,
    correct: bool | None = None,
    taps: Sequence[RawTap] = (),
    holds: Sequence[Hold] = (),
    moves: Sequence[Mapping[str, Any]] = (),
    route_steps: Sequence[Mapping[str, Any]] = (),
    pumps: Sequence[Mapping[str, Any]] = (),
    contributions: Sequence[Mapping[str, Any]] = (),
    partner_actions: Sequence[Mapping[str, Any]] = (),
    credit: Sequence[Mapping[str, Any]] = (),
    reports: Sequence[Mapping[str, Any]] = (),
    turns: Sequence[Mapping[str, Any]] = (),
    partner_type: str | None = None,
    tone_level: int | None = None,
    shift_kind: str | None = None,
    shift_ordinal: int = 0,
    since_shift: int | None = None,
    probe_group: str | None = None,
    window: int | None = None,
    prompt_ends: Sequence[tuple[str, float]] = (),
) -> Trial:
    t = Trial(
        session_id="s1",
        module_id=module,
        episode_id=None,
        block=block,
        trial_id=f"{module}.t{index:03d}",
        trial_index=index,
        trial_type=trial_type,
        stimulus_id=None,
        form_id="form_1",
        probe_group_id=probe_group,
        anchor_trial=False,
        phase=phase,
        condition_id=None,
        shift_active=shift_kind is not None,
        timer=phase == "pressure",
        noise=False,
        calibration_level="L2",
        partner_type=partner_type,
        customer_tone_level=tone_level,
        response_window_ms=window,
        expected_response=None,
        private_report=False,
        start_ms=onset,
        onset_ms=onset,
        end_ms=end,
        outcome=outcome,
        trial_correctness=correct,
    )
    if response is not None:
        t.responses.append(response)
    t.taps.extend(taps)
    t.holds.extend(holds)
    t.moves.extend(moves)
    t.route_steps.extend(route_steps)
    t.pumps.extend(pumps)
    t.contributions.extend(contributions)
    t.partner_actions.extend(partner_actions)
    t.credit_allocations.extend(credit)
    t.reports.extend(reports)
    t.turn_events.extend(turns)
    t.prompt_ends.extend(prompt_ends)
    t.params = dict(params or {})
    t.params_present = params is not None
    t.shift_kind = shift_kind
    t.shift_ordinal = shift_ordinal
    t.trials_since_shift = since_shift
    return t


def make_session(
    trials: Sequence[Trial], *, shifts: Mapping[str, Sequence[ContextShift]] | None = None
) -> SessionRecord:
    modules: dict[str, ModuleRecord] = {}
    for t in trials:
        modules.setdefault(t.module_id, ModuleRecord(module_id=t.module_id)).trials.append(t)
    for mid, sh in (shifts or {}).items():
        modules.setdefault(mid, ModuleRecord(module_id=mid)).shifts.extend(sh)
    return SessionRecord(
        session_id="s1",
        participant_pid="PXD0001",
        pathway="B",
        language="hi-IN",
        site_mode="supervised",
        mode="pilot",
        battery_arm="B_fixed",
        slot_form=None,
        synthetic=False,
        calibration_level="L2",
        timing_profile="cert",
        session_context=None,
        bands=None,
        modules=modules,
        n_events=0,
        seq_min=0,
        seq_max=0,
        seq_gaps=(),
        seq_conflicts=(),
        duplicate_events=0,
        invalid_events=0,
        ended_reason="completed",
        abandoned=False,
        walkaway_prompts=0,
        onlooker_reports=0,
        asr_confidences=(),
        timing_flags={},
        event_stream_sha256="0" * 64,
        played_before="no",
    )


def make_context(
    indicator_id: str,
    session: SessionRecord,
    *,
    pathway: str = "B",
    params: ScoringParams | None = None,
    dictionary: Dictionary | None = None,
    game_configs: Mapping[str, Mapping[str, Any]] | None = None,
) -> FormulaContext:
    d = dictionary or load_dictionary(pathway)  # type: ignore[arg-type]
    spec: IndicatorSpec = d.indicators[indicator_id]
    return FormulaContext(
        spec=spec,
        session=session,
        dictionary=d,
        params=params or load_params(),
        game_configs=game_configs or {},
        anticipatory_ms=150.0,
    )
