"""Postgres job queue: idempotent enqueue, ``FOR UPDATE SKIP LOCKED`` claim, retries with backoff.

* Idempotency key = SHA-256 of the JCS serialisation of ``{"job_type", "inputs"}``: enqueueing the
  same work twice returns the existing job (unless it failed and ``rerun_failed`` is set, or
  ``force_new`` asks for a deliberate re-run, which salts the key with a fresh nonce).
* Retries: exponential backoff ``base * 2^(attempt-1)`` capped, with jitter; :class:`PermanentJobError`
  (and AdapterUnavailableError) fail immediately.
* Stale ``running`` jobs whose lease expired are re-queued by :func:`requeue_stale`.
"""

from __future__ import annotations

import random
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from shriii_api.canonical import canonical_sha256
from shriii_api.db.models.ops import Job
from shriii_api.settings import Settings

JOB_TYPES: Final[tuple[str, ...]] = (
    "event_validation",
    "trial_eligibility",
    "feature_extraction",
    "questionnaire_scoring",
    "participant_matching",
    "dataset_snapshot",
    "reliability",
    "construct_validity",
    "fairness",
    "validation_analysis",
    "model_training",
    "norm_generation",
    "report_preparation",
    "kiosk_health",
    "consent_parking_expiry",
    "erasure",
    "retention",
)
"""Spec section 14 job types plus the governance jobs (parking expiry, erasure, retention)."""


class PermanentJobError(Exception):
    """A job failure that retrying cannot fix (bad inputs, missing engine)."""


class LeaseLostError(Exception):
    """The job's lease expired and it was re-queued (or claimed by another worker) while running."""


def idempotency_key(job_type: str, inputs: dict[str, Any]) -> str:
    return canonical_sha256({"job_type": job_type, "inputs": inputs})


def enqueue(
    session: Session,
    job_type: str,
    inputs: dict[str, Any],
    *,
    created_by: str,
    settings: Settings,
    priority: int = 100,
    run_after: datetime | None = None,
    max_attempts: int | None = None,
    parent_job_id: uuid.UUID | None = None,
    rerun_failed: bool = True,
    force_new: bool = False,
) -> Job:
    """Insert a job unless an identical one exists; returns the (new or existing) job."""
    if job_type not in JOB_TYPES:
        raise ValueError(f"unknown job type {job_type}")
    key_inputs = dict(inputs)
    if force_new:
        key_inputs["_rerun_nonce"] = uuid.uuid4().hex
    key = idempotency_key(job_type, key_inputs)
    stmt = (
        insert(Job)
        .values(
            job_id=uuid.uuid4(),
            job_type=job_type,
            idempotency_key=key,
            inputs=inputs,
            status="queued",
            priority=priority,
            attempts=0,
            max_attempts=max_attempts or settings.job_max_attempts,
            run_after=run_after or datetime.now(UTC),
            progress=0.0,
            error_history=[],
            parent_job_id=parent_job_id,
            created_by=created_by,
        )
        .on_conflict_do_nothing(index_elements=[Job.idempotency_key])
        .returning(Job.job_id)
    )
    new_id = session.execute(stmt).scalar_one_or_none()
    job = session.execute(select(Job).where(Job.idempotency_key == key)).scalar_one()
    if new_id is None and rerun_failed and job.status in ("failed", "cancelled"):
        job.status = "queued"
        job.attempts = 0
        job.run_after = datetime.now(UTC)
        job.error = None
        job.finished_at = None
        job.progress = 0.0
    session.flush()
    return job


def claim(session: Session, worker_id: str, job_types: tuple[str, ...] | None = None) -> Job | None:
    """Claim the next runnable job (``FOR UPDATE SKIP LOCKED``) and mark it running."""
    stmt = (
        select(Job)
        .where(Job.status == "queued", Job.run_after <= datetime.now(UTC))
        .order_by(Job.priority, Job.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if job_types:
        stmt = stmt.where(Job.job_type.in_(job_types))
    job = session.execute(stmt).scalar_one_or_none()
    if job is None:
        return None
    job.status = "running"
    job.attempts += 1
    job.locked_by = worker_id
    job.locked_at = datetime.now(UTC)
    job.started_at = job.started_at or datetime.now(UTC)
    session.flush()
    return job


def complete(session: Session, job_id: uuid.UUID, result: dict[str, Any], worker_id: str | None = None) -> None:
    """Mark the job succeeded. With ``worker_id``, only while this worker still holds the lease; otherwise
    :class:`LeaseLostError` is raised so the caller rolls back the handler's writes."""
    stmt = update(Job).where(Job.job_id == job_id)
    if worker_id is not None:
        stmt = stmt.where(Job.status == "running", Job.locked_by == worker_id)
    outcome = session.execute(
        stmt.values(
            status="succeeded", result=result, progress=1.0, finished_at=datetime.now(UTC), locked_by=None, error=None
        )
    )
    if worker_id is not None and not getattr(outcome, "rowcount", 0):
        raise LeaseLostError(f"job {job_id} is no longer leased by {worker_id}")


def fail(session: Session, job_id: uuid.UUID, error: str, *, permanent: bool, settings: Settings) -> str:
    """Record a failure; re-queue with backoff when retries remain. Returns the new status."""
    job = session.execute(select(Job).where(Job.job_id == job_id).with_for_update()).scalar_one()
    history = [*job.error_history, {"attempt": job.attempts, "at": datetime.now(UTC).isoformat(), "error": error}]
    job.error_history = history[-20:]
    job.error = error
    job.locked_by = None
    if permanent or job.attempts >= job.max_attempts:
        job.status = "failed"
        job.finished_at = datetime.now(UTC)
    else:
        delay = min(settings.job_backoff_max_s, settings.job_backoff_base_s * 2 ** (job.attempts - 1))
        delay *= 0.8 + 0.4 * random.random()
        job.status = "queued"
        job.run_after = datetime.now(UTC) + timedelta(seconds=delay)
    session.flush()
    return job.status


def set_progress(session: Session, job_id: uuid.UUID, progress: float, message: str | None = None) -> None:
    """Record progress; for a running job this also renews the lease (``locked_at`` heartbeat)."""
    session.execute(
        update(Job).where(Job.job_id == job_id).values(progress=max(0.0, min(1.0, progress)), progress_message=message)
    )
    session.execute(
        update(Job).where(Job.job_id == job_id, Job.status == "running").values(locked_at=datetime.now(UTC))
    )


def requeue_stale(session: Session, lease_s: int) -> int:
    """Return expired ``running`` jobs to the queue (worker crashed mid-job).

    A job whose attempts are exhausted is failed instead, so a job that kills its worker every time
    cannot loop forever. Returns the number of jobs re-queued or failed.
    """
    stale = "status = 'running' AND locked_at < now() - make_interval(secs => :lease)"
    failed = session.execute(
        text(
            "UPDATE ops.jobs SET status = 'failed', locked_by = NULL, finished_at = now(), "
            "error = 'lease expired on the final attempt (worker lost)' "
            f"WHERE {stale} AND attempts >= max_attempts"
        ),
        {"lease": lease_s},
    )
    requeued = session.execute(
        text(f"UPDATE ops.jobs SET status = 'queued', locked_by = NULL, run_after = now() WHERE {stale}"),
        {"lease": lease_s},
    )
    return int(getattr(failed, "rowcount", 0) or 0) + int(getattr(requeued, "rowcount", 0) or 0)


def cancel(session: Session, job_id: uuid.UUID) -> bool:
    result = session.execute(
        update(Job)
        .where(Job.job_id == job_id, Job.status == "queued")
        .values(status="cancelled", finished_at=datetime.now(UTC))
    )
    return bool(getattr(result, "rowcount", 0))
