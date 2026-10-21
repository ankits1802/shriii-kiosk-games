"""/api/v1/assessment-responses: criterion capture, scoring, corrections (audit history) and imports."""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile, status
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select

from shriii_api.api.deps import DbSession, SettingsDep, ensure_study_access, raise_error, require, set_audit
from shriii_api.api.schemas import ApiModel, JobRef
from shriii_api.auth.rbac import Perm, Principal
from shriii_api.db.models.criterion import ImportBatch, ImportRow, Response, ScaleScore
from shriii_api.services import criterion as criterion_svc
from shriii_api.worker.queue import enqueue

router = APIRouter(prefix="/assessment-responses", tags=["assessment-responses"])

Block = Literal["X", "A", "B", "C", "performance", "teamwork", "retest_short"]


class ItemResponseIn(BaseModel):
    item_id: str
    raw_response: float | None
    response_latency_ms: float | None = Field(default=None, ge=0)
    expected_response: float | None = Field(
        default=None,
        description=(
            "Administration-file key, stored for rescoring: the instructed response of an attention-check item, "
            "or the minimum number of moves for a performance '<problem>.moves' measure (required there)"
        ),
    )


class AdministrationIn(BaseModel):
    pid: str
    study_id: str
    wave: int = Field(default=1, ge=1)
    occasion_id: str
    instrument_id: str
    instrument_version: str | None = None
    language: str = Field(pattern=r"^[a-z]{2,3}-[A-Z]{2}$")
    block: Block
    administration_mode: Literal["self", "read_aloud"]
    administrator_id: str | None = None
    device_id: str = Field(min_length=1, max_length=128)
    audio_version: str | None = None
    site_mode: Literal["supervised", "open_public"] = "supervised"
    rater_role: Literal["self", "partner", "administrator", "observer"] = "self"
    rated_pid: str | None = None
    planned_missing_items: list[str] = Field(default_factory=list)
    responses: list[ItemResponseIn] = Field(min_length=1)


class ResponseOut(ApiModel):
    response_id: uuid.UUID
    pid: str
    subject_pid: str
    study_id: str
    wave: int
    occasion_id: str
    instrument_id: str
    instrument_version: str
    language_version: str
    block: str
    item_id: str
    raw_response: float | None
    response_latency_ms: float | None
    administration_mode: str
    administrator_id: str | None
    rater_role: str | None
    rated_pid: str | None
    device_id: str
    audio_version: str | None
    attention_check: bool
    attention_check_failed: bool | None
    planned_missing_items: list[str] = Field(default_factory=list)
    source: str
    recorded_at: datetime
    supersedes_id: uuid.UUID | None
    correction_reason: str | None
    submitted_by: str


class ScaleScoreOut(ApiModel):
    score_id: uuid.UUID
    pid: str
    study_id: str
    wave: int
    occasion_id: str
    instrument_id: str
    instrument_version: str
    scale_id: str
    score: float | None
    raw_mean: float | None
    score_type: str
    n_answered: int
    n_items: int
    key_version: str
    algorithm_version: str
    prorated: bool
    planned_missing: bool
    na_reason: str | None
    flags: list[str]
    scoring_run_id: uuid.UUID
    is_current: bool
    source_refs: dict[str, Any]
    computed_at: datetime


class SubmissionOut(BaseModel):
    responses: list[ResponseOut]
    scoring_run_id: uuid.UUID
    scores: list[ScaleScoreOut] | None = Field(
        default=None, description="Present only for callers allowed to read scores (never field administrators)"
    )


class CorrectionIn(BaseModel):
    raw_response: float | None
    reason: str = Field(min_length=3, max_length=2000)


class RescoreIn(BaseModel):
    pid: str
    study_id: str
    occasion_id: str
    instrument_id: str


class ImportSpec(BaseModel):
    study_id: str
    instrument_id: str
    instrument_version: str | None = None
    language: str = Field(pattern=r"^[a-z]{2,3}-[A-Z]{2}$")
    occasion_id: str
    wave: int = Field(default=1, ge=1)
    block: Block
    administration_mode: Literal["self", "read_aloud"] = "self"
    column_mapping: dict[str, str] = Field(
        description=(
            "{'pid': '<column>', 'item:<item_id>': '<column>', 'expected:<item_id>': '<column>', ...}; "
            "performance instruments map '<item>.<measure>' ids; 'expected:' columns carry administration-file keys"
        ),
        examples=[{"pid": "PID", "item:bscs.i01": "Q1"}],
    )


class ImportOut(ApiModel):
    import_id: uuid.UUID
    study_id: str
    instrument_id: str
    instrument_version: str
    language: str
    occasion_id: str
    wave: int
    block: str
    filename: str
    file_format: str
    file_sha256: str
    column_mapping: dict[str, Any]
    status: str
    counts: dict[str, Any]
    created_by: str
    created_at: datetime
    committed_at: datetime | None


class ImportRowOut(ApiModel):
    row_number: int
    pid: str | None
    values: dict[str, Any]
    status: str
    issues: list[Any]
    resolved_by: str | None
    resolved_at: datetime | None
    resolution_note: str | None


class ResolveIn(BaseModel):
    action: Literal["approve", "reject"]
    note: str | None = Field(default=None, max_length=2000)
    pid: str | None = None
    values: dict[str, float | None] | None = None


def _scores(db: DbSession, run_id: uuid.UUID) -> list[ScaleScoreOut]:
    rows = db.execute(
        select(ScaleScore).where(ScaleScore.scoring_run_id == run_id).order_by(ScaleScore.scale_id)
    ).scalars()
    return [ScaleScoreOut.model_validate(r) for r in rows]


@router.post(
    "",
    response_model=SubmissionOut,
    status_code=status.HTTP_201_CREATED,
    summary="Submit item responses for one administration and score them",
)
def submit(
    body: AdministrationIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.RESPONSES_WRITE))],
) -> SubmissionOut:
    ensure_study_access(request, principal, body.study_id)
    adm = criterion_svc.Administration(
        pid=body.pid,
        study_id=body.study_id,
        wave=body.wave,
        occasion_id=body.occasion_id,
        instrument_id=body.instrument_id,
        instrument_version=body.instrument_version,
        language=body.language,
        block=body.block,
        administration_mode=body.administration_mode,
        administrator_id=body.administrator_id,
        device_id=body.device_id,
        audio_version=body.audio_version,
        site_mode=body.site_mode,
        rater_role=body.rater_role,
        rated_pid=body.rated_pid,
        source="in_app",
        planned_missing_items=body.planned_missing_items,
        responses=[criterion_svc.ItemResponse(**r.model_dump()) for r in body.responses],
    )
    rows, run = criterion_svc.submit_administration(db, adm, principal.sub)
    set_audit(
        request,
        action="responses.submit",
        resource_type="administration",
        resource_id=str(run.run_id),
        study_id=body.study_id,
        instrument_id=body.instrument_id,
        items=len(rows),
    )
    return SubmissionOut(
        responses=[ResponseOut.model_validate(r) for r in rows],
        scoring_run_id=run.run_id,
        scores=_scores(db, run.run_id) if principal.has(Perm.SCORES_READ) else None,
    )


@router.get("", response_model=list[ResponseOut], summary="Current responses for one administration")
def list_responses(
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.RESPONSES_READ))],
    pid: str,
    study_id: str,
    occasion_id: str,
    instrument_id: str,
) -> list[ResponseOut]:
    ensure_study_access(request, principal, study_id)
    rows = criterion_svc.current_responses(
        db, pid=pid, study_id=study_id, occasion_id=occasion_id, instrument_id=instrument_id
    )
    set_audit(request, action="responses.read", study_id=study_id, instrument_id=instrument_id)
    return [ResponseOut.model_validate(r) for r in sorted(rows, key=lambda r: r.item_id)]


@router.get("/scores", response_model=list[ScaleScoreOut], summary="Criterion scale scores (layer 3)")
def list_scores(
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.SCORES_READ))],
    study_id: str,
    pid: str | None = None,
    occasion_id: str | None = None,
    instrument_id: str | None = None,
    include_history: bool = False,
) -> list[ScaleScoreOut]:
    ensure_study_access(request, principal, study_id)
    stmt = select(ScaleScore).where(ScaleScore.study_id == study_id)
    if pid:
        stmt = stmt.where(ScaleScore.pid == pid)
    if occasion_id:
        stmt = stmt.where(ScaleScore.occasion_id == occasion_id)
    if instrument_id:
        stmt = stmt.where(ScaleScore.instrument_id == instrument_id)
    if not include_history:
        stmt = stmt.where(ScaleScore.is_current.is_(True))
    rows = db.execute(
        stmt.order_by(ScaleScore.pid, ScaleScore.instrument_id, ScaleScore.scale_id, ScaleScore.computed_at)
    ).scalars()
    set_audit(request, action="scores.read", study_id=study_id)
    return [ScaleScoreOut.model_validate(r) for r in rows]


@router.post("/rescore", response_model=JobRef, status_code=202, summary="Enqueue questionnaire rescoring")
def rescore(
    body: RescoreIn,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.RESPONSES_WRITE, Perm.SCORES_READ))],
) -> JobRef:
    ensure_study_access(request, principal, body.study_id)
    job = enqueue(
        db, "questionnaire_scoring", body.model_dump(), created_by=principal.sub, settings=settings, force_new=True
    )
    return JobRef.model_validate(job)


@router.post("/{response_id}/correct", response_model=SubmissionOut, summary="Correct a response (superseding row)")
def correct(
    response_id: uuid.UUID,
    body: CorrectionIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.RESPONSES_WRITE))],
) -> SubmissionOut:
    original = db.get(Response, response_id)
    if original is None:
        raise_error(404, "unknown_response", "response not found")
    ensure_study_access(request, principal, original.study_id)
    row, run = criterion_svc.correct_response(
        db, response_id, raw_response=body.raw_response, reason=body.reason, actor=principal.sub
    )
    set_audit(
        request,
        action="responses.correct",
        resource_type="response",
        resource_id=str(response_id),
        study_id=original.study_id,
        reason=body.reason,
    )
    return SubmissionOut(
        responses=[ResponseOut.model_validate(row)],
        scoring_run_id=run.run_id,
        scores=_scores(db, run.run_id) if principal.has(Perm.SCORES_READ) else None,
    )


@router.get("/{response_id}/history", response_model=list[ResponseOut], summary="Correction history of a response")
def history(
    response_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.RESPONSES_READ))],
) -> list[ResponseOut]:
    chain = criterion_svc.response_history(db, response_id)
    ensure_study_access(request, principal, chain[0].study_id)
    return [ResponseOut.model_validate(r) for r in chain]


# ---------------------------------------------------------------- imports


def _import(db: DbSession, request: Request, principal: Principal, import_id: uuid.UUID) -> ImportBatch:
    batch = db.get(ImportBatch, import_id)
    if batch is None:
        raise_error(404, "unknown_import", "import not found")
    ensure_study_access(request, principal, batch.study_id)
    set_audit(request, resource_type="import", resource_id=str(import_id), study_id=batch.study_id)
    return batch


@router.post(
    "/imports",
    response_model=ImportOut,
    status_code=status.HTTP_201_CREATED,
    summary="Stage a CSV/XLSX import (column mapping + validation; ambiguous rows -> review queue)",
)
async def stage_import(
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.IMPORTS_WRITE))],
    file: Annotated[UploadFile, File(description=".csv or .xlsx file")],
    spec: Annotated[str, Form(description="ImportSpec as JSON")],
) -> ImportOut:
    try:
        parsed = ImportSpec.model_validate(json.loads(spec))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise_error(422, "invalid_import_spec", str(exc)[:500])
    ensure_study_access(request, principal, parsed.study_id)
    data = await file.read()
    from starlette.concurrency import run_in_threadpool  # noqa: PLC0415

    batch = await run_in_threadpool(
        lambda: criterion_svc.stage_import(
            db,
            filename=file.filename or "upload.csv",
            data=data,
            study_id=parsed.study_id,
            instrument_id=parsed.instrument_id,
            instrument_version=parsed.instrument_version,
            language=parsed.language,
            occasion_id=parsed.occasion_id,
            wave=parsed.wave,
            block=parsed.block,
            administration_mode=parsed.administration_mode,
            column_mapping=parsed.column_mapping,
            actor=principal.sub,
        )
    )
    set_audit(
        request,
        action="imports.stage",
        resource_type="import",
        resource_id=str(batch.import_id),
        study_id=parsed.study_id,
        counts=batch.counts,
    )
    return ImportOut.model_validate(batch)


@router.get("/imports/{import_id}", response_model=ImportOut, summary="Import status")
def get_import(
    import_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.IMPORTS_WRITE))],
) -> ImportOut:
    return ImportOut.model_validate(_import(db, request, principal, import_id))


@router.get("/imports/{import_id}/rows", response_model=list[ImportRowOut], summary="Staged rows (review queue)")
def import_rows(
    import_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.IMPORTS_WRITE))],
    status_filter: str | None = None,
) -> list[ImportRowOut]:
    _import(db, request, principal, import_id)
    stmt = select(ImportRow).where(ImportRow.import_id == import_id)
    if status_filter:
        stmt = stmt.where(ImportRow.status == status_filter)
    return [ImportRowOut.model_validate(r) for r in db.execute(stmt.order_by(ImportRow.row_number)).scalars()]


@router.post(
    "/imports/{import_id}/rows/{row_number}/resolve",
    response_model=ImportRowOut,
    summary="Manual review: approve (optionally fixing pid/values) or reject a row",
)
def resolve_row(
    import_id: uuid.UUID,
    row_number: int,
    body: ResolveIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.IMPORTS_WRITE))],
) -> ImportRowOut:
    batch = _import(db, request, principal, import_id)
    row = db.execute(
        select(ImportRow).where(ImportRow.import_id == import_id, ImportRow.row_number == row_number)
    ).scalar_one_or_none()
    if row is None:
        raise_error(404, "unknown_import_row", "row not found")
    criterion_svc.resolve_import_row(
        db, batch, row, action=body.action, actor=principal.sub, note=body.note, pid=body.pid, values=body.values
    )
    set_audit(request, action="imports.resolve", row=row_number, decision=body.action)
    return ImportRowOut.model_validate(row)


@router.post("/imports/{import_id}/commit", response_model=ImportOut, summary="Commit ready/approved rows")
def commit(
    import_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.IMPORTS_WRITE, Perm.RESPONSES_WRITE))],
) -> ImportOut:
    batch = _import(db, request, principal, import_id)
    criterion_svc.commit_import(db, batch, actor=principal.sub, device_id=f"import:{batch.file_format}")
    set_audit(request, action="imports.commit", counts=batch.counts)
    return ImportOut.model_validate(batch)


@router.post("/imports/{import_id}/cancel", response_model=ImportOut, summary="Cancel a staged import")
def cancel(
    import_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.IMPORTS_WRITE))],
) -> ImportOut:
    batch = _import(db, request, principal, import_id)
    if batch.status != "staged":
        raise_error(409, "import_not_staged", "only staged imports can be cancelled")
    batch.status = "cancelled"
    set_audit(request, action="imports.cancel")
    return ImportOut.model_validate(batch)
