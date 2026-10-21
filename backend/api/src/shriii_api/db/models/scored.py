"""Layers 2 and 4: trait registry, canonical trials, indicators, trait estimates, quality flags (``scored``)."""

from __future__ import annotations

import uuid
from datetime import datetime
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

SCHEMA = "scored"


class Construct(Base, CreatedAtMixin):
    """Trait registry entry (spec section 3); loaded from ``scoring/dictionary/shared.yaml``."""

    __tablename__ = "constructs"
    __table_args__ = {"schema": SCHEMA}

    construct_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256))
    kind: Mapped[str | None] = mapped_column(String(64))
    dictionary_version: Mapped[str] = mapped_column(String(64))
    definition: Mapped[dict[str, Any]] = mapped_column()


class IndicatorDefinition(Base, CreatedAtMixin):
    """Indicator registry (spec ``indicators``), one row per (indicator, pathway, dictionary version)."""

    __tablename__ = "indicators"
    __table_args__ = (UniqueConstraint("indicator_id", "pathway", "dictionary_version"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    indicator_id: Mapped[str] = mapped_column(String(128), index=True)
    pathway: Mapped[str] = mapped_column(String(1))
    dictionary_version: Mapped[str] = mapped_column(String(64))
    construct_id: Mapped[str] = mapped_column(String(64), index=True)
    role: Mapped[str | None] = mapped_column(String(32))
    tier: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str | None] = mapped_column(String(32))
    kind: Mapped[str | None] = mapped_column(String(64))
    module_id: Mapped[str | None] = mapped_column(String(128))
    definition: Mapped[dict[str, Any]] = mapped_column()


class FeatureDefinition(Base, CreatedAtMixin):
    """Extraction algorithm metadata for an indicator (spec ``feature_definitions``)."""

    __tablename__ = "feature_definitions"
    __table_args__ = (UniqueConstraint("indicator_id", "pathway", "dictionary_version"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    indicator_id: Mapped[str] = mapped_column(String(128))
    pathway: Mapped[str] = mapped_column(String(1))
    dictionary_version: Mapped[str] = mapped_column(String(64))
    algorithm: Mapped[str | None] = mapped_column(String(128))
    direction: Mapped[str | None] = mapped_column(String(32))
    min_valid_trials: Mapped[int | None] = mapped_column(Integer)
    event_inputs: Mapped[list[str]] = mapped_column(default=list)
    exclusions: Mapped[list[str]] = mapped_column(default=list)
    definition: Mapped[dict[str, Any]] = mapped_column(default=dict)


class TraitMapping(Base, CreatedAtMixin):
    """ECD mapping construct -> evidence/criterion with expected relationship (spec ``trait_mappings``)."""

    __tablename__ = "trait_mappings"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    construct_id: Mapped[str] = mapped_column(String(64), index=True)
    pathway: Mapped[str | None] = mapped_column(String(1))
    relation: Mapped[str] = mapped_column(String(32))
    """indicator | convergent | discriminant"""
    indicator_id: Mapped[str | None] = mapped_column(String(128))
    criterion_ref: Mapped[str | None] = mapped_column(String(256))
    expected_sign: Mapped[str | None] = mapped_column(String(16))
    expected_r_low: Mapped[float | None] = mapped_column(Float)
    expected_r_high: Mapped[float | None] = mapped_column(Float)
    dictionary_version: Mapped[str] = mapped_column(String(64))
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)


class ScoringRun(Base):
    """Reproducible scoring run with lineage (SCR-13 ``ScoringRunManifest``)."""

    __tablename__ = "scoring_runs"
    __table_args__ = {"schema": SCHEMA}

    run_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    kind: Mapped[str] = mapped_column(String(64))
    algorithm_version: Mapped[str] = mapped_column(String(64))
    dictionary_versions: Mapped[dict[str, Any]] = mapped_column(default=dict)
    dictionary_sha256: Mapped[dict[str, Any]] = mapped_column(default=dict)
    engine: Mapped[str] = mapped_column(String(128))
    inputs: Mapped[dict[str, Any]] = mapped_column(default=dict)
    manifest: Mapped[dict[str, Any]] = mapped_column(default=dict)
    status: Mapped[str] = mapped_column(String(32), default="running")
    job_id: Mapped[uuid.UUID | None] = mapped_column()
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column()


class TrialCanonical(Base, DerivedMixin):
    """Reconstructed trial ordered by (session_id, seq) with eligibility (ING-05, spec ``trials``)."""

    __tablename__ = "trials_canonical"
    __table_args__ = (
        UniqueConstraint("session_id", "module_id", "block_id", "trial_id", "trial_index"),
        {"schema": SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[uuid.UUID] = mapped_column(index=True)
    participant_pid: Mapped[str | None] = mapped_column(String(26), index=True)
    episode_id: Mapped[str | None] = mapped_column(String(128))
    module_id: Mapped[str | None] = mapped_column(String(128))
    block_id: Mapped[str | None] = mapped_column(String(128))
    trial_id: Mapped[str] = mapped_column(String(128))
    trial_index: Mapped[int] = mapped_column(Integer)
    phase: Mapped[str | None] = mapped_column(String(32))
    condition_id: Mapped[str | None] = mapped_column(String(128))
    scorable: Mapped[bool] = mapped_column(Boolean)
    start_seq: Mapped[int | None] = mapped_column(Integer)
    end_seq: Mapped[int | None] = mapped_column(Integer)
    outcome: Mapped[str | None] = mapped_column(String(32))
    correctness: Mapped[bool | None] = mapped_column(Boolean)
    latency_ms: Mapped[float | None] = mapped_column(Float)
    input_mode: Mapped[str | None] = mapped_column(String(32))
    timing_flag: Mapped[str | None] = mapped_column(String(32))
    interrupted: Mapped[bool] = mapped_column(Boolean, default=False)
    complete: Mapped[bool] = mapped_column(Boolean, default=True)
    eligible: Mapped[bool] = mapped_column(Boolean)
    exclusion_reasons: Mapped[list[str]] = mapped_column(default=list)


class IndicatorValue(Base, DerivedMixin):
    """Layer 2 behavioural indicator value per session (plan ``indicators_long``; spec features)."""

    __tablename__ = "indicators_long"
    __table_args__ = (
        Index("ix_indicators_long_current", "session_id", "indicator_id", postgresql_where=text("is_current")),
        {"schema": SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[uuid.UUID] = mapped_column(index=True)
    participant_pid: Mapped[str | None] = mapped_column(String(26), index=True)
    study_id: Mapped[str | None] = mapped_column(String(128))
    occasion_id: Mapped[str | None] = mapped_column(String(128))
    indicator_id: Mapped[str] = mapped_column(String(128), index=True)
    construct_id: Mapped[str | None] = mapped_column(String(64))
    pathway: Mapped[str | None] = mapped_column(String(1))
    value: Mapped[float | None] = mapped_column(Float)
    n_valid_trials: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), default="ok")
    """ok | insufficient_trials | not_applicable | group_only"""
    quality_flags: Mapped[list[str]] = mapped_column(default=list)
    scoring_run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey(f"{SCHEMA}.scoring_runs.run_id"))
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)


class GroupIndicatorValue(Base, DerivedMixin):
    """Group-level indicator estimate (private reports; SCR-08, BUILD_DECISIONS #6).

    Deliberately has no session or participant column: it describes a partition (study, pathway, language,
    calibration level), never a person. Partitions below ``private_report.min_group_participants`` are
    stored suppressed (no estimate).
    """

    __tablename__ = "group_indicators"
    __table_args__ = (
        Index("ix_group_indicators_study_current", "study_id", "indicator_id", postgresql_where=text("is_current")),
        {"schema": SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(String(128))
    pathway: Mapped[str] = mapped_column(String(1))
    partition: Mapped[dict[str, Any]] = mapped_column(default=dict)
    indicator_id: Mapped[str] = mapped_column(String(128))
    construct_id: Mapped[str | None] = mapped_column(String(64))
    estimate: Mapped[float | None] = mapped_column(Float)
    ci_low: Mapped[float | None] = mapped_column(Float)
    ci_high: Mapped[float | None] = mapped_column(Float)
    n_participants: Mapped[int] = mapped_column(Integer)
    n_reports: Mapped[int] = mapped_column(Integer)
    suppressed: Mapped[bool] = mapped_column(Boolean, default=False)
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)
    scoring_run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey(f"{SCHEMA}.scoring_runs.run_id"))
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)


class TraitEstimate(Base, DerivedMixin):
    """Layer 4 composite estimate and band (plan ``model_estimates``); only gate-passing traits are shown."""

    __tablename__ = "trait_estimates"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[uuid.UUID] = mapped_column(index=True)
    participant_pid: Mapped[str | None] = mapped_column(String(26), index=True)
    trait: Mapped[str] = mapped_column(String(64))
    pathway: Mapped[str] = mapped_column(String(1))
    language: Mapped[str] = mapped_column(String(16))
    composite: Mapped[float | None] = mapped_column(Float)
    sem: Mapped[float | None] = mapped_column(Float)
    band: Mapped[str | None] = mapped_column(String(16))
    not_enough_to_say: Mapped[bool] = mapped_column(Boolean, default=True)
    norm_table_version: Mapped[str | None] = mapped_column(String(64))
    release_pack_version: Mapped[str | None] = mapped_column(String(64))
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)


class SessionQualityFlag(Base):
    """Data-quality flag per session (spec ``session_quality_flags``; SCR-12, ING-05)."""

    __tablename__ = "session_quality_flags"
    __table_args__ = (
        Index(
            "uq_session_quality_flags_open",
            "session_id",
            "flag_code",
            unique=True,
            postgresql_where=text("resolved_at IS NULL"),
        ),
        {"schema": SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[uuid.UUID] = mapped_column(index=True)
    flag_code: Mapped[str] = mapped_column(String(64))
    severity: Mapped[str] = mapped_column(String(16))
    """info | warn | blocking (blocking makes the session invalid for reports)"""
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)
    algorithm_version: Mapped[str] = mapped_column(String(64))
    detected_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column()
    note: Mapped[str | None] = mapped_column(Text)
