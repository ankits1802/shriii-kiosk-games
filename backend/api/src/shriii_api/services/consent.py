"""Consent ledger (PRV-02): immutable artefacts, superseding records, purpose checks."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from shriii_api.db.models.participants import ConsentArtefact

CONSENT_KINDS = ("core", "archive", "contact", "research_audio", "asr_eval", "coplay_substudy", "criterion")


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def current_artefacts(
    session: Session, *, session_id: uuid.UUID | None = None, pid: str | None = None
) -> list[ConsentArtefact]:
    """Latest non-superseded artefact per kind for a session and/or pid."""
    stmt = select(ConsentArtefact)
    if session_id is not None and pid is not None:
        stmt = stmt.where((ConsentArtefact.session_id == session_id) | (ConsentArtefact.participant_pid == pid))
    elif session_id is not None:
        stmt = stmt.where(ConsentArtefact.session_id == session_id)
    elif pid is not None:
        stmt = stmt.where(ConsentArtefact.participant_pid == pid)
    else:
        raise ValueError("session_id or pid required")
    rows = list(session.execute(stmt.order_by(ConsentArtefact.created_at)).scalars())
    superseded = {r.supersedes_id for r in rows if r.supersedes_id is not None}
    latest: dict[str, ConsentArtefact] = {}
    for r in rows:
        if r.consent_id in superseded:
            continue
        prev = latest.get(r.kind)
        if prev is None or (r.decided_at, r.created_at) >= (prev.decided_at, prev.created_at):
            latest[r.kind] = r
    return list(latest.values())


def consent_state(session: Session, *, session_id: uuid.UUID | None = None, pid: str | None = None) -> dict[str, bool]:
    """kind -> granted for the current artefacts (missing kinds are absent = not granted)."""
    return {a.kind: a.granted for a in current_artefacts(session, session_id=session_id, pid=pid)}


def has_consent(session: Session, kind: str, *, session_id: uuid.UUID | None = None, pid: str | None = None) -> bool:
    return consent_state(session, session_id=session_id, pid=pid).get(kind, False)


def record_artefact(
    session: Session,
    *,
    kind: str,
    granted: bool,
    consent_script_id: str,
    script_audio_sha256: str,
    language: str,
    policy_version: str,
    presented_at: datetime,
    decided_at: datetime,
    recorded_by: str,
    participant_pid: str | None = None,
    session_id: uuid.UUID | None = None,
    protocol_id: str | None = None,
    kiosk_id: str | None = None,
    replay_counts: list[int] | None = None,
    supersedes_id: uuid.UUID | None = None,
    source_event_id: uuid.UUID | None = None,
) -> ConsentArtefact:
    """Append an artefact. If an earlier current artefact of the same kind exists it is superseded."""
    if kind not in CONSENT_KINDS:
        raise ValueError(f"unknown consent kind {kind}")
    if supersedes_id is None:
        for prior in current_artefacts(session, session_id=session_id, pid=participant_pid):
            if prior.kind == kind:
                supersedes_id = prior.consent_id
                break
    artefact = ConsentArtefact(
        consent_id=uuid.uuid4(),
        participant_pid=participant_pid,
        session_id=session_id,
        kind=kind,
        granted=granted,
        consent_script_id=consent_script_id,
        script_audio_sha256=script_audio_sha256,
        language=language,
        policy_version=policy_version,
        protocol_id=protocol_id,
        input_mode="tap",
        presented_at=presented_at,
        decided_at=decided_at,
        kiosk_id=kiosk_id,
        replay_counts=replay_counts or [],
        supersedes_id=supersedes_id,
        source_event_id=source_event_id,
        recorded_by=recorded_by,
    )
    session.add(artefact)
    session.flush()
    return artefact


def artefact_from_event(session: Session, event: dict[str, Any], recorded_by: str) -> ConsentArtefact | None:
    """Create the artefact for a consent/opt-in event (consent.granted/declined, optin.archive/contact)."""
    et = event["event_type"]
    ctx = event["context"]
    versions = event["versions"]
    payload = event["payload"]
    language = ctx.get("language")
    if language is None:
        raise ValueError("consent_without_language")
    script_hash = payload.get("consent_version_hash") or versions.get("audio_manifest_hash") or versions["bundle_hash"]
    ts = _parse_ts(event["timing"]["kiosk_t_wall"])
    common: dict[str, Any] = {
        "language": language,
        "policy_version": payload.get("policy_version") or versions["policy_version"],
        "presented_at": ts,
        "decided_at": ts,
        "recorded_by": recorded_by,
        "participant_pid": ctx.get("participant_pid"),
        "session_id": uuid.UUID(event["session_id"]),
        "protocol_id": _protocol_identifier(versions.get("protocol_version")),
        "kiosk_id": ctx.get("kiosk_id"),
        "source_event_id": uuid.UUID(event["event_id"]),
        "script_audio_sha256": script_hash,
    }
    if et in ("consent.granted", "consent.declined"):
        return record_artefact(
            session,
            kind=payload["consent_kind"],
            granted=et == "consent.granted",
            consent_script_id=payload["consent_script_id"],
            replay_counts=list(payload.get("replay_counts") or []),
            **common,
        )
    if et in ("optin.archive", "optin.contact"):
        kind = et.split(".", 1)[1]
        return record_artefact(
            session, kind=kind, granted=bool(payload["granted"]), consent_script_id=f"optin.{kind}", **common
        )
    return None


def _protocol_identifier(value: str | None) -> str | None:
    if value is None:
        return None
    ident = "".join(c if c.isalnum() or c in "_.:-" else "_" for c in value.lower())
    return ident[:128] or None
