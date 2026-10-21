"""Reporting (layer 5), governance/operations and the job queue."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from shriii_api.db.base import Base, CreatedAtMixin

REPORTING = "reporting"
GOVERNANCE = "governance"
OPS = "ops"


# ---------------------------------------------------------------- Reporting


class ReportTemplate(Base, CreatedAtMixin):
    __tablename__ = "report_templates"
    __table_args__ = (UniqueConstraint("template_id", "version", "language"), {"schema": REPORTING})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    template_id: Mapped[str] = mapped_column(String(128))
    version: Mapped[str] = mapped_column(String(64))
    language: Mapped[str] = mapped_column(String(16))
    report_mode: Mapped[str] = mapped_column(String(32))
    layout: Mapped[dict[str, Any]] = mapped_column(default=dict)
    status: Mapped[str] = mapped_column(String(16), default="draft")
    """draft | approved | withdrawn"""
    created_by: Mapped[str] = mapped_column(String(256))


class Report(Base, CreatedAtMixin):
    """Generated ``ReportArtefact`` (the retrieval token is stored only as a digest)."""

    __tablename__ = "reports"
    __table_args__ = {"schema": REPORTING}

    report_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    token_digest: Mapped[str] = mapped_column(String(64), unique=True)
    session_id: Mapped[uuid.UUID] = mapped_column(index=True)
    language: Mapped[str] = mapped_column(String(16))
    report_mode: Mapped[str] = mapped_column(String(32))
    requested_mode: Mapped[str] = mapped_column(String(32))
    traits_shown: Mapped[list[Any]] = mapped_column(default=list)
    artefact: Mapped[dict[str, Any]] = mapped_column()
    gate_evaluation: Mapped[dict[str, Any]] = mapped_column(default=dict)
    template_id: Mapped[str | None] = mapped_column(String(128))
    expires_at: Mapped[datetime] = mapped_column()
    withdrawn_at: Mapped[datetime | None] = mapped_column()
    withdrawn_reason: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(256))


class ReportApproval(Base, CreatedAtMixin):
    __tablename__ = "report_approvals"
    __table_args__ = {"schema": REPORTING}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    subject_kind: Mapped[str] = mapped_column(String(16))
    """template | report"""
    subject_id: Mapped[str] = mapped_column(String(128))
    decision: Mapped[str] = mapped_column(String(16))
    """approve | withdraw"""
    approver: Mapped[str] = mapped_column(String(256))
    note: Mapped[str | None] = mapped_column(Text)


# ---------------------------------------------------------------- Governance


class AuditEvent(Base):
    """Append-only audit log of every write and every research-data access (PRV-08)."""

    __tablename__ = "audit_events"
    __table_args__ = (Index("ix_audit_events_occurred_at", "occurred_at"), {"schema": GOVERNANCE})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    occurred_at: Mapped[datetime] = mapped_column(server_default=func.now())
    actor_sub: Mapped[str | None] = mapped_column(String(256), index=True)
    actor_roles: Mapped[list[str]] = mapped_column(default=list)
    actor_kind: Mapped[str] = mapped_column(String(16))
    """user | device | anonymous | system"""
    action: Mapped[str] = mapped_column(String(128), index=True)
    method: Mapped[str | None] = mapped_column(String(8))
    path: Mapped[str | None] = mapped_column(String(1024))
    status_code: Mapped[int | None] = mapped_column(Integer)
    outcome: Mapped[str] = mapped_column(String(16))
    """success | denied | error"""
    resource_type: Mapped[str | None] = mapped_column(String(64))
    resource_id: Mapped[str | None] = mapped_column(String(256))
    study_id: Mapped[str | None] = mapped_column(String(128))
    request_id: Mapped[str | None] = mapped_column(String(64))
    ip: Mapped[str | None] = mapped_column(String(64))
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)


class Kiosk(Base, CreatedAtMixin):
    """Kiosk device registry with device-token auth (mTLS later; PRV-07)."""

    __tablename__ = "kiosks"
    __table_args__ = {"schema": GOVERNANCE}

    kiosk_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    site_id: Mapped[str] = mapped_column(String(128))
    label: Mapped[str | None] = mapped_column(String(256))
    token_digest: Mapped[str] = mapped_column(String(64), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="active")
    """active | revoked"""
    hardware_sku: Mapped[str | None] = mapped_column(String(128))
    app_version: Mapped[str | None] = mapped_column(String(64))
    last_heartbeat_at: Mapped[datetime | None] = mapped_column()
    last_heartbeat: Mapped[dict[str, Any]] = mapped_column(default=dict)
    health_status: Mapped[str] = mapped_column(String(16), default="unknown")
    revoked_at: Mapped[datetime | None] = mapped_column()


class Deployment(Base, CreatedAtMixin):
    __tablename__ = "deployments"
    __table_args__ = {"schema": GOVERNANCE}

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    kiosk_id: Mapped[str] = mapped_column(ForeignKey(f"{GOVERNANCE}.kiosks.kiosk_id"), index=True)
    site_id: Mapped[str] = mapped_column(String(128))
    site_mode: Mapped[str] = mapped_column(String(32))
    study_id: Mapped[str | None] = mapped_column(String(128))
    policy_version: Mapped[str] = mapped_column(String(64))
    app_version: Mapped[str] = mapped_column(String(64))
    content_version_id: Mapped[uuid.UUID | None] = mapped_column()
    ring: Mapped[str] = mapped_column(String(32), default="pilot")
    status: Mapped[str] = mapped_column(String(16), default="active")
    effective_from: Mapped[datetime] = mapped_column(server_default=func.now())
    created_by: Mapped[str] = mapped_column(String(256))


class ContentVersion(Base, CreatedAtMixin):
    """Hash-stamped content bundle (games, instruments, dictionary, gates, hypotheses, lines)."""

    __tablename__ = "content_versions"
    __table_args__ = (UniqueConstraint("kind", "version", "sha256"), {"schema": GOVERNANCE})

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    kind: Mapped[str] = mapped_column(String(32))
    version: Mapped[str] = mapped_column(String(64))
    sha256: Mapped[str] = mapped_column(String(64))
    manifest: Mapped[dict[str, Any]] = mapped_column(default=dict)
    status: Mapped[str] = mapped_column(String(16), default="draft")
    """draft | approved | active | retired"""
    approved_by: Mapped[list[str]] = mapped_column(default=list)
    created_by: Mapped[str] = mapped_column(String(256))


class RuntimeSetting(Base):
    __tablename__ = "settings"
    __table_args__ = {"schema": GOVERNANCE}

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column()
    description: Mapped[str | None] = mapped_column(Text)
    updated_by: Mapped[str] = mapped_column(String(256))
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class LegalHold(Base, CreatedAtMixin):
    __tablename__ = "legal_holds"
    __table_args__ = {"schema": GOVERNANCE}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    scope_kind: Mapped[str] = mapped_column(String(16))
    """study | session | participant"""
    scope_value: Mapped[str] = mapped_column(String(128))
    reason: Mapped[str] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(256))
    released_at: Mapped[datetime | None] = mapped_column()


class RetentionRun(Base):
    __tablename__ = "retention_runs"
    __table_args__ = {"schema": GOVERNANCE}

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column()
    dry_run: Mapped[bool] = mapped_column(Boolean)
    policy_sha256: Mapped[str] = mapped_column(String(64))
    report: Mapped[dict[str, Any]] = mapped_column(default=dict)
    status: Mapped[str] = mapped_column(String(16), default="running")
    triggered_by: Mapped[str] = mapped_column(String(256))


class SystemEvent(Base):
    __tablename__ = "system_events"
    __table_args__ = {"schema": GOVERNANCE}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    occurred_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)
    kind: Mapped[str] = mapped_column(String(64))
    severity: Mapped[str] = mapped_column(String(16))
    kiosk_id: Mapped[str | None] = mapped_column(String(64))
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)


class Signoff(Base, CreatedAtMixin):
    """Imported governance sign-offs (PLT-09) referenced by gate promotions."""

    __tablename__ = "signoffs"
    __table_args__ = {"schema": GOVERNANCE}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    subject_kind: Mapped[str] = mapped_column(String(32))
    subject_id: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(64))
    signer: Mapped[str] = mapped_column(String(256))
    document_sha256: Mapped[str | None] = mapped_column(String(64))


# ---------------------------------------------------------------- Jobs


class Job(Base, CreatedAtMixin):
    """Postgres-backed job (claimed with ``FOR UPDATE SKIP LOCKED``; idempotency key = hash(inputs))."""

    __tablename__ = "jobs"
    __table_args__ = (
        Index("ix_jobs_claim", "status", "priority", "run_after"),
        {"schema": OPS},
    )

    job_id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    job_type: Mapped[str] = mapped_column(String(64), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(64), unique=True)
    inputs: Mapped[dict[str, Any]] = mapped_column()
    status: Mapped[str] = mapped_column(String(16), default="queued")
    """queued | running | succeeded | failed | cancelled"""
    priority: Mapped[int] = mapped_column(Integer, default=100)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5)
    run_after: Mapped[datetime] = mapped_column(server_default=func.now())
    locked_by: Mapped[str | None] = mapped_column(String(128))
    locked_at: Mapped[datetime | None] = mapped_column()
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    progress_message: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict[str, Any] | None] = mapped_column()
    error: Mapped[str | None] = mapped_column(Text)
    error_history: Mapped[list[Any]] = mapped_column(default=list)
    parent_job_id: Mapped[uuid.UUID | None] = mapped_column()
    trace_id: Mapped[str | None] = mapped_column(String(64))
    created_by: Mapped[str] = mapped_column(String(256))
    started_at: Mapped[datetime | None] = mapped_column()
    finished_at: Mapped[datetime | None] = mapped_column()
