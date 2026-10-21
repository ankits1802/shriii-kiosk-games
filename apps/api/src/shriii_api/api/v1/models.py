"""/api/v1/models: predictive models with participant-grouped evaluation and holdout cohorts."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from shriii_api.api.deps import DbSession, SettingsDep, ensure_study_access, raise_error, require, set_audit
from shriii_api.api.schemas import ApiModel
from shriii_api.auth.rbac import Perm, Principal
from shriii_api.db.models.validation import (
    DatasetSnapshot,
    ModelEvaluation,
    ModelVersion,
    Prediction,
    TrainingRun,
)
from shriii_api.worker.queue import enqueue

router = APIRouter(prefix="/models", tags=["models"])


class ModelCreate(BaseModel):
    name: str = Field(pattern=r"^[a-z0-9][a-z0-9_.-]{0,127}$")
    version: str
    comparison: Literal["game_to_criterion", "battery_to_outcome", "game_to_outcome", "game_plus_battery_to_outcome"]
    target: str = Field(description="Snapshot column, e.g. crit__bscs.total")
    features: list[str] = Field(min_length=1, description="Snapshot columns (ind__* / crit__*)")
    algorithm: Literal["ridge", "gradient_boosting"] = "ridge"
    params: dict[str, Any] = Field(default_factory=dict)
    snapshot_id: uuid.UUID
    holdout_cohort: str | None = Field(default=None, description="Cohort kept untouched for final confirmation")


class ModelOut(ApiModel):
    model_id: uuid.UUID
    name: str
    version: str
    comparison: str
    target: str
    features: list[str]
    algorithm: str
    params: dict[str, Any]
    snapshot_id: uuid.UUID
    holdout_cohort: str | None
    status: str
    created_by: str
    created_at: datetime


class TrainingRunOut(ApiModel):
    run_id: uuid.UUID
    model_id: uuid.UUID
    job_id: uuid.UUID | None
    status: str
    engine: str | None
    metrics: dict[str, Any]
    error: str | None
    created_at: datetime
    finished_at: datetime | None


class EvaluationOut(ApiModel):
    training_run_id: uuid.UUID
    split: str
    metric: str
    value: float | None
    sd: float | None
    n: int | None


def _model(db: DbSession, request: Request, principal: Principal, model_id: uuid.UUID) -> ModelVersion:
    model = db.get(ModelVersion, model_id)
    if model is None:
        raise_error(404, "unknown_model", "model not found")
    snap = db.get(DatasetSnapshot, model.snapshot_id)
    ensure_study_access(request, principal, snap.study_id if snap else None)
    set_audit(request, resource_type="model", resource_id=str(model_id), study_id=snap.study_id if snap else None)
    return model


@router.post(
    "",
    response_model=TrainingRunOut,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Register a model version and enqueue training/evaluation",
)
def create_model(
    body: ModelCreate,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.MODELS_WRITE))],
) -> TrainingRunOut:
    snap = db.get(DatasetSnapshot, body.snapshot_id)
    if snap is None:
        raise_error(404, "unknown_snapshot", "snapshot not found")
    ensure_study_access(request, principal, snap.study_id)
    if snap.status not in ("ready", "frozen"):
        raise_error(409, "snapshot_not_ready", f"snapshot is {snap.status}")
    columns = set(snap.manifest.get("columns", []))
    missing = sorted({body.target, *body.features} - columns)
    if missing:
        raise_error(422, "unknown_columns", "columns are not in the snapshot", columns=missing)
    if body.target in body.features:
        raise_error(422, "target_in_features", "the target cannot be a feature (leakage)")
    existing = db.execute(
        select(ModelVersion).where(ModelVersion.name == body.name, ModelVersion.version == body.version)
    ).scalar_one_or_none()
    if existing is not None:
        raise_error(409, "model_version_exists", "model name/version already registered")
    model = ModelVersion(created_by=principal.sub, status="registered", **body.model_dump())
    db.add(model)
    db.flush()
    run = TrainingRun(
        model_id=model.model_id,
        status="queued",
        cv_scheme={
            "kind": "group_k_fold",
            "groups": "research_id",
            "n_splits": int(body.params.get("n_splits", 5)),
            "holdout_cohort": body.holdout_cohort,
        },
    )
    db.add(run)
    db.flush()
    job = enqueue(
        db,
        "model_training",
        {"training_run_id": str(run.run_id)},
        created_by=principal.sub,
        settings=settings,
        priority=90,
    )
    run.job_id = job.job_id
    set_audit(
        request, action="models.create", resource_type="model", resource_id=str(model.model_id), study_id=snap.study_id
    )
    return TrainingRunOut.model_validate(run)


@router.get("", response_model=list[ModelOut], summary="Model versions")
def list_models(
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.MODELS_READ))],
    snapshot_id: uuid.UUID | None = None,
) -> list[ModelOut]:
    stmt = select(ModelVersion)
    if snapshot_id:
        stmt = stmt.where(ModelVersion.snapshot_id == snapshot_id)
    return [ModelOut.model_validate(m) for m in db.execute(stmt.order_by(ModelVersion.created_at.desc())).scalars()]


@router.get("/{model_id}", response_model=ModelOut, summary="One model version")
def get_model(
    model_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.MODELS_READ))],
) -> ModelOut:
    return ModelOut.model_validate(_model(db, request, principal, model_id))


@router.get("/{model_id}/training-runs", response_model=list[TrainingRunOut], summary="Training runs")
def training_runs(
    model_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.MODELS_READ))],
) -> list[TrainingRunOut]:
    _model(db, request, principal, model_id)
    rows = db.execute(
        select(TrainingRun).where(TrainingRun.model_id == model_id).order_by(TrainingRun.created_at.desc())
    ).scalars()
    return [TrainingRunOut.model_validate(r) for r in rows]


@router.get("/{model_id}/evaluations", response_model=list[EvaluationOut], summary="CV and holdout metrics")
def evaluations(
    model_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.MODELS_READ))],
) -> list[EvaluationOut]:
    _model(db, request, principal, model_id)
    rows = db.execute(
        select(ModelEvaluation)
        .where(ModelEvaluation.model_id == model_id)
        .order_by(ModelEvaluation.split, ModelEvaluation.metric)
    ).scalars()
    return [EvaluationOut.model_validate(r) for r in rows]


@router.get("/{model_id}/predictions", summary="Out-of-fold and holdout predictions (research ids only)")
def predictions(
    model_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.MODELS_READ))],
) -> list[dict[str, Any]]:
    _model(db, request, principal, model_id)
    set_audit(request, action="models.predictions")
    return [
        {
            "research_id": p.research_id,
            "occasion_id": p.occasion_id,
            "fold": p.fold,
            "split": p.split,
            "predicted": p.predicted,
            "observed": p.observed,
        }
        for p in db.execute(
            select(Prediction).where(Prediction.model_id == model_id).order_by(Prediction.split, Prediction.research_id)
        ).scalars()
    ]
