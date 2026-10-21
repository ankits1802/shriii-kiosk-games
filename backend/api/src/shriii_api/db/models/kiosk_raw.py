"""Layer 1: raw kiosk events (append-only) and ingestion bookkeeping (schema ``kiosk_raw``)."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    PrimaryKeyConstraint,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from shriii_api.db.base import Base, CreatedAtMixin

SCHEMA = "kiosk_raw"


class Batch(Base):
    """One UploadBatch, keyed by ``batch_id`` (idempotent replays return the stored result)."""

    __tablename__ = "batches"
    __table_args__ = {"schema": SCHEMA}

    batch_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    kiosk_id: Mapped[str] = mapped_column(String(64), index=True)
    sha256: Mapped[str] = mapped_column(String(64))
    event_count: Mapped[int] = mapped_column(Integer)
    kiosk_t_wall: Mapped[datetime] = mapped_column()
    received_at: Mapped[datetime] = mapped_column(server_default=func.now())
    clock_offset_estimate_ms: Mapped[float | None] = mapped_column(Float)
    result: Mapped[dict[str, Any]] = mapped_column()
    final: Mapped[bool] = mapped_column(Boolean, default=True)
    """False when some events were ``retryable``: a replay with the same batch_id is reprocessed."""


class BatchChunk(Base):
    """Raw per-session chunk exactly as uploaded (encrypted chunks stay sealed; erasure deletes rows)."""

    __tablename__ = "batch_chunks"
    __table_args__ = (UniqueConstraint("batch_id", "session_id"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    batch_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{SCHEMA}.batches.batch_id", ondelete="CASCADE"))
    session_id: Mapped[uuid.UUID] = mapped_column(index=True)
    encryption: Mapped[str] = mapped_column(String(32))
    first_seq: Mapped[int] = mapped_column(Integer)
    last_seq: Mapped[int] = mapped_column(Integer)
    event_count: Mapped[int] = mapped_column(Integer)
    body: Mapped[dict[str, Any]] = mapped_column()


class GameSession(Base):
    """Session registry (spec section 13 ``game_sessions``); created by the API or on first ingest."""

    __tablename__ = "sessions"
    __table_args__ = {"schema": SCHEMA}

    session_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    kiosk_id: Mapped[str] = mapped_column(String(64), index=True)
    site_id: Mapped[str | None] = mapped_column(String(128))
    site_mode: Mapped[str | None] = mapped_column(String(32))
    mode: Mapped[str | None] = mapped_column(String(32))
    language: Mapped[str | None] = mapped_column(String(16))
    battery_arm: Mapped[str | None] = mapped_column(String(32))
    pathway: Mapped[str | None] = mapped_column(String(1))
    slot_form: Mapped[str | None] = mapped_column(String(32))
    participant_pid: Mapped[str | None] = mapped_column(String(26), index=True)
    study_id: Mapped[str | None] = mapped_column(String(128), index=True)
    occasion_id: Mapped[str | None] = mapped_column(String(128))
    versions: Mapped[dict[str, Any]] = mapped_column(default=dict)
    synthetic: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(32), default="active", index=True)
    end_reason: Mapped[str | None] = mapped_column(String(64))
    last_seq_received: Mapped[int | None] = mapped_column(Integer)
    max_contiguous_seq: Mapped[int | None] = mapped_column(Integer)
    event_count: Mapped[int] = mapped_column(Integer, default=0)
    valid_for_report: Mapped[bool] = mapped_column(Boolean, default=False)
    invalidated_reason: Mapped[str | None] = mapped_column(Text)
    invalidated_by: Mapped[str | None] = mapped_column(String(256))
    created_by: Mapped[str | None] = mapped_column(String(256))
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column()
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class EventDedup(Base):
    """Unpartitioned global dedup table (ING-02 step 5). Kept after erasure as a replay guard."""

    __tablename__ = "event_dedup"
    __table_args__ = (UniqueConstraint("session_id", "seq"), {"schema": SCHEMA})

    event_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column()
    seq: Mapped[int] = mapped_column(Integer)
    batch_id: Mapped[uuid.UUID] = mapped_column()
    state: Mapped[str] = mapped_column(String(16))
    """accepted | parked | dead"""
    server_received_at: Mapped[datetime] = mapped_column()


class Event(Base):
    """Raw events, partitioned by ``server_received_date`` (declarative RANGE partitioning).

    Append-only: a trigger rejects UPDATE always and DELETE/TRUNCATE unless the transaction declared
    the erasure/retention purpose (``SET LOCAL shriii.mutation_purpose``).
    """

    __tablename__ = "events"
    __table_args__ = (
        PrimaryKeyConstraint("event_id", "server_received_date"),
        Index("ix_events_session_id_seq", "session_id", "seq"),
        Index("ix_events_participant_pid", "participant_pid"),
        {"schema": SCHEMA, "postgresql_partition_by": "RANGE (server_received_date)"},
    )

    event_id: Mapped[uuid.UUID] = mapped_column()
    server_received_date: Mapped[date] = mapped_column()
    server_received_at: Mapped[datetime] = mapped_column()
    session_id: Mapped[uuid.UUID] = mapped_column()
    seq: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(64))
    schema_version: Mapped[str] = mapped_column(String(16))
    participant_pid: Mapped[str | None] = mapped_column(String(26))
    kiosk_id: Mapped[str] = mapped_column(String(64))
    site_mode: Mapped[str | None] = mapped_column(String(32))
    mode: Mapped[str | None] = mapped_column(String(32))
    language: Mapped[str | None] = mapped_column(String(16))
    episode_id: Mapped[str | None] = mapped_column(String(128))
    module_id: Mapped[str | None] = mapped_column(String(128))
    block_id: Mapped[str | None] = mapped_column(String(128))
    trial_id: Mapped[str | None] = mapped_column(String(128))
    trial_index: Mapped[int | None] = mapped_column(Integer)
    phase: Mapped[str | None] = mapped_column(String(32))
    scorable: Mapped[bool] = mapped_column(Boolean)
    timing_flag: Mapped[str] = mapped_column(String(32))
    t_mono_ms: Mapped[float] = mapped_column(Float)
    kiosk_t_wall: Mapped[datetime] = mapped_column()
    batch_id: Mapped[uuid.UUID] = mapped_column()
    clock_offset_estimate_ms: Mapped[float | None] = mapped_column(Float)
    synthetic: Mapped[bool] = mapped_column(Boolean, default=False)
    payload: Mapped[dict[str, Any]] = mapped_column()
    payload_ext: Mapped[dict[str, Any] | None] = mapped_column()
    envelope: Mapped[dict[str, Any]] = mapped_column()
    """Full event as validated, with the server fields populated."""


class ConsentParking(Base):
    """Scorable events held until core consent arrives (ING-02 step 6); DLQ ``no_consent`` after the TTL."""

    __tablename__ = "consent_parking"
    __table_args__ = {"schema": SCHEMA}

    event_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(index=True)
    seq: Mapped[int] = mapped_column(Integer)
    batch_id: Mapped[uuid.UUID] = mapped_column()
    server_received_at: Mapped[datetime] = mapped_column()
    clock_offset_estimate_ms: Mapped[float | None] = mapped_column(Float)
    envelope: Mapped[dict[str, Any]] = mapped_column()
    expires_at: Mapped[datetime] = mapped_column(index=True)
    parked_at: Mapped[datetime] = mapped_column(server_default=func.now())


class DeadLetter(Base, CreatedAtMixin):
    """Dead-letter queue (ING-04). The payload is encrypted at rest; replay keeps event_id and seq."""

    __tablename__ = "dead_letter"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    event_id: Mapped[uuid.UUID | None] = mapped_column(index=True)
    session_id: Mapped[uuid.UUID | None] = mapped_column(index=True)
    seq: Mapped[int | None] = mapped_column(Integer)
    batch_id: Mapped[uuid.UUID | None] = mapped_column()
    kiosk_id: Mapped[str | None] = mapped_column(String(64))
    app_version: Mapped[str | None] = mapped_column(String(64))
    reason_code: Mapped[str] = mapped_column(String(128), index=True)
    schema_path: Mapped[str | None] = mapped_column(String(512))
    message: Mapped[str | None] = mapped_column(Text)
    payload_nonce: Mapped[bytes | None] = mapped_column(LargeBinary)
    payload_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    status: Mapped[str] = mapped_column(String(16), default="open")
    """open | replayed | discarded"""
    replayed_at: Mapped[datetime | None] = mapped_column()
