"""Pseudonymous participants, pairing codes/QR tokens, session linkage, withdrawals, contact vault.

* pids are random Crockford base32 (or HMAC-derived from an external reference for imports); the
  research DB stores ``pid_hmac`` = HMAC(pepper, pid), the only key the identity vault knows.
* Linking a game session to a pid: pairing code (check character validated, single use, expiring) or
  QR token; manual linking requires a second, different person (CRT-06). A session links to at most
  one pid (unique constraint).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from shriii_api.db.models.identity import ContactRecord, RelinkAudit
from shriii_api.db.models.kiosk_raw import GameSession
from shriii_api.db.models.participants import PairingCode, Participant, ParticipantLink, Withdrawal
from shriii_api.db.session import identity_session_scope
from shriii_api.errors import DomainError
from shriii_api.security import (
    derive_pid,
    encrypt_field,
    is_valid_code,
    keyed_hmac,
    new_opaque_token,
    new_pairing_code,
    new_pid,
    normalise_code,
    token_digest,
)
from shriii_api.settings import Settings


class LinkageError(DomainError):
    """Linkage error."""


def pid_hmac(settings: Settings, pid: str) -> str:
    return keyed_hmac(settings.key_bytes("pid_hmac_pepper"), pid)


def create_participant(
    db: Session, settings: Settings, *, created_by: str, study_id: str | None, external_ref: str | None = None
) -> Participant:
    """Create a participant; with ``external_ref`` the pid is HMAC-derived (idempotent reconciliation)."""
    if external_ref is not None:
        pid = derive_pid(settings.key_bytes("pid_hmac_pepper"), study_id or "global", external_ref)
        existing = db.get(Participant, pid)
        if existing is not None:
            return existing
        source = "derived"
    else:
        pid, source = new_pid(), "generated"
        while db.get(Participant, pid) is not None:  # pragma: no cover - 2^45 space
            pid = new_pid()
    participant = Participant(
        pid=pid,
        pid_hmac=pid_hmac(settings, pid),
        pepper_version=settings.pid_pepper_version,
        study_id=study_id,
        source=source,
        status="active",
        created_by=created_by,
    )
    db.add(participant)
    db.flush()
    return participant


def resolve_pid(db: Session, raw: str) -> Participant:
    code = normalise_code(raw)
    if not is_valid_code(code):
        raise LinkageError(422, "invalid_pid", "pid fails its check character")
    participant = db.get(Participant, code)
    if participant is None:
        raise LinkageError(404, "unknown_pid", "participant not found")
    return participant


@dataclass(slots=True)
class IssuedPairing:
    code: str
    qr_token: str
    expires_at: datetime


def issue_pairing(
    db: Session,
    participant: Participant,
    *,
    created_by: str,
    study_id: str | None,
    occasion_id: str | None,
    visit_number: int,
    ttl_hours: int,
) -> IssuedPairing:
    if participant.status != "active":
        raise LinkageError(409, "participant_withdrawn", "participant has withdrawn")
    for _ in range(10):
        code = new_pairing_code()
        if db.get(PairingCode, code) is None:
            break
    else:  # pragma: no cover
        raise LinkageError(503, "code_space_exhausted", "could not allocate a pairing code")
    token = new_opaque_token()
    expires = datetime.now(UTC) + timedelta(hours=ttl_hours)
    db.add(
        PairingCode(
            code=code,
            qr_token_digest=token_digest(token),
            pid=participant.pid,
            study_id=study_id,
            occasion_id=occasion_id,
            visit_number=visit_number,
            created_by=created_by,
            expires_at=expires,
        )
    )
    db.flush()
    return IssuedPairing(code=code, qr_token=token, expires_at=expires)


def link_session(
    db: Session,
    *,
    session_id: uuid.UUID,
    linked_by: str,
    pairing_code: str | None = None,
    qr_token: str | None = None,
    pid: str | None = None,
    second_linker: str | None = None,
) -> ParticipantLink:
    """Link a game session to a pid by pairing code, QR token or two-person manual entry."""
    pairing: PairingCode | None = None
    if pairing_code is not None:
        code = normalise_code(pairing_code)
        if not is_valid_code(code):
            raise LinkageError(422, "invalid_pairing_code", "pairing code fails its check character")
        pairing = db.get(PairingCode, code, with_for_update=True)
        method = "pairing_code"
    elif qr_token is not None:
        pairing = db.execute(
            select(PairingCode).where(PairingCode.qr_token_digest == token_digest(qr_token)).with_for_update()
        ).scalar_one_or_none()
        method = "qr_token"
    elif pid is not None:
        if not second_linker or second_linker == linked_by:
            raise LinkageError(422, "two_person_rule", "manual linking needs a second, different person")
        method = "manual"
    else:
        raise LinkageError(422, "no_link_method", "provide pairing_code, qr_token or pid")

    if method != "manual":
        if pairing is None:
            raise LinkageError(404, "unknown_pairing", "pairing code or token not found")
        if pairing.used_at is not None:
            raise LinkageError(409, "pairing_used", "pairing code was already used")
        if pairing.expires_at < datetime.now(UTC):
            raise LinkageError(410, "pairing_expired", "pairing code expired")
        participant = db.get(Participant, pairing.pid)
    else:
        assert pid is not None
        participant = resolve_pid(db, pid)
    if participant is None or participant.status != "active":
        raise LinkageError(409, "participant_withdrawn", "participant is not active")

    session_row = db.get(GameSession, session_id, with_for_update=True)
    if session_row is None:
        raise LinkageError(404, "unknown_session", "session not found")
    if session_row.participant_pid not in (None, participant.pid):
        raise LinkageError(409, "session_already_linked", "session is linked to another participant")
    link = ParticipantLink(
        pid=participant.pid,
        session_id=session_id,
        study_id=pairing.study_id if pairing else session_row.study_id,
        occasion_id=pairing.occasion_id if pairing else session_row.occasion_id,
        visit_number=pairing.visit_number if pairing else 1,
        method=method,
        linked_by=linked_by,
        second_linker=second_linker,
        confidence=1.0,
    )
    try:
        with db.begin_nested():
            db.add(link)
            db.flush()
    except IntegrityError as exc:
        raise LinkageError(409, "session_already_linked", "a session links to at most one pid") from exc
    if pairing is not None:
        pairing.used_at = datetime.now(UTC)
        pairing.used_session_id = session_id
    session_row.participant_pid = participant.pid
    session_row.study_id = link.study_id or session_row.study_id
    session_row.occasion_id = link.occasion_id or session_row.occasion_id
    db.flush()
    return link


def record_withdrawal(
    db: Session,
    settings: Settings,
    participant: Participant,
    *,
    scope: str,
    reason_code: str | None,
    recorded_by: str,
    erasure_request_id: uuid.UUID | None,
) -> Withdrawal:
    participant.status = "withdrawn"
    participant.withdrawn_at = datetime.now(UTC)
    w = Withdrawal(
        pid_hmac=participant.pid_hmac,
        scope=scope,
        reason_code=reason_code,
        erasure_request_id=erasure_request_id,
        recorded_by=recorded_by,
    )
    db.add(w)
    # Stop future use: invalidate unused pairing codes.
    db.execute(
        update(PairingCode)
        .where(PairingCode.pid == participant.pid, PairingCode.used_at.is_(None))
        .values(expires_at=datetime.now(UTC))
    )
    db.flush()
    return w


def store_contact(
    settings: Settings,
    *,
    pid: str,
    channel: str,
    contact: str,
    study_id: str | None,
    actor: str,
    purge_after: datetime | None,
) -> uuid.UUID:
    """Write an envelope-encrypted contact into the identity vault (separate DB connection)."""
    pepper = settings.key_bytes("pid_hmac_pepper")
    phmac = keyed_hmac(pepper, pid)
    record = ContactRecord(
        id=uuid.uuid4(),
        pid_hmac=phmac,
        pepper_version=settings.pid_pepper_version,
        channel=channel,
        contact_hmac=keyed_hmac(pepper, f"contact:{contact}"),
        contact_ciphertext=encrypt_field(settings.key_bytes("identity_vault_key"), contact, phmac),
        study_id=study_id,
        purge_after=purge_after,
    )
    with identity_session_scope() as vault:
        vault.add(record)
        vault.add(
            RelinkAudit(pid_hmac=phmac, actor=actor, action="store_contact", justification="contact opt-in recorded")
        )
    return record.id
