"""Async load driver: plays a ``Plan`` against the API like a fleet of kiosk outboxes.

Retry policy (the KSK-07 outbox contract):

* HTTP 200 with any ``retryable`` event status (``session_busy``): re-send the *same* body after a short
  back-off, until no event is retryable.
* HTTP 429/5xx, timeouts and connection errors: exponential back-off with jitter, same body.
* Any other 4xx is terminal for that batch and is reported as an error.

Every attempt is a ``Sample``. Latency covers sending the request body and reading the whole response.
Optional researcher users issue read requests against the research API at the same time.
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from collections import Counter
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from typing import Any

import httpx

from shriii_loadtest.batches import PreparedBatch
from shriii_loadtest.scenarios import KioskScript, Plan

__all__ = ["ResearchOptions", "RunResult", "Sample", "run_plan"]

BATCH_PATH = "/api/v1/events/batch"


@dataclass(slots=True)
class Sample:
    kind: str
    kiosk_id: str
    batch_id: str
    event_count: int
    size_bytes: int
    attempt: int
    t_start_s: float
    latency_ms: float
    http_status: int | None
    outcome: str
    """ok | retryable | http_error | transport_error"""
    duplicate_batch: bool = False
    statuses: dict[str, int] = field(default_factory=dict)
    error: str | None = None
    retry_after_s: float | None = None


@dataclass(slots=True)
class ResearchOptions:
    users: int = 0
    token: str | None = None
    think_s: float = 1.0
    study_id: str = "demo-s2-pilot"
    """Study for study-scoped reads (``shriii-api seed --demo`` creates it)."""
    endpoints: Sequence[tuple[str, float]] = (
        ("/api/v1/sessions?limit=50", 3.0),
        ("/api/v1/sessions/{session_id}", 3.0),
        ("/api/v1/sessions/{session_id}/quality-flags", 2.0),
        ("/api/v1/sessions/{session_id}/events?limit=500", 2.0),
        ("/api/v1/sessions/{session_id}/trials", 1.0),
        ("/api/v1/features/matrix?study_id={study_id}", 1.0),
        ("/api/v1/validation/datasets?study_id={study_id}", 1.0),
        ("/api/v1/assessment-responses/scores?study_id={study_id}", 1.0),
        ("/api/v1/studies", 1.0),
    )


@dataclass(slots=True)
class RunResult:
    plan: dict[str, Any]
    samples: list[Sample]
    wall_s: float
    research_samples: list[Sample] = field(default_factory=list)
    terminal_failures: list[dict[str, Any]] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "plan": self.plan,
            "wall_s": self.wall_s,
            "samples": [asdict(s) for s in self.samples],
            "research_samples": [asdict(s) for s in self.research_samples],
            "terminal_failures": self.terminal_failures,
        }


class _Driver:
    def __init__(
        self,
        plan: Plan,
        client: httpx.AsyncClient,
        *,
        max_attempts: int,
        rng: random.Random,
        t0: float,
    ) -> None:
        self.plan = plan
        self.client = client
        self.max_attempts = max_attempts
        self.rng = rng
        self.t0 = t0
        self.samples: list[Sample] = []
        self.failures: list[dict[str, Any]] = []
        self.done_sessions: list[str] = []

    async def _post(self, token: str, batch: PreparedBatch, attempt: int) -> Sample:
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        start = time.perf_counter()
        t_start = start - self.t0
        try:
            resp = await self.client.post(BATCH_PATH, content=batch.body, headers=headers)
            body = resp.content
            latency = (time.perf_counter() - start) * 1000
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            latency = (time.perf_counter() - start) * 1000
            return Sample(
                batch.kind,
                batch.kiosk_id,
                batch.batch_id,
                batch.event_count,
                batch.size_bytes,
                attempt,
                t_start,
                latency,
                None,
                "transport_error",
                error=type(exc).__name__,
            )
        sample = Sample(
            batch.kind,
            batch.kiosk_id,
            batch.batch_id,
            batch.event_count,
            batch.size_bytes,
            attempt,
            t_start,
            latency,
            resp.status_code,
            "ok",
        )
        if resp.status_code == 200:
            doc = json.loads(body)
            sample.duplicate_batch = bool(doc.get("duplicate_batch"))
            sample.statuses = {k: int(v) for k, v in (doc.get("summary") or {}).items() if v}
            if sample.statuses.get("retryable"):
                sample.outcome = "retryable"
        else:
            sample.outcome = "http_error"
            retry_after = resp.headers.get("retry-after")
            if retry_after is not None:
                try:
                    sample.retry_after_s = max(0.0, float(retry_after))
                except ValueError:
                    sample.retry_after_s = None
            try:
                detail = json.loads(body).get("detail")
                sample.error = detail.get("code") if isinstance(detail, dict) else str(detail)[:200]
            except (ValueError, AttributeError):
                sample.error = body[:200].decode(errors="replace")
        return sample

    def _backoff(self, attempt: int, base: float) -> float:
        return min(5.0, base * (2 ** (attempt - 1))) * (0.5 + self.rng.random())

    async def deliver(self, token: str, batch: PreparedBatch) -> bool:
        """Send until accepted as final; returns False on a terminal failure."""
        for attempt in range(1, self.max_attempts + 1):
            sample = await self._post(token, batch, attempt)
            self.samples.append(sample)
            if sample.outcome == "ok":
                return True
            if sample.outcome == "retryable":
                await asyncio.sleep(self._backoff(attempt, 0.1))
                continue
            status = sample.http_status
            if sample.outcome == "transport_error" or status == 429 or (status is not None and status >= 500):
                if sample.retry_after_s is not None:  # server-directed back-off (admission control)
                    await asyncio.sleep(sample.retry_after_s * (0.5 + self.rng.random()))
                else:
                    await asyncio.sleep(self._backoff(attempt, 0.25))
                continue
            break
        self.failures.append(
            {
                "batch_id": batch.batch_id,
                "kiosk_id": batch.kiosk_id,
                "kind": batch.kind,
                "http_status": self.samples[-1].http_status,
                "error": self.samples[-1].error,
            }
        )
        return False

    async def run_kiosk(self, script: KioskScript) -> None:
        await asyncio.sleep(script.start_offset_s)
        token = script.kiosk.token
        for step in script.steps:
            if step.delay_s:
                await asyncio.sleep(step.delay_s)
            jobs = [self.deliver(token, step.batch) for _ in range(step.copies)]
            jobs += [self.deliver(token, sibling) for sibling in step.siblings]
            await asyncio.gather(*jobs)
            self.done_sessions.extend(step.batch.session_ids)


async def _researcher(
    client: httpx.AsyncClient,
    opts: ResearchOptions,
    *,
    driver: _Driver,
    stop: asyncio.Event,
    rng: random.Random,
    out: list[Sample],
) -> None:
    paths = [p for p, _ in opts.endpoints]
    weights = [w for _, w in opts.endpoints]
    headers = {"Authorization": f"Bearer {opts.token}"}
    while not stop.is_set():
        template = rng.choices(paths, weights)[0]
        if "{session_id}" in template:
            if not driver.done_sessions:
                await asyncio.sleep(0.2)
                continue
            path = template.format(session_id=rng.choice(driver.done_sessions), study_id=opts.study_id)
        else:
            path = template.format(study_id=opts.study_id)
        route = template.split("?")[0]
        start = time.perf_counter()
        try:
            resp = await client.get(path, headers=headers)
            _ = resp.content
            status: int | None = resp.status_code
            outcome = "ok" if resp.status_code == 200 else "http_error"
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            status, outcome = None, f"transport_error:{type(exc).__name__}"
        latency = (time.perf_counter() - start) * 1000
        out.append(Sample(f"research:{route}", "researcher", "", 0, 0, 1, start - driver.t0, latency, status, outcome))
        await asyncio.sleep(rng.expovariate(1.0 / opts.think_s) if opts.think_s > 0 else 0)


async def run_plan(
    plan: Plan,
    base_url: str,
    *,
    timeout_s: float = 60.0,
    max_attempts: int = 40,
    research: ResearchOptions | None = None,
    seed: int = 7,
    transport: httpx.AsyncBaseTransport | None = None,
) -> RunResult:
    """Play ``plan``; ``transport`` swaps the network for an in-process ASGI app or a mock (tests)."""
    copies = max((s.copies + len(s.siblings) for k in plan.scripts for s in k.steps), default=1)
    connections = max(16, len(plan.scripts) * copies + (research.users if research else 0) + 8)
    limits = httpx.Limits(max_connections=connections, max_keepalive_connections=connections)
    async with httpx.AsyncClient(base_url=base_url, timeout=timeout_s, limits=limits, transport=transport) as client:
        t0 = time.perf_counter()
        driver = _Driver(plan, client, max_attempts=max_attempts, rng=random.Random(seed), t0=t0)
        stop = asyncio.Event()
        research_samples: list[Sample] = []
        research_tasks = []
        if research and research.users > 0 and research.token:
            rng = random.Random(seed + 1)
            research_tasks = [
                asyncio.create_task(
                    _researcher(
                        client,
                        research,
                        driver=driver,
                        stop=stop,
                        rng=random.Random(rng.random()),
                        out=research_samples,
                    )
                )
                for _ in range(research.users)
            ]
        await asyncio.gather(*(driver.run_kiosk(script) for script in plan.scripts))
        stop.set()
        await asyncio.gather(*research_tasks)
        wall = time.perf_counter() - t0
    return RunResult(
        plan=plan.describe(),
        samples=driver.samples,
        wall_s=wall,
        research_samples=research_samples,
        terminal_failures=driver.failures,
    )


def status_totals(samples: Sequence[Sample]) -> dict[str, int]:
    totals: Counter[str] = Counter()
    for s in samples:
        totals.update(s.statuses)
    return dict(totals)
