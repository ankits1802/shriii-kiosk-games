"""Trial canonicalisation: raw events (layer 1) -> ordered sessions, modules and trials.

Rules (ING-05, SCR-02):

* Events are grouped by ``session_id`` and ordered by ``seq`` (never by wall clock). Exact duplicates
  (same ``event_id``) are dropped; two different events with the same ``seq`` are a ``seq_conflict``;
  missing ``seq`` values are recorded as gaps. ``invalid`` placeholders keep ``seq`` gapless and are
  counted but never reach indicators.
* A trial is the run of trial-level events sharing ``task.trial_id`` within a module, opened by
  ``trial_start``; its committed response is the last ``response`` event.
* A trial is ``scorable`` only if every attached event is scorable and its phase is not practice/warm-up.
* Context shifts are attached to modules; a trial is post-shift when its ``trial_index`` is at or after
  the shift's ``shift_index`` (switch points are never inferred from phases).
* ``GameTrialSpec.params`` (scheduler / solver output) are joined by ``(session_id, trial_id)``.

The output is invariant to the input row order.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

__all__ = [
    "ContextShift",
    "Hold",
    "ModuleRecord",
    "RawTap",
    "Response",
    "SessionRecord",
    "Trial",
    "canonicalise",
    "pathway_of",
]

NON_SCORABLE_PHASES = frozenset({"practice", "warmup"})
TRIAL_EVENT_TYPES = frozenset(
    {
        "trial_start",
        "stimulus_onset",
        "prompt_audio_end",
        "prompt_window_open",
        "prompt_window_close",
        "response",
        "asr_result",
        "input.raw_tap",
        "input.hold",
        "trial_end",
        "move",
        "route_step",
        "contribution",
        "pump",
        "report",
        "partner_action",
        "turn_event",
        "credit_allocation",
        "idle",
    }
)


@dataclass(frozen=True, slots=True)
class Response:
    """A ``response`` event (committed closed-code answer)."""

    seq: int
    t_ms: float
    value: str | None
    correctness: bool | None
    input_mode: str
    latency_ms: float | None
    latency_anchor: str
    barge_in: bool
    hold_ms: float | None
    tap_count: int
    revisions: tuple[tuple[str, float], ...]
    touch_xy: tuple[float, float] | None
    asr_confidence: float | None


@dataclass(frozen=True, slots=True)
class RawTap:
    """An ``input.raw_tap`` event."""

    seq: int
    t_ms: float
    target_id: str | None
    pointer_t_ms: float
    anchor_offset_ms: float | None
    classification: str
    touch_xy: tuple[float, float]
    trial_id: str | None


@dataclass(frozen=True, slots=True)
class Hold:
    """An ``input.hold`` event."""

    seq: int
    t_ms: float
    target_id: str
    hold_ms: float
    required_hold_ms: float
    completed: bool


@dataclass(frozen=True, slots=True)
class ContextShift:
    """A ``context_shift`` event attached to its module."""

    seq: int
    t_ms: float
    kind: str
    announced: bool
    shift_index: int
    trial_id: str | None


@dataclass(slots=True)
class Trial:
    """One canonical trial (layer 1 -> trial table)."""

    session_id: str
    module_id: str
    episode_id: str | None
    block: str
    trial_id: str
    trial_index: int
    trial_type: str
    stimulus_id: str | None
    form_id: str | None
    probe_group_id: str | None
    anchor_trial: bool
    phase: str
    condition_id: str | None
    shift_active: bool
    timer: bool
    noise: bool
    calibration_level: str | None
    partner_type: str | None
    customer_tone_level: int | None
    response_window_ms: int | None
    expected_response: str | None
    private_report: bool
    start_ms: float
    onset_ms: float | None = None
    audio_end_ms: float | None = None
    end_ms: float | None = None
    outcome: str | None = None
    trial_correctness: bool | None = None
    duration_ms: float | None = None
    scorable: bool = True
    interrupted: bool = False
    timing_flag: str = "ok"
    responses: list[Response] = field(default_factory=list)
    taps: list[RawTap] = field(default_factory=list)
    holds: list[Hold] = field(default_factory=list)
    moves: list[Mapping[str, Any]] = field(default_factory=list)
    route_steps: list[Mapping[str, Any]] = field(default_factory=list)
    pumps: list[Mapping[str, Any]] = field(default_factory=list)
    contributions: list[Mapping[str, Any]] = field(default_factory=list)
    partner_actions: list[Mapping[str, Any]] = field(default_factory=list)
    credit_allocations: list[Mapping[str, Any]] = field(default_factory=list)
    reports: list[Mapping[str, Any]] = field(default_factory=list)
    turn_events: list[Mapping[str, Any]] = field(default_factory=list)
    idles: list[Mapping[str, Any]] = field(default_factory=list)
    prompt_ends: list[tuple[str, float]] = field(default_factory=list)
    event_times: list[tuple[str, float, int]] = field(default_factory=list)
    params: Mapping[str, Any] = field(default_factory=dict)
    params_present: bool = False
    seq_min: int = 0
    seq_max: int = 0
    block_pos: int = 0
    shift_kind: str | None = None
    shift_index: int | None = None
    shift_ordinal: int = 0
    trials_since_shift: int | None = None
    closed: bool = False
    latency_valid: bool = True

    @property
    def response(self) -> Response | None:
        """The committed response (last ``response`` event), if any."""
        return self.responses[-1] if self.responses else None

    @property
    def post_shift(self) -> bool:
        return self.shift_kind is not None

    @property
    def responded(self) -> bool:
        r = self.response
        return r is not None and r.input_mode != "timeout" and r.value is not None

    @property
    def correct(self) -> bool | None:
        """Correctness of the committed response, falling back to the trial-end correctness."""
        r = self.response
        if r is not None and r.correctness is not None:
            return r.correctness
        return self.trial_correctness


@dataclass(slots=True)
class ModuleRecord:
    """Events of one module/episode within a session."""

    module_id: str
    kind: str | None = None
    started_ms: float | None = None
    ended_reason: str | None = None
    duration_ms: float | None = None
    trials: list[Trial] = field(default_factory=list)
    shifts: list[ContextShift] = field(default_factory=list)
    taps: list[RawTap] = field(default_factory=list)
    reports: list[Mapping[str, Any]] = field(default_factory=list)
    seq_min: int | None = None
    seq_max: int | None = None


@dataclass(slots=True)
class SessionRecord:
    """One reconstructed session with integrity information."""

    session_id: str
    participant_pid: str | None
    pathway: str | None
    language: str | None
    site_mode: str | None
    mode: str | None
    battery_arm: str | None
    slot_form: str | None
    synthetic: bool
    calibration_level: str | None
    timing_profile: str | None
    session_context: Mapping[str, Any] | None
    bands: Mapping[str, Any] | None
    modules: dict[str, ModuleRecord]
    n_events: int
    seq_min: int
    seq_max: int
    seq_gaps: tuple[int, ...]
    seq_conflicts: tuple[int, ...]
    duplicate_events: int
    invalid_events: int
    ended_reason: str | None
    abandoned: bool
    walkaway_prompts: int
    onlooker_reports: int
    asr_confidences: tuple[float, ...]
    timing_flags: Mapping[str, int]
    event_stream_sha256: str
    played_before: str | None

    @property
    def trials(self) -> list[Trial]:
        return [t for m in self.modules.values() for t in m.trials]


def pathway_of(battery_arm: str | None, module_ids: Iterable[str]) -> str | None:
    """Pathway from the arm (B_* -> B, A_* -> A) or, failing that, from the modules played."""
    if battery_arm:
        if battery_arm.startswith("B"):
            return "B"
        if battery_arm.startswith("A"):
            return "A"
    mods = set(module_ids)
    if mods & {"stall", "weighing_post", "road_home", "coplay"}:
        return "A"
    if mods & {"dont_tap", "card_sort", "balloon", "tower", "share_pot"}:
        return "B"
    return None


def _xy(v: Any) -> tuple[float, float] | None:
    if v is None:
        return None
    return (float(v[0]), float(v[1]))


def _block_suffix(module_id: str, block_id: str | None) -> str:
    if not block_id:
        return ""
    prefix = module_id + "."
    return block_id[len(prefix) :] if block_id.startswith(prefix) else block_id


def _stream_sha(events: Sequence[Mapping[str, Any]]) -> str:
    h = hashlib.sha256()
    for e in events:
        h.update(str(e.get("event_id")).encode())
        h.update(b"|")
        h.update(str(e.get("seq")).encode())
        h.update(b"\n")
    return h.hexdigest()


def _new_trial(e: Mapping[str, Any], task: Mapping[str, Any], cond: Mapping[str, Any] | None) -> Trial:
    p = e.get("payload") or {}
    module_id = str(task.get("module_id") or "")
    c = cond or {}
    return Trial(
        session_id=str(e["session_id"]),
        module_id=module_id,
        episode_id=task.get("episode_id"),
        block=_block_suffix(module_id, task.get("block_id")),
        trial_id=str(task.get("trial_id")),
        trial_index=int(task.get("trial_index") or 0),
        trial_type=str(p.get("trial_type", "")),
        stimulus_id=p.get("stimulus_id"),
        form_id=task.get("form_id"),
        probe_group_id=task.get("probe_group_id"),
        anchor_trial=bool(task.get("anchor_trial", False)),
        phase=str(c.get("phase", "main")),
        condition_id=c.get("condition_id"),
        shift_active=bool(c.get("shift_active", False)),
        timer=bool(c.get("timer", False)),
        noise=bool(c.get("noise", False)),
        calibration_level=c.get("calibration_level"),
        partner_type=c.get("partner_type"),
        customer_tone_level=c.get("customer_tone_level"),
        response_window_ms=p.get("response_window_ms"),
        expected_response=p.get("expected_response"),
        private_report=bool(p.get("private_report", False)),
        start_ms=float(e["timing"]["t_mono_ms"]),
        seq_min=int(e["seq"]),
        seq_max=int(e["seq"]),
    )


def _attach(trial: Trial, e: Mapping[str, Any]) -> None:
    et = e["event_type"]
    p = e.get("payload") or {}
    timing = e.get("timing") or {}
    seq = int(e["seq"])
    t = float(timing.get("t_mono_ms", 0.0))
    trial.seq_min = min(trial.seq_min, seq)
    trial.seq_max = max(trial.seq_max, seq)
    trial.event_times.append((et, t, seq))
    if not timing.get("scorable", True):
        trial.scorable = False
    if timing.get("interrupted", False):
        trial.interrupted = True
    flag = timing.get("timing_flag", "ok")
    if flag != "ok" and trial.timing_flag == "ok":
        trial.timing_flag = str(flag)
    if et == "stimulus_onset":
        if trial.onset_ms is None:
            trial.onset_ms = float(p.get("presented_onset_ms", t))
    elif et == "prompt_audio_end":
        end = float(p.get("audio_end_ms", t))
        trial.prompt_ends.append((str(p.get("line_id", "")), end))
        trial.audio_end_ms = end
    elif et == "response":
        revisions = tuple((str(r["value"]), float(r["t_ms"])) for r in (p.get("revisions") or []))
        trial.responses.append(
            Response(
                seq=seq,
                t_ms=t,
                value=p.get("response_value"),
                correctness=p.get("correctness"),
                input_mode=str(p.get("input_mode", "touch")),
                latency_ms=None if p.get("latency_ms") is None else float(p["latency_ms"]),
                latency_anchor=str(p.get("latency_anchor", "visual_onset")),
                barge_in=bool(p.get("barge_in", False)),
                hold_ms=None if p.get("hold_ms") is None else float(p["hold_ms"]),
                tap_count=int(p.get("tap_count", 0)),
                revisions=revisions,
                touch_xy=_xy(p.get("touch_xy_norm")),
                asr_confidence=p.get("asr_confidence"),
            )
        )
    elif et == "input.raw_tap":
        trial.taps.append(_tap(e))
    elif et == "input.hold":
        trial.holds.append(
            Hold(
                seq=seq,
                t_ms=t,
                target_id=str(p.get("target_id", "")),
                hold_ms=float(p.get("hold_ms", 0.0)),
                required_hold_ms=float(p.get("required_hold_ms", 0.0)),
                completed=bool(p.get("completed", False)),
            )
        )
    elif et == "trial_end":
        trial.end_ms = t
        trial.outcome = p.get("outcome")
        trial.trial_correctness = p.get("correctness")
        trial.duration_ms = None if p.get("duration_ms") is None else float(p["duration_ms"])
        trial.closed = True
    elif et in (
        "move",
        "route_step",
        "pump",
        "contribution",
        "partner_action",
        "credit_allocation",
        "report",
        "turn_event",
        "idle",
    ):
        rec = {**p, "_t_ms": t, "_seq": seq}
        {
            "move": trial.moves,
            "route_step": trial.route_steps,
            "pump": trial.pumps,
            "contribution": trial.contributions,
            "partner_action": trial.partner_actions,
            "credit_allocation": trial.credit_allocations,
            "report": trial.reports,
            "turn_event": trial.turn_events,
            "idle": trial.idles,
        }[et].append(rec)


def _tap(e: Mapping[str, Any]) -> RawTap:
    p = e.get("payload") or {}
    task = e.get("task") or {}
    t = float(e["timing"]["t_mono_ms"])
    return RawTap(
        seq=int(e["seq"]),
        t_ms=t,
        target_id=p.get("target_id"),
        pointer_t_ms=float(p.get("pointer_t_ms", t)),
        anchor_offset_ms=None if p.get("anchor_offset_ms") is None else float(p["anchor_offset_ms"]),
        classification=str(p.get("classification", "on_target")),
        touch_xy=_xy(p.get("touch_xy_norm")) or (0.0, 0.0),
        trial_id=task.get("trial_id"),
    )


def _assign_shifts(module: ModuleRecord) -> None:
    shifts = sorted(module.shifts, key=lambda s: (s.shift_index, s.seq))
    counts: dict[str, int] = defaultdict(int)
    for trial in module.trials:
        if trial.block and trial.block not in counts:
            counts[trial.block] = 0
        trial.block_pos = counts[trial.block]
        counts[trial.block] += 1
        active: ContextShift | None = None
        ordinal = 0
        for i, s in enumerate(shifts):
            if s.shift_index <= trial.trial_index:
                active = s
                ordinal = i + 1
        if active is not None:
            trial.shift_kind = active.kind
            trial.shift_index = active.shift_index
            trial.shift_ordinal = ordinal
            trial.trials_since_shift = trial.trial_index - active.shift_index


def _session(
    session_id: str,
    raw: Sequence[Mapping[str, Any]],
    trial_params: Mapping[str, Mapping[str, Any]] | None,
) -> SessionRecord:
    by_id: dict[str, Mapping[str, Any]] = {}
    duplicates = 0
    for e in sorted(raw, key=lambda x: (int(x["seq"]), str(x["event_id"]))):
        eid = str(e["event_id"])
        if eid in by_id:
            duplicates += 1
            continue
        by_id[eid] = e
    events = sorted(by_id.values(), key=lambda x: (int(x["seq"]), str(x["event_id"])))
    seqs = [int(e["seq"]) for e in events]
    conflicts = sorted({s for s, n in _count(seqs).items() if n > 1})
    present = set(seqs)
    gaps = tuple(s for s in range(min(present), max(present) + 1) if s not in present) if present else ()

    pid: str | None = None
    language: str | None = None
    ctx0: Mapping[str, Any] = events[0].get("context") or {} if events else {}
    session_context: Mapping[str, Any] | None = None
    bands: Mapping[str, Any] | None = None
    calibration: str | None = None
    slot_form = ctx0.get("slot_form")
    ended_reason: str | None = None
    abandoned = False
    walkaways = 0
    onlookers = 0
    invalid = 0
    asr: list[float] = []
    flags: dict[str, int] = defaultdict(int)
    modules: dict[str, ModuleRecord] = {}
    open_trials: dict[tuple[str, str], Trial] = {}
    trial_levels: dict[str, int] = defaultdict(int)
    timing_profile = (events[0].get("versions") or {}).get("timing_profile_version") if events else None

    def module(mid: str) -> ModuleRecord:
        if mid not in modules:
            modules[mid] = ModuleRecord(module_id=mid)
        return modules[mid]

    for e in events:
        et = str(e["event_type"])
        ctx = e.get("context") or {}
        if ctx.get("participant_pid"):
            pid = str(ctx["participant_pid"])
        if ctx.get("language"):
            language = str(ctx["language"])
        timing = e.get("timing") or {}
        flags[str(timing.get("timing_flag", "ok"))] += 1
        p = e.get("payload") or {}
        task = e.get("task") or {}
        cond = e.get("condition")
        if et == "invalid":
            invalid += 1
            continue
        if et == "session_start":
            slot_form = p.get("slot_form", slot_form)
        elif et == "session.context":
            session_context = p.get("context")
        elif et == "bands.answered":
            bands = p
        elif et == "calibration_result":
            calibration = p.get("level")
        elif et == "session_end":
            ended_reason = p.get("reason")
        elif et == "session.abandoned":
            abandoned = True
        elif et == "walkaway.prompted":
            walkaways += 1
        elif et == "onlooker_reported":
            onlookers += 1
        elif et == "asr_result" and p.get("asr_confidence") is not None:
            asr.append(float(p["asr_confidence"]))
        elif et == "module_start":
            m = module(str(p.get("module_id") or task.get("module_id")))
            m.kind = p.get("kind")
            m.started_ms = float(timing.get("t_mono_ms", 0.0))
        elif et == "module_end":
            m = module(str(p.get("module_id") or task.get("module_id")))
            m.ended_reason = p.get("ended_reason")
            m.duration_ms = p.get("duration_ms")
        elif et == "context_shift":
            mid = task.get("module_id")
            if mid:
                module(str(mid)).shifts.append(
                    ContextShift(
                        seq=int(e["seq"]),
                        t_ms=float(timing.get("t_mono_ms", 0.0)),
                        kind=str(p.get("kind")),
                        announced=bool(p.get("announced", False)),
                        shift_index=int(p.get("shift_index", 0)),
                        trial_id=task.get("trial_id"),
                    )
                )
        mid = task.get("module_id") if task else None
        if mid:
            m = module(str(mid))
            s = int(e["seq"])
            m.seq_min = s if m.seq_min is None else min(m.seq_min, s)
            m.seq_max = s if m.seq_max is None else max(m.seq_max, s)
            if et == "input.raw_tap":
                m.taps.append(_tap(e))
            if et == "report":
                m.reports.append({**p, "_t_ms": float(timing.get("t_mono_ms", 0.0)), "_seq": int(e["seq"])})
        if et not in TRIAL_EVENT_TYPES or not task or not task.get("trial_id") or not mid:
            continue
        key = (str(mid), str(task["trial_id"]))
        if et == "trial_start":
            trial = _new_trial(e, task, cond)
            params = (trial_params or {}).get(trial.trial_id)
            if params is not None:
                trial.params = params
                trial.params_present = True
            if trial.phase in NON_SCORABLE_PHASES:
                trial.scorable = False
            open_trials[key] = trial
            module(str(mid)).trials.append(trial)
            if trial.calibration_level:
                trial_levels[trial.calibration_level] += 1
            _attach(trial, e)
            continue
        trial_open = open_trials.get(key)
        if trial_open is None:
            continue
        _attach(trial_open, e)
        if et == "trial_end":
            open_trials.pop(key, None)

    for m in modules.values():
        m.trials.sort(key=lambda t: (t.trial_index, t.seq_min))
        _assign_shifts(m)
    if calibration is None and trial_levels:
        calibration = max(sorted(trial_levels), key=lambda k: trial_levels[k])
    if session_context and session_context.get("calibration_level") and calibration is None:
        calibration = session_context["calibration_level"]
    played_before = None
    if bands is not None:
        played_before = bands.get("played_before")
    elif session_context is not None:
        played_before = session_context.get("played_before")
    if language is None and session_context is not None:
        language = session_context.get("language")
    arm = ctx0.get("battery_arm")
    return SessionRecord(
        session_id=session_id,
        participant_pid=pid,
        pathway=pathway_of(arm, modules.keys()),
        language=language,
        site_mode=ctx0.get("site_mode"),
        mode=ctx0.get("mode"),
        battery_arm=arm,
        slot_form=slot_form,
        synthetic=bool(ctx0.get("synthetic", False)),
        calibration_level=calibration,
        timing_profile=timing_profile,
        session_context=session_context,
        bands=bands,
        modules=modules,
        n_events=len(events),
        seq_min=min(seqs) if seqs else 0,
        seq_max=max(seqs) if seqs else 0,
        seq_gaps=gaps,
        seq_conflicts=tuple(conflicts),
        duplicate_events=duplicates,
        invalid_events=invalid,
        ended_reason=ended_reason,
        abandoned=abandoned,
        walkaway_prompts=walkaways,
        onlooker_reports=onlookers,
        asr_confidences=tuple(asr),
        timing_flags=dict(flags),
        event_stream_sha256=_stream_sha(events),
        played_before=played_before,
    )


def _count(values: Iterable[int]) -> dict[int, int]:
    out: dict[int, int] = defaultdict(int)
    for v in values:
        out[v] += 1
    return out


def canonicalise(
    events: Iterable[Mapping[str, Any]],
    trial_params: Mapping[str, Mapping[str, Mapping[str, Any]]] | None = None,
) -> list[SessionRecord]:
    """Reconstruct sessions from raw event dicts.

    ``trial_params`` maps ``session_id -> trial_id -> GameTrialSpec.params``. Sessions are returned sorted
    by ``session_id``.
    """
    by_session: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for e in events:
        by_session[str(e["session_id"])].append(e)
    return [_session(sid, by_session[sid], (trial_params or {}).get(sid)) for sid in sorted(by_session)]
