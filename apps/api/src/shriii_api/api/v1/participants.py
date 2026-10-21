"""/api/v1/participants: pseudonymous pids, pairing/QR linkage, consents, withdrawal, erasure, contact."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from shriii_api.api.deps import DbSession, SettingsDep, ensure_study_access, raise_error, require, set_audit
from shriii_api.api.schemas import ApiModel, Limit, Offset, Page
from shriii_api.auth.rbac import Perm, Principal
from shriii_api.db.models.participants import (
    ConsentArtefact,
    ErasureReceipt,
    ErasureRequest,
    Participant,
    ParticipantLink,
)
from shriii_api.db.models.study import Enrollment
from shriii_api.services import consent as consent_svc
from shriii_api.services import participants as participant_svc
from shriii_api.worker.queue import enqueue

router = APIRouter(prefix="/participants", tags=["participants"])

ConsentKind = Literal["core", "archive", "contact", "research_audio", "asr_eval", "coplay_substudy", "criterion"]


class ParticipantCreate(BaseModel):
    study_id: str | None = None
    external_ref: str | None = Field(
        default=None,
        min_length=1,
        max_length=256,
        description="Legacy identifier to reconcile; the pid is HMAC-derived and the reference is never stored.",
    )


class ParticipantOut(ApiModel):
    pid: str
    study_id: str | None
    source: str
    status: str
    created_at: datetime
    withdrawn_at: datetime | None


class LinkOut(ApiModel):
    id: int
    pid: str
    session_id: uuid.UUID
    study_id: str | None
    occasion_id: str | None
    visit_number: int
    method: str
    linked_by: str
    second_linker: str | None
    created_at: datetime


class ConsentOut(ApiModel):
    consent_id: uuid.UUID
    participant_pid: str | None
    session_id: uuid.UUID | None
    kind: str
    granted: bool
    consent_script_id: str
    script_audio_sha256: str
    language: str
    policy_version: str
    protocol_id: str | None
    input_mode: str
    presented_at: datetime
    decided_at: datetime
    kiosk_id: str | None
    replay_counts: list[Any]
    supersedes_id: uuid.UUID | None
    recorded_by: str
    created_at: datetime


class ParticipantDetail(BaseModel):
    participant: ParticipantOut
    links: list[LinkOut]
    consent: dict[str, bool]
    enrollments: list[dict[str, Any]]


class PairingCreate(BaseModel):
    study_id: str | None = None
    occasion_id: str | None = None
    visit_number: int = Field(default=1, ge=1, le=20)
    ttl_hours: int = Field(default=24, ge=1, le=24 * 30)


class PairingOut(BaseModel):
    code: str
    qr_token: str
    qr_payload: str
    expires_at: datetime


class LinkCreate(BaseModel):
    session_id: uuid.UUID
    pairing_code: str | None = Field(default=None, min_length=6, max_length=8)
    qr_token: str | None = None
    pid: str | None = None
    second_linker: str | None = Field(default=None, description="Required for manual (pid) linking")


class ConsentCreate(BaseModel):
    kind: ConsentKind
    granted: bool
    consent_script_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_.:-]{0,127}$")
    script_audio_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    language: str = Field(pattern=r"^[a-z]{2,3}-[A-Z]{2}$")
    policy_version: str
    protocol_id: str | None = None
    presented_at: datetime
    decided_at: datetime
    session_id: uuid.UUID | None = None
    kiosk_id: str | None = None
    replay_counts: list[int] = Field(default_factory=list)
    supersedes_id: uuid.UUID | None = None


class WithdrawBody(BaseModel):
    scope: Literal["stop_participation", "withdraw_and_erase"]
    reason_code: str | None = Field(default=None, max_length=64)


class WithdrawOut(BaseModel):
    pid_hmac: str
    scope: str
    erasure_request_id: uuid.UUID | None


class ErasureCreate(BaseModel):
    scope: Literal["participant", "session"]
    pid: str | None = None
    session_id: uuid.UUID | None = None
    channel: Literal["administrator", "qr_page", "kiosk_hand_icon"] = "administrator"
    reason: str | None = Field(default=None, max_length=2000)


class ErasureOut(ApiModel):
    request_id: uuid.UUID
    scope: str
    pid_hmac: str | None
    session_id: uuid.UUID | None
    channel: str
    status: str
    job_id: uuid.UUID | None
    created_at: datetime
    completed_at: datetime | None
    error: str | None
    receipt: dict[str, Any] | None = None


class ContactCreate(BaseModel):
    channel: Literal["phone", "sms", "ivr", "email"]
    contact: str = Field(min_length=3, max_length=256)
    study_id: str | None = None
    purge_after: datetime | None = None


def _participant(db: DbSession, request: Request, principal: Principal, pid: str) -> Participant:
    try:
        p = participant_svc.resolve_pid(db, pid)
    except participant_svc.LinkageError:
        raise_error(404, "unknown_pid", "participant not found")
    ensure_study_access(request, principal, p.study_id)
    set_audit(request, resource_type="participant", resource_id=p.pid_hmac[:16], study_id=p.study_id)
    return p


def create_erasure_request(
    db: DbSession,
    settings: SettingsDep,
    *,
    scope: str,
    pid: str | None,
    session_id: uuid.UUID | None,
    channel: str,
    reason: str | None,
    actor: str,
) -> ErasureRequest:
    req = ErasureRequest(
        scope=scope,
        pid=pid,
        pid_hmac=participant_svc.pid_hmac(settings, pid) if pid else None,
        session_id=session_id,
        channel=channel,
        reason=reason,
        requested_by=actor,
        status="requested",
    )
    db.add(req)
    db.flush()
    job = enqueue(db, "erasure", {"request_id": str(req.request_id)}, created_by=actor, settings=settings, priority=10)
    req.job_id = job.job_id
    db.flush()
    return req


@router.post("", response_model=ParticipantOut, status_code=status.HTTP_201_CREATED, summary="Create a pid")
def create_participant(
    body: ParticipantCreate,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.PARTICIPANTS_CREATE))],
) -> ParticipantOut:
    ensure_study_access(request, principal, body.study_id)
    p = participant_svc.create_participant(
        db, settings, created_by=principal.sub, study_id=body.study_id, external_ref=body.external_ref
    )
    set_audit(
        request,
        action="participant.create",
        resource_type="participant",
        resource_id=p.pid_hmac[:16],
        study_id=body.study_id,
    )
    return ParticipantOut.model_validate(p)


@router.get("", response_model=Page[ParticipantOut], summary="Pseudonymous participant records")
def list_participants(
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.PARTICIPANTS_READ))],
    limit: Limit = 100,
    offset: Offset = 0,
    study_id: str | None = None,
    status_filter: str | None = None,
) -> Page[ParticipantOut]:
    ensure_study_access(request, principal, study_id)
    stmt = select(Participant)
    if study_id:
        stmt = stmt.where(Participant.study_id == study_id)
    elif not principal.is_admin and "*" not in principal.studies:
        stmt = stmt.where(Participant.study_id.in_(sorted(principal.studies)))
    if status_filter:
        stmt = stmt.where(Participant.status == status_filter)
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    rows = db.execute(stmt.order_by(Participant.created_at.desc()).limit(limit).offset(offset)).scalars()
    set_audit(request, action="participant.list", resource_type="participant", study_id=study_id)
    return Page[ParticipantOut](
        items=[ParticipantOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset
    )


@router.post(
    "/link",
    response_model=LinkOut,
    status_code=status.HTTP_201_CREATED,
    summary="Link a game session to a pid (pairing code, QR token or two-person manual)",
)
def link(
    body: LinkCreate,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.PARTICIPANTS_LINK))],
) -> LinkOut:
    if principal.kind == "device" and body.pid is not None:
        raise_error(403, "manual_link_forbidden", "devices link only by pairing code or QR token")
    row = participant_svc.link_session(
        db,
        session_id=body.session_id,
        linked_by=principal.sub,
        pairing_code=body.pairing_code,
        qr_token=body.qr_token,
        pid=body.pid,
        second_linker=body.second_linker,
    )
    set_audit(
        request,
        action="participant.link",
        resource_type="session",
        resource_id=str(body.session_id),
        study_id=row.study_id,
        method=row.method,
    )
    return LinkOut.model_validate(row)


@router.post(
    "/erasure-requests",
    response_model=ErasureOut,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Request erasure of a participant or a session",
)
def request_erasure(
    body: ErasureCreate,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.ERASURE_REQUEST))],
) -> ErasureOut:
    pid = None
    if body.scope == "participant":
        if not body.pid:
            raise_error(422, "pid_required", "participant erasure needs a pid")
        pid = _participant(db, request, principal, body.pid).pid
    elif body.session_id is None:
        raise_error(422, "session_required", "session erasure needs a session_id")
    req = create_erasure_request(
        db,
        settings,
        scope=body.scope,
        pid=pid,
        session_id=body.session_id,
        channel=body.channel,
        reason=body.reason,
        actor=principal.sub,
    )
    set_audit(request, action="erasure.request", resource_type="erasure_request", resource_id=str(req.request_id))
    return ErasureOut.model_validate(req)


@router.get("/erasure-requests/{request_id}", response_model=ErasureOut, summary="Erasure status and signed receipt")
def get_erasure(
    request_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.ERASURE_REQUEST))],
) -> ErasureOut:
    req = db.get(ErasureRequest, request_id)
    if req is None:
        raise_error(404, "unknown_erasure_request", "erasure request not found")
    out = ErasureOut.model_validate(req)
    receipt = db.execute(select(ErasureReceipt).where(ErasureReceipt.request_id == request_id)).scalar_one_or_none()
    if receipt is not None:
        out.receipt = {
            "receipt_id": str(receipt.receipt_id),
            "body": receipt.body,
            "signature": receipt.signature,
            "key_id": receipt.key_id,
            "algorithm": "ed25519",
            "issued_at": receipt.issued_at.isoformat(),
        }
    set_audit(request, resource_type="erasure_request", resource_id=str(request_id))
    return out


@router.get("/{pid}", response_model=ParticipantDetail, summary="Participant record (pseudonymous)")
def get_participant(
    pid: str, request: Request, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.PARTICIPANTS_READ))]
) -> ParticipantDetail:
    p = _participant(db, request, principal, pid)
    links = db.execute(select(ParticipantLink).where(ParticipantLink.pid == p.pid)).scalars()
    enrollments = db.execute(select(Enrollment).where(Enrollment.pid == p.pid)).scalars()
    return ParticipantDetail(
        participant=ParticipantOut.model_validate(p),
        links=[LinkOut.model_validate(link_row) for link_row in links],
        consent=consent_svc.consent_state(db, pid=p.pid),
        enrollments=[
            {
                "study_id": e.study_id,
                "cohort_id": e.cohort_id,
                "arm_id": e.arm_id,
                "criterion_block": e.criterion_block,
                "status": e.status,
            }
            for e in enrollments
        ],
    )


@router.post(
    "/{pid}/pairing-codes",
    response_model=PairingOut,
    status_code=status.HTTP_201_CREATED,
    summary="Issue a pairing code + QR token",
)
def issue_pairing(
    pid: str,
    body: PairingCreate,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.PARTICIPANTS_LINK))],
) -> PairingOut:
    p = _participant(db, request, principal, pid)
    issued = participant_svc.issue_pairing(
        db,
        p,
        created_by=principal.sub,
        study_id=body.study_id or p.study_id,
        occasion_id=body.occasion_id,
        visit_number=body.visit_number,
        ttl_hours=body.ttl_hours,
    )
    set_audit(request, action="participant.pairing_code")
    return PairingOut(
        code=issued.code,
        qr_token=issued.qr_token,
        qr_payload=f"shriii:pair:{issued.qr_token}",
        expires_at=issued.expires_at,
    )


@router.get("/{pid}/consents", response_model=list[ConsentOut], summary="Consent artefacts (full history)")
def list_consents(
    pid: str, request: Request, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.CONSENT_READ))]
) -> list[ConsentOut]:
    p = _participant(db, request, principal, pid)
    session_ids = select(ParticipantLink.session_id).where(ParticipantLink.pid == p.pid)
    rows = db.execute(
        select(ConsentArtefact)
        .where((ConsentArtefact.participant_pid == p.pid) | (ConsentArtefact.session_id.in_(session_ids)))
        .order_by(ConsentArtefact.created_at)
    ).scalars()
    return [ConsentOut.model_validate(r) for r in rows]


@router.post(
    "/{pid}/consents",
    response_model=ConsentOut,
    status_code=status.HTTP_201_CREATED,
    summary="Record a consent artefact (immutable; supersedes the previous one of the same kind)",
)
def record_consent(
    pid: str,
    body: ConsentCreate,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.CONSENT_WRITE))],
) -> ConsentOut:
    p = _participant(db, request, principal, pid)
    if p.status != "active" and body.granted:
        raise_error(409, "participant_withdrawn", "cannot grant consent for a withdrawn participant")
    artefact = consent_svc.record_artefact(
        db,
        kind=body.kind,
        granted=body.granted,
        consent_script_id=body.consent_script_id,
        script_audio_sha256=body.script_audio_sha256,
        language=body.language,
        policy_version=body.policy_version,
        presented_at=body.presented_at,
        decided_at=body.decided_at,
        recorded_by=principal.sub,
        participant_pid=p.pid,
        session_id=body.session_id,
        protocol_id=body.protocol_id,
        kiosk_id=body.kiosk_id,
        replay_counts=body.replay_counts,
        supersedes_id=body.supersedes_id,
    )
    set_audit(request, action="consent.record", kind=body.kind, granted=body.granted)
    return ConsentOut.model_validate(artefact)


@router.post("/{pid}/withdraw", response_model=WithdrawOut, summary="Withdraw (optionally with erasure)")
def withdraw(
    pid: str,
    body: WithdrawBody,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.PARTICIPANTS_WITHDRAW))],
) -> WithdrawOut:
    p = _participant(db, request, principal, pid)
    erasure_id = None
    if body.scope == "withdraw_and_erase":
        req = create_erasure_request(
            db,
            settings,
            scope="participant",
            pid=p.pid,
            session_id=None,
            channel="administrator",
            reason=f"withdrawal:{body.reason_code or ''}",
            actor=principal.sub,
        )
        erasure_id = req.request_id
    w = participant_svc.record_withdrawal(
        db,
        settings,
        p,
        scope=body.scope,
        reason_code=body.reason_code,
        recorded_by=principal.sub,
        erasure_request_id=erasure_id,
    )
    set_audit(request, action="participant.withdraw", scope=body.scope)
    return WithdrawOut(pid_hmac=w.pid_hmac, scope=w.scope, erasure_request_id=erasure_id)


@router.post(
    "/{pid}/contact",
    status_code=status.HTTP_201_CREATED,
    summary="Store contact details in the identity vault (requires contact opt-in)",
)
def store_contact(
    pid: str,
    body: ContactCreate,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.CONTACT_WRITE))],
) -> dict[str, str]:
    p = _participant(db, request, principal, pid)
    if not consent_svc.has_consent(db, "contact", pid=p.pid):
        raise_error(409, "contact_opt_in_missing", "no contact opt-in recorded for this participant")
    record_id = participant_svc.store_contact(
        settings,
        pid=p.pid,
        channel=body.channel,
        contact=body.contact,
        study_id=body.study_id or p.study_id,
        actor=principal.sub,
        purge_after=body.purge_after,
    )
    set_audit(request, action="vault.store_contact")
    return {"contact_record_id": str(record_id)}
