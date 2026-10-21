"""Locust scenarios for interactive or distributed load tests of the SHRIII API.

The deterministic, verified runs in RESULTS.md come from ``shriii-loadtest`` (async driver with database
verification). Use this file when you want Locust's live UI, ramp-up shapes or distributed workers:

    uv run --package shriii-loadtest locust -f tools/loadtest/locustfile.py \
        --host http://127.0.0.1:8000 --users 60 --spawn-rate 10 KioskUser ResearcherUser

Prerequisites: ``shriii-loadtest provision --kiosks N`` (writes ``.cache/fleet.json``) and
``shriii-loadtest corpus``. Each KioskUser takes one kiosk identity from the fleet, so ``--users`` for
KioskUser must not exceed the fleet size.

Environment knobs:
    LT_THINK_S        mean think time between batches per kiosk (default 5)
    LT_RETRY_P        probability of re-sending a batch with the same batch_id (default 0.1)
    LT_REPACK_P       probability of re-sending the same events under a new batch_id (default 0.05)
    LT_ENCRYPTION     none_dev | sealed (default none_dev; staging/prod require sealed)
    LT_MAX_BODY       split batches above this many bytes (default: no split)
    LT_STUDY_ID       study for study-scoped research reads (default demo-s2-pilot)

Request names in the Locust stats: ``batch[500] fresh``, ``batch[<500] fresh``, ``batch retry_same_id``,
``batch repacked``; research reads are grouped by route template. A batch whose response contains
``retryable`` events is re-sent (the kiosk outbox rule) and counted as ``batch ... retry_busy``.
"""

from __future__ import annotations

import json
import os
import queue
import random
import threading
from collections import deque
from datetime import UTC, datetime, timedelta
from typing import Any

import gevent
from locust import HttpUser, between, events, task
from locust.exception import StopUser

from shriii_loadtest.batches import KioskIdentity, OutboxSession, PreparedBatch, build_batch, pack_outbox
from shriii_loadtest.corpus import Corpus, default_cache_dir, load_or_build_corpus, retarget
from shriii_loadtest.provision import Fleet, load_fleet
from shriii_loadtest.scenarios import PlanOptions, repack

THINK_S = float(os.environ.get("LT_THINK_S", "5"))
RETRY_P = float(os.environ.get("LT_RETRY_P", "0.1"))
REPACK_P = float(os.environ.get("LT_REPACK_P", "0.05"))
ENCRYPTION = os.environ.get("LT_ENCRYPTION", "none_dev")
MAX_BODY = int(os.environ["LT_MAX_BODY"]) if os.environ.get("LT_MAX_BODY") else None
STUDY_ID = os.environ.get("LT_STUDY_ID", "demo-s2-pilot")

_shared: dict[str, Any] = {}
_lock = threading.Lock()
_kiosks: queue.Queue[KioskIdentity] = queue.Queue()
_uploaded_sessions: deque[str] = deque(maxlen=2000)


def _state() -> tuple[Corpus, Fleet]:
    with _lock:
        if "corpus" not in _shared:
            fleet = load_fleet(default_cache_dir() / "fleet.json")
            _shared["fleet"] = fleet
            _shared["corpus"] = load_or_build_corpus()
            for kiosk in fleet.kiosks:
                _kiosks.put(kiosk)
        return _shared["corpus"], _shared["fleet"]


@events.test_start.add_listener
def _on_start(environment: Any, **_: Any) -> None:
    _state()


class KioskUser(HttpUser):
    """One kiosk outbox: plays sessions from the corpus and drains them in 500-event batches."""

    wait_time = between(0, 0)  # pacing is done per batch with an exponential think time

    def on_start(self) -> None:
        corpus, fleet = _state()
        try:
            self.kiosk = _kiosks.get_nowait()
        except queue.Empty as exc:
            raise StopUser("no free kiosk identity; provision more kiosks") from exc
        self.rng = random.Random(hash(self.kiosk.kiosk_id))
        self.corpus = corpus
        self.opts = PlanOptions(encryption=ENCRYPTION,  # type: ignore[arg-type]
                                public_key=fleet.public_key_bytes if ENCRYPTION == "sealed" else None,
                                max_body_bytes=MAX_BODY)
        self.pending: deque[PreparedBatch] = deque()

    def on_stop(self) -> None:
        if getattr(self, "kiosk", None) is not None:
            _kiosks.put(self.kiosk)

    def _refill(self) -> None:
        template = self.rng.choice(self.corpus.sessions)
        sid, evs = retarget(template.events, kiosk_id=self.kiosk.kiosk_id, site_id=self.kiosk.site_id,
                            started_at=datetime.now(UTC) - timedelta(minutes=25), rng=self.rng)
        session = OutboxSession(session_id=sid, events=evs)
        for slices in pack_outbox([session]):
            batch = build_batch(self.kiosk, slices, kiosk_t_wall=datetime.now(UTC), encryption=self.opts.encryption,
                                public_key=self.opts.public_key)
            self.pending.append(batch)

    def _send(self, batch: PreparedBatch, label: str) -> dict[str, Any] | None:
        size = "500" if batch.event_count == 500 else "<500"
        name = f"batch[{size}] {label}" if label == "fresh" else f"batch {label}"
        headers = {"Authorization": f"Bearer {self.kiosk.token}", "Content-Type": "application/json"}
        with self.client.post("/api/v1/events/batch", data=batch.body, headers=headers, name=name,
                              catch_response=True) as resp:
            if resp.status_code != 200:
                resp.failure(f"HTTP {resp.status_code}: {resp.text[:120]}")
                return None
            doc = resp.json()
            resp.success()
            return doc

    @task
    def upload(self) -> None:
        if not self.pending:
            self._refill()
        batch = self.pending.popleft()
        doc = self._send(batch, "fresh")
        attempts = 1
        while doc is not None and doc.get("summary", {}).get("retryable") and attempts < 10:
            gevent.sleep(0.2 * attempts)
            doc = self._send(batch, "retry_busy")
            attempts += 1
        if doc is None:
            self.pending.appendleft(batch)  # the outbox keeps it; try again after back-off
            gevent.sleep(min(15.0, 0.5 * attempts))
            return
        _uploaded_sessions.extend(batch.session_ids)
        if self.rng.random() < RETRY_P:
            self._send(batch, "retry_same_id")
        if self.rng.random() < REPACK_P:
            self._send(repack(batch, "repacked"), "repacked")
        if THINK_S > 0:
            gevent.sleep(self.rng.expovariate(1.0 / THINK_S))


class ResearcherUser(HttpUser):
    """Dashboard-style reads against the research API while kiosks upload."""

    wait_time = between(0.5, 2.0)

    def on_start(self) -> None:
        resp = self.client.post("/api/v1/auth/dev-login", json={"sub": "locust-researcher", "roles": ["researcher"]},
                                name="auth dev-login")
        resp.raise_for_status()
        self.headers = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    def _session(self) -> str | None:
        return random.choice(_uploaded_sessions) if _uploaded_sessions else None

    @task(3)
    def list_sessions(self) -> None:
        self.client.get("/api/v1/sessions?limit=50", headers=self.headers, name="GET /sessions")

    @task(3)
    def session_detail(self) -> None:
        sid = self._session()
        if sid:
            self.client.get(f"/api/v1/sessions/{sid}", headers=self.headers, name="GET /sessions/{id}")

    @task(2)
    def session_events(self) -> None:
        sid = self._session()
        if sid:
            self.client.get(f"/api/v1/sessions/{sid}/events?limit=500", headers=self.headers,
                            name="GET /sessions/{id}/events")

    @task(2)
    def quality_flags(self) -> None:
        sid = self._session()
        if sid:
            self.client.get(f"/api/v1/sessions/{sid}/quality-flags", headers=self.headers,
                            name="GET /sessions/{id}/quality-flags")

    @task(1)
    def feature_matrix(self) -> None:
        self.client.get(f"/api/v1/features/matrix?study_id={STUDY_ID}", headers=self.headers,
                        name="GET /features/matrix")

    @task(1)
    def datasets(self) -> None:
        self.client.get(f"/api/v1/validation/datasets?study_id={STUDY_ID}", headers=self.headers,
                        name="GET /validation/datasets")

    @task(1)
    def scores(self) -> None:
        self.client.get(f"/api/v1/assessment-responses/scores?study_id={STUDY_ID}", headers=self.headers,
                        name="GET /assessment-responses/scores")


if __name__ == "__main__":  # pragma: no cover - convenience for a quick syntax/self check
    corpus, fleet = _state()
    print(json.dumps({"corpus": corpus.describe(), "kiosks": len(fleet.kiosks)}, indent=2))
