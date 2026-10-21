"""Event-stream writer for synthetic sessions: gapless ``seq``, monotonic clock, contract-shaped envelopes.

Events conform to ``event-envelope.v1`` (strict writer profile) and to the scoring conventions in
:mod:`shriii_scoring.conventions`; ``trial_params`` collects the per-trial ``GameTrialSpec.params``.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np

from shriii_simulator.ids import fake_sha256, uuid7

__all__ = ["SessionWriter", "TrialHandle"]

BASE_UNIX_MS = 1_792_000_000_000  # 2026-10 epoch for synthetic wall clocks


@dataclass(slots=True)
class TrialHandle:
    """Position and condition of the trial currently being written."""

    task: dict[str, Any]
    condition: dict[str, Any]
    scorable: bool
    trial_type: str
    onset_ms: float = 0.0
    anchor_ms: float = 0.0
    taps: int = 0


@dataclass(slots=True)
class SessionWriter:
    """Accumulates the events of one session."""

    rng: np.random.Generator
    session_id: str
    context: dict[str, Any]
    versions: dict[str, Any]
    start_unix_ms: int
    t: float = 0.0
    seq: int = 0
    events: list[dict[str, Any]] = field(default_factory=list)
    trial_params: dict[str, dict[str, Any]] = field(default_factory=dict)
    trial_counters: dict[str, int] = field(default_factory=dict)
    timing_glitch_p: float = 0.0
    calibration_level: str = "L2"
    variant_seed: str = "1a2b3c"
    module_t0: float = 0.0
    form_id: str = "form_1"

    @staticmethod
    def create(
        rng: np.random.Generator,
        *,
        participant_pid: str | None,
        language: str,
        battery_arm: str,
        slot_form: str | None,
        mode: str = "pilot",
        site_mode: str = "supervised",
        session_index: int = 0,
        timing_glitch_p: float = 0.0,
        timing_profile: str = "sim-certified-v1",
        synthetic: bool = True,
    ) -> SessionWriter:
        start = BASE_UNIX_MS + session_index * 3_600_000 + int(rng.integers(0, 3_000_000))
        sid = uuid7(rng, start)
        context = {
            "participant_pid": participant_pid,
            "kiosk_id": "kiosk-sim-01",
            "site_id": "site-sim-01",
            "site_mode": site_mode,
            "mode": mode,
            "battery_arm": battery_arm,
            "slot_form": slot_form,
            "language": language,
            "player_slot": 1,
            "synthetic": synthetic,
        }
        versions = {
            "app_version": "0.1.0",
            "bundle_hash": fake_sha256("bundle"),
            "audio_manifest_hash": fake_sha256("audio"),
            "variant_pack_id": f"{language.lower()}.default",
            "scoring_dict_version": "0.1.0",
            "indicator_set_version": "0.1.0",
            "protocol_version": "S2-pilot-sim",
            "policy_version": "1.0.0",
            "release_pack_version": None,
            "device_profile_id": "sim-device",
            "hardware_sku": "sim-sku",
            "timing_profile_version": timing_profile,
        }
        return SessionWriter(
            rng=rng,
            session_id=sid,
            context=context,
            versions=versions,
            start_unix_ms=start,
            timing_glitch_p=timing_glitch_p,
        )

    # ------------------------------------------------------------------ primitives

    def advance(self, ms: float) -> None:
        self.t += max(0.0, float(ms))

    def _wall(self) -> str:
        dt = datetime.fromtimestamp((self.start_unix_ms + self.t) / 1000.0, tz=UTC) + timedelta(hours=5, minutes=30)
        return dt.replace(tzinfo=None).isoformat(timespec="milliseconds") + "+05:30"

    def emit(
        self,
        event_type: str,
        payload: Mapping[str, Any],
        *,
        task: Mapping[str, Any] | None = None,
        condition: Mapping[str, Any] | None = None,
        scorable: bool = False,
        timing_flag: str = "ok",
        interrupted: bool = False,
        at: float | None = None,
    ) -> dict[str, Any]:
        """Append one event at the current clock (or ``at``, which must not be earlier than the clock)."""
        if at is not None:
            self.t = max(self.t, float(at))
        ev = {
            "schema_version": "1.0",
            "event_id": uuid7(self.rng, self.start_unix_ms + int(self.t)),
            "event_type": event_type,
            "seq": self.seq,
            "session_id": self.session_id,
            "context": dict(self.context),
            "versions": dict(self.versions),
            "task": dict(task) if task is not None else None,
            "condition": dict(condition) if condition is not None else None,
            "timing": {
                "t_mono_ms": round(self.t, 3),
                "kiosk_t_wall": self._wall(),
                "timing_flag": timing_flag,
                "scorable": scorable,
                "interrupted": interrupted,
            },
            "server": {"server_received_at": None, "clock_offset_estimate_ms": None, "batch_id": None},
            "payload": dict(payload),
        }
        self.events.append(ev)
        self.seq += 1
        return ev

    # ------------------------------------------------------------------ module / trial helpers

    def module_start(self, module_id: str, kind: str, paradigms: list[str], episode: bool = False) -> None:
        self.trial_counters[module_id] = 0
        task = self._task(module_id, None, None, None, episode=episode)
        self.emit(
            "module_start",
            {
                "module_id": module_id,
                "kind": kind,
                "paradigms": paradigms,
                "duration_budget_ms": 95000 if kind == "micro" else 200000,
                "soft_cap_ms": 110000 if kind == "micro" else 216000,
                "hard_cap_ms": 120000 if kind == "micro" else 230000,
                "config_hash": fake_sha256(f"config.{module_id}"),
            },
            task=task,
        )
        self.module_t0 = self.t

    def module_end(self, module_id: str, ended_reason: str = "completed", episode: bool = False) -> None:
        self.emit(
            "module_end",
            {
                "module_id": module_id,
                "ended_reason": ended_reason,
                "duration_ms": round(self.t - self.module_t0, 3),
                "trials_completed": self.trial_counters.get(module_id, 0),
            },
            task=self._task(module_id, None, None, None, episode=episode),
        )

    def _task(
        self,
        module_id: str,
        block: str | None,
        trial_id: str | None,
        trial_index: int | None,
        *,
        episode: bool,
        probe_group: str | None = None,
        anchor: bool = False,
    ) -> dict[str, Any]:
        return {
            "episode_id": module_id if episode else None,
            "module_id": module_id,
            "block_id": f"{module_id}.{block}" if block else None,
            "trial_id": trial_id,
            "trial_index": trial_index,
            "probe_group_id": probe_group,
            "form_id": self.form_id,
            "anchor_trial": anchor,
        }

    def condition(
        self,
        phase: str,
        condition_id: str,
        *,
        shift_active: bool = False,
        timer: bool = False,
        noise: bool = False,
        partner_type: str | None = None,
        customer_tone_level: int | None = None,
    ) -> dict[str, Any]:
        c: dict[str, Any] = {
            "phase": phase,
            "condition_id": condition_id,
            "shift_active": shift_active,
            "timer": timer,
            "noise": noise,
            "calibration_level": self.calibration_level,
            "variant_seed": self.variant_seed,
        }
        if partner_type is not None:
            c["partner_type"] = partner_type
        if customer_tone_level is not None:
            c["customer_tone_level"] = customer_tone_level
        return c

    def start_trial(
        self,
        module_id: str,
        block: str,
        trial_type: str,
        condition: dict[str, Any],
        *,
        params: Mapping[str, Any] | None = None,
        stimulus_id: str | None = None,
        response_window_ms: int | None = None,
        expected_response: str | None = None,
        private_report: bool = False,
        episode: bool = False,
        probe_group: str | None = None,
        onset_delay_ms: float = 0.0,
        audio_prompt: str | None = None,
        audio_ms: float = 0.0,
    ) -> TrialHandle:
        """Write ``trial_start`` and ``stimulus_onset`` (and ``prompt_audio_end`` when ``audio_prompt``)."""
        idx = self.trial_counters.get(module_id, 0)
        self.trial_counters[module_id] = idx + 1
        trial_id = f"{module_id}.t{idx:03d}"
        task = self._task(module_id, block, trial_id, idx, episode=episode, probe_group=probe_group)
        scorable = condition["phase"] not in ("practice", "warmup")
        stim = stimulus_id or f"{module_id}.stim.{trial_type}.{idx:03d}"
        self.emit(
            "trial_start",
            {
                "trial_type": trial_type,
                "stimulus_id": stim,
                "response_window_ms": response_window_ms,
                "private_report": private_report,
                "expected_response": expected_response,
            },
            task=task,
            condition=condition,
            scorable=scorable,
        )
        self.advance(onset_delay_ms)
        flag = "frame_drop" if self.rng.random() < self.timing_glitch_p else "ok"
        self.emit(
            "stimulus_onset",
            {
                "stimulus_id": stim,
                "stimulus_version": "1.0",
                "requested_onset_ms": round(self.t, 3),
                "presented_onset_ms": round(self.t, 3),
                "audio_onset_ms": None,
                "onset_source": "raf_commit",
                "duration_ms": None,
            },
            task=task,
            condition=condition,
            scorable=scorable,
            timing_flag=flag,
        )
        handle = TrialHandle(
            task=task, condition=condition, scorable=scorable, trial_type=trial_type, onset_ms=self.t, anchor_ms=self.t
        )
        if audio_prompt is not None:
            self.advance(audio_ms)
            self.emit(
                "prompt_audio_end",
                {"line_id": audio_prompt, "audio_end_ms": round(self.t, 3)},
                task=task,
                condition=condition,
                scorable=scorable,
            )
            handle.anchor_ms = self.t
        self.trial_params[trial_id] = dict(params or {})
        return handle

    def trial_event(self, h: TrialHandle, event_type: str, payload: Mapping[str, Any], at: float | None = None) -> None:
        self.emit(event_type, payload, task=h.task, condition=h.condition, scorable=h.scorable, at=at)

    def tap(
        self,
        h: TrialHandle,
        classification: str,
        *,
        target_id: str | None,
        xy: tuple[float, float],
        at: float | None = None,
    ) -> None:
        when = self.t if at is None else max(self.t, at)
        self.trial_event(
            h,
            "input.raw_tap",
            {
                "target_id": target_id,
                "touch_xy_norm": [round(xy[0], 4), round(xy[1], 4)],
                "pointer_t_ms": round(when, 3),
                "anchor_offset_ms": round(when - h.anchor_ms, 3),
                "pointer_type": "touch",
                "active_points": 1,
                "classification": classification,
            },
            at=when,
        )

    def respond(
        self,
        h: TrialHandle,
        value: str | None,
        *,
        latency_ms: float | None,
        correctness: bool | None,
        xy: tuple[float, float] | None = None,
        revisions: list[tuple[str, float]] | None = None,
        stimulus_id: str | None = None,
        anchor: str = "visual_onset",
        hold_ms: float | None = None,
        tap_target: str | None = None,
    ) -> None:
        """Write a committed response (``latency_ms=None`` writes a timeout)."""
        timeout = latency_ms is None
        if not timeout:
            assert latency_ms is not None
            self.t = max(self.t, h.anchor_ms + latency_ms)
            if xy is not None:
                self.tap(h, "on_target", target_id=tap_target, xy=xy, at=self.t)
        payload: dict[str, Any] = {
            "stimulus_id": stimulus_id,
            "response_value": None if timeout else value,
            "correctness": correctness,
            "input_mode": "timeout" if timeout else "touch",
            "latency_ms": None if timeout else round(float(latency_ms or 0.0), 3),
            "latency_anchor": anchor,
            "barge_in": False,
            "hold_ms": hold_ms,
            "tap_count": 0 if timeout else 1,
            "revisions": [{"value": v, "t_ms": round(max(t, 0.0), 3)} for v, t in (revisions or [])],
            "touch_xy_norm": None if timeout or xy is None else [round(xy[0], 4), round(xy[1], 4)],
        }
        self.trial_event(h, "response", payload)

    def end_trial(self, h: TrialHandle, outcome: str, correctness: bool | None, response_count: int) -> None:
        self.trial_event(
            h,
            "trial_end",
            {
                "outcome": outcome,
                "correctness": correctness,
                "response_count": response_count,
                "duration_ms": round(self.t - h.onset_ms, 3),
            },
        )

    def context_shift(
        self, module_id: str, kind: str, announced: bool, shift_index: int, episode: bool = False
    ) -> None:
        self.emit(
            "context_shift",
            {"kind": kind, "announced": announced, "shift_index": shift_index},
            task=self._task(module_id, None, None, None, episode=episode),
        )
