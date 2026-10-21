"""/api/v1/admin: kiosks, deployments, content versions, gates & release packs, settings, audit, jobs, DLQ."""

from __future__ import annotations

import base64
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from shriii_api.api.deps import DbSession, SettingsDep, raise_error, require, set_audit
from shriii_api.api.schemas import ApiModel, Limit, Offset, Page
from shriii_api.auth.rbac import Perm, Principal
from shriii_api.auth.tokens import DEVICE_TOKEN_PREFIX
from shriii_api.db.models.kiosk_raw import DeadLetter
from shriii_api.db.models.ops import (
    AuditEvent,
    ContentVersion,
    Deployment,
    Job,
    Kiosk,
    LegalHold,
    RuntimeSetting,
    SystemEvent,
)
from shriii_api.db.models.participants import ErasureRequest
from shriii_api.db.models.validation import BatteryGate, ReleasePackRecord, TraitGate
from shriii_api.security import ed25519_public_key, new_opaque_token, token_digest, x25519_public_key
from shriii_api.services import content_sync
from shriii_api.services import gates as gate_svc
from shriii_api.services import ingestion as ingestion_svc
from shriii_api.services import retention as retention_svc
from shriii_api.worker import queue

router = APIRouter(prefix="/admin", tags=["admin"])

SiteMode = Literal["supervised", "open_public"]
TraitStatus = Literal["unvalidated", "research_only", "validated_broad_style", "validated_banded", "withheld"]


# ---------------------------------------------------------------- kiosks


class KioskCreate(BaseModel):
    kiosk_id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,63}$")
    site_id: str
    label: str | None = None
    hardware_sku: str | None = None


class KioskOut(ApiModel):
    kiosk_id: str
    site_id: str
    label: str | None
    status: str
    hardware_sku: str | None
    app_version: str | None
    last_heartbeat_at: datetime | None
    last_heartbeat: dict[str, Any]
    health_status: str
    created_at: datetime
    revoked_at: datetime | None


class KioskToken(BaseModel):
    kiosk: KioskOut
    device_token: str = Field(description="Shown once; store it in the kiosk's secure storage")
    backend_x25519_public_key: str = Field(description="Base64; seal per-session DEKs to this key")


class Heartbeat(BaseModel):
    app_version: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict, description="DeviceHeartbeat fields (no PII)")


def _new_device_token() -> str:
    return DEVICE_TOKEN_PREFIX + new_opaque_token(32)


@router.post("/kiosks", response_model=KioskToken, status_code=201, summary="Register a kiosk; returns its token once")
def create_kiosk(
    body: KioskCreate,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.ADMIN_KIOSKS))],
) -> KioskToken:
    if db.get(Kiosk, body.kiosk_id) is not None:
        raise_error(409, "kiosk_exists", "kiosk already registered")
    token = _new_device_token()
    kiosk = Kiosk(
        kiosk_id=body.kiosk_id,
        site_id=body.site_id,
        label=body.label,
        hardware_sku=body.hardware_sku,
        token_digest=token_digest(token),
        status="active",
        last_heartbeat={},
        health_status="unknown",
    )
    db.add(kiosk)
    db.flush()
    set_audit(request, action="kiosks.create", resource_type="kiosk", resource_id=body.kiosk_id)
    pub = base64.b64encode(x25519_public_key(settings.key_bytes("backend_x25519_private_key"))).decode()
    return KioskToken(kiosk=KioskOut.model_validate(kiosk), device_token=token, backend_x25519_public_key=pub)


@router.get("/kiosks", response_model=list[KioskOut], summary="Kiosk fleet and health")
def list_kiosks(db: DbSession, principal: Annotated[Principal, Depends(require(Perm.ADMIN_KIOSKS))]) -> list[KioskOut]:
    return [KioskOut.model_validate(k) for k in db.execute(select(Kiosk).order_by(Kiosk.kiosk_id)).scalars()]


@router.post("/kiosks/{kiosk_id}/rotate-token", response_model=KioskToken, summary="Rotate a device token")
def rotate_token(
    kiosk_id: str,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.ADMIN_KIOSKS))],
) -> KioskToken:
    kiosk = db.get(Kiosk, kiosk_id)
    if kiosk is None:
        raise_error(404, "unknown_kiosk", "kiosk not found")
    token = _new_device_token()
    kiosk.token_digest = token_digest(token)
    kiosk.status, kiosk.revoked_at = "active", None
    set_audit(request, action="kiosks.rotate_token", resource_type="kiosk", resource_id=kiosk_id)
    pub = base64.b64encode(x25519_public_key(settings.key_bytes("backend_x25519_private_key"))).decode()
    return KioskToken(kiosk=KioskOut.model_validate(kiosk), device_token=token, backend_x25519_public_key=pub)


@router.post("/kiosks/{kiosk_id}/revoke", response_model=KioskOut, summary="Revoke a kiosk (stolen/decommissioned)")
def revoke_kiosk(
    kiosk_id: str, request: Request, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.ADMIN_KIOSKS))]
) -> KioskOut:
    kiosk = db.get(Kiosk, kiosk_id)
    if kiosk is None:
        raise_error(404, "unknown_kiosk", "kiosk not found")
    kiosk.status, kiosk.revoked_at = "revoked", datetime.now(UTC)
    db.add(SystemEvent(kind="kiosk_revoked", severity="warn", kiosk_id=kiosk_id, details={"by": principal.sub}))
    set_audit(request, action="kiosks.revoke", resource_type="kiosk", resource_id=kiosk_id)
    return KioskOut.model_validate(kiosk)


@router.post("/kiosks/heartbeat", response_model=KioskOut, summary="Device heartbeat (kiosk device token)")
def heartbeat(
    body: Heartbeat,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.KIOSK_HEARTBEAT))],
) -> KioskOut:
    if principal.kiosk_id is None:
        raise_error(403, "device_only", "heartbeats come from kiosk devices")
    kiosk = db.get(Kiosk, principal.kiosk_id)
    assert kiosk is not None
    kiosk.last_heartbeat_at = datetime.now(UTC)
    kiosk.last_heartbeat = body.payload
    kiosk.app_version = body.app_version or kiosk.app_version
    kiosk.health_status = "healthy"
    set_audit(request, action="kiosks.heartbeat", resource_type="kiosk", resource_id=kiosk.kiosk_id)
    return KioskOut.model_validate(kiosk)


# ---------------------------------------------------------------- deployments and content


class DeploymentIn(BaseModel):
    kiosk_id: str
    site_id: str
    site_mode: SiteMode
    study_id: str | None = None
    policy_version: str
    app_version: str
    content_version_id: uuid.UUID | None = None
    ring: str = "pilot"


class DeploymentOut(ApiModel):
    id: uuid.UUID
    kiosk_id: str
    site_id: str
    site_mode: str
    study_id: str | None
    policy_version: str
    app_version: str
    content_version_id: uuid.UUID | None
    ring: str
    status: str
    effective_from: datetime
    created_by: str


class ContentVersionOut(ApiModel):
    id: uuid.UUID
    kind: str
    version: str
    sha256: str
    status: str
    approved_by: list[str]
    created_at: datetime


class ApproversIn(BaseModel):
    approvers: list[str] = Field(min_length=2)


@router.post("/deployments", response_model=DeploymentOut, status_code=201, summary="Deploy a kiosk to a site")
def create_deployment(
    body: DeploymentIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.ADMIN_KIOSKS))],
) -> DeploymentOut:
    if db.get(Kiosk, body.kiosk_id) is None:
        raise_error(404, "unknown_kiosk", "kiosk not found")
    for prior in db.execute(
        select(Deployment).where(Deployment.kiosk_id == body.kiosk_id, Deployment.status == "active")
    ).scalars():
        prior.status = "superseded"
    row = Deployment(created_by=principal.sub, status="active", **body.model_dump())
    db.add(row)
    db.flush()
    set_audit(
        request,
        action="deployments.create",
        resource_type="deployment",
        resource_id=str(row.id),
        study_id=body.study_id,
    )
    return DeploymentOut.model_validate(row)


@router.get("/deployments", response_model=list[DeploymentOut], summary="Deployments")
def list_deployments(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.ADMIN_KIOSKS))], kiosk_id: str | None = None
) -> list[DeploymentOut]:
    stmt = select(Deployment)
    if kiosk_id:
        stmt = stmt.where(Deployment.kiosk_id == kiosk_id)
    return [DeploymentOut.model_validate(d) for d in db.execute(stmt.order_by(Deployment.created_at.desc())).scalars()]


@router.post(
    "/content-versions/sync",
    response_model=list[ContentVersionOut],
    summary="Hash-stamp current content (games, instruments, dictionary, gates, hypotheses)",
)
def sync_content(
    request: Request, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.ADMIN_CONTENT))]
) -> list[ContentVersionOut]:
    rows = content_sync.record_content_versions(db, principal.sub)
    set_audit(request, action="content.sync", count=len(rows))
    return [ContentVersionOut.model_validate(r) for r in rows]


@router.get("/content-versions", response_model=list[ContentVersionOut], summary="Content versions")
def list_content(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.ADMIN_CONTENT))]
) -> list[ContentVersionOut]:
    rows = db.execute(select(ContentVersion).order_by(ContentVersion.kind, ContentVersion.created_at.desc()))
    return [ContentVersionOut.model_validate(r) for r in rows.scalars()]


@router.post(
    "/content-versions/{version_id}/approve",
    response_model=ContentVersionOut,
    summary="Approve a content version (two people)",
)
def approve_content(
    version_id: uuid.UUID,
    body: ApproversIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.ADMIN_CONTENT))],
) -> ContentVersionOut:
    row = db.get(ContentVersion, version_id)
    if row is None:
        raise_error(404, "unknown_content_version", "content version not found")
    if len(set(body.approvers)) < 2:
        raise_error(422, "two_person_rule", "approval needs two distinct approvers")
    row.status, row.approved_by = "approved", sorted(set(body.approvers))
    set_audit(request, action="content.approve", resource_id=str(version_id))
    return ContentVersionOut.model_validate(row)


# ---------------------------------------------------------------- gates and release packs


class BatteryGateIn(BaseModel):
    language: str = Field(pattern=r"^[a-z]{2,3}-[A-Z]{2}$")
    pathway: Literal["A", "B"]
    site_mode: SiteMode
    status: Literal["open", "closed"]
    evidence_ids: list[str] = Field(default_factory=list)
    approvers: list[str] = Field(default_factory=list)
    note: str | None = None


class TraitGateIn(BaseModel):
    trait: str
    language: str = Field(pattern=r"^[a-z]{2,3}-[A-Z]{2}$")
    pathway: Literal["A", "B"]
    status: TraitStatus
    evidence_ids: list[str] = Field(default_factory=list)
    approvers: list[str] = Field(default_factory=list)
    note: str | None = None


class GateOut(ApiModel):
    id: int
    status: str
    evidence_ids: list[str]
    approvers: list[str]
    effective_from: datetime
    gates_version: str
    note: str | None
    recorded_by: str
    created_at: datetime


class BatteryGateOut(GateOut):
    language: str
    pathway: str
    site_mode: str


class TraitGateOut(GateOut):
    trait: str
    language: str
    pathway: str


class ReleasePackOut(ApiModel):
    release_pack_version: str
    issued_at: datetime
    expires_at: datetime
    key_id: str
    revoked_at: datetime | None
    pack: dict[str, Any]


@router.post(
    "/gates/battery",
    response_model=BatteryGateOut,
    status_code=201,
    summary="Record a battery release gate status (append-only; opening needs evidence + sign-off)",
)
def set_battery_gate(
    body: BatteryGateIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.GATES_WRITE))],
) -> BatteryGateOut:
    row = gate_svc.record_battery_gate(db, actor=principal.sub, **body.model_dump())
    set_audit(
        request,
        action="gates.battery",
        resource_id=f"{body.language}/{body.pathway}/{body.site_mode}",
        status=body.status,
    )
    return BatteryGateOut.model_validate(row)


@router.post(
    "/gates/trait",
    response_model=TraitGateOut,
    status_code=201,
    summary="Record a trait gate status (caps and permanent withholds from gates.yaml enforced)",
)
def set_trait_gate(
    body: TraitGateIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.GATES_WRITE))],
) -> TraitGateOut:
    row = gate_svc.record_trait_gate(db, actor=principal.sub, **body.model_dump())
    set_audit(
        request, action="gates.trait", resource_id=f"{body.trait}/{body.language}/{body.pathway}", status=body.status
    )
    return TraitGateOut.model_validate(row)


@router.get("/gates", summary="Current gate statuses and history")
def list_gates(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.GATES_READ))], include_history: bool = False
) -> dict[str, Any]:
    battery_keys, trait_keys = gate_svc.all_gate_keys(db)
    current_b = [gate_svc.current_battery_gate(db, *k) for k in battery_keys]
    current_t = [gate_svc.current_trait_gate(db, *k) for k in trait_keys]
    out: dict[str, Any] = {
        "gates_version": str(gate_svc.gates_config()["version"]),
        "battery": [BatteryGateOut.model_validate(g).model_dump(mode="json") for g in current_b if g],
        "traits": [TraitGateOut.model_validate(g).model_dump(mode="json") for g in current_t if g],
    }
    if include_history:
        out["battery_history"] = [
            BatteryGateOut.model_validate(g).model_dump(mode="json")
            for g in db.execute(select(BatteryGate).order_by(BatteryGate.id)).scalars()
        ]
        out["trait_history"] = [
            TraitGateOut.model_validate(g).model_dump(mode="json")
            for g in db.execute(select(TraitGate).order_by(TraitGate.id)).scalars()
        ]
    return out


@router.post(
    "/gates/release-pack",
    response_model=ReleasePackOut,
    status_code=201,
    summary="Build and sign a release pack from the current gate state",
)
def build_release_pack(
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.GATES_WRITE))],
    expiry_days: int | None = None,
) -> ReleasePackOut:
    record = gate_svc.build_release_pack(db, settings, principal.sub, expiry_days)
    set_audit(request, action="gates.release_pack", resource_id=record.release_pack_version)
    return ReleasePackOut.model_validate(record)


@router.get("/gates/release-pack/current", response_model=ReleasePackOut, summary="Current signed release pack")
def current_release_pack(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.GATES_READ))]
) -> ReleasePackOut:
    record = gate_svc.current_release_pack(db)
    if record is None:
        raise_error(404, "no_release_pack", "no release pack issued (kiosks stay in thank-you mode)")
    return ReleasePackOut.model_validate(record)


@router.post("/gates/release-pack/{version}/revoke", response_model=ReleasePackOut, summary="Revoke a release pack")
def revoke_release_pack(
    version: str, request: Request, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.GATES_WRITE))]
) -> ReleasePackOut:
    record = db.execute(
        select(ReleasePackRecord).where(ReleasePackRecord.release_pack_version == version)
    ).scalar_one_or_none()
    if record is None:
        raise_error(404, "unknown_release_pack", "release pack not found")
    record.revoked_at = datetime.now(UTC)
    set_audit(request, action="gates.release_pack.revoke", resource_id=version)
    return ReleasePackOut.model_validate(record)


@router.get("/gates/release-pack/public-key", summary="Ed25519 verification key for release packs and receipts")
def release_pack_public_key(settings: SettingsDep) -> dict[str, str]:
    key = ed25519_public_key(settings.key_bytes("release_pack_signing_key"))
    return {
        "algorithm": "ed25519",
        "key_id": settings.release_pack_key_id,
        "public_key": base64.b64encode(key).decode(),
    }


# ---------------------------------------------------------------- settings and audit


class SettingIn(BaseModel):
    value: dict[str, Any]
    description: str | None = None


class SettingOut(ApiModel):
    key: str
    value: dict[str, Any]
    description: str | None
    updated_by: str
    updated_at: datetime


class AuditOut(ApiModel):
    id: int
    occurred_at: datetime
    actor_sub: str | None
    actor_roles: list[str]
    actor_kind: str
    action: str
    method: str | None
    path: str | None
    status_code: int | None
    outcome: str
    resource_type: str | None
    resource_id: str | None
    study_id: str | None
    request_id: str | None
    details: dict[str, Any]


@router.get("/settings", response_model=list[SettingOut], summary="Runtime settings")
def list_settings(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.ADMIN_SETTINGS))]
) -> list[SettingOut]:
    return [
        SettingOut.model_validate(s) for s in db.execute(select(RuntimeSetting).order_by(RuntimeSetting.key)).scalars()
    ]


@router.put("/settings/{key}", response_model=SettingOut, summary="Set a runtime setting (audited)")
def put_setting(
    key: str,
    body: SettingIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.ADMIN_SETTINGS))],
) -> SettingOut:
    row = db.get(RuntimeSetting, key)
    previous = row.value if row else None
    if row is None:
        row = RuntimeSetting(key=key, value=body.value, description=body.description, updated_by=principal.sub)
        db.add(row)
    else:
        row.value, row.description, row.updated_by = body.value, body.description, principal.sub
        row.updated_at = datetime.now(UTC)
    db.flush()
    set_audit(
        request, action="settings.put", resource_type="setting", resource_id=key, previous=previous, new=body.value
    )
    return SettingOut.model_validate(row)


@router.get("/audit", response_model=Page[AuditOut], summary="Audit log")
def audit_log(
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.AUDIT_READ))],
    limit: Limit = 100,
    offset: Offset = 0,
    actor: str | None = None,
    action: str | None = None,
    outcome: str | None = None,
    since: datetime | None = None,
) -> Page[AuditOut]:
    stmt = select(AuditEvent)
    if actor:
        stmt = stmt.where(AuditEvent.actor_sub == actor)
    if action:
        stmt = stmt.where(AuditEvent.action.like(f"{action}%"))
    if outcome:
        stmt = stmt.where(AuditEvent.outcome == outcome)
    if since:
        stmt = stmt.where(AuditEvent.occurred_at >= since)
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    rows = db.execute(stmt.order_by(AuditEvent.id.desc()).limit(limit).offset(offset)).scalars()
    return Page[AuditOut](items=[AuditOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset)


@router.get("/system-events", summary="Operational system events")
def system_events(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.ADMIN_KIOSKS))], limit: Limit = 100
) -> list[dict[str, Any]]:
    rows = db.execute(select(SystemEvent).order_by(SystemEvent.id.desc()).limit(limit)).scalars()
    return [
        {
            "id": e.id,
            "occurred_at": e.occurred_at.isoformat(),
            "kind": e.kind,
            "severity": e.severity,
            "kiosk_id": e.kiosk_id,
            "details": e.details,
        }
        for e in rows
    ]


# ---------------------------------------------------------------- jobs


class JobOut(ApiModel):
    job_id: uuid.UUID
    job_type: str
    idempotency_key: str
    inputs: dict[str, Any]
    status: str
    priority: int
    attempts: int
    max_attempts: int
    run_after: datetime
    progress: float
    progress_message: str | None
    result: dict[str, Any] | None
    error: str | None
    parent_job_id: uuid.UUID | None
    created_by: str
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class JobIn(BaseModel):
    job_type: str
    inputs: dict[str, Any] = Field(default_factory=dict)
    priority: int = Field(default=100, ge=0, le=1000)
    force_new: bool = False


@router.post(
    "/jobs",
    response_model=JobOut,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Enqueue a job (idempotent by hash(inputs) unless force_new)",
)
def enqueue_job(
    body: JobIn,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.JOBS_WRITE))],
) -> JobOut:
    if body.job_type not in queue.JOB_TYPES:
        raise_error(422, "unknown_job_type", f"job_type must be one of {', '.join(queue.JOB_TYPES)}")
    if body.job_type in ("erasure", "retention") and not principal.is_admin:
        raise_error(403, "forbidden", "governance jobs are admin only")
    job = queue.enqueue(
        db,
        body.job_type,
        body.inputs,
        created_by=principal.sub,
        settings=settings,
        priority=body.priority,
        force_new=body.force_new,
    )
    set_audit(request, action="jobs.enqueue", resource_type="job", resource_id=str(job.job_id), job_type=body.job_type)
    return JobOut.model_validate(job)


@router.get("/jobs", response_model=Page[JobOut], summary="Jobs")
def list_jobs(
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.JOBS_READ))],
    limit: Limit = 100,
    offset: Offset = 0,
    status_filter: str | None = None,
    job_type: str | None = None,
) -> Page[JobOut]:
    stmt = select(Job)
    if status_filter:
        stmt = stmt.where(Job.status == status_filter)
    if job_type:
        stmt = stmt.where(Job.job_type == job_type)
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    rows = db.execute(stmt.order_by(Job.created_at.desc()).limit(limit).offset(offset)).scalars()
    return Page[JobOut](items=[JobOut.model_validate(j) for j in rows], total=total, limit=limit, offset=offset)


@router.get("/jobs/{job_id}", response_model=JobOut, summary="One job (status/progress/result)")
def get_job(
    job_id: uuid.UUID, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.JOBS_READ))]
) -> JobOut:
    job = db.get(Job, job_id)
    if job is None:
        raise_error(404, "unknown_job", "job not found")
    return JobOut.model_validate(job)


@router.post("/jobs/{job_id}/retry", response_model=JobOut, summary="Re-queue a failed job")
def retry_job(
    job_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.JOBS_WRITE))],
) -> JobOut:
    job = db.get(Job, job_id, with_for_update=True)
    if job is None:
        raise_error(404, "unknown_job", "job not found")
    if job.status not in ("failed", "cancelled"):
        raise_error(409, "job_not_failed", f"job is {job.status}")
    job.status, job.attempts, job.error, job.run_after, job.finished_at = "queued", 0, None, datetime.now(UTC), None
    set_audit(request, action="jobs.retry", resource_type="job", resource_id=str(job_id))
    return JobOut.model_validate(job)


@router.post("/jobs/{job_id}/cancel", response_model=JobOut, summary="Cancel a queued job")
def cancel_job(
    job_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.JOBS_WRITE))],
) -> JobOut:
    if not queue.cancel(db, job_id):
        raise_error(409, "job_not_cancellable", "only queued jobs can be cancelled")
    job = db.get(Job, job_id)
    assert job is not None
    db.refresh(job)
    set_audit(request, action="jobs.cancel", resource_type="job", resource_id=str(job_id))
    return JobOut.model_validate(job)


# ---------------------------------------------------------------- DLQ, retention, holds, erasure


class DeadLetterOut(ApiModel):
    id: int
    event_id: uuid.UUID | None
    session_id: uuid.UUID | None
    seq: int | None
    batch_id: uuid.UUID | None
    kiosk_id: str | None
    app_version: str | None
    reason_code: str
    schema_path: str | None
    message: str | None
    status: str
    created_at: datetime
    replayed_at: datetime | None


class RetentionIn(BaseModel):
    dry_run: bool = True


class LegalHoldIn(BaseModel):
    scope_kind: Literal["study", "session", "participant"]
    scope_value: str
    reason: str = Field(min_length=3)


@router.get("/dead-letters", response_model=Page[DeadLetterOut], summary="Dead-letter queue (grouped by reason)")
def dead_letters(
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.DEAD_LETTER_MANAGE))],
    limit: Limit = 100,
    offset: Offset = 0,
    reason_code: str | None = None,
    status_filter: str | None = "open",
) -> Page[DeadLetterOut]:
    stmt = select(DeadLetter)
    if reason_code:
        stmt = stmt.where(DeadLetter.reason_code == reason_code)
    if status_filter:
        stmt = stmt.where(DeadLetter.status == status_filter)
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    rows = db.execute(stmt.order_by(DeadLetter.id.desc()).limit(limit).offset(offset)).scalars()
    return Page[DeadLetterOut](
        items=[DeadLetterOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset
    )


@router.get("/dead-letters/summary", summary="DLQ counts by reason code and app version")
def dead_letter_summary(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.DEAD_LETTER_MANAGE))]
) -> list[dict[str, Any]]:
    rows = db.execute(
        select(DeadLetter.reason_code, DeadLetter.app_version, func.count())
        .where(DeadLetter.status == "open")
        .group_by(DeadLetter.reason_code, DeadLetter.app_version)
    ).all()
    return [{"reason_code": r, "app_version": v, "count": int(c)} for r, v, c in rows]


@router.post("/dead-letters/{dead_letter_id}/replay", summary="Replay a dead letter (keeps event_id and seq)")
def replay_dead_letter(
    dead_letter_id: int,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.DEAD_LETTER_MANAGE))],
) -> dict[str, Any]:
    row = db.get(DeadLetter, dead_letter_id)
    if row is None:
        raise_error(404, "unknown_dead_letter", "dead letter not found")
    outcome = ingestion_svc.replay_dead_letter(db, settings, row, principal)
    set_audit(request, action="dead_letters.replay", resource_id=str(dead_letter_id), outcome=outcome)
    return outcome


@router.post("/dead-letters/{dead_letter_id}/discard", response_model=DeadLetterOut, summary="Discard a dead letter")
def discard_dead_letter(
    dead_letter_id: int,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.DEAD_LETTER_MANAGE))],
) -> DeadLetterOut:
    row = db.get(DeadLetter, dead_letter_id)
    if row is None:
        raise_error(404, "unknown_dead_letter", "dead letter not found")
    row.status = "discarded"
    set_audit(request, action="dead_letters.discard", resource_id=str(dead_letter_id))
    return DeadLetterOut.model_validate(row)


@router.post("/retention/run", summary="Run the retention schedule now (dry run by default)")
def run_retention(
    body: RetentionIn,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.RETENTION_RUN))],
) -> dict[str, Any]:
    run = retention_svc.run_retention(db, settings, dry_run=body.dry_run, triggered_by=principal.sub)
    set_audit(request, action="retention.run", dry_run=body.dry_run)
    return {
        "retention_run_id": str(run.id),
        "dry_run": run.dry_run,
        "report": run.report,
        "policy_sha256": run.policy_sha256,
    }


@router.post("/legal-holds", status_code=201, summary="Place a legal hold (blocks purge and erasure)")
def create_hold(
    body: LegalHoldIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.RETENTION_RUN))],
) -> dict[str, Any]:
    row = LegalHold(created_by=principal.sub, **body.model_dump())
    db.add(row)
    db.flush()
    set_audit(request, action="legal_holds.create", resource_id=str(row.id))
    return {"id": row.id, **body.model_dump()}


@router.post("/legal-holds/{hold_id}/release", summary="Release a legal hold")
def release_hold(
    hold_id: int, request: Request, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.RETENTION_RUN))]
) -> dict[str, Any]:
    row = db.get(LegalHold, hold_id)
    if row is None:
        raise_error(404, "unknown_hold", "legal hold not found")
    row.released_at = datetime.now(UTC)
    set_audit(request, action="legal_holds.release", resource_id=str(hold_id))
    return {"id": row.id, "released_at": row.released_at.isoformat()}


@router.get("/erasure-requests", summary="Erasure requests")
def erasure_requests(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.ERASURE_EXECUTE))], limit: Limit = 100
) -> list[dict[str, Any]]:
    rows = db.execute(select(ErasureRequest).order_by(ErasureRequest.created_at.desc()).limit(limit)).scalars()
    return [
        {
            "request_id": str(r.request_id),
            "scope": r.scope,
            "status": r.status,
            "channel": r.channel,
            "pid_hmac": r.pid_hmac,
            "session_id": str(r.session_id) if r.session_id else None,
            "created_at": r.created_at.isoformat(),
            "completed_at": r.completed_at.isoformat() if r.completed_at else None,
            "error": r.error,
        }
        for r in rows
    ]
