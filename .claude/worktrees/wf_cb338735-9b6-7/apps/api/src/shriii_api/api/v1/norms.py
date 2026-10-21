"""/api/v1/norms: reference populations, norm tables (provisional by default) and interpretations."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from shriii_api.api.deps import DbSession, SettingsDep, ensure_study_access, raise_error, require, set_audit
from shriii_api.api.schemas import ApiModel, JobRef
from shriii_api.auth.rbac import Perm, Principal
from shriii_api.db.models.validation import (
    DatasetSnapshot,
    NormTableRecord,
    ReferencePopulation,
    ScoreInterpretation,
)
from shriii_api.worker.queue import enqueue

router = APIRouter(prefix="/norms", tags=["norms"])

LANG = r"^[a-z]{2,3}-[A-Z]{2}$"


class ReferencePopulationIn(BaseModel):
    name: str
    language: str = Field(pattern=LANG)
    pathway: str = Field(pattern=r"^[AB]$")
    description: str | None = None
    snapshot_id: uuid.UUID | None = None
    weights_scheme: str | None = None
    effective_n: int | None = Field(default=None, ge=0)


class ReferencePopulationOut(ApiModel):
    id: uuid.UUID
    name: str
    language: str
    pathway: str
    description: str | None
    snapshot_id: uuid.UUID | None
    weights_scheme: str | None
    effective_n: int | None
    created_at: datetime


class NormGenerateIn(BaseModel):
    snapshot_id: uuid.UUID
    trait: str
    pathway: str = Field(pattern=r"^[AB]$")
    language: str = Field(pattern=LANG)
    norm_table_version: str
    reliability: float = Field(ge=0, lt=1, description="Retest reliability used for the SEM (from a validation run)")
    quantiles: list[float] = Field(default_factory=lambda: [1 / 3, 2 / 3], min_length=2, max_length=2)
    ci_level: float = Field(default=0.90, gt=0, lt=1)
    reference_population_id: uuid.UUID | None = None


class NormTableOut(ApiModel):
    id: uuid.UUID
    norm_table_version: str
    trait: str
    pathway: str
    language: str
    reference_population_id: uuid.UUID | None
    cut_points: list[Any]
    sem: float
    ci_level: float
    provisional: bool
    effective_n: int
    method: str
    coefficients: dict[str, Any]
    status: str
    approved_by: list[str]
    algorithm_version: str
    data_snapshot_id: uuid.UUID | None
    source_refs: dict[str, Any]
    computed_at: datetime


class ApproveIn(BaseModel):
    approvers: list[str] = Field(min_length=2)
    final: bool = Field(default=False, description="Mark non-provisional (final norms)")


class InterpretationOut(ApiModel):
    id: int
    trait: str
    band: str
    phrase_key: str
    version: str
    approved: bool
    approved_by: list[str]


@router.post(
    "/reference-populations",
    response_model=ReferencePopulationOut,
    status_code=201,
    summary="Register a reference population",
)
def create_population(
    body: ReferencePopulationIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.NORMS_WRITE))],
) -> ReferencePopulationOut:
    row = ReferencePopulation(created_by=principal.sub, **body.model_dump())
    db.add(row)
    db.flush()
    set_audit(request, action="norms.population", resource_type="reference_population", resource_id=str(row.id))
    return ReferencePopulationOut.model_validate(row)


@router.get("/reference-populations", response_model=list[ReferencePopulationOut], summary="Reference populations")
def list_populations(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.NORMS_READ))]
) -> list[ReferencePopulationOut]:
    rows = db.execute(select(ReferencePopulation).order_by(ReferencePopulation.created_at.desc())).scalars()
    return [ReferencePopulationOut.model_validate(r) for r in rows]


@router.post(
    "/tables",
    response_model=JobRef,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Enqueue norm generation from a snapshot (provisional draft)",
)
def generate(
    body: NormGenerateIn,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.NORMS_WRITE))],
) -> JobRef:
    snap = db.get(DatasetSnapshot, body.snapshot_id)
    if snap is None:
        raise_error(404, "unknown_snapshot", "snapshot not found")
    ensure_study_access(request, principal, snap.study_id)
    inputs = body.model_dump(mode="json")
    job = enqueue(db, "norm_generation", inputs, created_by=principal.sub, settings=settings)
    set_audit(request, action="norms.generate", study_id=snap.study_id, trait=body.trait)
    return JobRef.model_validate(job)


@router.get("/tables", response_model=list[NormTableOut], summary="Norm tables")
def list_tables(
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.NORMS_READ))],
    trait: str | None = None,
    language: str | None = None,
    pathway: str | None = None,
) -> list[NormTableOut]:
    stmt = select(NormTableRecord)
    if trait:
        stmt = stmt.where(NormTableRecord.trait == trait)
    if language:
        stmt = stmt.where(NormTableRecord.language == language)
    if pathway:
        stmt = stmt.where(NormTableRecord.pathway == pathway)
    return [
        NormTableOut.model_validate(r) for r in db.execute(stmt.order_by(NormTableRecord.computed_at.desc())).scalars()
    ]


@router.post("/tables/{table_id}/approve", response_model=NormTableOut, summary="Approve a norm table (two people)")
def approve_table(
    table_id: uuid.UUID,
    body: ApproveIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.NORMS_WRITE))],
) -> NormTableOut:
    row = db.get(NormTableRecord, table_id)
    if row is None:
        raise_error(404, "unknown_norm_table", "norm table not found")
    if len(set(body.approvers)) < 2:
        raise_error(422, "two_person_rule", "approval needs two distinct approvers")
    row.status = "approved"
    row.approved_by = sorted(set(body.approvers))
    row.provisional = not body.final
    set_audit(request, action="norms.approve", resource_type="norm_table", resource_id=str(table_id))
    return NormTableOut.model_validate(row)


@router.get("/interpretations", response_model=list[InterpretationOut], summary="Phrase allowlist entries")
def interpretations(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.NORMS_READ))]
) -> list[InterpretationOut]:
    rows = db.execute(select(ScoreInterpretation).order_by(ScoreInterpretation.trait, ScoreInterpretation.band))
    return [InterpretationOut.model_validate(r) for r in rows.scalars()]


@router.post(
    "/interpretations/{interpretation_id}/approve",
    response_model=InterpretationOut,
    summary="Approve a strengths-framed phrase key (two people)",
)
def approve_interpretation(
    interpretation_id: int,
    body: ApproveIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.NORMS_WRITE))],
) -> InterpretationOut:
    row = db.get(ScoreInterpretation, interpretation_id)
    if row is None:
        raise_error(404, "unknown_interpretation", "interpretation not found")
    if len(set(body.approvers)) < 2:
        raise_error(422, "two_person_rule", "approval needs two distinct approvers")
    row.approved = True
    row.approved_by = sorted(set(body.approvers))
    set_audit(request, action="norms.interpretation.approve", resource_id=str(interpretation_id))
    return InterpretationOut.model_validate(row)
