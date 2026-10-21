"""Participants, linkage (``linkage``) and consent ledger / erasure (``consent``)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, Float, ForeignKey, Integer, LargeBinary, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from shriii_api.db.base import Base, CreatedAtMixin

LINKAGE = "linkage"
CONSENT = "consent"


class Participant(Base, CreatedAtMixin):
    """Pseudonymous participant: pid only, never identity data (PRV-04)."""

    __tablename__ = "participants"
    __table_args__ = {"schema": LINKAGE}

    pid: Mapped[str] = mapped_column(String(26), primary_key=True)
    pid_hmac: Mapped[str] = mapped_column(String(64), unique=True)
    pepper_version: Mapped[int] = mapped_column(Integer)
    study_id: Mapped[str | None] = mapped_column(String(128), index=True)
    source: Mapped[str] = mapped_column(String(16))
    """generated | derived (HMAC of an external reference)"""
    status: Mapped[str] = mapped_column(String(16), default="active")
    """active | withdrawn"""
    withdrawn_at: Mapped[datetime | None] = mapped_column()
    created_by: Mapped[str] = mapped_column(String(256))


class ParticipantLink(Base, CreatedAtMixin):
    """Game session <-> pid link (``ParticipantLink``). A session links to at most one pid."""

    __tablename__ = "participant_links"
    __table_args__ = {"schema": LINKAGE}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    pid: Mapped[str] = mapped_column(ForeignKey(f"{LINKAGE}.participants.pid", ondelete="CASCADE"), index=True)
    session_id: Mapped[uuid.UUID] = mapped_column(unique=True)
    study_id: Mapped[str | None] = mapped_column(String(128))
    occasion_id: Mapped[str | None] = mapped_column(String(128))
    visit_number: Mapped[int] = mapped_column(Integer, default=1)
    method: Mapped[str] = mapped_column(String(32))
    """pairing_code | qr_token | manual"""
    linked_by: Mapped[str] = mapped_column(String(256))
    second_linker: Mapped[str | None] = mapped_column(String(256))
    confidence: Mapped[float] = mapped_column(Float, default=1.0)


class PairingCode(Base, CreatedAtMixin):
    """6-char Crockford pairing code + opaque QR token for kiosk pilot mode (restricted)."""

    __tablename__ = "pairing_codes"
    __table_args__ = {"schema": LINKAGE}

    code: Mapped[str] = mapped_column(String(8), primary_key=True)
    qr_token_digest: Mapped[str] = mapped_column(String(64), unique=True)
    pid: Mapped[str] = mapped_column(ForeignKey(f"{LINKAGE}.participants.pid", ondelete="CASCADE"), index=True)
    study_id: Mapped[str | None] = mapped_column(String(128))
    occasion_id: Mapped[str | None] = mapped_column(String(128))
    visit_number: Mapped[int] = mapped_column(Integer, default=1)
    created_by: Mapped[str] = mapped_column(String(256))
    expires_at: Mapped[datetime] = mapped_column()
    used_at: Mapped[datetime | None] = mapped_column()
    used_session_id: Mapped[uuid.UUID | None] = mapped_column()


class Withdrawal(Base, CreatedAtMixin):
    __tablename__ = "withdrawals"
    __table_args__ = {"schema": LINKAGE}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    pid_hmac: Mapped[str] = mapped_column(String(64), index=True)
    scope: Mapped[str] = mapped_column(String(32))
    """stop_participation | withdraw_and_erase"""
    reason_code: Mapped[str | None] = mapped_column(String(64))
    erasure_request_id: Mapped[uuid.UUID | None] = mapped_column()
    recorded_by: Mapped[str] = mapped_column(String(256))


class ConsentArtefact(Base):
    """Immutable consent record (plan section 6.3). Changes are superseding records (trigger-enforced)."""

    __tablename__ = "artefacts"
    __table_args__ = {"schema": CONSENT}

    consent_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    participant_pid: Mapped[str | None] = mapped_column(String(26), index=True)
    session_id: Mapped[uuid.UUID | None] = mapped_column(index=True)
    kind: Mapped[str] = mapped_column(String(32))
    granted: Mapped[bool] = mapped_column(Boolean)
    consent_script_id: Mapped[str] = mapped_column(String(128))
    script_audio_sha256: Mapped[str] = mapped_column(String(64))
    language: Mapped[str] = mapped_column(String(16))
    policy_version: Mapped[str] = mapped_column(String(64))
    protocol_id: Mapped[str | None] = mapped_column(String(128))
    input_mode: Mapped[str] = mapped_column(String(8), default="tap")
    presented_at: Mapped[datetime] = mapped_column()
    decided_at: Mapped[datetime] = mapped_column()
    kiosk_id: Mapped[str | None] = mapped_column(String(64))
    replay_counts: Mapped[list[Any]] = mapped_column(default=list)
    supersedes_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey(f"{CONSENT}.artefacts.consent_id"))
    source_event_id: Mapped[uuid.UUID | None] = mapped_column()
    recorded_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class SessionKey(Base, CreatedAtMixin):
    """Session DEK re-wrapped under the KEK (ING-08). Deleting the row crypto-shreds the raw chunks."""

    __tablename__ = "session_keys"
    __table_args__ = {"schema": CONSENT}

    session_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    nonce: Mapped[bytes] = mapped_column(LargeBinary)
    wrapped_dek: Mapped[bytes] = mapped_column(LargeBinary)
    kek_version: Mapped[int] = mapped_column(Integer, default=1)


class ErasureRequest(Base, CreatedAtMixin):
    __tablename__ = "erasure_requests"
    __table_args__ = {"schema": CONSENT}

    request_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    scope: Mapped[str] = mapped_column(String(16))
    """participant | session"""
    pid: Mapped[str | None] = mapped_column(String(26))
    """Cleared once the erasure completes; ``pid_hmac`` remains for the receipt."""
    pid_hmac: Mapped[str | None] = mapped_column(String(64), index=True)
    session_id: Mapped[uuid.UUID | None] = mapped_column()
    channel: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str | None] = mapped_column(Text)
    requested_by: Mapped[str] = mapped_column(String(256))
    status: Mapped[str] = mapped_column(String(32), default="requested")
    """requested | running | completed | blocked_legal_hold | failed"""
    job_id: Mapped[uuid.UUID | None] = mapped_column()
    completed_at: Mapped[datetime | None] = mapped_column()
    error: Mapped[str | None] = mapped_column(Text)


class ErasureReceipt(Base):
    """Signed erasure receipt (PRV-06a)."""

    __tablename__ = "receipts"
    __table_args__ = {"schema": CONSENT}

    receipt_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{CONSENT}.erasure_requests.request_id"))
    body: Mapped[dict[str, Any]] = mapped_column()
    signature: Mapped[str] = mapped_column(String(256))
    key_id: Mapped[str] = mapped_column(String(128))
    issued_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Tombstone(Base, CreatedAtMixin):
    """Replay guard: re-applied after restores and checked by ingestion (PRV-06)."""

    __tablename__ = "tombstones"
    __table_args__ = {"schema": CONSENT}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[uuid.UUID | None] = mapped_column(unique=True)
    pid_hmac: Mapped[str | None] = mapped_column(String(64), index=True)
    reason: Mapped[str] = mapped_column(String(32))
    request_id: Mapped[uuid.UUID | None] = mapped_column()
    note: Mapped[str | None] = mapped_column(Text)
