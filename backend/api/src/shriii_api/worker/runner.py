"""Worker loop: claim (own transaction) -> run handler + complete (one transaction) -> or record failure."""

from __future__ import annotations

import logging
import os
import signal
import socket
import time
import traceback
import uuid
from collections.abc import Callable
from types import FrameType
from typing import Any

from shriii_api.adapters.scoring import AdapterUnavailableError
from shriii_api.db.session import session_scope
from shriii_api.observability import tracer
from shriii_api.settings import Settings, get_settings
from shriii_api.worker import queue
from shriii_api.worker.handlers import FAILURE_HOOKS, HANDLERS, JobContext

log = logging.getLogger(__name__)


def default_worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:6]}"


def _progress(job_id: uuid.UUID) -> Callable[[float, str | None], None]:
    def report(value: float, message: str | None = None) -> None:
        with session_scope() as s:
            queue.set_progress(s, job_id, value, message)

    return report


def run_one(worker_id: str, settings: Settings | None = None, job_types: tuple[str, ...] | None = None) -> bool:
    """Claim and execute one job. Returns False when the queue had nothing runnable."""
    settings = settings or get_settings()
    with session_scope() as s:
        job = queue.claim(s, worker_id, job_types)
        if job is None:
            return False
        job_id, job_type, inputs, created_by, attempt = (
            job.job_id,
            job.job_type,
            dict(job.inputs),
            job.created_by,
            job.attempts,
        )
    handler = HANDLERS.get(job_type)
    with tracer.start_as_current_span(f"job.{job_type}") as span:
        span.set_attribute("shriii.job_id", str(job_id))
        try:
            if handler is None:
                raise queue.PermanentJobError(f"no handler for {job_type}")
            with session_scope() as s:
                ctx = JobContext(
                    job_id=job_id,
                    job_type=job_type,
                    inputs=inputs,
                    created_by=created_by,
                    attempt=attempt,
                    progress=_progress(job_id),
                )
                result = handler(s, settings, ctx)
                queue.complete(s, job_id, result, worker_id)
            log.info("job succeeded", extra={"job_id": str(job_id), "job_type": job_type})
        except queue.LeaseLostError as exc:
            # The handler's writes were rolled back; the re-queued job runs again elsewhere.
            log.warning("job lease lost", extra={"job_id": str(job_id), "job_type": job_type, "error": str(exc)})
        except (queue.PermanentJobError, AdapterUnavailableError) as exc:
            _record_failure(job_id, job_type, inputs, f"{type(exc).__name__}: {exc}", permanent=True, settings=settings)
        except Exception as exc:
            detail = f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=5)}"
            _record_failure(job_id, job_type, inputs, detail, permanent=False, settings=settings)
    return True


def _record_failure(
    job_id: uuid.UUID, job_type: str, inputs: dict[str, Any], error: str, *, permanent: bool, settings: Settings
) -> None:
    with session_scope() as s:
        status = queue.fail(s, job_id, error[:8000], permanent=permanent, settings=settings)
        hook = FAILURE_HOOKS.get(job_type)
        if status == "failed" and hook is not None:
            hook(s, dict(inputs), error)
    log.warning(
        "job failed",
        extra={"job_id": str(job_id), "job_type": job_type, "status": status, "error": error.splitlines()[0][:300]},
    )


def drain(worker_id: str | None = None, *, max_jobs: int = 1000, settings: Settings | None = None) -> int:
    """Run jobs until the queue is empty (tests, CLI ``work --once``)."""
    wid = worker_id or default_worker_id()
    done = 0
    while done < max_jobs and run_one(wid, settings):
        done += 1
    return done


class _Stop:
    flag = False


def run_forever(settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    wid = default_worker_id()

    def stop(signum: int, frame: FrameType | None) -> None:
        log.info("worker stopping", extra={"signal": signum})
        _Stop.flag = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    log.info("worker started", extra={"worker_id": wid})
    last_maintenance = 0.0
    while not _Stop.flag:
        now = time.monotonic()
        if now - last_maintenance > 300:
            with session_scope() as s:
                bucket = time.strftime("%Y-%m-%dT%H", time.gmtime())
                queue.enqueue(
                    s, "kiosk_health", {"bucket": bucket}, created_by="system:worker", settings=settings, priority=200
                )
                # Nightly retention run (PRV-05); idempotent per UTC day.
                queue.enqueue(
                    s,
                    "retention",
                    {"bucket": time.strftime("%Y-%m-%d", time.gmtime()), "dry_run": False},
                    created_by="system:worker",
                    settings=settings,
                    priority=300,
                )
                queue.enqueue(
                    s,
                    "consent_parking_expiry",
                    {"bucket": bucket},
                    created_by="system:worker",
                    settings=settings,
                    priority=150,
                )
            last_maintenance = now
        if not run_one(wid, settings):
            time.sleep(settings.worker_poll_interval_s)
