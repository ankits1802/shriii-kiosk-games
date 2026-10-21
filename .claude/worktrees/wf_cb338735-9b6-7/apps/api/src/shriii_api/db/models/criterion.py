"""Layer 3: criterion instruments, responses and scale scores (schema ``criterion``)."""

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
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from shriii_api.db.base import Base, CreatedAtMixin, DerivedMixin

SCHEMA = "criterion"


class Instrument(Base, CreatedAtMixin):
    __tablename__ = "instruments"
    __table_args__ = {"schema": SCHEMA}

    instrument_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(String(256))
    short_name: Mapped[str] = mapped_column(String(256))
    kind: Mapped[str] = mapped_column(String(32))
    citation: Mapped[str] = mapped_column(Text)
    constructs_measured: Mapped[list[str]] = mapped_column(default=list)
    current_version: Mapped[str] = mapped_column(String(64))


class InstrumentVersion(Base, CreatedAtMixin):
    __tablename__ = "instrument_versions"
    __table_args__ = (UniqueConstraint("instrument_id", "version"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.instruments.instrument_id"))
    version: Mapped[str] = mapped_column(String(64))
    key_version: Mapped[str] = mapped_column(String(64))
    definition: Mapped[dict[str, Any]] = mapped_column()
    sha256: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32), default="active")
    source_path: Mapped[str | None] = mapped_column(String(512))


class Item(Base):
    __tablename__ = "items"
    __table_args__ = (UniqueConstraint("instrument_version_id", "item_id"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instrument_version_id: Mapped[int] = mapped_column(
        ForeignKey(f"{SCHEMA}.instrument_versions.id", ondelete="CASCADE")
    )
    item_id: Mapped[str] = mapped_column(String(128))
    number: Mapped[int] = mapped_column(Integer)
    subscales: Mapped[list[str]] = mapped_column(default=list)
    reverse_keyed: Mapped[bool] = mapped_column(Boolean)
    attention_check: Mapped[bool] = mapped_column(Boolean)
    block: Mapped[str | None] = mapped_column(String(32))
    item_text_source: Mapped[dict[str, Any]] = mapped_column(default=dict)


class LanguageVersion(Base):
    """Per-language version with ITC state; only approved versions can be administered (CRT-02)."""

    __tablename__ = "language_versions"
    __table_args__ = (UniqueConstraint("instrument_version_id", "language"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instrument_version_id: Mapped[int] = mapped_column(
        ForeignKey(f"{SCHEMA}.instrument_versions.id", ondelete="CASCADE")
    )
    language: Mapped[str] = mapped_column(String(16))
    itc_state: Mapped[str] = mapped_column(String(32))
    approved: Mapped[bool] = mapped_column(Boolean, default=False)
    translation_permission: Mapped[str] = mapped_column(String(32))
    approved_by: Mapped[list[str]] = mapped_column(default=list)
    approved_at: Mapped[datetime | None] = mapped_column()


class ScoringKey(Base, CreatedAtMixin):
    """Versioned criterion scoring key (CRT-04): reverse items, scales, prorating."""

    __tablename__ = "keys"
    __table_args__ = (UniqueConstraint("instrument_version_id", "key_version"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instrument_version_id: Mapped[int] = mapped_column(
        ForeignKey(f"{SCHEMA}.instrument_versions.id", ondelete="CASCADE")
    )
    key_version: Mapped[str] = mapped_column(String(64))
    prorate_min_prop: Mapped[float] = mapped_column(Float)
    reverse_formula: Mapped[str | None] = mapped_column(String(64))
    reverse_items: Mapped[list[str]] = mapped_column(default=list)
    scales: Mapped[list[Any]] = mapped_column(default=list)
    sha256: Mapped[str] = mapped_column(String(64))


class Permission(Base, CreatedAtMixin):
    """Licensing and permission tracker (CRT-03); append-only history, latest row is current."""

    __tablename__ = "permissions"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.instruments.instrument_id"), index=True)
    language: Mapped[str | None] = mapped_column(String(16))
    holder: Mapped[str] = mapped_column(String(256))
    licence: Mapped[str] = mapped_column(String(256))
    permission_status: Mapped[str] = mapped_column(String(32))
    permission_document: Mapped[str | None] = mapped_column(String(256))
    allowed_use: Mapped[str] = mapped_column(Text)
    expiry: Mapped[date | None] = mapped_column()
    commercial_use: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str | None] = mapped_column(Text)
    recorded_by: Mapped[str] = mapped_column(String(256))


class Response(Base):
    """Item response (``CriterionResponse``). Append-only; corrections are superseding rows."""

    __tablename__ = "responses"
    __table_args__ = (
        Index("ix_responses_subject_occasion", "subject_pid", "study_id", "occasion_id", "instrument_id"),
        {"schema": SCHEMA},
    )

    response_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    pid: Mapped[str] = mapped_column(String(26))
    """Respondent (self/partner) or, for observer/administrator ratings, the rated participant."""
    subject_pid: Mapped[str] = mapped_column(String(26), index=True)
    """Participant whose criterion score this response feeds (``rated_pid`` when set, else ``pid``)."""
    study_id: Mapped[str] = mapped_column(String(128))
    wave: Mapped[int] = mapped_column(Integer)
    occasion_id: Mapped[str] = mapped_column(String(128))
    instrument_id: Mapped[str] = mapped_column(String(128))
    instrument_version: Mapped[str] = mapped_column(String(64))
    language_version: Mapped[str] = mapped_column(String(64))
    block: Mapped[str] = mapped_column(String(32))
    item_id: Mapped[str] = mapped_column(String(128))
    raw_response: Mapped[float | None] = mapped_column(Float)
    response_latency_ms: Mapped[float | None] = mapped_column(Float)
    administration_mode: Mapped[str] = mapped_column(String(32))
    administrator_id: Mapped[str | None] = mapped_column(String(128))
    rater_role: Mapped[str | None] = mapped_column(String(32))
    rated_pid: Mapped[str | None] = mapped_column(String(26))
    device_id: Mapped[str] = mapped_column(String(128))
    audio_version: Mapped[str | None] = mapped_column(String(64))
    attention_check: Mapped[bool] = mapped_column(Boolean, default=False)
    attention_check_failed: Mapped[bool | None] = mapped_column(Boolean)
    expected_response: Mapped[float | None] = mapped_column(Float)
    """Administration-file key value: the instructed answer of an attention-check item, or the minimum
    number of moves of a performance ``<problem>.moves`` measure (needed again on every rescore)."""
    source: Mapped[str] = mapped_column(String(32))
    import_id: Mapped[uuid.UUID | None] = mapped_column()
    recorded_at: Mapped[datetime] = mapped_column()
    supersedes_id: Mapped[uuid.UUID | None] = mapped_column(index=True)
    correction_reason: Mapped[str | None] = mapped_column(Text)
    submitted_by: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class ScaleScore(Base, DerivedMixin):
    """Criterion scale score (``CriterionScaleScore``, spec ``criterion_scores``)."""

    __tablename__ = "scale_scores"
    __table_args__ = (
        Index(
            "ix_scale_scores_current",
            "pid",
            "study_id",
            "occasion_id",
            "instrument_id",
            postgresql_where=text("is_current"),
        ),
        {"schema": SCHEMA},
    )

    score_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    pid: Mapped[str] = mapped_column(String(26))
    study_id: Mapped[str] = mapped_column(String(128))
    wave: Mapped[int] = mapped_column(Integer)
    occasion_id: Mapped[str] = mapped_column(String(128))
    instrument_id: Mapped[str] = mapped_column(String(128))
    instrument_version: Mapped[str] = mapped_column(String(64))
    scale_id: Mapped[str] = mapped_column(String(128))
    score: Mapped[float | None] = mapped_column(Float)
    raw_mean: Mapped[float | None] = mapped_column(Float)
    score_type: Mapped[str] = mapped_column(String(32))
    n_answered: Mapped[int] = mapped_column(Integer)
    n_items: Mapped[int] = mapped_column(Integer)
    key_version: Mapped[str] = mapped_column(String(64))
    prorated: Mapped[bool] = mapped_column(Boolean)
    planned_missing: Mapped[bool] = mapped_column(Boolean, default=False)
    na_reason: Mapped[str | None] = mapped_column(String(64))
    flags: Mapped[list[str]] = mapped_column(default=list)
    scoring_run_id: Mapped[uuid.UUID] = mapped_column()
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)


class ImportBatch(Base, CreatedAtMixin):
    """Controlled CSV/XLSX import of questionnaire data (column mapping + validation + review)."""

    __tablename__ = "imports"
    __table_args__ = {"schema": SCHEMA}

    import_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    study_id: Mapped[str] = mapped_column(String(128))
    instrument_id: Mapped[str] = mapped_column(String(128))
    instrument_version: Mapped[str] = mapped_column(String(64))
    language: Mapped[str] = mapped_column(String(16))
    occasion_id: Mapped[str] = mapped_column(String(128))
    wave: Mapped[int] = mapped_column(Integer)
    block: Mapped[str] = mapped_column(String(32))
    administration_mode: Mapped[str] = mapped_column(String(32))
    filename: Mapped[str] = mapped_column(String(512))
    file_format: Mapped[str] = mapped_column(String(8))
    file_sha256: Mapped[str] = mapped_column(String(64))
    column_mapping: Mapped[dict[str, Any]] = mapped_column()
    status: Mapped[str] = mapped_column(String(32), default="staged")
    """staged | committed | cancelled"""
    counts: Mapped[dict[str, Any]] = mapped_column(default=dict)
    created_by: Mapped[str] = mapped_column(String(256))
    committed_at: Mapped[datetime | None] = mapped_column()
    committed_by: Mapped[str | None] = mapped_column(String(256))


class ImportRow(Base):
    """One staged row; ambiguous rows wait in the manual-review queue."""

    __tablename__ = "import_rows"
    __table_args__ = (UniqueConstraint("import_id", "row_number"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    import_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{SCHEMA}.imports.import_id", ondelete="CASCADE"))
    row_number: Mapped[int] = mapped_column(Integer)
    pid: Mapped[str | None] = mapped_column(String(26))
    values: Mapped[dict[str, Any]] = mapped_column()
    status: Mapped[str] = mapped_column(String(32), index=True)
    """ready | needs_review | approved | rejected | committed"""
    issues: Mapped[list[Any]] = mapped_column(default=list)
    resolved_by: Mapped[str | None] = mapped_column(String(256))
    resolved_at: Mapped[datetime | None] = mapped_column()
    resolution_note: Mapped[str | None] = mapped_column(Text)
