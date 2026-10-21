"""Replay one session end to end: load -> validate -> sequence -> timeline -> rescore -> report."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from shriii_contracts.schema_validation import Mode
from shriii_scoring import IndicatorEngine

from shriii_replay.jcs import canonical_sha256
from shriii_replay.load import Issue, LoadedInput, load_input
from shriii_replay.reproduce import DEFAULT_TOLERANCE, Reproducibility, reproduce
from shriii_replay.timeline import Timeline, build_timeline
from shriii_replay.validate import check_sequence, validate_batches, validate_events


class ReplayInputError(ValueError):
    """The input cannot be replayed at all (empty, ambiguous session, ...)."""


@dataclass(slots=True)
class ReplayReport:
    input: dict[str, Any]
    session_id: str
    validation_mode: str
    n_events: int
    n_events_clean: int
    issues: list[Issue]
    timeline: Timeline
    reproducibility: Reproducibility | None
    sessions_in_input: list[str] = field(default_factory=list)
    raw_events_sha256: str = ""

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.all_issues if i.severity == "error"]

    @property
    def all_issues(self) -> list[Issue]:
        extra = self.reproducibility.issues if self.reproducibility else []
        return [*self.issues, *self.timeline.issues, *extra]

    @property
    def valid(self) -> bool:
        return not any(i.severity == "error" for i in [*self.issues, *self.timeline.issues])

    @property
    def reproducible(self) -> bool | None:
        return None if self.reproducibility is None else self.reproducibility.reproducible

    @property
    def exit_code(self) -> int:
        if not self.valid:
            return 2
        if self.reproducible is False:
            return 3
        return 0

    def as_dict(self) -> dict[str, Any]:
        tl = self.timeline
        sev = Counter(i.severity for i in self.all_issues)
        return {
            "report": "shriii.session-replay/1",
            "input": self.input,
            "session_id": self.session_id,
            "verdict": {
                "valid": self.valid,
                "reproducible": self.reproducible,
                "dictionary_sha_match": self.reproducibility.dictionary_sha_match if self.reproducibility else None,
                "errors": sev.get("error", 0),
                "warnings": sev.get("warning", 0),
                "exit_code": self.exit_code,
            },
            "validation": {
                "mode": self.validation_mode,
                "n_events": self.n_events,
                "n_events_clean": self.n_events_clean,
            },
            "session": {
                "participant_pid": tl.participant_pid,
                "battery_arm": tl.battery_arm,
                "pathway": tl.pathway,
                "language": tl.language,
                "mode": tl.mode,
                "site_mode": tl.site_mode,
                "synthetic": tl.synthetic,
                "seed": tl.seed,
                "raw_events_sha256": self.raw_events_sha256,
                "versions": tl.versions,
                "duration_ms": round(tl.end_ms - tl.start_ms, 3),
                "end_reason": tl.end_reason,
                "event_counts": dict(sorted(tl.event_counts.items())),
                "input_modes": dict(sorted(tl.input_modes.items())),
            },
            "modules": [
                {
                    "module_id": m.module_id,
                    "kind": m.kind,
                    "start_ms": m.start_ms,
                    "end_ms": m.end_ms,
                    "ended_reason": m.ended_reason,
                    "n_trials": len(m.trials),
                }
                for m in tl.modules
            ],
            "trials": [
                {
                    **{k: v for k, v in asdict(t).items() if k not in ("responses", "other_events")},
                    "responses": [asdict(r) for r in t.responses],
                }
                for t in tl.trials
            ],
            "markers": [asdict(m) for m in tl.markers],
            "issues": [i.as_dict() for i in self.all_issues],
            "reproducibility": self.reproducibility.as_dict() if self.reproducibility else None,
        }


def _content_sha(events: Sequence[Mapping[str, Any]]) -> str:
    """JCS SHA-256 of the deduplicated, seq-ordered events (covers payloads, unlike the engine's
    ``event_stream_sha256``, which hashes event ids and seq only)."""
    try:
        return str(canonical_sha256(list(events)))
    except (TypeError, ValueError):
        return ""


def _session_of(ev: Mapping[str, Any]) -> str:
    return str(ev.get("session_id"))


def replay_session(
    source: Path | LoadedInput,
    *,
    session_id: str | None = None,
    trial_params: Mapping[str, Mapping[str, Mapping[str, Any]]] | None = None,
    stored: Sequence[Mapping[str, Any]] | None = None,
    mode: Mode = "strict",
    rescore: bool = True,
    tolerance: float = DEFAULT_TOLERANCE,
    partition_events: Sequence[Mapping[str, Any]] | None = None,
    allow_synthetic: bool | None = None,
    engine: IndicatorEngine | None = None,
) -> ReplayReport:
    loaded = load_input(source) if isinstance(source, Path) else source
    if not loaded.events:
        raise ReplayInputError(f"{loaded.path}: no events found")
    sessions = sorted({_session_of(e) for e in loaded.events})
    if session_id is None:
        if len(sessions) > 1:
            raise ReplayInputError(f"input holds {len(sessions)} sessions; pick one with --session: {sessions}")
        session_id = sessions[0]
    elif session_id not in sessions:
        raise ReplayInputError(f"session {session_id} not in input (found {sessions})")
    events = [e for e in loaded.events if _session_of(e) == session_id]

    issues: list[Issue] = list(loaded.issues)
    issues.extend(validate_batches(loaded.batches, mode))
    ev_issues, clean = validate_events(events, mode)
    issues.extend(ev_issues)
    seq_issues, ordered = check_sequence(events)
    issues.extend(seq_issues)
    timeline = build_timeline(ordered)

    repro: Reproducibility | None = None
    if rescore:
        synth = timeline.synthetic if allow_synthetic is None else allow_synthetic
        try:
            repro = reproduce(
                ordered,
                trial_params,
                stored,
                session_id=session_id,
                allow_synthetic=synth,
                tolerance=tolerance,
                partition_events=partition_events,
                engine=engine,
            )
        except Exception as exc:  # report, never crash the QA run
            issues.append(Issue("error", "rescore_failed", session_id, f"{type(exc).__name__}: {exc}"))
    return ReplayReport(
        input={"path": loaded.path, "kind": loaded.kind, "n_batches": len(loaded.batches)},
        session_id=session_id,
        validation_mode=mode,
        n_events=len(events),
        n_events_clean=clean,
        issues=issues,
        timeline=timeline,
        reproducibility=repro,
        sessions_in_input=sessions,
        raw_events_sha256=_content_sha(ordered),
    )
