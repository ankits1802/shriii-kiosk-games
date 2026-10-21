"""/api/v1/features: layer-2 behavioural indicators, definitions and extraction jobs."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from shriii_api.api.deps import DbSession, SettingsDep, ensure_study_access, raise_error, redact_pid, require, set_audit
from shriii_api.api.schemas import ApiModel, JobRef, Limit, Offset
from shriii_api.auth.rbac import Perm, Principal
from shriii_api.db.models.kiosk_raw import GameSession
from shriii_api.db.models.scored import (
    Construct,
    FeatureDefinition,
    GroupIndicatorValue,
    IndicatorDefinition,
    IndicatorValue,
    TraitMapping,
)
from shriii_api.worker.queue import enqueue

router = APIRouter(prefix="/features", tags=["features"])


class IndicatorValueOut(ApiModel):
    session_id: uuid.UUID
    participant_pid: str | None
    study_id: str | None
    occasion_id: str | None
    indicator_id: str
    construct_id: str | None
    pathway: str | None
    value: float | None
    n_valid_trials: int | None
    status: str
    quality_flags: list[str]
    algorithm_version: str
    dictionary_version: str | None
    scoring_run_id: uuid.UUID | None
    source_refs: dict[str, Any]
    is_current: bool
    computed_at: datetime


class IndicatorDefinitionOut(ApiModel):
    indicator_id: str
    pathway: str
    dictionary_version: str
    construct_id: str
    role: str | None
    tier: int | None
    status: str | None
    kind: str | None
    module_id: str | None
    definition: dict[str, Any]


class ConstructOut(ApiModel):
    construct_id: str
    name: str
    kind: str | None
    dictionary_version: str
    definition: dict[str, Any]
    mappings: list[dict[str, Any]] = Field(default_factory=list)


class ExtractIn(BaseModel):
    session_ids: list[uuid.UUID] = Field(min_length=1, max_length=1000)


def _value_out(principal: Principal, row: IndicatorValue) -> IndicatorValueOut:
    out = IndicatorValueOut.model_validate(row)
    out.participant_pid = redact_pid(principal, row.participant_pid)
    return out


@router.get("", response_model=list[IndicatorValueOut], summary="Indicator values (current by default)")
def list_features(
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.FEATURES_READ))],
    session_id: uuid.UUID | None = None,
    study_id: str | None = None,
    indicator_id: str | None = None,
    include_history: bool = False,
    limit: Limit = 1000,
    offset: Offset = 0,
) -> list[IndicatorValueOut]:
    if session_id is None and study_id is None:
        raise_error(422, "filter_required", "filter by session_id or study_id")
    stmt = select(IndicatorValue)
    if session_id is not None:
        session_row = db.get(GameSession, session_id)
        ensure_study_access(request, principal, session_row.study_id if session_row else None)
        stmt = stmt.where(IndicatorValue.session_id == session_id)
    if study_id is not None:
        ensure_study_access(request, principal, study_id)
        stmt = stmt.where(IndicatorValue.study_id == study_id)
    if indicator_id:
        stmt = stmt.where(IndicatorValue.indicator_id == indicator_id)
    if not include_history:
        stmt = stmt.where(IndicatorValue.is_current.is_(True))
    rows = db.execute(
        stmt.order_by(IndicatorValue.session_id, IndicatorValue.indicator_id).limit(limit).offset(offset)
    ).scalars()
    set_audit(request, action="features.read", study_id=study_id, resource_id=str(session_id) if session_id else None)
    return [_value_out(principal, r) for r in rows]


@router.get("/matrix", summary="Participant x occasion indicator matrix for a study (wide)")
def matrix(
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.FEATURES_READ))],
    study_id: str,
    occasion_id: str | None = None,
) -> dict[str, Any]:
    ensure_study_access(request, principal, study_id)
    stmt = select(IndicatorValue).where(IndicatorValue.study_id == study_id, IndicatorValue.is_current.is_(True))
    if occasion_id:
        stmt = stmt.where(IndicatorValue.occasion_id == occasion_id)
    rows: dict[tuple[str, str | None], dict[str, Any]] = {}
    indicators: set[str] = set()
    for iv in db.execute(stmt).scalars():
        key = (str(iv.session_id), iv.occasion_id)
        entry = rows.setdefault(
            key,
            {
                "session_id": str(iv.session_id),
                "occasion_id": iv.occasion_id,
                "participant_pid": redact_pid(principal, iv.participant_pid),
                "values": {},
            },
        )
        entry["values"][iv.indicator_id] = iv.value
        indicators.add(iv.indicator_id)
    set_audit(request, action="features.matrix", study_id=study_id)
    return {"study_id": study_id, "indicators": sorted(indicators), "rows": list(rows.values())}


@router.get("/definitions", response_model=list[IndicatorDefinitionOut], summary="Indicator registry (dictionary)")
def definitions(
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.FEATURES_READ))],
    pathway: str | None = None,
    construct_id: str | None = None,
) -> list[IndicatorDefinitionOut]:
    stmt = select(IndicatorDefinition)
    if pathway:
        stmt = stmt.where(IndicatorDefinition.pathway == pathway)
    if construct_id:
        stmt = stmt.where(IndicatorDefinition.construct_id == construct_id)
    rows = db.execute(stmt.order_by(IndicatorDefinition.pathway, IndicatorDefinition.indicator_id)).scalars()
    return [IndicatorDefinitionOut.model_validate(r) for r in rows]


@router.get("/feature-definitions", summary="Extraction algorithm metadata per indicator")
def feature_definitions(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.FEATURES_READ))], pathway: str | None = None
) -> list[dict[str, Any]]:
    stmt = select(FeatureDefinition)
    if pathway:
        stmt = stmt.where(FeatureDefinition.pathway == pathway)
    return [
        {
            "indicator_id": f.indicator_id,
            "pathway": f.pathway,
            "dictionary_version": f.dictionary_version,
            "algorithm": f.algorithm,
            "direction": f.direction,
            "min_valid_trials": f.min_valid_trials,
            "event_inputs": f.event_inputs,
            "exclusions": f.exclusions,
            "definition": f.definition,
        }
        for f in db.execute(stmt.order_by(FeatureDefinition.indicator_id)).scalars()
    ]


@router.get("/constructs", response_model=list[ConstructOut], summary="Trait registry with ECD mappings")
def constructs(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.FEATURES_READ))]
) -> list[ConstructOut]:
    out = []
    for c in db.execute(select(Construct).order_by(Construct.construct_id)).scalars():
        item = ConstructOut.model_validate(c)
        item.mappings = [
            {
                "relation": m.relation,
                "pathway": m.pathway,
                "indicator_id": m.indicator_id,
                "criterion_ref": m.criterion_ref,
                "expected_sign": m.expected_sign,
                "expected_r_low": m.expected_r_low,
                "expected_r_high": m.expected_r_high,
            }
            for m in db.execute(
                select(TraitMapping)
                .where(TraitMapping.construct_id == c.construct_id)
                .order_by(TraitMapping.relation, TraitMapping.id)
            ).scalars()
        ]
        out.append(item)
    return out


@router.post(
    "/extract",
    response_model=list[JobRef],
    status_code=202,
    summary="Enqueue trial eligibility + feature extraction (reprocessing after dictionary updates)",
)
def extract(
    body: ExtractIn,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.FEATURES_RUN))],
) -> list[JobRef]:
    jobs = []
    for sid in body.session_ids:
        row = db.get(GameSession, sid)
        if row is None:
            raise_error(404, "unknown_session", f"session {sid} not found")
        ensure_study_access(request, principal, row.study_id)
        jobs.append(
            enqueue(
                db,
                "trial_eligibility",
                {"session_id": str(sid), "accepted_events": row.event_count},
                created_by=principal.sub,
                settings=settings,
                force_new=True,
            )
        )
    set_audit(request, action="features.extract", sessions=len(body.session_ids))
    return [JobRef.model_validate(j) for j in jobs]


class GroupIndicatorOut(ApiModel):
    study_id: str
    pathway: str
    partition: dict[str, Any]
    indicator_id: str
    construct_id: str | None
    estimate: float | None
    ci_low: float | None
    ci_high: float | None
    n_participants: int
    n_reports: int
    suppressed: bool
    details: dict[str, Any]
    algorithm_version: str
    scoring_run_id: uuid.UUID | None
    computed_at: datetime


@router.post(
    "/batch-scoring",
    response_model=JobRef,
    status_code=202,
    summary="Enqueue batch scoring of a study x pathway (model-based and group-level indicators)",
)
def batch_scoring(
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.FEATURES_RUN))],
    study_id: str,
    pathway: Annotated[str, Query(pattern=r"^[AB]$")],
) -> JobRef:
    ensure_study_access(request, principal, study_id)
    job = enqueue(
        db,
        "batch_scoring",
        {"study_id": study_id, "pathway": pathway},
        created_by=principal.sub,
        settings=settings,
        force_new=True,
        priority=70,
    )
    set_audit(request, action="features.batch_scoring", study_id=study_id, pathway=pathway)
    return JobRef.model_validate(job)


@router.get(
    "/group-indicators",
    response_model=list[GroupIndicatorOut],
    summary="Group-level estimates (private reports): partitions only, never individuals; small cells suppressed",
)
def group_indicators(
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.FEATURES_READ))],
    study_id: str,
    include_history: bool = False,
) -> list[GroupIndicatorOut]:
    ensure_study_access(request, principal, study_id)
    stmt = select(GroupIndicatorValue).where(GroupIndicatorValue.study_id == study_id)
    if not include_history:
        stmt = stmt.where(GroupIndicatorValue.is_current.is_(True))
    rows = db.execute(stmt.order_by(GroupIndicatorValue.indicator_id, GroupIndicatorValue.id)).scalars()
    return [GroupIndicatorOut.model_validate(r) for r in rows]
