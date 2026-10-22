"""The demo pipeline's database-free half: simulation, upload bodies and criterion administrations.

These run without PostgreSQL so a broken simulator / contract / instrument change surfaces in every
local ``pytest`` run, before the (database-backed) end-to-end run in CI.
"""

from __future__ import annotations

import json
from collections import Counter
from typing import Any

import pytest
from shriii_contracts import EVENT_ADAPTER, check_event_invariants

from shriii_api import content
from shriii_api.canonical import canonical_sha256
from shriii_api.services import criterion as criterion_svc
from shriii_api.services.demo_pipeline import (
    MAX_EVENTS_PER_BATCH,
    ROTATING,
    DemoConfig,
    _administrations,
    _batches,
    _Instrument,
    _Simulated,
    _without_events,
    simulate,
)
from shriii_api.services.ingestion import _BatchShell
from shriii_api.settings import Settings

CONFIG = DemoConfig(participants_per_language=12, retests=4, seed=5)


@pytest.fixture(scope="module")
def sim() -> _Simulated:
    return simulate(CONFIG, 5, "demo-offline")


def test_presets() -> None:
    fast = DemoConfig.preset("fast")
    full = DemoConfig.preset("full")
    assert (fast.participants_per_language, fast.retests) == (120, 40)
    assert (full.participants_per_language, full.retests) == (400, 100)
    assert fast.n_boot < full.n_boot
    with pytest.raises(ValueError, match="unknown demo preset"):
        DemoConfig.preset("huge")


def test_simulation_shape(sim: _Simulated) -> None:
    assert len(sim.persons) == CONFIG.participants_per_language * len(CONFIG.languages)
    assert Counter(p.language for p in sim.persons.values()) == dict.fromkeys(CONFIG.languages, 12)
    assert sum(p.retest for p in sim.persons.values()) == CONFIG.retests
    assert len(sim.sessions) == len(sim.persons) + CONFIG.retests
    assert {p.block for p in sim.persons.values()} <= set(ROTATING)
    # Planted DIF lives in the focal (last) language only.
    assert sim.dif == {CONFIG.dif_trial: {CONFIG.languages[-1]: CONFIG.dif_logit_shift}}
    assert set(sim.criterion) == {"T1", "T2"}
    # A retest keeps the person's T1 rotating block.
    for r in sim.criterion["T2"].responses:
        assert r["block"] not in ROTATING or r["block"] == sim.persons[r["pid"]].block


def test_upload_bodies_match_the_batch_contract(sim: _Simulated) -> None:
    limit = Settings().max_batch_bytes
    n_batches = 0
    for session in sim.sessions[:6]:
        last_seq = -1
        for body in _batches(session):
            n_batches += 1
            shell = _BatchShell.model_validate(body)
            assert canonical_sha256(body["session_chunks"]) == shell.sha256
            assert len(json.dumps(body).encode()) <= limit
            chunk = body["session_chunks"][0]
            assert chunk["event_count"] == len(chunk["events"]) <= MAX_EVENTS_PER_BATCH
            assert chunk["first_seq"] == last_seq + 1  # gapless across batches
            last_seq = chunk["last_seq"]
            for raw in chunk["events"]:
                event = EVENT_ADAPTER.validate_python(raw)
                assert check_event_invariants(event, origin="kiosk") == []
    assert n_batches >= 6


def _instruments() -> dict[str, _Instrument]:
    return {
        str(d.data["instrument_id"]): _Instrument(str(d.data["version"]), d.data)
        for d in content.instrument_documents()
    }


def test_administrations_validate_against_the_registry(sim: _Simulated) -> None:
    instruments = _instruments()
    slim = _without_events(sim)
    wanted = sorted({r["instrument_id"] for c in slim.criterion.values() for r in c.responses} | {"bfi2_xs"})
    pids = sorted(slim.persons)
    seen: Counter[str] = Counter()
    planned_total = 0
    for occasion in ("T1", "T2"):
        for pid, inst_id, responses, planned, block, _role in _administrations(
            slim, instruments, occasion, wanted, pids
        ):
            definition: dict[str, Any] = instruments[inst_id].definition
            resolved = {}
            for r in responses:
                item, measure = criterion_svc._resolve_item(definition, r.item_id)
                criterion_svc._validate_value(definition, r.item_id, r.raw_response)
                if measure == "moves" and r.raw_response is not None:
                    assert r.expected_response is not None
                resolved[r.item_id] = item
            answered = {str(resolved[r.item_id]["item_id"]) for r in responses if r.raw_response is not None}
            assert criterion_svc._planned_missing(definition, planned, answered=answered) == planned
            assert block in (*ROTATING, "X")
            if planned:
                assert block == slim.persons[pid].block
            planned_total += len(planned)
            seen[f"{occasion}:{inst_id}"] += 1
    assert planned_total > 0
    assert seen["T1:bfi2_xs"] > 0  # served from the shared BFI-2-S items
    assert any(k.startswith("T2:") for k in seen)


def test_checks_separate_pipeline_failures_from_statistical_expectations() -> None:
    from shriii_api.services.demo_pipeline import evaluate_checks, failed_hard_checks  # noqa: PLC0415

    summary: dict[str, Any] = {
        "simulated": {"events": 10},
        "ingestion": {"events": {"accepted": 10}},
        "failed_jobs": [],
        "research": {
            "validation_runs": {"dif": {"status": "succeeded"}},
            "model": {"status": "succeeded", "n_holdout": 3},
            "gates": {"battery": [{"status": "closed"}]},
            "results": {"planted_dif": {"recovered": False}},
        },
        "operations": {"report": {"report_mode": "thank_you"}},
    }
    summary["checks"] = evaluate_checks(summary)
    assert failed_hard_checks(summary) == []
    assert summary["checks"]["planted_dif_recovered"] == {
        "kind": "soft",
        "passed": False,
        "detail": {"recovered": False},
    }
    summary["research"]["gates"]["battery"] = [{"status": "open"}]
    summary["ingestion"]["events"] = {"accepted": 9, "rejected": 1}
    summary["checks"] = evaluate_checks(summary)
    assert failed_hard_checks(summary) == ["events_accepted", "gates_fail_closed"]


def test_cli_presets_and_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    from shriii_api import cli  # noqa: PLC0415
    from shriii_api.services import demo_pipeline  # noqa: PLC0415

    seen: list[DemoConfig] = []

    def fake_run(_settings: Any, config: DemoConfig, *, migrate_first: bool = True) -> dict[str, Any]:
        seen.append(config)
        return {"checks": {}}

    monkeypatch.setattr(demo_pipeline, "run_demo_pipeline", fake_run)
    monkeypatch.setattr(demo_pipeline, "render_summary", lambda _s: "ok")
    assert cli.main(["demo-pipeline", "--fast", "--no-migrate"]) == 0
    assert cli.main(["demo-pipeline", "--fast", "--retest", "10", "--no-migrate"]) == 0
    assert cli.main(["demo-pipeline", "--no-migrate"]) == 0
    assert [(c.participants_per_language, c.retests, c.n_boot) for c in seen] == [
        (120, 40, 200),
        (120, 10, 200),
        (400, 100, 500),
    ]
    with pytest.raises(SystemExit):
        cli.main(["demo-pipeline", "--languages", "hi-IN", "--no-migrate"])
