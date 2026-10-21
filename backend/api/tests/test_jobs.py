"""Job queue: idempotency, SKIP LOCKED claims, retries with backoff, permanent failures, stale leases."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text

from shriii_api.db.models.ops import Job
from shriii_api.db.session import get_engine, session_factory, session_scope
from shriii_api.worker import handlers, queue
from shriii_api.worker.runner import drain, run_one


def test_enqueue_is_idempotent_by_input_hash(settings: Any) -> None:
    with session_scope() as db:
        a = queue.enqueue(db, "participant_matching", {"study_id": "s1"}, created_by="t", settings=settings)
        b = queue.enqueue(db, "participant_matching", {"study_id": "s1"}, created_by="t", settings=settings)
        c = queue.enqueue(db, "participant_matching", {"study_id": "s2"}, created_by="t", settings=settings)
        forced = queue.enqueue(
            db, "participant_matching", {"study_id": "s1"}, created_by="t", settings=settings, force_new=True
        )
        assert a.job_id == b.job_id
        assert a.job_id not in {c.job_id, forced.job_id}
        assert a.idempotency_key == queue.idempotency_key("participant_matching", {"study_id": "s1"})
    with pytest.raises(ValueError, match="unknown job type"), session_scope() as db:
        queue.enqueue(db, "bogus", {}, created_by="t", settings=settings)


def test_skip_locked_claims_are_exclusive(settings: Any) -> None:
    with session_scope() as db:
        for i in range(2):
            queue.enqueue(db, "participant_matching", {"study_id": f"s{i}"}, created_by="t", settings=settings)
    factory = session_factory()
    first, second, third = factory(), factory(), factory()
    try:
        j1 = queue.claim(first, "w1")
        j2 = queue.claim(second, "w2")  # the first row is locked by w1's open transaction
        j3 = queue.claim(third, "w3")
        assert j1 is not None and j2 is not None
        assert j1.job_id != j2.job_id
        assert j3 is None
    finally:
        for s in (first, second, third):
            s.rollback()
            s.close()


def test_retry_with_backoff_then_success(settings: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}

    def flaky(db: Any, s: Any, ctx: handlers.JobContext) -> dict[str, Any]:
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("transient")
        return {"ok": True, "attempt": ctx.attempt}

    monkeypatch.setitem(handlers.HANDLERS, "participant_matching", flaky)
    monkeypatch.setattr("shriii_api.worker.runner.HANDLERS", handlers.HANDLERS)
    with session_scope() as db:
        job_id = queue.enqueue(db, "participant_matching", {"study_id": "x"}, created_by="t", settings=settings).job_id
    assert run_one("w", settings)
    with session_scope() as db:
        job = db.get(Job, job_id)
        assert job is not None
        assert job.status == "queued" and job.attempts == 1 and "transient" in (job.error or "")
        assert job.run_after > datetime.now(UTC) - timedelta(seconds=1)
        job.run_after = datetime.now(UTC) - timedelta(seconds=1)
    assert run_one("w", settings)
    with session_scope() as db:
        job = db.get(Job, job_id)
        assert job is not None and job.status == "succeeded" and job.result == {"ok": True, "attempt": 2}
        assert len(job.error_history) == 1


def test_permanent_failure_and_hook(settings: Any) -> None:
    with session_scope() as db:
        job_id = queue.enqueue(
            db, "validation_analysis", {"run_id": str(uuid.uuid4())}, created_by="t", settings=settings
        ).job_id
    drain(settings=settings)
    with session_scope() as db:
        job = db.get(Job, job_id)
        assert job is not None and job.status == "failed" and job.attempts == 1
        assert "PermanentJobError" in (job.error or "")


def test_retries_exhausted(settings: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    def always(db: Any, s: Any, ctx: handlers.JobContext) -> dict[str, Any]:
        raise RuntimeError("boom")

    monkeypatch.setitem(handlers.HANDLERS, "participant_matching", always)
    with session_scope() as db:
        job_id = queue.enqueue(
            db, "participant_matching", {"study_id": "y"}, created_by="t", settings=settings, max_attempts=2
        ).job_id
    for _ in range(2):
        with get_engine().begin() as conn:
            conn.execute(text("UPDATE ops.jobs SET run_after = now() - interval '1 second'"))
        run_one("w", settings)
    with session_scope() as db:
        job = db.get(Job, job_id)
        assert job is not None and job.status == "failed" and job.attempts == 2
        # A failed job is re-queued when the same work is enqueued again.
        again = queue.enqueue(db, "participant_matching", {"study_id": "y"}, created_by="t", settings=settings)
        assert again.job_id == job_id and again.status == "queued"


def test_stale_running_jobs_are_requeued(settings: Any) -> None:
    with session_scope() as db:
        job = queue.enqueue(db, "participant_matching", {"study_id": "z"}, created_by="t", settings=settings)
        job_id = job.job_id
    with session_scope() as db:
        claimed = queue.claim(db, "crashed-worker")
        assert claimed is not None
        claimed.locked_at = datetime.now(UTC) - timedelta(hours=2)
    with session_scope() as db:
        assert queue.requeue_stale(db, lease_s=60) == 1
        job2 = db.get(Job, job_id)
        assert job2 is not None and job2.status == "queued"


def test_jobs_api(client: Any, admin: dict[str, str], researcher: dict[str, str]) -> None:
    r = client.post("/api/v1/admin/jobs", headers=admin, json={"job_type": "kiosk_health", "inputs": {"b": 1}})
    assert r.status_code == 202
    again = client.post("/api/v1/admin/jobs", headers=admin, json={"job_type": "kiosk_health", "inputs": {"b": 1}})
    assert again.json()["job_id"] == r.json()["job_id"]
    denied = client.post("/api/v1/admin/jobs", headers=researcher, json={"job_type": "retention", "inputs": {}})
    assert denied.status_code == 403
    drain()
    job = client.get(f"/api/v1/admin/jobs/{r.json()['job_id']}", headers=researcher).json()
    assert job["status"] == "succeeded" and job["progress"] == 1.0
    assert "stale_kiosks" in job["result"]


def test_stale_job_on_its_last_attempt_fails_instead_of_looping(settings: Any) -> None:
    with session_scope() as db:
        job = queue.enqueue(
            db, "participant_matching", {"study_id": "poison"}, created_by="t", settings=settings, max_attempts=1
        )
        job_id = job.job_id
    with session_scope() as db:
        claimed = queue.claim(db, "crashed-worker")
        assert claimed is not None and claimed.attempts == 1
        claimed.locked_at = datetime.now(UTC) - timedelta(hours=2)
    with session_scope() as db:
        assert queue.requeue_stale(db, lease_s=60) == 1
        row = db.get(Job, job_id)
        assert row is not None and row.status == "failed" and "lease expired" in (row.error or "")


def test_progress_renews_the_lease_and_a_lost_lease_rolls_back(settings: Any) -> None:
    with session_scope() as db:
        job_id = queue.enqueue(
            db, "participant_matching", {"study_id": "lease"}, created_by="t", settings=settings
        ).job_id
    with session_scope() as db:
        claimed = queue.claim(db, "worker-a")
        assert claimed is not None
        claimed.locked_at = datetime.now(UTC) - timedelta(hours=2)
    with session_scope() as db:
        queue.set_progress(db, job_id, 0.5, "half way")
    with session_scope() as db:
        assert queue.requeue_stale(db, lease_s=60) == 0  # heartbeat renewed the lease
        row = db.get(Job, job_id)
        assert row is not None and row.status == "running"
        row.locked_at = datetime.now(UTC) - timedelta(hours=2)
    with session_scope() as db:
        assert queue.requeue_stale(db, lease_s=60) == 1
        assert queue.claim(db, "worker-b") is not None
    with pytest.raises(queue.LeaseLostError), session_scope() as db:
        queue.complete(db, job_id, {"late": True}, "worker-a")
    with session_scope() as db:
        row = db.get(Job, job_id)
        assert row is not None and row.status == "running" and row.locked_by == "worker-b"
        queue.complete(db, job_id, {"ok": True}, "worker-b")
