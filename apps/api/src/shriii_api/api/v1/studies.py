"""/api/v1/studies: studies, protocol versions, cohorts, quotas, arms, enrollment, occasions, retests,
deviations, dataset freeze and analysis-plan registration (spec section 8; CRT-07, CRT-10, CRT-11)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from shriii_api import content
from shriii_api.api.deps import DbSession, ensure_study_access, raise_error, require, set_audit
from shriii_api.api.schemas import ApiModel
from shriii_api.auth.rbac import Perm, Principal
from shriii_api.db.models.study import (
    Arm,
    Cohort,
    Enrollment,
    MeasurementOccasion,
    ProtocolDeviation,
    ProtocolVersion,
    Quota,
    RetestSchedule,
    Study,
)
from shriii_api.db.models.validation import AnalysisPlan
from shriii_api.services import participants as participant_svc
from shriii_api.services import studies as study_svc

router = APIRouter(prefix="/studies", tags=["studies"])

Block = Literal["A", "B", "C"]
_ALL_BLOCKS: tuple[Block, ...] = ("A", "B", "C")
StudyCode = Literal["S1", "S1b", "S2", "S3", "S2-D", "S4u", "S5"]


class StudyIn(BaseModel):
    study_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_.:-]{0,127}$")
    code: StudyCode
    name: str
    stage: str
    description: str | None = None
    requires_prereg: bool | None = Field(default=None, description="Defaults to true for S2 onwards")
    prereg_id: str | None = None
    target_sample: int | None = Field(default=None, ge=0)
    power_record: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict, description="Study-specific game/battery config")


class StudyPatch(BaseModel):
    status: Literal["draft", "active", "closed"] | None = None
    prereg_id: str | None = None
    description: str | None = None
    target_sample: int | None = None
    config: dict[str, Any] | None = None


class StudyOut(ApiModel):
    study_id: str
    code: str
    name: str
    stage: str
    status: str
    requires_prereg: bool
    prereg_id: str | None
    current_protocol_version: str | None
    description: str | None
    config: dict[str, Any]
    target_sample: int | None
    power_record: dict[str, Any]
    frozen_at: datetime | None
    created_by: str
    created_at: datetime


class ProtocolIn(BaseModel):
    version: str
    document_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    summary: str | None = None
    game_config: dict[str, Any] = Field(default_factory=dict)
    battery: dict[str, Any] = Field(default_factory=dict)
    effective_from: datetime
    approved_by: list[str] = Field(default_factory=list)


class CohortIn(BaseModel):
    cohort_id: str
    name: str
    criteria: dict[str, Any] = Field(default_factory=dict)
    holdout: bool = False


class QuotaIn(BaseModel):
    cell: dict[str, str] = Field(description="language, age_band, gender, edu_band, literacy_band ('*' = any)")
    target: int = Field(ge=1)


class ArmIn(BaseModel):
    arm_id: Literal["B_fixed", "A_narrative", "B_adaptive", "A_D", "C"]
    ratio: int = Field(default=1, ge=1, le=10)
    description: str | None = None


class OccasionIn(BaseModel):
    occasion_id: str
    wave: int = Field(default=1, ge=1)
    label: str
    sequence: int = Field(default=1, ge=1)
    offset_days_min: int | None = Field(default=None, ge=0)
    offset_days_max: int | None = Field(default=None, ge=0)
    instruments: list[str] = Field(default_factory=list)
    game_required: bool = True


class EnrollIn(BaseModel):
    pid: str
    cell: dict[str, str] = Field(default_factory=dict)
    cohort_id: str | None = None
    eligibility: dict[str, bool] = Field(default_factory=dict)
    criterion_blocks: list[Block] = Field(default_factory=lambda: list(_ALL_BLOCKS))


class EnrollmentOut(ApiModel):
    study_id: str
    pid: str
    cohort_id: str | None
    cell_key: str | None
    arm_id: str | None
    criterion_block: str | None
    status: str
    created_at: datetime


class EnrollOut(BaseModel):
    enrollment: EnrollmentOut
    warnings: list[str]


class RetestIn(BaseModel):
    occasion_id: str
    anchors: dict[str, date] = Field(description="pid -> T1 date")
    channel: Literal["ivr", "sms", "phone"] | None = "ivr"


class RetestCompleteIn(BaseModel):
    pid: str
    occasion_id: str
    completed_on: date


class DeviationIn(BaseModel):
    category: str
    severity: Literal["minor", "major", "critical"]
    description: str = Field(min_length=3)
    pid: str | None = None
    session_id: str | None = None


class FreezeIn(BaseModel):
    reason: str = Field(min_length=3)


class AnalysisPlanIn(BaseModel):
    version: str
    prereg_id: str | None = None
    registry_url: str | None = None
    document: dict[str, Any] = Field(default_factory=dict, description="Analysis plan text/structure")


def _study(db: DbSession, request: Request, principal: Principal, study_id: str) -> Study:
    ensure_study_access(request, principal, study_id)
    study = db.get(Study, study_id)
    if study is None:
        raise_error(404, "unknown_study", "study not found")
    set_audit(request, resource_type="study", resource_id=study_id, study_id=study_id)
    return study


def _writable(study: Study) -> None:
    if study.status == "frozen":
        raise_error(409, "study_frozen", "study is frozen")


@router.post("", response_model=StudyOut, status_code=status.HTTP_201_CREATED, summary="Create a study")
def create_study(
    body: StudyIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_WRITE))],
) -> StudyOut:
    ensure_study_access(request, principal, body.study_id)
    if db.get(Study, body.study_id) is not None:
        raise_error(409, "study_exists", "study already exists")
    data = body.model_dump()
    requires = data.pop("requires_prereg")
    study = Study(
        requires_prereg=body.code in study_svc.STAGES_REQUIRING_PREREG if requires is None else requires,
        status="draft",
        created_by=principal.sub,
        **data,
    )
    db.add(study)
    db.flush()
    set_audit(
        request, action="studies.create", resource_type="study", resource_id=body.study_id, study_id=body.study_id
    )
    return StudyOut.model_validate(study)


@router.get("", response_model=list[StudyOut], summary="Studies")
def list_studies(db: DbSession, principal: Annotated[Principal, Depends(require(Perm.STUDIES_READ))]) -> list[StudyOut]:
    rows = db.execute(select(Study).order_by(Study.created_at)).scalars()
    return [StudyOut.model_validate(s) for s in rows if principal.can_access_study(s.study_id)]


@router.get("/{study_id}", summary="Study with design (protocols, cohorts, arms, occasions, quotas)")
def get_study(
    study_id: str, request: Request, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.STUDIES_READ))]
) -> dict[str, Any]:
    study = _study(db, request, principal, study_id)

    def rows(model: Any) -> list[Any]:
        return list(db.execute(select(model).where(model.study_id == study_id)).scalars())

    return {
        "study": StudyOut.model_validate(study).model_dump(mode="json"),
        "protocols": [
            {
                "version": p.version,
                "document_sha256": p.document_sha256,
                "summary": p.summary,
                "effective_from": p.effective_from.isoformat(),
                "approved_by": p.approved_by,
            }
            for p in rows(ProtocolVersion)
        ],
        "cohorts": [
            {"cohort_id": c.cohort_id, "name": c.name, "criteria": c.criteria, "holdout": c.holdout}
            for c in rows(Cohort)
        ],
        "arms": [{"arm_id": a.arm_id, "ratio": a.ratio, "description": a.description} for a in rows(Arm)],
        "occasions": [
            {
                "occasion_id": o.occasion_id,
                "wave": o.wave,
                "label": o.label,
                "sequence": o.sequence,
                "offset_days_min": o.offset_days_min,
                "offset_days_max": o.offset_days_max,
                "instruments": o.instruments,
                "game_required": o.game_required,
            }
            for o in rows(MeasurementOccasion)
        ],
        "quotas": study_svc.quota_status(db, study_id),
        "analysis_plans": [
            {
                "plan_id": str(p.plan_id),
                "version": p.version,
                "prereg_id": p.prereg_id,
                "hypotheses_sha256": p.hypotheses_sha256,
                "gates_sha256": p.gates_sha256,
                "registered_at": p.registered_at.isoformat(),
            }
            for p in rows(AnalysisPlan)
        ],
    }


@router.patch("/{study_id}", response_model=StudyOut, summary="Update study status/metadata")
def patch_study(
    study_id: str,
    body: StudyPatch,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_WRITE))],
) -> StudyOut:
    study = _study(db, request, principal, study_id)
    _writable(study)
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(study, key, value)
    set_audit(request, action="studies.update", changes=body.model_dump(exclude_unset=True))
    return StudyOut.model_validate(study)


@router.post("/{study_id}/protocol-versions", status_code=201, summary="Register a protocol version")
def add_protocol(
    study_id: str,
    body: ProtocolIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_WRITE))],
) -> dict[str, Any]:
    study = _study(db, request, principal, study_id)
    _writable(study)
    db.add(ProtocolVersion(study_id=study_id, created_by=principal.sub, **body.model_dump()))
    study.current_protocol_version = body.version
    db.flush()
    set_audit(request, action="studies.protocol", version=body.version)
    return {"study_id": study_id, "version": body.version}


@router.post("/{study_id}/cohorts", status_code=201, summary="Add a cohort")
def add_cohort(
    study_id: str,
    body: CohortIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_WRITE))],
) -> dict[str, Any]:
    _writable(_study(db, request, principal, study_id))
    db.add(Cohort(study_id=study_id, **body.model_dump()))
    db.flush()
    set_audit(request, action="studies.cohort", cohort_id=body.cohort_id)
    return {"study_id": study_id, **body.model_dump()}


@router.post("/{study_id}/quotas", status_code=201, summary="Add a stratified recruitment target")
def add_quota(
    study_id: str,
    body: QuotaIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_WRITE))],
) -> dict[str, Any]:
    _writable(_study(db, request, principal, study_id))
    key = study_svc.cell_key(body.cell)
    db.add(Quota(study_id=study_id, cell_key=key, cell=body.cell, target=body.target))
    db.flush()
    set_audit(request, action="studies.quota", cell_key=key)
    return {"study_id": study_id, "cell_key": key, "target": body.target}


@router.get("/{study_id}/quotas", summary="Quota cells with enrolled counts and 'cell full' flags")
def quotas(
    study_id: str, request: Request, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.STUDIES_READ))]
) -> list[dict[str, Any]]:
    _study(db, request, principal, study_id)
    return study_svc.quota_status(db, study_id)


@router.post("/{study_id}/arms", status_code=201, summary="Add an arm (allocation ratio)")
def add_arm(
    study_id: str,
    body: ArmIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_WRITE))],
) -> dict[str, Any]:
    _writable(_study(db, request, principal, study_id))
    db.add(Arm(study_id=study_id, **body.model_dump()))
    db.flush()
    set_audit(request, action="studies.arm", arm_id=body.arm_id)
    return {"study_id": study_id, **body.model_dump()}


@router.post("/{study_id}/occasions", status_code=201, summary="Add a measurement occasion")
def add_occasion(
    study_id: str,
    body: OccasionIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_WRITE))],
) -> dict[str, Any]:
    _writable(_study(db, request, principal, study_id))
    if (body.offset_days_min is None) != (body.offset_days_max is None) or (
        body.offset_days_min is not None
        and body.offset_days_max is not None
        and body.offset_days_min > body.offset_days_max
    ):
        raise_error(422, "invalid_window", "offset_days_min/max must both be set with min <= max")
    db.add(MeasurementOccasion(study_id=study_id, **body.model_dump()))
    db.flush()
    set_audit(request, action="studies.occasion", occasion_id=body.occasion_id)
    return {"study_id": study_id, **body.model_dump()}


@router.post(
    "/{study_id}/enrollments",
    response_model=EnrollOut,
    status_code=201,
    summary="Enroll a participant (eligibility, quota cell, block-randomised arm and criterion block)",
)
def enroll(
    study_id: str,
    body: EnrollIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_ENROLL))],
) -> EnrollOut:
    study = _study(db, request, principal, study_id)
    _writable(study)
    participant = participant_svc.resolve_pid(db, body.pid)
    result = study_svc.enroll(
        db,
        study=study,
        participant=participant,
        cell=body.cell,
        cohort_id=body.cohort_id,
        eligibility=body.eligibility,
        actor=principal.sub,
        criterion_blocks=list(body.criterion_blocks),
    )
    set_audit(request, action="studies.enroll", warnings=result.warnings)
    return EnrollOut(enrollment=EnrollmentOut.model_validate(result.enrollment), warnings=result.warnings)


@router.get("/{study_id}/enrollments", response_model=list[EnrollmentOut], summary="Enrollments")
def enrollments(
    study_id: str,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_READ, Perm.PARTICIPANTS_READ))],
) -> list[EnrollmentOut]:
    _study(db, request, principal, study_id)
    rows = db.execute(select(Enrollment).where(Enrollment.study_id == study_id).order_by(Enrollment.created_at))
    return [EnrollmentOut.model_validate(e) for e in rows.scalars()]


@router.post("/{study_id}/retests", summary="Schedule retest windows (contact opt-in required)")
def schedule_retests(
    study_id: str,
    body: RetestIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_WRITE))],
) -> dict[str, Any]:
    study = _study(db, request, principal, study_id)
    _writable(study)
    scheduled, refused = study_svc.schedule_retests(
        db, study=study, occasion_id=body.occasion_id, anchors=body.anchors, channel=body.channel
    )
    set_audit(request, action="studies.retests", scheduled=len(scheduled), refused=len(refused))
    return {
        "scheduled": [
            {
                "pid": r.pid,
                "occasion_id": r.occasion_id,
                "window_start": r.window_start.isoformat(),
                "window_end": r.window_end.isoformat(),
                "status": r.status,
            }
            for r in scheduled
        ],
        "refused": refused,
    }


@router.post("/{study_id}/retests/complete", summary="Mark a retest done (flags out-of-window pairs)")
def complete_retest(
    study_id: str,
    body: RetestCompleteIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_ENROLL))],
) -> dict[str, Any]:
    _study(db, request, principal, study_id)
    row = db.execute(
        select(RetestSchedule).where(
            RetestSchedule.study_id == study_id,
            RetestSchedule.pid == body.pid,
            RetestSchedule.occasion_id == body.occasion_id,
        )
    ).scalar_one_or_none()
    if row is None:
        raise_error(404, "unknown_retest", "no retest scheduled")
    study_svc.complete_retest(db, row, body.completed_on)
    set_audit(request, action="studies.retest_complete", status=row.status)
    return {"pid": row.pid, "occasion_id": row.occasion_id, "status": row.status}


@router.post("/{study_id}/deviations", status_code=201, summary="Record a protocol deviation")
def add_deviation(
    study_id: str,
    body: DeviationIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_ENROLL))],
) -> dict[str, Any]:
    _study(db, request, principal, study_id)
    row = ProtocolDeviation(study_id=study_id, reported_by=principal.sub, **body.model_dump())
    db.add(row)
    db.flush()
    set_audit(request, action="studies.deviation", severity=body.severity)
    return {"id": row.id, "study_id": study_id, **body.model_dump()}


@router.get("/{study_id}/deviations", summary="Protocol deviations")
def deviations(
    study_id: str, request: Request, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.STUDIES_READ))]
) -> list[dict[str, Any]]:
    _study(db, request, principal, study_id)
    return [
        {
            "id": d.id,
            "category": d.category,
            "severity": d.severity,
            "description": d.description,
            "reported_by": d.reported_by,
            "created_at": d.created_at.isoformat(),
        }
        for d in db.execute(
            select(ProtocolDeviation).where(ProtocolDeviation.study_id == study_id).order_by(ProtocolDeviation.id)
        ).scalars()
    ]


@router.post("/{study_id}/freeze", summary="Freeze the study and lock its ready snapshots")
def freeze(
    study_id: str,
    body: FreezeIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_WRITE))],
) -> dict[str, Any]:
    study = _study(db, request, principal, study_id)
    _writable(study)
    record = study_svc.freeze_study(db, study, reason=body.reason, actor=principal.sub)
    set_audit(request, action="studies.freeze", snapshots=record.snapshot_ids)
    return {
        "study_id": study_id,
        "frozen_at": study.frozen_at.isoformat() if study.frozen_at else None,
        "snapshot_ids": record.snapshot_ids,
    }


@router.post(
    "/{study_id}/analysis-plans",
    status_code=201,
    summary="Register an analysis plan (freezes the current hypotheses.yaml/gates.yaml hashes)",
)
def register_plan(
    study_id: str,
    body: AnalysisPlanIn,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.STUDIES_WRITE))],
) -> dict[str, Any]:
    study = _study(db, request, principal, study_id)
    hyp, gates = content.hypotheses(), content.gates()
    plan = AnalysisPlan(
        study_id=study_id,
        version=body.version,
        prereg_id=body.prereg_id or study.prereg_id,
        hypotheses_version=str(hyp.data["version"]),
        hypotheses_sha256=hyp.sha256,
        gates_version=str(gates.data["version"]),
        gates_sha256=gates.sha256,
        dictionary_sha256={p: content.dictionary_pathway(p).sha256 for p in ("A", "B")},
        document=body.document,
        registry_url=body.registry_url,
        registered_by=principal.sub,
    )
    db.add(plan)
    if body.prereg_id and not study.prereg_id:
        study.prereg_id = body.prereg_id
    db.flush()
    set_audit(request, action="studies.analysis_plan", version=body.version)
    return {
        "plan_id": str(plan.plan_id),
        "study_id": study_id,
        "version": body.version,
        "hypotheses_sha256": hyp.sha256,
        "gates_sha256": gates.sha256,
    }
