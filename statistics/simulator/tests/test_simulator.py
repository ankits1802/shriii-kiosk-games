"""Simulator output: contract validity, determinism, planted structure, criterion responses."""

from __future__ import annotations

import numpy as np
import pytest
from shriii_contracts import check_event_invariants, check_session_sequence, parse_event
from shriii_contracts.schema_validation import iter_errors
from shriii_scoring.conventions import MODULE_TRIAL_TYPES, PARAM_KEYS
from shriii_simulator.criterion import simulate_criterion
from shriii_simulator.params import load_sim_params
from shriii_simulator.population import CONSTRUCTS, correlation_matrix, retest_person, sample_population
from shriii_simulator.session import simulate_study


@pytest.mark.parametrize(
    ("pathway", "slot", "coplay"),
    [
        ("B", "wait_or_now", False),
        ("B", "steady_hands", False),
        ("B", "four_stalls", False),
        ("B", "private_dice", False),
        ("A", None, True),
    ],
)
def test_events_are_strictly_contract_valid(pathway: str, slot: str | None, coplay: bool) -> None:
    study = simulate_study(1, pathway, seed=1, slot_form=slot, include_coplay=coplay)  # type: ignore[arg-type]
    s = study.sessions[0]
    # jsonschema (canonical) on one event of every type; Pydantic strict parsing (same schemas) on all events.
    seen: set[str] = set()
    for e in s.events:
        if e["event_type"] in seen:
            continue
        seen.add(e["event_type"])
        errs = list(iter_errors("event-envelope", e, "strict"))
        assert errs == [], (e["event_type"], errs[0].message if errs else "")
    parsed = [parse_event(e, strict=True) for e in s.events]
    assert check_session_sequence(parsed) == []
    assert all(check_event_invariants(e) == [] for e in parsed)
    assert all(e["context"]["synthetic"] for e in s.events)


def test_trial_types_and_params_follow_conventions() -> None:
    for pathway in ("A", "B"):
        study = simulate_study(2, pathway, seed=2, include_coplay=pathway == "A")
        for s in study.sessions:
            for e in s.events:
                if e["event_type"] != "trial_start":
                    continue
                module = e["task"]["module_id"]
                tt = e["payload"]["trial_type"]
                assert tt in MODULE_TRIAL_TYPES[module], (module, tt)
                if e["condition"]["phase"] in ("practice", "warmup"):
                    continue
                params = s.trial_params[e["task"]["trial_id"]]
                for key in PARAM_KEYS.get(tt, ()):
                    assert key in params, (module, tt, key)


def test_simulation_is_deterministic() -> None:
    a = simulate_study(3, "B", seed=42)
    b = simulate_study(3, "B", seed=42)
    assert a.events == b.events
    c = simulate_study(3, "B", seed=43)
    assert a.events != c.events


def test_latent_correlations_and_retest_stability() -> None:
    prm = load_sim_params()
    rng = np.random.default_rng(0)
    people = sample_population(4000, prm, rng)
    z = np.array([[p.z(c) for c in CONSTRUCTS] for p in people])
    emp = np.corrcoef(z, rowvar=False)
    assert np.allclose(emp, correlation_matrix(prm), atol=0.05)
    t2 = [retest_person(p, rng, 0.7) for p in people]
    r = np.corrcoef([p.z("self_control") for p in people], [p.z("self_control") for p in t2])[0, 1]
    assert r == pytest.approx(0.7, abs=0.03)


def test_walkaway_and_timing_glitches_are_simulated() -> None:
    prm = load_sim_params().with_overrides(
        {"nuisance.walkaway_probability": 1.0, "nuisance.timing_glitch_probability": 0.2}
    )
    study = simulate_study(3, "B", seed=5, params=prm)
    assert all(s.walked_away for s in study.sessions)
    types = {e["event_type"] for e in study.events}
    assert {"walkaway.prompted", "session.abandoned"} <= types
    assert any(e["timing"]["timing_flag"] == "frame_drop" for e in study.events)


def test_honest_and_overreporting_populations() -> None:
    honest = load_sim_params().with_overrides({"private_report.overreport_logit": -50.0})
    s1 = simulate_study(60, "B", seed=6, params=honest, slot_form="private_dice")
    vals = [e["payload"]["reported_value"] for e in s1.events if e["event_type"] == "report"]
    assert abs(np.mean(np.isin(vals, [5, 6])) - 1 / 3) < 0.05
    s2 = simulate_study(20, "B", seed=7, slot_form="private_dice", strategies={"over_reporter": 20})
    vals2 = [e["payload"]["reported_value"] for e in s2.events if e["event_type"] == "report"]
    assert all(v == 6 for v in vals2)


def test_criterion_responses_valid_and_reverse_keyed() -> None:
    prm = load_sim_params()
    people = sample_population(30, prm, np.random.default_rng(8))
    sim = simulate_criterion(people, seed=9, careless=[people[0].pid])
    for r in sim.responses[:400]:
        assert list(iter_errors("criterion-response", r, "strict")) == []
    blocks = {sim.blocks[p.pid] for p in people}
    assert blocks == {"A", "B", "C"}
    items = {r["item_id"] for r in sim.responses if r["pid"] == people[1].pid}
    assert not any(i.startswith("bfi2_xs.") for i in items)  # administered once as BFI-2-S items


def test_trial_level_dif_injection() -> None:
    prm = load_sim_params().with_overrides({"nuisance.trial_dif": {"dont_tap.nogo": {"ta-IN": 2.0}}})
    rates = {}
    for lang in ("hi-IN", "ta-IN"):
        study = simulate_study(15, "B", seed=12, params=prm, language=lang)
        nogo = [
            e
            for e in study.events
            if e["event_type"] == "trial_end"
            and e["task"]["module_id"] == "dont_tap"
            and e["payload"]["outcome"] in ("commission", "correct")
        ]
        comm = [e for e in nogo if e["payload"]["outcome"] == "commission"]
        rates[lang] = len(comm) / max(len(nogo), 1)
    assert rates["ta-IN"] > rates["hi-IN"] + 0.05
