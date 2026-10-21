"""Experiment and study management (schema ``study``; spec section 8, CRT-07, CRT-10)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from shriii_api.db.base import Base, CreatedAtMixin

SCHEMA = "study"


class Study(Base, CreatedAtMixin):
    __tablename__ = "studies"
    __table_args__ = {"schema": SCHEMA}

    study_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    code: Mapped[str] = mapped_column(String(16))
    """S1 | S1b | S2 | S3 | S2-D | S4u | S5"""
    name: Mapped[str] = mapped_column(String(256))
    stage: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default="draft")
    """draft | active | closed | frozen"""
    requires_prereg: Mapped[bool] = mapped_column(Boolean, default=False)
    prereg_id: Mapped[str | None] = mapped_column(String(256))
    current_protocol_version: Mapped[str | None] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(Text)
    config: Mapped[dict[str, Any]] = mapped_column(default=dict)
    target_sample: Mapped[int | None] = mapped_column(Integer)
    power_record: Mapped[dict[str, Any]] = mapped_column(default=dict)
    frozen_at: Mapped[datetime | None] = mapped_column()
    created_by: Mapped[str] = mapped_column(String(256))


class ProtocolVersion(Base, CreatedAtMixin):
    __tablename__ = "protocol_versions"
    __table_args__ = (UniqueConstraint("study_id", "version"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.studies.study_id"))
    version: Mapped[str] = mapped_column(String(64))
    document_sha256: Mapped[str] = mapped_column(String(64))
    summary: Mapped[str | None] = mapped_column(Text)
    game_config: Mapped[dict[str, Any]] = mapped_column(default=dict)
    battery: Mapped[dict[str, Any]] = mapped_column(default=dict)
    effective_from: Mapped[datetime] = mapped_column()
    approved_by: Mapped[list[str]] = mapped_column(default=list)
    created_by: Mapped[str] = mapped_column(String(256))


class Cohort(Base, CreatedAtMixin):
    __tablename__ = "cohorts"
    __table_args__ = (UniqueConstraint("study_id", "cohort_id"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.studies.study_id"))
    cohort_id: Mapped[str] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(256))
    criteria: Mapped[dict[str, Any]] = mapped_column(default=dict)
    holdout: Mapped[bool] = mapped_column(Boolean, default=False)


class Quota(Base, CreatedAtMixin):
    """Stratified recruitment target per cell (language x age x gender x education x literacy)."""

    __tablename__ = "quotas"
    __table_args__ = (UniqueConstraint("study_id", "cell_key"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.studies.study_id"))
    cell_key: Mapped[str] = mapped_column(String(256))
    cell: Mapped[dict[str, Any]] = mapped_column()
    target: Mapped[int] = mapped_column(Integer)


class Arm(Base, CreatedAtMixin):
    __tablename__ = "arms"
    __table_args__ = (UniqueConstraint("study_id", "arm_id"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.studies.study_id"))
    arm_id: Mapped[str] = mapped_column(String(64))
    ratio: Mapped[int] = mapped_column(Integer, default=1)
    description: Mapped[str | None] = mapped_column(Text)


class RandomisationBlock(Base):
    """Permuted-block state per (study, cell, kind); kind = arm | criterion_block."""

    __tablename__ = "randomisation_blocks"
    __table_args__ = (UniqueConstraint("study_id", "cell_key", "kind"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.studies.study_id"))
    cell_key: Mapped[str] = mapped_column(String(256))
    kind: Mapped[str] = mapped_column(String(32))
    block: Mapped[list[str]] = mapped_column(default=list)
    position: Mapped[int] = mapped_column(Integer, default=0)
    blocks_used: Mapped[int] = mapped_column(Integer, default=0)


class Enrollment(Base, CreatedAtMixin):
    __tablename__ = "enrollments"
    __table_args__ = (UniqueConstraint("study_id", "pid"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.studies.study_id"))
    pid: Mapped[str] = mapped_column(ForeignKey("linkage.participants.pid", ondelete="CASCADE"), index=True)
    cohort_id: Mapped[str | None] = mapped_column(String(128))
    cell_key: Mapped[str | None] = mapped_column(String(256))
    cell: Mapped[dict[str, Any]] = mapped_column(default=dict)
    arm_id: Mapped[str | None] = mapped_column(String(64))
    criterion_block: Mapped[str | None] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(String(16), default="enrolled")
    eligibility: Mapped[dict[str, Any]] = mapped_column(default=dict)
    enrolled_by: Mapped[str] = mapped_column(String(256))


class MeasurementOccasion(Base, CreatedAtMixin):
    __tablename__ = "measurement_occasions"
    __table_args__ = (UniqueConstraint("study_id", "occasion_id"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.studies.study_id"))
    occasion_id: Mapped[str] = mapped_column(String(128))
    wave: Mapped[int] = mapped_column(Integer, default=1)
    label: Mapped[str] = mapped_column(String(256))
    sequence: Mapped[int] = mapped_column(Integer, default=1)
    offset_days_min: Mapped[int | None] = mapped_column(Integer)
    offset_days_max: Mapped[int | None] = mapped_column(Integer)
    instruments: Mapped[list[str]] = mapped_column(default=list)
    game_required: Mapped[bool] = mapped_column(Boolean, default=True)


class RetestSchedule(Base, CreatedAtMixin):
    __tablename__ = "retest_schedules"
    __table_args__ = (UniqueConstraint("study_id", "pid", "occasion_id"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.studies.study_id"))
    pid: Mapped[str] = mapped_column(ForeignKey("linkage.participants.pid", ondelete="CASCADE"), index=True)
    occasion_id: Mapped[str] = mapped_column(String(128))
    anchor_date: Mapped[date] = mapped_column()
    window_start: Mapped[date] = mapped_column()
    window_end: Mapped[date] = mapped_column()
    status: Mapped[str] = mapped_column(String(16), default="scheduled")
    """scheduled | completed | missed | out_of_window | cancelled"""
    channel: Mapped[str | None] = mapped_column(String(16))
    completed_at: Mapped[datetime | None] = mapped_column()


class ProtocolDeviation(Base, CreatedAtMixin):
    __tablename__ = "deviations"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.studies.study_id"))
    pid: Mapped[str | None] = mapped_column(String(26))
    session_id: Mapped[str | None] = mapped_column(String(64))
    category: Mapped[str] = mapped_column(String(64))
    severity: Mapped[str] = mapped_column(String(16))
    description: Mapped[str] = mapped_column(Text)
    reported_by: Mapped[str] = mapped_column(String(256))


class DatasetFreeze(Base, CreatedAtMixin):
    __tablename__ = "dataset_freezes"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    study_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.studies.study_id"))
    reason: Mapped[str] = mapped_column(Text)
    snapshot_ids: Mapped[list[str]] = mapped_column(default=list)
    frozen_by: Mapped[str] = mapped_column(String(256))
