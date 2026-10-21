"""The driver follows the outbox retry policy and records every attempt (mock server, no network)."""

from __future__ import annotations

import asyncio
import json
from collections import Counter

import httpx

from shriii_loadtest.batches import KioskIdentity
from shriii_loadtest.corpus import Corpus
from shriii_loadtest.report import evaluate, load_targets, render_markdown, summarise_run
from shriii_loadtest.runner import ResearchOptions, run_plan
from shriii_loadtest.scenarios import PlanOptions, build_plan


class FakeIngest:
    """Idempotent fake: first attempt of each batch -> 503, second -> one retryable event, then accepted.

    Replays of a finished ``batch_id`` return ``duplicate_batch``; events already seen are ``duplicate``.
    """

    def __init__(self) -> None:
        self.attempts: Counter[str] = Counter()
        self.final: set[str] = set()
        self.seen: set[str] = set()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path != "/api/v1/events/batch":
            return httpx.Response(200, json={"items": []})
        assert request.headers["authorization"].startswith("Bearer kdt_")
        doc = json.loads(request.content)
        bid = doc["batch_id"]
        self.attempts[bid] += 1
        if bid in self.final:
            return httpx.Response(200, json={"duplicate_batch": True, "summary": {"duplicate": doc["event_count"]}})
        if self.attempts[bid] == 1:
            return httpx.Response(503, json={"detail": {"code": "unavailable"}})
        events = [e for c in doc["session_chunks"] for e in c["events"]]
        if self.attempts[bid] == 2:
            return httpx.Response(200, json={"duplicate_batch": False,
                                             "summary": {"accepted": len(events) - 1, "retryable": 1}})
        new = [e for e in events if e["event_id"] not in self.seen]
        self.seen.update(e["event_id"] for e in events)
        self.final.add(bid)
        return httpx.Response(200, json={"duplicate_batch": False,
                                         "summary": {"accepted": len(new), "duplicate": len(events) - len(new)}})


def test_retry_policy_and_reporting(corpus: Corpus, kiosks: list[KioskIdentity]) -> None:
    plan = build_plan("retry", corpus, kiosks, PlanOptions(kiosks=3, sessions_per_kiosk=1, think_s=0.01,
                                                           retry_same_id_p=1.0, repack_p=1.0))
    fake = FakeIngest()
    research = ResearchOptions(users=2, token="jwt", think_s=0.01)
    result = asyncio.run(run_plan(plan, "http://test", transport=httpx.MockTransport(fake), research=research, seed=3))
    assert not result.terminal_failures
    fresh = [s for s in result.samples if s.kind == "fresh"]
    n = len(fresh) // 3
    assert n > 0
    assert Counter(s.outcome for s in fresh) == Counter({"http_error": n, "retryable": n, "ok": n})
    assert sorted({s.attempt for s in fresh}) == [1, 2, 3]
    retries = [s for s in result.samples if s.kind == "retry_same_id"]
    assert retries and all(s.duplicate_batch for s in retries)
    assert fake.seen == {e for k in plan.scripts for s in k.steps for e in s.batch.event_ids}
    assert result.research_samples and all(s.http_status == 200 for s in result.research_samples)
    summary = summarise_run(result)
    assert summary["by_kind"]["fresh"]["retryable_responses"] == n
    checks = evaluate(summary, None, load_targets())
    assert checks["terminal_failures"]["passed"]
    md = render_markdown("unit", summary, checks, None, {"label": "unit"})
    assert "| fresh |" in md and "Research API" in md


def test_terminal_4xx_is_reported(corpus: Corpus, kiosks: list[KioskIdentity]) -> None:
    plan = build_plan("saturate", corpus, kiosks, PlanOptions(kiosks=1, sessions_per_kiosk=1))

    def reject(request: httpx.Request) -> httpx.Response:
        return httpx.Response(413, json={"detail": {"code": "batch_too_large"}})

    result = asyncio.run(run_plan(plan, "http://test", transport=httpx.MockTransport(reject)))
    assert len(result.terminal_failures) == len(plan.scripts[0].steps)
    assert all(f["error"] == "batch_too_large" for f in result.terminal_failures)
    assert all(s.attempt == 1 for s in result.samples)
    checks = evaluate(summarise_run(result), None, load_targets())
    assert not checks["terminal_failures"]["passed"] and not checks["ing02_p95"]["passed"]
