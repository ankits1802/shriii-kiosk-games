"""Gate evaluator (fail closed, caps, never one-language release, property tests) and power utilities."""

from __future__ import annotations

from typing import Any

import pytest
import yaml
from hypothesis import given, settings
from hypothesis import strategies as st
from shriii_contracts.paths import scoring_dir
from shriii_validation.gates import (
    BatteryEvidence,
    GateHistory,
    TraitEvidence,
    evaluate_battery_gate,
    evaluate_trait_gate,
)
from shriii_validation.power import (
    dif_power_simulation,
    icc_ci_halfwidth,
    n_for_correlation_lower_bound,
    n_for_icc_halfwidth,
    power_correlation_lower_bound,
)
from shriii_validation.rbackend import UnavailableRBackend, default_backend

GATES: dict[str, Any] = yaml.safe_load((scoring_dir() / "gates.yaml").read_text(encoding="utf-8"))
SHARED: dict[str, Any] = yaml.safe_load((scoring_dir() / "dictionary" / "shared.yaml").read_text(encoding="utf-8"))
CONSTRUCTS = {c["id"]: c for c in SHARED["constructs"]}
GROUPINGS = GATES["trait_gate"]["invariance"]["required_groupings"]
TIER1_B = [c for c, v in CONSTRUCTS.items() if v["tier"] == 1]


def full_evidence(trait: str, language: str = "hi-IN", pathway: str = "B", **over: Any) -> TraitEvidence:
    base: dict[str, Any] = dict(  # noqa: C408
        trait=trait,
        language=language,
        pathway=pathway,
        retest_icc_a1=0.72,
        retest_icc_a1_lower=0.55,
        retest_pairs=100,
        reliability=0.8,
        reliability_lower=0.7,
        convergent_r=0.25,
        convergent_lower=0.15,
        convergent_sign_correct=True,
        convergent_holm_passed=True,
        pattern_passed=True,
        nomological_passed=True,
        invariance=dict.fromkeys(GROUPINGS, True),
        norms="provisional",
        signoffs=("pi", "lead"),
    )
    base.update(over)
    return TraitEvidence(**base)


def test_full_evidence_promotes_when_not_evaluate_only() -> None:
    d = evaluate_trait_gate(full_evidence("self_control"), GATES, CONSTRUCTS["self_control"], evaluate_only=False)
    assert d.status == "validated_banded" and all(v == "pass" for v in d.rules.values())


def test_evaluate_only_never_promotes() -> None:
    d = evaluate_trait_gate(full_evidence("self_control"), GATES, CONSTRUCTS["self_control"], evaluate_only=True)
    assert d.status == "unvalidated" and d.evaluated_status == "validated_banded"


def test_missing_evidence_fails_closed() -> None:
    d = evaluate_trait_gate(
        TraitEvidence("self_control", "hi-IN", "B"), GATES, CONSTRUCTS["self_control"], evaluate_only=False
    )
    assert d.status == "unvalidated"
    few_pairs = evaluate_trait_gate(
        full_evidence("self_control", retest_pairs=20), GATES, CONSTRUCTS["self_control"], evaluate_only=False
    )
    assert few_pairs.status == "unvalidated" and few_pairs.rules["B1"] == "missing"


def test_failing_retest_or_convergent_is_research_only() -> None:
    d = evaluate_trait_gate(
        full_evidence("self_control", retest_icc_a1=0.5), GATES, CONSTRUCTS["self_control"], evaluate_only=False
    )
    assert d.status == "research_only"
    dis = evaluate_trait_gate(
        full_evidence("self_control", convergent_observed=False), GATES, CONSTRUCTS["self_control"], evaluate_only=False
    )
    assert dis.status == "research_only" and any("disattenuated" in r for r in dis.reasons)


def test_caps_and_withholds() -> None:
    for trait in ("integrity", "risk_preference", "teamwork", "response_consistency"):
        pw = "A" if trait == "integrity" else "B"
        d = evaluate_trait_gate(full_evidence(trait, pathway=pw), GATES, CONSTRUCTS[trait], evaluate_only=False)
        assert d.status == "validated_broad_style" and d.capped, trait
    for trait in ("emotional_regulation", "judgement"):
        d = evaluate_trait_gate(full_evidence(trait, pathway="B"), GATES, CONSTRUCTS[trait], evaluate_only=False)
        assert d.status == "withheld"


def test_planted_dif_blocks_promotion() -> None:
    inv = dict.fromkeys(GROUPINGS, True)
    inv["language"] = False
    d = evaluate_trait_gate(
        full_evidence("self_control", invariance=inv), GATES, CONSTRUCTS["self_control"], evaluate_only=False
    )
    assert d.status != "validated_banded" and d.rules["B4"] == "fail"


def _battery(lang: str) -> BatteryEvidence:
    return BatteryEvidence(
        lang,
        "B",
        "supervised",
        criterion_invariance_passed=True,
        unresolved_large_dif=False,
        differential_exclusion_pp=2.0,
        signoff_roles=("pi_or_research_lead", "ethics_officer"),
    )


def _decisions(lang: str, passing: bool) -> list[Any]:
    out = []
    for t in TIER1_B:
        ev = full_evidence(t, language=lang) if passing else TraitEvidence(t, lang, "B")
        out.append(evaluate_trait_gate(ev, GATES, CONSTRUCTS[t], evaluate_only=False))
    return out


def test_battery_gate_needs_two_languages() -> None:
    one = _decisions("hi-IN", True) + _decisions("mr-IN", False)
    ev = {("hi-IN", "B", "supervised"): _battery("hi-IN"), ("mr-IN", "B", "supervised"): _battery("mr-IN")}
    d = evaluate_battery_gate(
        "hi-IN", "B", "supervised", trait_decisions=one, battery_evidence=ev, gates=GATES, tier1_constructs=TIER1_B
    )
    assert d.status == "closed" and d.rules["A1"] == "fail"
    two = _decisions("hi-IN", True) + _decisions("mr-IN", True)
    d2 = evaluate_battery_gate(
        "hi-IN", "B", "supervised", trait_decisions=two, battery_evidence=ev, gates=GATES, tier1_constructs=TIER1_B
    )
    assert d2.status == "open"
    pub = evaluate_battery_gate(
        "hi-IN", "B", "open_public", trait_decisions=two, battery_evidence=ev, gates=GATES, tier1_constructs=TIER1_B
    )
    assert pub.status == "closed"  # VAL-18 mode equivalence evidence missing


@given(st.lists(st.booleans(), min_size=3, max_size=3), st.lists(st.booleans(), min_size=3, max_size=3))
@settings(max_examples=40, deadline=None)
def test_battery_gate_property_never_opens_with_one_passing_language(passing: list[bool], fair: list[bool]) -> None:
    langs = ["hi-IN", "mr-IN", "ta-IN"]
    decisions = [d for lang, ok in zip(langs, passing, strict=True) for d in _decisions(lang, ok)]
    ev = {}
    for lang, f in zip(langs, fair, strict=True):
        b = _battery(lang)
        ev[(lang, "B", "supervised")] = BatteryEvidence(
            b.language,
            "B",
            "supervised",
            criterion_invariance_passed=f,
            unresolved_large_dif=False,
            differential_exclusion_pp=1.0,
            signoff_roles=b.signoff_roles,
        )
    qualifying = sum(1 for p, f in zip(passing, fair, strict=True) if p and f)
    for lang in langs:
        d = evaluate_battery_gate(
            lang,
            "B",
            "supervised",
            trait_decisions=decisions,
            battery_evidence=ev,
            gates=GATES,
            tier1_constructs=TIER1_B,
        )
        if d.status == "open":
            assert qualifying >= 2 and lang in d.qualifying_languages


def test_gate_history_regressions() -> None:
    h = GateHistory()
    h.append(("self_control", "hi-IN", "B"), "validated_banded", [])
    h.append(("self_control", "hi-IN", "B"), "research_only", ["retest fell below threshold"])
    assert h.current(("self_control", "hi-IN", "B")) == "research_only"
    assert len(h.regressions()) == 1 and len(h.entries) == 2


def test_power_correlation_matches_plan_va102() -> None:
    n = n_for_correlation_lower_bound(0.25, 0.10, alpha=0.05 / 8, power=0.8)
    assert 450 <= n <= 480  # plan VAL-02: ~470 for r = .25 vs .10 at Holm alpha .00625
    assert power_correlation_lower_bound(n, 0.25, 0.10, alpha=0.05 / 8) == pytest.approx(0.8, abs=0.01)


def test_icc_halfwidth() -> None:
    hw = icc_ci_halfwidth(100, 0.6)
    assert 0.1 <= hw <= 0.15  # plan: retest 100 pairs, ICC .60 half-width ~ .12
    assert n_for_icc_halfwidth(0.6, hw) == pytest.approx(100, abs=2)


def test_dif_power_record_and_rbackend() -> None:
    rec = dif_power_simulation(400, n_items=12, uniform_shift=1.0, replications=8, seed=1)
    assert rec.detection_rate >= 0.75 and rec.false_positive_rate <= 0.1
    b = default_backend()
    assert isinstance(b, UnavailableRBackend)
    assert b.invariance_lavaan(None, "", "language").status == "not_available"
    assert b.irt_dif_mirt(None, []).status == "not_available"


def test_withheld_tier1_counts_as_fail_unless_configured() -> None:
    """A2 share: withheld Tier-1 constructs stay in the denominator when count_withheld_as_fail is true."""
    import copy  # noqa: PLC0415

    tier1 = ["self_control", "emotional_regulation", "judgement"]  # two of three withheld in Pathway B
    decisions = [
        evaluate_trait_gate(full_evidence(t, language=lang), GATES, CONSTRUCTS[t], evaluate_only=False)
        for lang in ("hi-IN", "mr-IN")
        for t in tier1
    ]
    assert sum(d.status == "withheld" for d in decisions) == 4
    ev = {("hi-IN", "B", "supervised"): _battery("hi-IN"), ("mr-IN", "B", "supervised"): _battery("mr-IN")}
    strict = evaluate_battery_gate(
        "hi-IN", "B", "supervised", trait_decisions=decisions, battery_evidence=ev, gates=GATES, tier1_constructs=tier1
    )
    assert strict.rules["A2"] == "fail" and strict.status == "closed"
    lenient_gates = copy.deepcopy(GATES)
    lenient_gates["battery_gate"]["count_withheld_as_fail"] = False
    lenient = evaluate_battery_gate(
        "hi-IN",
        "B",
        "supervised",
        trait_decisions=decisions,
        battery_evidence=ev,
        gates=lenient_gates,
        tier1_constructs=tier1,
    )
    assert lenient.rules["A2"] == "pass"
