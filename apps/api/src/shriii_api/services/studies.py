"""Study engine (CRT-07, CRT-10): enrollment, quota cells, block randomisation, retest scheduling, freeze."""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from shriii_api.canonical import sha256_hex
from shriii_api.db.models.participants import Participant
from shriii_api.db.models.study import (
    Arm,
    DatasetFreeze,
    Enrollment,
    MeasurementOccasion,
    Quota,
    RandomisationBlock,
    RetestSchedule,
    Study,
)
from shriii_api.db.models.validation import AnalysisPlan, DatasetSnapshot
from shriii_api.errors import DomainError
from shriii_api.services import consent as consent_svc

CELL_FIELDS = ("language", "age_band", "gender", "edu_band", "literacy_band")
STAGES_REQUIRING_PREREG = frozenset({"S2", "S2-D", "S3", "S4u", "S5"})


class StudyError(DomainError):
    """Study error."""


def cell_key(cell: dict[str, Any]) -> str:
    return "|".join(f"{f}={cell.get(f, '*')}" for f in CELL_FIELDS)


def _matching_quota(quotas: list[Quota], cell: dict[str, Any]) -> Quota | None:
    for q in quotas:
        if all(q.cell.get(f) in (None, "*", cell.get(f)) for f in CELL_FIELDS):
            return q
    return None


def quota_status(db: Session, study_id: str) -> list[dict[str, Any]]:
    quotas = list(db.execute(select(Quota).where(Quota.study_id == study_id)).scalars())
    out = []
    for q in quotas:
        n = db.execute(
            select(func.count())
            .select_from(Enrollment)
            .where(Enrollment.study_id == study_id, Enrollment.cell_key == q.cell_key, Enrollment.status != "withdrawn")
        ).scalar_one()
        out.append(
            {"cell_key": q.cell_key, "cell": q.cell, "target": q.target, "enrolled": int(n), "full": int(n) >= q.target}
        )
    return out


def _draw(db: Session, study_id: str, key: str, kind: str, options: list[tuple[str, int]]) -> str:
    """Permuted-block randomisation within a cell (seeded per study/cell/block for reproducibility)."""
    state = db.execute(
        select(RandomisationBlock)
        .where(
            RandomisationBlock.study_id == study_id, RandomisationBlock.cell_key == key, RandomisationBlock.kind == kind
        )
        .with_for_update()
    ).scalar_one_or_none()
    if state is None:
        state = RandomisationBlock(study_id=study_id, cell_key=key, kind=kind, block=[], position=0, blocks_used=0)
        db.add(state)
    if state.position >= len(state.block):
        block = [opt for opt, ratio in options for _ in range(max(1, ratio))]
        seed = int(sha256_hex(f"{study_id}|{key}|{kind}|{state.blocks_used}")[:16], 16)
        random.Random(seed).shuffle(block)
        state.block = block
        state.position = 0
        state.blocks_used += 1
    choice = state.block[state.position]
    state.position += 1
    db.flush()
    return choice


@dataclass(slots=True)
class EnrollmentResult:
    enrollment: Enrollment
    warnings: list[str]


def enroll(
    db: Session,
    *,
    study: Study,
    participant: Participant,
    cell: dict[str, Any],
    cohort_id: str | None,
    eligibility: dict[str, Any],
    actor: str,
    criterion_blocks: list[str],
) -> EnrollmentResult:
    if study.status not in ("active", "draft"):
        raise StudyError(409, "study_not_open", f"study is {study.status}")
    if participant.status != "active":
        raise StudyError(409, "participant_withdrawn", "participant has withdrawn")
    failed = [k for k, v in eligibility.items() if v is False]
    if failed:
        raise StudyError(422, "ineligible", f"eligibility criteria not met: {', '.join(failed)}")
    if cell.get("age_band") in ("under_18",):
        raise StudyError(422, "minor", "adults only")
    existing = db.execute(
        select(Enrollment).where(Enrollment.study_id == study.study_id, Enrollment.pid == participant.pid)
    ).scalar_one_or_none()
    if existing is not None:
        return EnrollmentResult(existing, ["already_enrolled"])
    key = cell_key(cell)
    warnings: list[str] = []
    quotas = list(db.execute(select(Quota).where(Quota.study_id == study.study_id)).scalars())
    quota = _matching_quota(quotas, cell)
    if quota is not None:
        status = next((q for q in quota_status(db, study.study_id) if q["cell_key"] == quota.cell_key), None)
        if status and status["full"]:
            warnings.append("cell_full")
        key = quota.cell_key
    arms = [
        (a.arm_id, a.ratio)
        for a in db.execute(select(Arm).where(Arm.study_id == study.study_id).order_by(Arm.arm_id)).scalars()
    ]
    arm = _draw(db, study.study_id, key, "arm", arms) if arms else None
    block = (
        _draw(db, study.study_id, key, "criterion_block", [(b, 1) for b in criterion_blocks])
        if criterion_blocks
        else None
    )
    row = Enrollment(
        study_id=study.study_id,
        pid=participant.pid,
        cohort_id=cohort_id,
        cell_key=key,
        cell=cell,
        arm_id=arm,
        criterion_block=block,
        status="enrolled",
        eligibility=eligibility,
        enrolled_by=actor,
    )
    db.add(row)
    if participant.study_id is None:
        participant.study_id = study.study_id
    db.flush()
    return EnrollmentResult(row, warnings)


def schedule_retests(
    db: Session, *, study: Study, occasion_id: str, anchors: dict[str, date], channel: str | None
) -> tuple[list[RetestSchedule], list[dict[str, str]]]:
    """Schedule T2 windows from occasion offsets; refuses pids without a contact opt-in (CRT-10)."""
    occ = db.execute(
        select(MeasurementOccasion).where(
            MeasurementOccasion.study_id == study.study_id, MeasurementOccasion.occasion_id == occasion_id
        )
    ).scalar_one_or_none()
    if occ is None or occ.offset_days_min is None or occ.offset_days_max is None:
        raise StudyError(422, "occasion_without_window", "occasion needs offset_days_min/max for retests")
    scheduled: list[RetestSchedule] = []
    refused: list[dict[str, str]] = []
    for pid, anchor in sorted(anchors.items()):
        participant = db.get(Participant, pid)
        if participant is None or participant.status != "active":
            refused.append({"pid": pid, "reason": "not_active"})
            continue
        if not consent_svc.has_consent(db, "contact", pid=pid):
            refused.append({"pid": pid, "reason": "no_contact_opt_in"})
            continue
        existing = db.execute(
            select(RetestSchedule).where(
                RetestSchedule.study_id == study.study_id,
                RetestSchedule.pid == pid,
                RetestSchedule.occasion_id == occasion_id,
            )
        ).scalar_one_or_none()
        if existing is not None:
            scheduled.append(existing)
            continue
        row = RetestSchedule(
            study_id=study.study_id,
            pid=pid,
            occasion_id=occasion_id,
            anchor_date=anchor,
            window_start=anchor + timedelta(days=occ.offset_days_min),
            window_end=anchor + timedelta(days=occ.offset_days_max),
            status="scheduled",
            channel=channel,
        )
        db.add(row)
        scheduled.append(row)
    db.flush()
    return scheduled, refused


def complete_retest(db: Session, schedule: RetestSchedule, completed_on: date) -> RetestSchedule:
    in_window = schedule.window_start <= completed_on <= schedule.window_end
    schedule.status = "completed" if in_window else "out_of_window"
    schedule.completed_at = datetime.now(UTC)
    db.flush()
    return schedule


def require_prereg(db: Session, study: Study) -> AnalysisPlan | None:
    """CRT-07: S2+ analyses refuse a study without a registered analysis plan."""
    plan = (
        db.execute(
            select(AnalysisPlan)
            .where(AnalysisPlan.study_id == study.study_id)
            .order_by(AnalysisPlan.registered_at.desc())
        )
        .scalars()
        .first()
    )
    if (study.requires_prereg or study.code in STAGES_REQUIRING_PREREG) and plan is None:
        raise StudyError(
            409, "prereg_required", f"study {study.study_id} ({study.code}) has no registered analysis plan"
        )
    return plan


def freeze_study(db: Session, study: Study, *, reason: str, actor: str) -> DatasetFreeze:
    snapshots = list(
        db.execute(
            select(DatasetSnapshot).where(DatasetSnapshot.study_id == study.study_id, DatasetSnapshot.status == "ready")
        ).scalars()
    )
    now = datetime.now(UTC)
    for s in snapshots:
        s.status = "frozen"
        s.frozen_at = now
        s.frozen_by = actor
    study.status = "frozen"
    study.frozen_at = now
    freeze = DatasetFreeze(
        study_id=study.study_id, reason=reason, snapshot_ids=[str(s.snapshot_id) for s in snapshots], frozen_by=actor
    )
    db.add(freeze)
    db.flush()
    return freeze
