"""/api/v1/validation: dataset snapshots (frozen/locked Parquet) and validation runs."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from shriii_api import content
from shriii_api.adapters import validation as validation_adapter
from shriii_api.adapters.scoring import AdapterUnavailableError
from shriii_api.api.deps import DbSession, SettingsDep, ensure_study_access, raise_error, require, set_audit
from shriii_api.api.schemas import ApiModel, JobRef
from shriii_api.auth.rbac import Perm, Principal
from shriii_api.db.models.ops import Job
from shriii_api.db.models.study import Study
from shriii_api.db.models.validation import DatasetSnapshot, MatchedRecord, StatisticalResult, ValidationRun
from shriii_api.services import gate_evaluation as gate_eval_svc
from shriii_api.services import studies as study_svc
from shriii_api.worker.queue import enqueue

router = APIRouter(prefix="/validation", tags=["validation"])

ANALYSIS_JOB = {"reliability": "reliability", "construct_validity": "construct_validity", "fairness": "fairness"}
ANALYSES: tuple[str, ...] = validation_adapter.analyses()


class SnapshotSpec(BaseModel):
    occasion_ids: list[str] | None = None
    pathway: str | None = Field(default=None, pattern=r"^[AB]$")
    require_game: bool = True
    require_criterion: bool = True
    include_synthetic: bool = Field(default=False, description="Honoured only in dev/test environments")
    holdout_cohorts: list[str] = Field(default_factory=list)


class DatasetCreate(BaseModel):
    study_id: str
    name: str = Field(min_length=1, max_length=256)
    spec: SnapshotSpec = Field(default_factory=SnapshotSpec)


class DatasetOut(ApiModel):
    snapshot_id: uuid.UUID
    study_id: str
    name: str
    version: int
    status: str
    spec: dict[str, Any]
    manifest: dict[str, Any]
    exclusions: dict[str, Any]
    sha256: str | None
    row_count: int | None
    n_participants: int | None
    job_id: uuid.UUID | None
    created_by: str
    created_at: datetime
    frozen_at: datetime | None
    tombstoned_at: datetime | None
    tombstone_reason: str | None
    supersedes_id: uuid.UUID | None
    error: str | None


class RunCreate(BaseModel):
    snapshot_id: uuid.UUID
    analysis: str = Field(description=f"One of {', '.join(ANALYSES)}")
    params: dict[str, Any] = Field(default_factory=dict)
    hypothesis_ids: list[str] = Field(default_factory=list)
    confirmatory: bool = False


class ResultOut(ApiModel):
    subject: str
    subject_kind: str
    metric: str
    estimate: float | None
    ci_low: float | None
    ci_high: float | None
    ci_level: float | None
    n: int | None
    threshold: float | None
    passed: bool | None
    hypothesis_id: str | None
    exploratory: bool
    method: str
    subgroup: dict[str, Any]
    details: dict[str, Any]
    exclusions: dict[str, Any] = Field(default_factory=dict)
    provenance: dict[str, Any] = Field(default_factory=dict)


class GateEvaluationIn(BaseModel):
    pathway: str = Field(pattern=r"^[AB]$")
    languages: list[str] | None = Field(default=None, description="Default: every language with results")
    site_modes: list[str] = Field(default_factory=lambda: ["supervised"])


class RunOut(ApiModel):
    run_id: uuid.UUID
    snapshot_id: uuid.UUID
    analysis: str
    params: dict[str, Any]
    hypothesis_ids: list[str]
    confirmatory: bool
    analysis_plan_id: uuid.UUID | None
    status: str
    job_id: uuid.UUID | None
    engine: str | None
    manifest: dict[str, Any]
    error: str | None
    created_by: str
    created_at: datetime
    finished_at: datetime | None
    job_status: str | None = None
    results: list[ResultOut] | None = None


def _snapshot(db: DbSession, request: Request, principal: Principal, snapshot_id: uuid.UUID) -> DatasetSnapshot:
    snap = db.get(DatasetSnapshot, snapshot_id)
    if snap is None:
        raise_error(404, "unknown_snapshot", "snapshot not found")
    ensure_study_access(request, principal, snap.study_id)
    set_audit(request, resource_type="snapshot", resource_id=str(snapshot_id), study_id=snap.study_id)
    return snap


@router.post(
    "/datasets",
    response_model=DatasetOut,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Build a matched participant x occasion snapshot (Parquet + DB record)",
)
def create_dataset(
    body: DatasetCreate,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.DATASETS_WRITE))],
) -> DatasetOut:
    ensure_study_access(request, principal, body.study_id)
    study = db.get(Study, body.study_id)
    if study is None:
        raise_error(404, "unknown_study", "study not found")
    if study.status == "frozen":
        raise_error(409, "study_frozen", "study datasets are frozen")
    snap = DatasetSnapshot(
        study_id=body.study_id, name=body.name, status="building", spec=body.spec.model_dump(), created_by=principal.sub
    )
    db.add(snap)
    db.flush()
    job = enqueue(
        db,
        "dataset_snapshot",
        {"snapshot_id": str(snap.snapshot_id)},
        created_by=principal.sub,
        settings=settings,
        priority=40,
    )
    snap.job_id = job.job_id
    set_audit(
        request,
        action="datasets.create",
        resource_type="snapshot",
        resource_id=str(snap.snapshot_id),
        study_id=body.study_id,
    )
    return DatasetOut.model_validate(snap)


@router.get("/datasets", response_model=list[DatasetOut], summary="Snapshots of a study")
def list_datasets(
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.DATASETS_READ))],
    study_id: str,
) -> list[DatasetOut]:
    ensure_study_access(request, principal, study_id)
    rows = db.execute(
        select(DatasetSnapshot).where(DatasetSnapshot.study_id == study_id).order_by(DatasetSnapshot.created_at.desc())
    ).scalars()
    return [DatasetOut.model_validate(r) for r in rows]


@router.get("/datasets/{snapshot_id}", response_model=DatasetOut, summary="Snapshot with manifest and exclusions")
def get_dataset(
    snapshot_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.DATASETS_READ))],
) -> DatasetOut:
    return DatasetOut.model_validate(_snapshot(db, request, principal, snapshot_id))


@router.post("/datasets/{snapshot_id}/freeze", response_model=DatasetOut, summary="Freeze (lock) a ready snapshot")
def freeze_dataset(
    snapshot_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.DATASETS_WRITE))],
) -> DatasetOut:
    snap = _snapshot(db, request, principal, snapshot_id)
    if snap.status != "ready":
        raise_error(409, "snapshot_not_ready", f"snapshot is {snap.status}")
    snap.status = "frozen"
    snap.frozen_at = datetime.now(UTC)
    snap.frozen_by = principal.sub
    set_audit(request, action="datasets.freeze")
    return DatasetOut.model_validate(snap)


@router.get("/datasets/{snapshot_id}/download", summary="Download the de-identified Parquet file (audited)")
def download_dataset(
    snapshot_id: uuid.UUID,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.DATASETS_READ))],
) -> FileResponse:
    snap = _snapshot(db, request, principal, snapshot_id)
    if snap.status not in ("ready", "frozen") or not snap.parquet_path:
        raise_error(409, "snapshot_unavailable", f"snapshot is {snap.status}")
    path = Path(settings.data_dir) / snap.parquet_path
    if not path.exists():
        raise_error(410, "snapshot_file_missing", "snapshot file is missing")
    set_audit(request, action="datasets.download", rows=snap.row_count)
    return FileResponse(
        path, media_type="application/vnd.apache.parquet", filename=f"{snap.study_id}-{snap.snapshot_id}.parquet"
    )


@router.post("/matching", response_model=JobRef, status_code=202, summary="Enqueue participant-record matching")
def matching(
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.DATASETS_WRITE))],
    study_id: str,
) -> JobRef:
    ensure_study_access(request, principal, study_id)
    job = enqueue(
        db, "participant_matching", {"study_id": study_id}, created_by=principal.sub, settings=settings, force_new=True
    )
    return JobRef.model_validate(job)


@router.get("/matched-records", summary="Participant x occasion match table")
def matched_records(
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.PARTICIPANTS_READ, Perm.DATASETS_READ))],
    study_id: str,
) -> list[dict[str, Any]]:
    ensure_study_access(request, principal, study_id)
    set_audit(request, action="matched_records.read", study_id=study_id)
    return [
        {
            "pid": m.pid,
            "occasion_id": m.occasion_id,
            "session_ids": m.session_ids,
            "has_game": m.has_game,
            "has_criterion": m.has_criterion,
            "instrument_versions": m.instrument_versions,
            "game_versions": m.game_versions,
            "issues": m.issues,
            "algorithm_version": m.algorithm_version,
        }
        for m in db.execute(
            select(MatchedRecord)
            .where(MatchedRecord.study_id == study_id)
            .order_by(MatchedRecord.pid, MatchedRecord.occasion_id)
        ).scalars()
    ]


@router.post("/runs", response_model=RunOut, status_code=status.HTTP_202_ACCEPTED, summary="Enqueue an analysis")
def create_run(
    body: RunCreate,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.VALIDATION_RUN))],
) -> RunOut:
    if body.analysis not in ANALYSES:
        raise_error(422, "unknown_analysis", f"analysis must be one of {', '.join(ANALYSES)}")
    snap = _snapshot(db, request, principal, body.snapshot_id)
    if snap.status not in ("ready", "frozen"):
        raise_error(409, "snapshot_not_ready", f"snapshot is {snap.status}")
    study = db.get(Study, snap.study_id)
    if study is None:
        raise_error(404, "unknown_study", "study not found")
    plan = study_svc.require_prereg(db, study)
    if body.confirmatory:
        if snap.status != "frozen":
            raise_error(409, "snapshot_not_frozen", "confirmatory analyses run on frozen snapshots only")
        if plan is None:
            raise_error(409, "prereg_required", "confirmatory analyses need a registered analysis plan")
        known = {h["id"] for h in content.hypotheses().data.get("hypotheses", [])}
        unknown = sorted(set(body.hypothesis_ids) - known)
        if not body.hypothesis_ids or unknown:
            raise_error(
                422, "unknown_hypotheses", "confirmatory runs must cite registered hypothesis ids", unknown=unknown
            )
    run = ValidationRun(
        snapshot_id=snap.snapshot_id,
        analysis=body.analysis,
        params=body.params,
        hypothesis_ids=body.hypothesis_ids,
        confirmatory=body.confirmatory,
        analysis_plan_id=plan.plan_id if plan else None,
        status="queued",
        created_by=principal.sub,
    )
    db.add(run)
    db.flush()
    job = enqueue(
        db,
        ANALYSIS_JOB.get(body.analysis, "validation_analysis"),
        {"run_id": str(run.run_id)},
        created_by=principal.sub,
        settings=settings,
        priority=80,
    )
    run.job_id = job.job_id
    set_audit(
        request,
        action="validation.run",
        resource_type="validation_run",
        resource_id=str(run.run_id),
        analysis=body.analysis,
        confirmatory=body.confirmatory,
    )
    return RunOut.model_validate(run)


@router.get("/runs", response_model=list[RunOut], summary="Validation runs")
def list_runs(
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.VALIDATION_READ))],
    snapshot_id: uuid.UUID,
) -> list[RunOut]:
    _snapshot(db, request, principal, snapshot_id)
    rows = db.execute(
        select(ValidationRun).where(ValidationRun.snapshot_id == snapshot_id).order_by(ValidationRun.created_at.desc())
    ).scalars()
    return [RunOut.model_validate(r) for r in rows]


@router.get("/runs/{run_id}", response_model=RunOut, summary="Run status, provenance and results")
def get_run(
    run_id: uuid.UUID,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.VALIDATION_READ))],
) -> RunOut:
    run = db.get(ValidationRun, run_id)
    if run is None:
        raise_error(404, "unknown_run", "run not found")
    _snapshot(db, request, principal, run.snapshot_id)
    return _run_out(db, run)


def _run_out(db: DbSession, run: ValidationRun) -> RunOut:
    out = RunOut.model_validate(run)
    if run.job_id:
        job = db.get(Job, run.job_id)
        out.job_status = job.status if job else None
        if job is not None and job.status == "failed" and not out.error:
            out.error = job.error
    out.results = [
        ResultOut.model_validate(r)
        for r in db.execute(
            select(StatisticalResult).where(StatisticalResult.run_id == run.run_id).order_by(StatisticalResult.id)
        ).scalars()
    ]
    return out


@router.post(
    "/datasets/{snapshot_id}/gate-evaluation",
    response_model=RunOut,
    status_code=status.HTTP_201_CREATED,
    summary="Evaluate trait and battery gates from the snapshot's latest results (evaluate-only, never promotes)",
)
def gate_evaluation(
    snapshot_id: uuid.UUID,
    body: GateEvaluationIn,
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.VALIDATION_RUN))],
) -> RunOut:
    snap = _snapshot(db, request, principal, snapshot_id)
    if snap.status not in ("ready", "frozen"):
        raise_error(409, "snapshot_not_ready", f"snapshot is {snap.status}")
    try:
        run = gate_eval_svc.evaluate_snapshot_gates(
            db,
            settings,
            snap,
            pathway=body.pathway,
            actor=principal.sub,
            languages=body.languages,
            site_modes=body.site_modes,
        )
    except AdapterUnavailableError as exc:
        raise_error(503, "adapter_unavailable", str(exc))
    set_audit(request, action="validation.gate_evaluation", resource_type="validation_run", resource_id=str(run.run_id))
    return _run_out(db, run)
