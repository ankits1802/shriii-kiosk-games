"""Rebuild the session timeline (modules, trials, stimuli, responses, shifts, walkaway) from raw events.

Times are ``timing.t_mono_ms`` (session monotonic clock). Latencies are re-derived from the anchors in
the stream (``stimulus_onset.presented_onset_ms``, ``prompt_audio_end.audio_end_ms``, the
``prompt_window_open`` time for ``go_signal``) and compared with the logged ``latency_ms``.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from shriii_replay.load import Issue

LATENCY_TOLERANCE_MS = 1.0
"""A response logged earlier than ``anchor + latency_ms - tolerance`` cannot have that latency."""


@dataclass(slots=True)
class ResponseRow:
    seq: int
    t_ms: float
    value: str | None
    input_mode: str
    latency_ms: float | None
    latency_anchor: str | None
    barge_in: bool
    correctness: bool | None
    anchor_ms: float | None
    recomputed_latency_ms: float | None
    asr_label: str | None = None
    asr_confidence: float | None = None


@dataclass(slots=True)
class TrialRow:
    module_id: str
    trial_id: str
    trial_index: int | None
    block_id: str | None
    phase: str | None
    trial_type: str | None
    stimulus_id: str | None
    start_ms: float
    seq_min: int
    seq_max: int
    scorable: bool
    shift_active: bool
    timer: bool
    noise: bool
    calibration_level: str | None
    onset_ms: float | None = None
    requested_onset_ms: float | None = None
    audio_end_ms: float | None = None
    go_ms: float | None = None
    end_ms: float | None = None
    outcome: str | None = None
    correctness: bool | None = None
    response_window_ms: int | None = None
    interrupted: bool = False
    timing_flags: list[str] = field(default_factory=list)
    responses: list[ResponseRow] = field(default_factory=list)
    taps: int = 0
    other_events: Counter[str] = field(default_factory=Counter)


@dataclass(slots=True)
class ModuleSpan:
    module_id: str
    kind: str | None
    start_ms: float
    end_ms: float | None = None
    ended_reason: str | None = None
    episode_id: str | None = None
    trials: list[TrialRow] = field(default_factory=list)


@dataclass(slots=True)
class Marker:
    t_ms: float
    seq: int
    kind: str
    label: str
    module_id: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class Timeline:
    session_id: str | None
    participant_pid: str | None
    battery_arm: str | None
    pathway: str | None
    language: str | None
    mode: str | None
    site_mode: str | None
    synthetic: bool
    versions: dict[str, Any]
    seed: str | None
    start_ms: float
    end_ms: float
    end_reason: str | None
    modules: list[ModuleSpan]
    markers: list[Marker]
    states: list[Marker]
    event_counts: Counter[str]
    input_modes: Counter[str]
    issues: list[Issue]

    @property
    def trials(self) -> list[TrialRow]:
        return [t for m in self.modules for t in m.trials]


def _pathway(arm: str | None) -> str | None:
    if not arm:
        return None
    return arm[0] if arm[:1] in ("A", "B") else None


def _ms(v: Any, default: float) -> float:
    """A numeric time from untrusted input (replay renders events that failed validation)."""
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else default


def _obj(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def build_timeline(events: Sequence[dict[str, Any]]) -> Timeline:
    """``events`` must be one session, deduplicated and ordered by ``seq`` (see ``check_sequence``)."""
    issues: list[Issue] = []
    first = events[0] if events else {}
    ctx = _obj(first.get("context"))
    modules: dict[str, ModuleSpan] = {}
    module_order: list[str] = []
    trials: dict[tuple[str, str], TrialRow] = {}
    markers: list[Marker] = []
    states: list[Marker] = []
    counts: Counter[str] = Counter(e.get("event_type", "?") for e in events)
    modes: Counter[str] = Counter()
    seed: str | None = None
    end_reason: str | None = None
    times = [_ms(_obj(e.get("timing")).get("t_mono_ms"), 0.0) for e in events]

    def module(mid: str, t: float) -> ModuleSpan:
        if mid not in modules:
            modules[mid] = ModuleSpan(module_id=mid, kind=None, start_ms=t)
            module_order.append(mid)
        return modules[mid]

    for ev, t in zip(events, times, strict=True):
        et = ev.get("event_type", "?")
        seq = int(ev.get("seq", -1)) if isinstance(ev.get("seq"), int) else -1
        p = _obj(ev.get("payload"))
        task = _obj(ev.get("task"))
        cond = _obj(ev.get("condition"))
        timing = _obj(ev.get("timing"))
        mid = task.get("module_id")
        tid = task.get("trial_id")

        if et == "session_start":
            seed = p.get("seed")
        elif et == "session_end":
            end_reason = p.get("reason")
        elif et == "session.state_changed":
            states.append(Marker(t, seq, "state", str(p.get("to_state")), detail=dict(p)))
        elif et == "module_start" and isinstance(p.get("module_id"), str):
            m = module(p["module_id"], t)
            m.kind = p.get("kind")
            m.start_ms = t
            m.episode_id = task.get("episode_id")
        elif et == "module_end" and isinstance(p.get("module_id"), str):
            m = module(p["module_id"], t)
            m.end_ms = t
            m.ended_reason = p.get("ended_reason")
        elif et == "context_shift":
            markers.append(
                Marker(
                    t,
                    seq,
                    "shift",
                    f"{p.get('kind')}{' (announced)' if p.get('announced') else ''} @ trial {p.get('shift_index')}",
                    mid,
                    dict(p),
                )
            )
        elif et in ("walkaway.prompted", "walkaway.resumed", "session.abandoned", "idle"):
            label = {
                "walkaway.prompted": f"walkaway: {p.get('stage')}",
                "walkaway.resumed": f"resumed after {p.get('stage')}",
                "session.abandoned": f"abandoned ({p.get('reason')})",
                "idle": f"idle {p.get('duration_ms')} ms",
            }[et]
            markers.append(Marker(t, seq, et, label, mid, dict(p)))
        elif et in ("invalid", "instruction_replay", "ui.replay", "onlooker_reported", "researcher_annotation"):
            markers.append(Marker(t, seq, et, et if et != "invalid" else f"invalid: {p.get('reason')}", mid, dict(p)))
        elif et == "device_health":
            markers.append(Marker(t, seq, et, f"device: p99 frame {p.get('frame_time_p99_ms')} ms", mid, dict(p)))

        if not (isinstance(mid, str) and isinstance(tid, str)):
            continue
        key = (mid, tid)
        trial = trials.get(key)
        if trial is None:
            # The first event of a trial opens it (normally trial_start; tolerate logger reordering).
            trial = TrialRow(
                module_id=mid,
                trial_id=tid,
                trial_index=task.get("trial_index"),
                block_id=task.get("block_id"),
                phase=cond.get("phase"),
                trial_type=None,
                stimulus_id=None,
                start_ms=t,
                seq_min=seq,
                seq_max=seq,
                scorable=bool(timing.get("scorable", False)),
                shift_active=bool(cond.get("shift_active", False)),
                timer=bool(cond.get("timer", False)),
                noise=bool(cond.get("noise", False)),
                calibration_level=cond.get("calibration_level"),
            )
            trials[key] = trial
            module(mid, t).trials.append(trial)
        trial.seq_min = min(trial.seq_min, seq)
        trial.seq_max = max(trial.seq_max, seq)
        trial.interrupted = trial.interrupted or bool(timing.get("interrupted", False))
        flag = timing.get("timing_flag")
        if isinstance(flag, str) and flag != "ok" and flag not in trial.timing_flags:
            trial.timing_flags.append(flag)
        if et == "trial_start":
            trial.start_ms = t
            trial.trial_type = p.get("trial_type")
            trial.stimulus_id = p.get("stimulus_id")
            trial.response_window_ms = p.get("response_window_ms")
        elif et == "stimulus_onset":
            trial.onset_ms = _ms(p.get("presented_onset_ms"), t)
            trial.requested_onset_ms = p.get("requested_onset_ms")
            trial.stimulus_id = trial.stimulus_id or p.get("stimulus_id")
        elif et == "prompt_audio_end":
            trial.audio_end_ms = _ms(p.get("audio_end_ms"), t)
        elif et == "prompt_window_open":
            trial.go_ms = t
        elif et == "trial_end":
            trial.end_ms = t
            trial.outcome = p.get("outcome")
            trial.correctness = p.get("correctness")
        elif et == "input.raw_tap":
            trial.taps += 1
        elif et == "response":
            r = _response(p, t, seq, trial)
            trial.responses.append(r)
            modes[r.input_mode] += 1
            if (
                r.latency_ms is not None
                and r.anchor_ms is not None
                and t < r.anchor_ms + r.latency_ms - LATENCY_TOLERANCE_MS
            ):
                issues.append(
                    Issue(
                        "warning",
                        "latency_inconsistent",
                        f"seq {seq} ({mid}/{tid})",
                        f"latency_ms {r.latency_ms} but the response was logged {t - r.anchor_ms:.3f} ms after "
                        f"its {r.latency_anchor} anchor",
                    )
                )
            if r.latency_ms is not None and r.latency_anchor and r.anchor_ms is None:
                issues.append(
                    Issue(
                        "info",
                        "latency_anchor_missing",
                        f"seq {seq} ({mid}/{tid})",
                        f"no {r.latency_anchor} event before this response; latency cannot be re-derived",
                    )
                )
        else:
            trial.other_events[et] += 1

    for m in modules.values():
        if m.end_ms is None and m.trials:
            last = max((tr.end_ms or tr.start_ms) for tr in m.trials)
            m.end_ms = last
            issues.append(Issue("warning", "module_not_ended", m.module_id, "module has no module_end event"))
        for tr in m.trials:
            if tr.end_ms is None:
                issues.append(
                    Issue("warning", "trial_not_ended", f"{m.module_id}/{tr.trial_id}", "trial has no trial_end event")
                )
    return Timeline(
        session_id=first.get("session_id"),
        participant_pid=ctx.get("participant_pid"),
        battery_arm=ctx.get("battery_arm"),
        pathway=_pathway(ctx.get("battery_arm")),
        language=ctx.get("language"),
        mode=ctx.get("mode"),
        site_mode=ctx.get("site_mode"),
        synthetic=bool(ctx.get("synthetic", False)),
        versions=dict(first.get("versions") or {}),
        seed=seed,
        start_ms=min(times) if times else 0.0,
        end_ms=max(times) if times else 0.0,
        end_reason=end_reason,
        modules=[modules[m] for m in module_order],
        markers=markers,
        states=states,
        event_counts=counts,
        input_modes=modes,
        issues=issues,
    )


def _response(p: dict[str, Any], t: float, seq: int, trial: TrialRow) -> ResponseRow:
    anchor = p.get("latency_anchor")
    anchor_ms = {"visual_onset": trial.onset_ms, "audio_end": trial.audio_end_ms, "go_signal": trial.go_ms}.get(
        anchor if isinstance(anchor, str) else ""
    )
    lat = p.get("latency_ms")
    return ResponseRow(
        seq=seq,
        t_ms=t,
        value=p.get("response_value"),
        input_mode=str(p.get("input_mode", "none")),
        latency_ms=float(lat) if isinstance(lat, int | float) else None,
        latency_anchor=anchor,
        barge_in=bool(p.get("barge_in", False)),
        correctness=p.get("correctness"),
        anchor_ms=anchor_ms,
        recomputed_latency_ms=None if anchor_ms is None or lat is None else round(t - anchor_ms, 3),
        asr_label=p.get("asr_label"),
        asr_confidence=p.get("asr_confidence"),
    )
