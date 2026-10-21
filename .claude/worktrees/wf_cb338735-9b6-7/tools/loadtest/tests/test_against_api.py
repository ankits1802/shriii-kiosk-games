"""End to end against the real API (in-process ASGI + PostgreSQL): the ING-02 correctness criteria.

Small versions of the storm, retry and out-of-order scenarios run through the real ingestion code and
``verify_plan`` must find every event stored exactly once, nothing parked and nothing dead-lettered.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from shriii_loadtest.corpus import Corpus
from shriii_loadtest.provision import Fleet, provision_fleet
from shriii_loadtest.report import evaluate, load_targets, summarise_run
from shriii_loadtest.runner import ResearchOptions, run_plan
from shriii_loadtest.scenarios import PlanOptions, build_plan
from shriii_loadtest.verify import verify_plan


@pytest.fixture(scope="module")
def fleet(api_app: tuple[Any, str]) -> Fleet:
    app, _ = api_app
    with TestClient(app, base_url="http://api") as client:
        return provision_fleet("http://api", 6, client=client)


def _run(api_app: tuple[Any, str], plan: Any, research: ResearchOptions | None = None) -> tuple[Any, dict[str, Any]]:
    app, db_url = api_app
    result = asyncio.run(run_plan(plan, "http://api", transport=httpx.ASGITransport(app=app), research=research))
    return result, verify_plan(db_url, plan.expected_sessions)


def test_dup_storm_stores_each_event_once(api_app: tuple[Any, str], fleet: Fleet, corpus: Corpus) -> None:
    plan = build_plan("dup_storm", corpus, fleet.kiosks, PlanOptions(kiosks=3, storm_batches=3, copies=4))
    result, verification = _run(api_app, plan)
    assert not result.terminal_failures
    assert verification["passed"], verification
    assert verification["duplicate_rows"] == 0 and verification["stored_rows"] == plan.unique_events
    # A replayed batch_id returns the *stored* result (duplicate_batch=true, original statuses), so only
    # first-time processing counts towards "accepted".
    storm = [s for s in result.samples if s.kind in ("storm", "storm_repacked") and s.http_status == 200
             and not s.duplicate_batch]
    accepted = sum(s.statuses.get("accepted", 0) for s in storm)
    assert accepted == sum(k.steps[0].batch.event_count for k in plan.scripts)


def test_retries_and_repacks_add_nothing(api_app: tuple[Any, str], fleet: Fleet, corpus: Corpus) -> None:
    opts = PlanOptions(kiosks=2, sessions_per_kiosk=1, think_s=0.01, retry_same_id_p=1.0, repack_p=1.0, seed=5)
    plan = build_plan("retry", corpus, fleet.kiosks, opts)
    result, verification = _run(api_app, plan)
    assert verification["passed"], verification
    replays = [s for s in result.samples if s.kind == "retry_same_id" and s.http_status == 200]
    assert replays and all(s.duplicate_batch for s in replays)
    repacks = [s for s in result.samples if s.kind == "repacked" and s.http_status == 200 and s.outcome == "ok"]
    assert repacks and all(set(s.statuses) == {"duplicate"} for s in repacks)


def test_out_of_order_with_skewed_clocks_unparks(api_app: tuple[Any, str], fleet: Fleet, corpus: Corpus) -> None:
    opts = PlanOptions(kiosks=4, sessions_per_kiosk=1, clock_skew_share=1.0, seed=9)
    plan = build_plan("out_of_order", corpus, fleet.kiosks, opts)
    result, verification = _run(api_app, plan)
    assert verification["passed"], verification
    assert sum(s.statuses.get("parked", 0) for s in result.samples) > 0
    assert verification["still_parked"] == 0


def test_sealed_batches_with_research_reads(api_app: tuple[Any, str], fleet: Fleet, corpus: Corpus) -> None:
    app, _ = api_app
    with TestClient(app, base_url="http://api") as client:
        token = client.post("/api/v1/auth/dev-login", json={"sub": "r", "roles": ["researcher"]}).json()["access_token"]
    opts = PlanOptions(kiosks=2, sessions_per_kiosk=1, encryption="sealed", public_key=fleet.public_key_bytes,
                       max_body_bytes=1_048_576, think_s=0.05, seed=13)
    plan = build_plan("steady", corpus, fleet.kiosks, opts)
    result, verification = _run(api_app, plan, ResearchOptions(users=2, token=token, think_s=0.05))
    assert verification["passed"], verification
    summary = summarise_run(result)
    checks = evaluate(summary, verification, load_targets())
    assert checks["duplicate_rows"]["passed"] and checks["exactly_once"]["passed"]
    failed = {(s.kind, s.http_status) for s in result.research_samples if s.http_status != 200}
    assert result.research_samples and not failed, failed
