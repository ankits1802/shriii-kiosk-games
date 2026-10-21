"""Validation, gates, release packs, predictive models and norming (schema ``validation``)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    Float,
    ForeignKey,
    Integer,
    PrimaryKeyConstraint,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from shriii_api.db.base import Base, CreatedAtMixin, DerivedMixin

SCHEMA = "validation"


class AnalysisPlan(Base):
    """Registered (frozen) analysis plan / pre-registration (CRT-11). Immutable once registered."""

    __tablename__ = "analysis_plans"
    __table_args__ = (UniqueConstraint("study_id", "version"), {"schema": SCHEMA})

    plan_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    study_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[str] = mapped_column(String(64))
    prereg_id: Mapped[str | None] = mapped_column(String(256))
    hypotheses_version: Mapped[str] = mapped_column(String(64))
    hypotheses_sha256: Mapped[str] = mapped_column(String(64))
    gates_version: Mapped[str] = mapped_column(String(64))
    gates_sha256: Mapped[str] = mapped_column(String(64))
    dictionary_sha256: Mapped[dict[str, Any]] = mapped_column(default=dict)
    document: Mapped[dict[str, Any]] = mapped_column(default=dict)
    registry_url: Mapped[str | None] = mapped_column(String(512))
    registered_by: Mapped[str] = mapped_column(String(256))
    registered_at: Mapped[datetime] = mapped_column(server_default=func.now())


class DatasetSnapshot(Base, CreatedAtMixin):
    """Matched participant x occasion analysis snapshot (ING-06) written as de-identified Parquet."""

    __tablename__ = "dataset_snapshots"
    __table_args__ = {"schema": SCHEMA}

    snapshot_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    study_id: Mapped[str] = mapped_column(String(128), index=True)
    name: Mapped[str] = mapped_column(String(256))
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(16), default="building")
    """building | ready | frozen | tombstoned | failed"""
    spec: Mapped[dict[str, Any]] = mapped_column(default=dict)
    manifest: Mapped[dict[str, Any]] = mapped_column(default=dict)
    exclusions: Mapped[dict[str, Any]] = mapped_column(default=dict)
    parquet_path: Mapped[str | None] = mapped_column(String(1024))
    sha256: Mapped[str | None] = mapped_column(String(64))
    row_count: Mapped[int | None] = mapped_column(Integer)
    n_participants: Mapped[int | None] = mapped_column(Integer)
    job_id: Mapped[uuid.UUID | None] = mapped_column()
    created_by: Mapped[str] = mapped_column(String(256))
    frozen_at: Mapped[datetime | None] = mapped_column()
    frozen_by: Mapped[str | None] = mapped_column(String(256))
    tombstoned_at: Mapped[datetime | None] = mapped_column()
    tombstone_reason: Mapped[str | None] = mapped_column(Text)
    supersedes_id: Mapped[uuid.UUID | None] = mapped_column()
    error: Mapped[str | None] = mapped_column(Text)


class SnapshotMember(Base):
    """Restricted pid membership of a snapshot (used only by the erasure cascade)."""

    __tablename__ = "snapshot_members"
    __table_args__ = (PrimaryKeyConstraint("snapshot_id", "pid"), {"schema": SCHEMA})

    snapshot_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey(f"{SCHEMA}.dataset_snapshots.snapshot_id", ondelete="CASCADE")
    )
    pid: Mapped[str] = mapped_column(String(26), index=True)


class MatchedRecord(Base, DerivedMixin):
    """Participant x occasion match of game sessions and criterion records (spec section 6)."""

    __tablename__ = "matched_records"
    __table_args__ = (UniqueConstraint("pid", "study_id", "occasion_id"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    pid: Mapped[str] = mapped_column(String(26), index=True)
    study_id: Mapped[str] = mapped_column(String(128))
    occasion_id: Mapped[str] = mapped_column(String(128))
    session_ids: Mapped[list[str]] = mapped_column(default=list)
    instrument_versions: Mapped[dict[str, Any]] = mapped_column(default=dict)
    game_versions: Mapped[dict[str, Any]] = mapped_column(default=dict)
    has_game: Mapped[bool] = mapped_column(Boolean)
    has_criterion: Mapped[bool] = mapped_column(Boolean)
    issues: Mapped[list[str]] = mapped_column(default=list)


class ValidationRun(Base, CreatedAtMixin):
    """Analysis run (plan ``analysis_runs``); every coefficient traces to run -> snapshot manifest."""

    __tablename__ = "validation_runs"
    __table_args__ = {"schema": SCHEMA}

    run_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    snapshot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{SCHEMA}.dataset_snapshots.snapshot_id"))
    analysis: Mapped[str] = mapped_column(String(64))
    params: Mapped[dict[str, Any]] = mapped_column(default=dict)
    hypothesis_ids: Mapped[list[str]] = mapped_column(default=list)
    confirmatory: Mapped[bool] = mapped_column(Boolean, default=False)
    analysis_plan_id: Mapped[uuid.UUID | None] = mapped_column()
    status: Mapped[str] = mapped_column(String(16), default="queued")
    job_id: Mapped[uuid.UUID | None] = mapped_column()
    engine: Mapped[str | None] = mapped_column(String(128))
    manifest: Mapped[dict[str, Any]] = mapped_column(default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(256))
    finished_at: Mapped[datetime | None] = mapped_column()


class StatisticalResult(Base):
    """``ValidationResult``: observed estimate with CI, N, threshold and provenance."""

    __tablename__ = "statistical_results"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey(f"{SCHEMA}.validation_runs.run_id", ondelete="CASCADE"), index=True
    )
    subject: Mapped[str] = mapped_column(String(256))
    subject_kind: Mapped[str] = mapped_column(String(32))
    metric: Mapped[str] = mapped_column(String(64))
    estimate: Mapped[float | None] = mapped_column(Float)
    ci_low: Mapped[float | None] = mapped_column(Float)
    ci_high: Mapped[float | None] = mapped_column(Float)
    ci_level: Mapped[float | None] = mapped_column(Float)
    n: Mapped[int | None] = mapped_column(Integer)
    threshold: Mapped[float | None] = mapped_column(Float)
    passed: Mapped[bool | None] = mapped_column(Boolean)
    hypothesis_id: Mapped[str | None] = mapped_column(String(128))
    exploratory: Mapped[bool] = mapped_column(Boolean, default=True)
    method: Mapped[str] = mapped_column(String(128))
    subgroup: Mapped[dict[str, Any]] = mapped_column(default=dict)
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)


class IndicatorDecision(Base, CreatedAtMixin):
    __tablename__ = "indicator_decisions"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    indicator_id: Mapped[str] = mapped_column(String(128), index=True)
    pathway: Mapped[str] = mapped_column(String(1))
    decision: Mapped[str] = mapped_column(String(32))
    provisional_flags: Mapped[list[str]] = mapped_column(default=list)
    rationale: Mapped[str] = mapped_column(Text)
    evidence_ids: Mapped[list[str]] = mapped_column(default=list)
    signers: Mapped[list[str]] = mapped_column(default=list)


class BatteryGate(Base, CreatedAtMixin):
    """``BatteryGateStatus`` history (append-only); the latest effective row per key is current."""

    __tablename__ = "battery_gates"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    language: Mapped[str] = mapped_column(String(16))
    pathway: Mapped[str] = mapped_column(String(1))
    site_mode: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16))
    evidence_ids: Mapped[list[str]] = mapped_column(default=list)
    approvers: Mapped[list[str]] = mapped_column(default=list)
    effective_from: Mapped[datetime] = mapped_column()
    gates_version: Mapped[str] = mapped_column(String(64))
    note: Mapped[str | None] = mapped_column(Text)
    recorded_by: Mapped[str] = mapped_column(String(256))


class TraitGate(Base, CreatedAtMixin):
    """``TraitGateStatus`` history (append-only)."""

    __tablename__ = "trait_gates"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    trait: Mapped[str] = mapped_column(String(64))
    language: Mapped[str] = mapped_column(String(16))
    pathway: Mapped[str] = mapped_column(String(1))
    status: Mapped[str] = mapped_column(String(32))
    evidence_ids: Mapped[list[str]] = mapped_column(default=list)
    approvers: Mapped[list[str]] = mapped_column(default=list)
    effective_from: Mapped[datetime] = mapped_column()
    gates_version: Mapped[str] = mapped_column(String(64))
    note: Mapped[str | None] = mapped_column(Text)
    recorded_by: Mapped[str] = mapped_column(String(256))


class ReleasePackRecord(Base, CreatedAtMixin):
    """Signed, expiring release pack (REP-03)."""

    __tablename__ = "release_packs"
    __table_args__ = (UniqueConstraint("release_pack_version"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    release_pack_version: Mapped[str] = mapped_column(String(64))
    issued_at: Mapped[datetime] = mapped_column()
    expires_at: Mapped[datetime] = mapped_column()
    pack: Mapped[dict[str, Any]] = mapped_column()
    key_id: Mapped[str] = mapped_column(String(128))
    revoked_at: Mapped[datetime | None] = mapped_column()
    created_by: Mapped[str] = mapped_column(String(256))


# ---------------------------------------------------------------- Models


class ModelVersion(Base, CreatedAtMixin):
    __tablename__ = "model_versions"
    __table_args__ = (UniqueConstraint("name", "version"), {"schema": SCHEMA})

    model_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(128))
    version: Mapped[str] = mapped_column(String(64))
    comparison: Mapped[str] = mapped_column(String(64))
    """game_to_criterion | battery_to_outcome | game_to_outcome | game_plus_battery_to_outcome"""
    target: Mapped[str] = mapped_column(String(256))
    features: Mapped[list[str]] = mapped_column(default=list)
    algorithm: Mapped[str] = mapped_column(String(64))
    params: Mapped[dict[str, Any]] = mapped_column(default=dict)
    snapshot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{SCHEMA}.dataset_snapshots.snapshot_id"))
    holdout_cohort: Mapped[str | None] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16), default="registered")
    created_by: Mapped[str] = mapped_column(String(256))


class TrainingRun(Base, CreatedAtMixin):
    __tablename__ = "training_runs"
    __table_args__ = {"schema": SCHEMA}

    run_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    model_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{SCHEMA}.model_versions.model_id"), index=True)
    job_id: Mapped[uuid.UUID | None] = mapped_column()
    status: Mapped[str] = mapped_column(String(16), default="queued")
    cv_scheme: Mapped[dict[str, Any]] = mapped_column(default=dict)
    engine: Mapped[str | None] = mapped_column(String(128))
    metrics: Mapped[dict[str, Any]] = mapped_column(default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    finished_at: Mapped[datetime | None] = mapped_column()


class ModelEvaluation(Base, CreatedAtMixin):
    __tablename__ = "model_evaluations"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    model_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{SCHEMA}.model_versions.model_id"), index=True)
    training_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{SCHEMA}.training_runs.run_id"))
    split: Mapped[str] = mapped_column(String(16))
    """cv | holdout"""
    metric: Mapped[str] = mapped_column(String(32))
    value: Mapped[float | None] = mapped_column(Float)
    sd: Mapped[float | None] = mapped_column(Float)
    n: Mapped[int | None] = mapped_column(Integer)
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)


class Prediction(Base, CreatedAtMixin):
    """Out-of-fold predictions keyed by the snapshot's de-identified research id (never the pid)."""

    __tablename__ = "predictions"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    model_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{SCHEMA}.model_versions.model_id"), index=True)
    training_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey(f"{SCHEMA}.training_runs.run_id"))
    research_id: Mapped[str] = mapped_column(String(64))
    occasion_id: Mapped[str | None] = mapped_column(String(128))
    fold: Mapped[int | None] = mapped_column(Integer)
    split: Mapped[str] = mapped_column(String(16))
    predicted: Mapped[float] = mapped_column(Float)
    observed: Mapped[float | None] = mapped_column(Float)


# ---------------------------------------------------------------- Norming


class ReferencePopulation(Base, CreatedAtMixin):
    __tablename__ = "reference_populations"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(256))
    language: Mapped[str] = mapped_column(String(16))
    pathway: Mapped[str] = mapped_column(String(1))
    description: Mapped[str | None] = mapped_column(Text)
    snapshot_id: Mapped[uuid.UUID | None] = mapped_column()
    weights_scheme: Mapped[str | None] = mapped_column(String(128))
    effective_n: Mapped[int | None] = mapped_column(Integer)
    created_by: Mapped[str] = mapped_column(String(256))


class NormTableRecord(Base, DerivedMixin):
    """``NormTable`` (VAL-11): cut-points, SEM and provisional flag per trait x language x pathway."""

    __tablename__ = "norm_tables"
    __table_args__ = (UniqueConstraint("norm_table_version", "trait", "pathway", "language"), {"schema": SCHEMA})

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    norm_table_version: Mapped[str] = mapped_column(String(64))
    trait: Mapped[str] = mapped_column(String(64))
    pathway: Mapped[str] = mapped_column(String(1))
    language: Mapped[str] = mapped_column(String(16))
    reference_population_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey(f"{SCHEMA}.reference_populations.id"))
    cut_points: Mapped[list[Any]] = mapped_column()
    sem: Mapped[float] = mapped_column(Float)
    ci_level: Mapped[float] = mapped_column(Float)
    provisional: Mapped[bool] = mapped_column(Boolean, default=True)
    effective_n: Mapped[int] = mapped_column(Integer)
    method: Mapped[str] = mapped_column(String(64))
    coefficients: Mapped[dict[str, Any]] = mapped_column(default=dict)
    status: Mapped[str] = mapped_column(String(16), default="draft")
    """draft | approved | retired"""
    approved_by: Mapped[list[str]] = mapped_column(default=list)
    created_by: Mapped[str] = mapped_column(String(256))


class ScoreInterpretation(Base, CreatedAtMixin):
    """Strengths-framed phrase allowlist entry (REP-01)."""

    __tablename__ = "score_interpretations"
    __table_args__ = (UniqueConstraint("trait", "band", "version"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    trait: Mapped[str] = mapped_column(String(64))
    band: Mapped[str] = mapped_column(String(16))
    phrase_key: Mapped[str] = mapped_column(String(128))
    version: Mapped[str] = mapped_column(String(64))
    approved: Mapped[bool] = mapped_column(Boolean, default=False)
    approved_by: Mapped[list[str]] = mapped_column(default=list)
