"""/api/v1/reports: release-gated participant reports (fail closed), token/QR retrieval, templates."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from shriii_api.api.deps import DbSession, SettingsDep, ensure_study_access, raise_error, require, set_audit
from shriii_api.api.schemas import ApiModel
from shriii_api.api.v1.participants import ErasureOut, create_erasure_request
from shriii_api.auth.rbac import Perm, Principal
from shriii_api.db.models.kiosk_raw import GameSession
from shriii_api.db.models.ops import Report, ReportApproval, ReportTemplate
from shriii_api.services import reports as report_svc

router = APIRouter(prefix="/reports", tags=["reports"])

DeliveryMode = Literal["spoken", "printed", "qr", "screen"]
_SCREEN: DeliveryMode = "screen"


class ReportCreate(BaseModel):
    session_id: uuid.UUID
    report_mode: Literal["thank_you", "player_report", "demo"] = "thank_you"
    delivery_modes: list[DeliveryMode] = Field(default_factory=lambda: [_SCREEN])
    ttl_hours: int | None = Field(default=None, ge=1, le=24 * 7)
    template_id: str | None = None


class ReportCreated(BaseModel):
    artefact: dict[str, Any] = Field(description="ReportArtefact (contains the retrieval token once)")
    qr_url: str


class ReportOut(ApiModel):
    report_id: uuid.UUID
    session_id: uuid.UUID
    language: str
    report_mode: str
    requested_mode: str
    traits_shown: list[Any]
    artefact: dict[str, Any]
    gate_evaluation: dict[str, Any]
    template_id: str | None
    created_at: datetime
    expires_at: datetime
    withdrawn_at: datetime | None
    withdrawn_reason: str | None


class WithdrawIn(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


class TemplateIn(BaseModel):
    template_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_.-]{0,127}$")
    version: str
    language: str = Field(pattern=r"^[a-z]{2,3}-[A-Z]{2}$")
    report_mode: Literal["thank_you", "player_report", "demo"]
    layout: dict[str, Any] = Field(default_factory=dict)


class TemplateOut(ApiModel):
    id: int
    template_id: str
    version: str
    language: str
    report_mode: str
    layout: dict[str, Any]
    status: str
    created_by: str
    created_at: datetime


class TemplateDecision(BaseModel):
    decision: Literal["approve", "withdraw"]
    note: str | None = None


@router.post(
    "",
    response_model=ReportCreated,
    status_code=status.HTTP_201_CREATED,
    summary="Generate a report (player_report only when every gate passes; otherwise thank_you)",
)
def create_report(
    body: ReportCreate,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.REPORTS_GENERATE))],
) -> ReportCreated:
    session_row = db.get(GameSession, body.session_id)
    if session_row is None:
        raise_error(404, "unknown_session", "session not found")
    if principal.kind == "device" and principal.kiosk_id != session_row.kiosk_id:
        raise_error(403, "kiosk_mismatch", "session belongs to another kiosk")
    ensure_study_access(request, principal, session_row.study_id)
    generated = report_svc.generate_report(
        db,
        settings,
        session_id=body.session_id,
        requested_mode=body.report_mode,
        delivery_modes=list(body.delivery_modes),
        ttl_hours=body.ttl_hours,
        actor=principal.sub,
        template_id=body.template_id,
    )
    artefact = {**generated.report.artefact, "token": generated.token}
    set_audit(
        request,
        action="reports.generate",
        resource_type="report",
        resource_id=str(generated.report.report_id),
        study_id=session_row.study_id,
        requested_mode=body.report_mode,
        delivered_mode=generated.report.report_mode,
        traits=len(generated.report.traits_shown),
    )
    return ReportCreated(artefact=artefact, qr_url=generated.qr_url)


@router.get("/by-token/{token}", summary="Retrieve a report by its opaque token (public, expiring)")
def by_token(token: str, request: Request, db: DbSession) -> dict[str, Any]:
    report = report_svc.find_by_token(db, token)
    if report is None:
        raise_error(404, "report_not_found", "report not found or expired")
    set_audit(request, action="reports.token_view", resource_type="report", resource_id=str(report.report_id))
    return {**report.artefact, "token": token}


@router.post(
    "/by-token/{token}/erase",
    response_model=ErasureOut,
    status_code=status.HTTP_202_ACCEPTED,
    summary="'Erase my data' from the report page (session erasure)",
)
def erase_by_token(token: str, request: Request, db: DbSession, settings: SettingsDep) -> ErasureOut:
    report = report_svc.find_by_token(db, token)
    if report is None:
        raise_error(404, "report_not_found", "report not found or expired")
    session_row = db.get(GameSession, report.session_id)
    req = create_erasure_request(
        db,
        settings,
        scope="session",
        pid=None,
        session_id=report.session_id,
        channel="qr_page",
        reason="erase my data (report page)",
        actor=f"report-token:{report.report_id}",
    )
    report.withdrawn_at = datetime.now(UTC)
    report.withdrawn_reason = "erasure requested"
    set_audit(
        request,
        action="erasure.request",
        resource_type="erasure_request",
        resource_id=str(req.request_id),
        study_id=session_row.study_id if session_row else None,
    )
    return ErasureOut.model_validate(req)


@router.get("", response_model=list[ReportOut], summary="Reports with gate evaluation (research mode)")
def list_reports(
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.REPORTS_READ))],
    session_id: uuid.UUID,
) -> list[ReportOut]:
    session_row = db.get(GameSession, session_id)
    ensure_study_access(request, principal, session_row.study_id if session_row else None)
    rows = db.execute(select(Report).where(Report.session_id == session_id).order_by(Report.created_at.desc()))
    set_audit(request, action="reports.read", resource_id=str(session_id))
    return [ReportOut.model_validate(r) for r in rows.scalars()]


@router.post("/{report_id}/withdraw", response_model=ReportOut, summary="Withdraw a delivered report")
def withdraw(
    report_id: uuid.UUID,
    body: WithdrawIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.REPORTS_MANAGE))],
) -> ReportOut:
    report = db.get(Report, report_id)
    if report is None:
        raise_error(404, "unknown_report", "report not found")
    report.withdrawn_at = datetime.now(UTC)
    report.withdrawn_reason = body.reason
    db.add(
        ReportApproval(
            subject_kind="report",
            subject_id=str(report_id),
            decision="withdraw",
            approver=principal.sub,
            note=body.reason,
        )
    )
    set_audit(request, action="reports.withdraw", resource_type="report", resource_id=str(report_id))
    return ReportOut.model_validate(report)


@router.get("/templates", response_model=list[TemplateOut], summary="Versioned report templates")
def list_templates(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.REPORTS_READ))]
) -> list[TemplateOut]:
    rows = db.execute(select(ReportTemplate).order_by(ReportTemplate.template_id, ReportTemplate.version))
    return [TemplateOut.model_validate(r) for r in rows.scalars()]


@router.post("/templates", response_model=TemplateOut, status_code=201, summary="Create a template version (draft)")
def create_template(
    body: TemplateIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.REPORTS_MANAGE))],
) -> TemplateOut:
    row = ReportTemplate(created_by=principal.sub, status="draft", **body.model_dump())
    db.add(row)
    db.flush()
    set_audit(request, action="reports.template.create", resource_id=f"{body.template_id}@{body.version}")
    return TemplateOut.model_validate(row)


@router.post("/templates/{template_pk}/decision", response_model=TemplateOut, summary="Approve or withdraw a template")
def template_decision(
    template_pk: int,
    body: TemplateDecision,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.REPORTS_MANAGE))],
) -> TemplateOut:
    row = db.get(ReportTemplate, template_pk)
    if row is None:
        raise_error(404, "unknown_template", "template not found")
    if body.decision == "approve" and row.created_by == principal.sub:
        raise_error(409, "four_eyes", "the author cannot approve their own template")
    row.status = "approved" if body.decision == "approve" else "withdrawn"
    db.add(
        ReportApproval(
            subject_kind="template",
            subject_id=str(template_pk),
            decision=body.decision,
            approver=principal.sub,
            note=body.note,
        )
    )
    set_audit(request, action=f"reports.template.{body.decision}", resource_id=str(template_pk))
    return TemplateOut.model_validate(row)
