"""Session registry, integrity checks (seq gaps, conflicts) and quality flags (ING-05, SCR-12)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from shriii_api.db.models.kiosk_raw import EventDedup, GameSession
from shriii_api.db.models.scored import SessionQualityFlag
from shriii_api.settings import Settings
from shriii_api.worker.queue import enqueue

INTEGRITY_ALGORITHM_VERSION = "api-integrity-0.1.0"
BLOCKING_FLAGS = frozenset({"seq_conflict", "invalidated", "missing_session_start"})

_PATHWAY_BY_ARM = {"B_fixed": "B", "B_adaptive": "B", "A_narrative": "A", "A_D": "A"}


def pathway_for_arm(battery_arm: str | None) -> str | None:
    return _PATHWAY_BY_ARM.get(battery_arm or "")


def get_or_create_session(db: Session, event: dict[str, Any], created_by: str) -> GameSession:
    session_id = uuid.UUID(event["session_id"])
    row = db.get(GameSession, session_id, with_for_update=True)
    if row is not None:
        return row
    ctx = event["context"]
    row = GameSession(
        session_id=session_id,
        kiosk_id=ctx["kiosk_id"],
        site_id=ctx.get("site_id"),
        site_mode=ctx.get("site_mode"),
        mode=ctx.get("mode"),
        language=ctx.get("language"),
        battery_arm=ctx.get("battery_arm"),
        pathway=pathway_for_arm(ctx.get("battery_arm")),
        slot_form=ctx.get("slot_form"),
        participant_pid=ctx.get("participant_pid"),
        versions=dict(event.get("versions") or {}),
        synthetic=bool(ctx.get("synthetic")),
        status="active",
        event_count=0,
        created_by=created_by,
    )
    db.add(row)
    db.flush()
    return row


@dataclass(slots=True)
class Integrity:
    received: int
    max_seq: int | None
    max_contiguous: int | None
    gaps: list[tuple[int, int]]


def compute_integrity(db: Session, session_id: uuid.UUID) -> Integrity:
    """Missing seq ranges between 0 and the highest received seq (accepted, parked or dead all count)."""
    seqs = sorted(db.execute(select(EventDedup.seq).where(EventDedup.session_id == session_id)).scalars())
    if not seqs:
        return Integrity(0, None, None, [])
    gaps: list[tuple[int, int]] = []
    expected = 0
    for s in seqs:
        if s > expected:
            gaps.append((expected, s - 1))
        expected = s + 1
    max_contiguous = seqs[-1] if not gaps else (gaps[0][0] - 1 if gaps[0][0] > 0 else None)
    return Integrity(len(seqs), seqs[-1], max_contiguous, gaps)


def raise_flag(db: Session, session_id: uuid.UUID, code: str, severity: str, details: dict[str, Any]) -> None:
    """Open (or refresh) a flag; at most one open flag per (session, code)."""
    db.execute(
        text(
            "INSERT INTO scored.session_quality_flags "
            "(session_id, flag_code, severity, details, algorithm_version, detected_at, updated_at) "
            "VALUES (:sid, :code, :sev, CAST(:details AS jsonb), :alg, now(), now()) "
            "ON CONFLICT (session_id, flag_code) WHERE resolved_at IS NULL "
            "DO UPDATE SET details = EXCLUDED.details, severity = EXCLUDED.severity, updated_at = now()"
        ),
        {
            "sid": session_id,
            "code": code,
            "sev": severity,
            "details": _json(details),
            "alg": INTEGRITY_ALGORITHM_VERSION,
        },
    )


def resolve_flag(db: Session, session_id: uuid.UUID, code: str, note: str) -> None:
    db.execute(
        text(
            "UPDATE scored.session_quality_flags SET resolved_at = now(), note = :note, updated_at = now() "
            "WHERE session_id = :sid AND flag_code = :code AND resolved_at IS NULL"
        ),
        {"sid": session_id, "code": code, "note": note},
    )


def _json(value: Any) -> str:
    import json  # noqa: PLC0415

    return json.dumps(value, default=str)


def refresh_integrity(db: Session, row: GameSession) -> Integrity:
    """Recompute seq gaps for a session and open/resolve the ``seq_gap`` flag."""
    integrity = compute_integrity(db, row.session_id)
    row.last_seq_received = integrity.max_seq
    row.max_contiguous_seq = integrity.max_contiguous
    if integrity.gaps:
        missing = sum(b - a + 1 for a, b in integrity.gaps)
        raise_flag(
            db,
            row.session_id,
            "seq_gap",
            "warn",
            {"missing_ranges": [list(g) for g in integrity.gaps], "missing_count": missing},
        )
    else:
        resolve_flag(db, row.session_id, "seq_gap", "gap filled by a later upload")
    return integrity


def open_flags(db: Session, session_id: uuid.UUID) -> list[SessionQualityFlag]:
    return list(
        db.execute(
            select(SessionQualityFlag).where(
                SessionQualityFlag.session_id == session_id, SessionQualityFlag.resolved_at.is_(None)
            )
        ).scalars()
    )


def update_validity(db: Session, row: GameSession) -> None:
    """``valid_for_report``: completed, not invalidated/erased, no blocking flag and no open seq gap."""
    flags = {f.flag_code for f in open_flags(db, row.session_id)}
    row.valid_for_report = (
        row.status == "completed" and not (flags & BLOCKING_FLAGS) and "seq_gap" not in flags and not row.synthetic
    )


def on_session_end(db: Session, row: GameSession, reason: str, settings: Settings, actor: str) -> None:
    """Close a session and enqueue the downstream pipeline (trial eligibility -> features)."""
    row.end_reason = reason
    row.status = "completed" if reason == "completed" else ("withdrawn" if reason == "withdrawn" else "abandoned")
    row.completed_at = row.completed_at or datetime.now(UTC)
    db.flush()
    if row.status != "withdrawn":
        enqueue_pipeline(db, row, settings, actor)


def enqueue_pipeline(db: Session, row: GameSession, settings: Settings, actor: str) -> None:
    count = db.execute(
        select(func.count())
        .select_from(EventDedup)
        .where(EventDedup.session_id == row.session_id, EventDedup.state == "accepted")
    ).scalar_one()
    inputs = {"session_id": str(row.session_id), "accepted_events": int(count)}
    enqueue(db, "trial_eligibility", inputs, created_by=actor, settings=settings, priority=50)
