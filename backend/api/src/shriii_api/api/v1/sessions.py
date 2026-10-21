"""/api/v1/sessions: create, resume, complete, invalidate; integrity, flags, trials and raw events."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from shriii_api.api.deps import DbSession, SettingsDep, ensure_study_access, raise_error, redact_pid, require, set_audit
from shriii_api.api.schemas import ApiModel, JobRef, Limit, Offset, Page
from shriii_api.auth.rbac import Perm, Principal
from shriii_api.db.models.kiosk_raw import ConsentParking, Event, EventDedup, GameSession
from shriii_api.db.models.scored import SessionQualityFlag, TrialCanonical
from shriii_api.security import new_uuid7
from shriii_api.services import sessions as session_svc
from shriii_api.worker.queue import enqueue

router = APIRouter(prefix="/sessions", tags=["sessions"])

UUID7 = r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"


class SessionCreate(BaseModel):
    session_id: str | None = Field(default=None, pattern=UUID7, description="Kiosk-generated UUIDv7")
    kiosk_id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,63}$")
    site_id: str = Field(min_length=1, max_length=128)
    site_mode: Literal["supervised", "open_public"]
    mode: Literal["think_aloud", "pilot", "retest", "public", "substudy"]
    language: str | None = Field(default=None, pattern=r"^[a-z]{2,3}-[A-Z]{2}$")
    battery_arm: Literal["B_fixed", "A_narrative", "B_adaptive", "A_D", "C"] | None = None
    slot_form: str | None = None
    study_id: str | None = None
    occasion_id: str | None = None
    versions: dict[str, Any] = Field(default_factory=dict)
    synthetic: bool = False


class SessionOut(ApiModel):
    session_id: uuid.UUID
    kiosk_id: str
    site_id: str | None
    site_mode: str | None
    mode: str | None
    language: str | None
    battery_arm: str | None
    pathway: str | None
    slot_form: str | None
    participant_pid: str | None
    study_id: str | None
    occasion_id: str | None
    status: str
    end_reason: str | None
    event_count: int
    last_seq_received: int | None
    max_contiguous_seq: int | None
    valid_for_report: bool
    synthetic: bool
    started_at: datetime
    completed_at: datetime | None


class FlagOut(ApiModel):
    id: int
    flag_code: str
    severity: str
    details: dict[str, Any]
    algorithm_version: str
    detected_at: datetime
    resolved_at: datetime | None


class ResumeOut(BaseModel):
    session: SessionOut
    accepted_events: int
    parked_events: int
    last_seq_received: int | None
    max_contiguous_seq: int | None
    missing_ranges: list[list[int]]


class SessionDetail(BaseModel):
    session: SessionOut
    open_flags: list[FlagOut]
    missing_ranges: list[list[int]]
    consent: dict[str, bool]


class CompleteBody(BaseModel):
    reason: Literal[
        "completed", "abandoned", "withdrawn", "time_cap", "under_age", "consent_declined", "crash_recovery"
    ] = "completed"


class InvalidateBody(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


class TrialOut(ApiModel):
    module_id: str | None
    episode_id: str | None
    block_id: str | None
    trial_id: str
    trial_index: int
    phase: str | None
    scorable: bool
    outcome: str | None
    correctness: bool | None
    latency_ms: float | None
    input_mode: str | None
    timing_flag: str | None
    complete: bool
    eligible: bool
    exclusion_reasons: list[str]
    algorithm_version: str


def _out(principal: Principal, row: GameSession) -> SessionOut:
    out = SessionOut.model_validate(row)
    out.participant_pid = redact_pid(principal, row.participant_pid)
    return out


def _load(db: DbSession, request: Request, principal: Principal, session_id: uuid.UUID) -> GameSession:
    row = db.get(GameSession, session_id)
    if row is None:
        raise_error(404, "unknown_session", "session not found")
    if principal.kind == "device" and principal.kiosk_id != row.kiosk_id:
        raise_error(403, "kiosk_mismatch", "session belongs to another kiosk")
    ensure_study_access(request, principal, row.study_id)
    set_audit(request, resource_type="session", resource_id=str(session_id), study_id=row.study_id)
    return row


@router.post("", response_model=SessionOut, status_code=status.HTTP_201_CREATED, summary="Create a session")
def create_session(
    body: SessionCreate,
    request: Request,
    response: Response,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.SESSIONS_WRITE))],
) -> SessionOut:
    if principal.kind == "device" and principal.kiosk_id != body.kiosk_id:
        raise_error(403, "kiosk_mismatch", "device token does not belong to this kiosk")
    ensure_study_access(request, principal, body.study_id)
    sid = uuid.UUID(body.session_id) if body.session_id else new_uuid7()
    existing = db.get(GameSession, sid)
    if existing is not None:
        if existing.kiosk_id != body.kiosk_id:
            raise_error(409, "session_conflict", "session id already used by another kiosk")
        response.status_code = status.HTTP_200_OK
        return _out(principal, existing)
    row = GameSession(
        session_id=sid,
        kiosk_id=body.kiosk_id,
        site_id=body.site_id,
        site_mode=body.site_mode,
        mode=body.mode,
        language=body.language,
        battery_arm=body.battery_arm,
        pathway=session_svc.pathway_for_arm(body.battery_arm),
        slot_form=body.slot_form,
        study_id=body.study_id,
        occasion_id=body.occasion_id,
        versions=body.versions,
        synthetic=body.synthetic,
        status="active",
        event_count=0,
        created_by=principal.sub,
    )
    db.add(row)
    db.flush()
    set_audit(request, action="session.create", resource_type="session", resource_id=str(sid), study_id=body.study_id)
    return _out(principal, row)


@router.get("", response_model=Page[SessionOut], summary="List sessions")
def list_sessions(
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.SESSIONS_READ))],
    limit: Limit = 100,
    offset: Offset = 0,
    study_id: str | None = None,
    status_filter: str | None = None,
    kiosk_id: str | None = None,
) -> Page[SessionOut]:
    ensure_study_access(request, principal, study_id)
    stmt = select(GameSession)
    if study_id:
        stmt = stmt.where(GameSession.study_id == study_id)
    elif not principal.is_admin and "*" not in principal.studies:
        stmt = stmt.where(GameSession.study_id.in_(sorted(principal.studies)))
    if status_filter:
        stmt = stmt.where(GameSession.status == status_filter)
    if kiosk_id:
        stmt = stmt.where(GameSession.kiosk_id == kiosk_id)
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    rows = db.execute(stmt.order_by(GameSession.started_at.desc()).limit(limit).offset(offset)).scalars()
    set_audit(request, action="session.list", resource_type="session", study_id=study_id)
    return Page[SessionOut](items=[_out(principal, r) for r in rows], total=total, limit=limit, offset=offset)


@router.get("/{session_id}", response_model=SessionDetail, summary="Session with integrity and open flags")
def get_session(
    session_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.SESSIONS_READ))],
) -> SessionDetail:
    from shriii_api.services.consent import consent_state  # noqa: PLC0415

    row = _load(db, request, principal, session_id)
    integrity = session_svc.compute_integrity(db, session_id)
    return SessionDetail(
        session=_out(principal, row),
        open_flags=[FlagOut.model_validate(f) for f in session_svc.open_flags(db, session_id)],
        missing_ranges=[list(g) for g in integrity.gaps],
        consent=consent_state(db, session_id=session_id),
    )


@router.post("/{session_id}/resume", response_model=ResumeOut, summary="Resume: what the server already holds")
def resume_session(
    session_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.SESSIONS_WRITE))],
) -> ResumeOut:
    row = _load(db, request, principal, session_id)
    if row.status in ("invalidated", "erased"):
        raise_error(409, "session_closed", f"session is {row.status}")
    integrity = session_svc.compute_integrity(db, session_id)
    accepted = db.execute(
        select(func.count())
        .select_from(EventDedup)
        .where(EventDedup.session_id == session_id, EventDedup.state == "accepted")
    ).scalar_one()
    parked = db.execute(
        select(func.count()).select_from(ConsentParking).where(ConsentParking.session_id == session_id)
    ).scalar_one()
    set_audit(request, action="session.resume")
    return ResumeOut(
        session=_out(principal, row),
        accepted_events=accepted,
        parked_events=parked,
        last_seq_received=integrity.max_seq,
        max_contiguous_seq=integrity.max_contiguous,
        missing_ranges=[list(g) for g in integrity.gaps],
    )


@router.post("/{session_id}/complete", response_model=SessionOut, summary="Mark a session ended (enqueues pipeline)")
def complete_session(
    session_id: uuid.UUID,
    body: CompleteBody,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.SESSIONS_WRITE))],
) -> SessionOut:
    row = _load(db, request, principal, session_id)
    if row.status in ("invalidated", "erased"):
        raise_error(409, "session_closed", f"session is {row.status}")
    if row.status == "active":
        session_svc.on_session_end(db, row, body.reason, settings, principal.sub)
    session_svc.refresh_integrity(db, row)
    session_svc.update_validity(db, row)
    set_audit(request, action="session.complete", reason=body.reason)
    return _out(principal, row)


@router.post("/{session_id}/invalidate", response_model=SessionOut, summary="Invalidate a session (research)")
def invalidate_session(
    session_id: uuid.UUID,
    body: InvalidateBody,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.SESSIONS_INVALIDATE))],
) -> SessionOut:
    row = _load(db, request, principal, session_id)
    row.status = "invalidated"
    row.valid_for_report = False
    row.invalidated_reason = body.reason
    row.invalidated_by = principal.sub
    session_svc.raise_flag(db, session_id, "invalidated", "blocking", {"reason": body.reason, "by": principal.sub})
    set_audit(request, action="session.invalidate", reason=body.reason)
    return _out(principal, row)


@router.get("/{session_id}/quality-flags", response_model=list[FlagOut], summary="All quality flags (incl. resolved)")
def quality_flags(
    session_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.SESSIONS_READ))],
) -> list[FlagOut]:
    _load(db, request, principal, session_id)
    rows = db.execute(
        select(SessionQualityFlag)
        .where(SessionQualityFlag.session_id == session_id)
        .order_by(SessionQualityFlag.detected_at)
    ).scalars()
    return [FlagOut.model_validate(r) for r in rows]


@router.get("/{session_id}/trials", response_model=list[TrialOut], summary="Canonical trials with eligibility")
def trials(
    session_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.FEATURES_READ))],
) -> list[TrialOut]:
    _load(db, request, principal, session_id)
    rows = db.execute(
        select(TrialCanonical).where(TrialCanonical.session_id == session_id).order_by(TrialCanonical.start_seq)
    ).scalars()
    return [TrialOut.model_validate(r) for r in rows]


@router.get("/{session_id}/events", summary="Raw events in seq order (audited research data access)")
def raw_events(
    session_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.EVENTS_READ_RAW))],
    limit: Limit = 1000,
    offset: Offset = 0,
) -> dict[str, Any]:
    _load(db, request, principal, session_id)
    rows = list(
        db.execute(
            select(Event.envelope).where(Event.session_id == session_id).order_by(Event.seq).limit(limit).offset(offset)
        ).scalars()
    )
    set_audit(request, action="events.read_raw", rows=len(rows))
    return {"session_id": str(session_id), "events": rows, "limit": limit, "offset": offset}


@router.post(
    "/{session_id}/revalidate",
    response_model=JobRef,
    status_code=202,
    summary="Enqueue event re-validation and trial eligibility",
)
def revalidate(
    session_id: uuid.UUID,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.FEATURES_RUN))],
) -> JobRef:
    row = _load(db, request, principal, session_id)
    job = enqueue(
        db,
        "event_validation",
        {"session_id": str(session_id), "events": row.event_count},
        created_by=principal.sub,
        settings=settings,
    )
    session_svc.enqueue_pipeline(db, row, settings, principal.sub)
    return JobRef.model_validate(job)
