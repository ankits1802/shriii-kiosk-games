"""Semantic invariants beyond the restricted JSON Schema profile.

Mirrors ``packages/contracts/src/invariants.ts`` (same codes) so kiosk and backend agree.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from shriii_contracts._base import FORBIDDEN_FIELD_NAMES
from shriii_contracts._generated import (
    EventEnvelopeBase,
    GameTrialSpec,
    ModuleStartEvent,
    ResponseEvent,
)

_NON_SCORABLE_PHASES = frozenset({"practice", "warmup"})
_ONBOARDING_EVENTS = frozenset(
    {"consent.granted", "consent.declined", "optin.archive", "optin.contact", "bands.answered"}
)


@dataclass(frozen=True, slots=True)
class InvariantViolation:
    """One violated invariant; ``code`` is stable (usable as a DLQ reason code)."""

    code: str
    path: str
    message: str


def check_event_invariants(
    event: EventEnvelopeBase, origin: Literal["kiosk", "server"] = "kiosk"
) -> list[InvariantViolation]:
    """Check a single parsed event."""
    v: list[InvariantViolation] = []
    if origin == "kiosk":
        s = event.server
        if s.server_received_at is not None or s.clock_offset_estimate_ms is not None or s.batch_id is not None:
            v.append(
                InvariantViolation("server_fields_on_kiosk", "/server", "kiosk events must carry null server fields")
            )
    if event.condition is not None and event.condition.phase in _NON_SCORABLE_PHASES and event.timing.scorable:
        v.append(
            InvariantViolation(
                "practice_scorable", "/timing/scorable", "practice and warm-up events must be scorable=false"
            )
        )
    if isinstance(event, ResponseEvent):
        p = event.payload
        is_timeout = p.input_mode == "timeout"
        if is_timeout != (p.latency_ms is None):
            v.append(
                InvariantViolation(
                    "latency_null_iff_timeout",
                    "/payload/latency_ms",
                    "latency_ms is null exactly when input_mode is timeout",
                )
            )
        if p.latency_ms is not None and p.barge_in != (p.latency_ms < 0):
            v.append(
                InvariantViolation(
                    "barge_in_sign", "/payload/barge_in", "barge_in is true exactly when latency_ms is negative"
                )
            )
        if is_timeout and p.response_value is not None:
            v.append(
                InvariantViolation("timeout_with_value", "/payload/response_value", "timeouts carry no response_value")
            )
        voice = p.input_mode in ("voice", "voice_then_touch_confirm")
        if not voice and p.asr_label is not None:
            v.append(
                InvariantViolation(
                    "asr_label_without_voice", "/payload/asr_label", "asr_label requires a voice input mode"
                )
            )
    elif event.event_type in _ONBOARDING_EVENTS and event.timing.scorable:
        v.append(
            InvariantViolation(
                "onboarding_scorable", "/timing/scorable", "onboarding and consent events are never scorable"
            )
        )
    elif isinstance(event, ModuleStartEvent) and event.payload.soft_cap_ms > event.payload.hard_cap_ms:
        v.append(InvariantViolation("caps_order", "/payload/soft_cap_ms", "soft_cap_ms must not exceed hard_cap_ms"))
    return v


def check_session_sequence(events: Sequence[EventEnvelopeBase]) -> list[InvariantViolation]:
    """Single session, gapless seq from 0, unique event_id, non-decreasing t_mono_ms, session_start first."""
    v: list[InvariantViolation] = []
    if not events:
        return v
    ordered = sorted(events, key=lambda e: e.seq)
    session_id = ordered[0].session_id
    seen: set[str] = set()
    last_mono = float("-inf")
    for i, e in enumerate(ordered):
        if e.session_id != session_id:
            v.append(InvariantViolation("mixed_sessions", f"/{i}/session_id", "events from more than one session"))
        if e.seq != i:
            v.append(InvariantViolation("seq_gap", f"/{i}/seq", f"expected seq {i}, found {e.seq}"))
        if e.event_id in seen:
            v.append(InvariantViolation("duplicate_event_id", f"/{i}/event_id", "duplicate event_id"))
        seen.add(e.event_id)
        if e.timing.t_mono_ms < last_mono:
            v.append(InvariantViolation("mono_decreasing", f"/{i}/timing/t_mono_ms", "t_mono_ms decreased"))
        last_mono = e.timing.t_mono_ms
    if ordered[0].event_type != "session_start":
        v.append(InvariantViolation("missing_session_start", "/0/event_type", "first event must be session_start"))
    return v


def check_trial_spec_invariants(spec: GameTrialSpec) -> list[InvariantViolation]:
    """voice_vocabulary subset of vocabulary; private reports touch-only; anchors scorable."""
    v: list[InvariantViolation] = []
    extra = [c for c in spec.voice_vocabulary if c not in set(spec.vocabulary)]
    if extra:
        v.append(
            InvariantViolation(
                "voice_not_subset_of_touch", "/voice_vocabulary", f"not in vocabulary: {', '.join(extra)}"
            )
        )
    if spec.private_report and spec.voice_vocabulary:
        v.append(InvariantViolation("private_report_voice", "/voice_vocabulary", "private reports are touch only"))
    if spec.anchor_trial and not spec.scorable:
        v.append(InvariantViolation("anchor_not_scorable", "/anchor_trial", "anchor trials must be scorable"))
    if spec.phase in _NON_SCORABLE_PHASES and spec.scorable:
        v.append(InvariantViolation("practice_scorable", "/scorable", "practice and warm-up trials are never scorable"))
    return v


def find_forbidden_field_names(schema: Any, path: str = "#") -> list[str]:
    """Every ``properties`` key in a JSON Schema whose name is privacy-forbidden."""
    hits: list[str] = []
    if isinstance(schema, list):
        for i, s in enumerate(schema):
            hits.extend(find_forbidden_field_names(s, f"{path}/{i}"))
    elif isinstance(schema, dict):
        for key, sub in schema.items():
            if key == "properties" and isinstance(sub, dict):
                for name, prop in sub.items():
                    if name in FORBIDDEN_FIELD_NAMES:
                        hits.append(f"{path}/properties/{name}")
                    hits.extend(find_forbidden_field_names(prop, f"{path}/properties/{name}"))
            else:
                hits.extend(find_forbidden_field_names(sub, f"{path}/{key}"))
    return hits
