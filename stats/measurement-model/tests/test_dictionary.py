"""Validation of the scoring dictionary, hypotheses and gates (SCR-01, SCR-03, CRT-11, VAL-14).

Schema checks use the canonical JSON Schemas (jsonschema, strict) and the generated Pydantic models;
semantic checks encode the plan's matrix rules (section 4.3) and freeze-time consistency rules.
"""

from __future__ import annotations

import json
from collections import defaultdict
from functools import cache
from pathlib import Path
from typing import Any

import pytest
import yaml
from shriii_contracts import EVENT_TYPES, parse_contract
from shriii_contracts.paths import content_dir, schemas_dir, scoring_dir
from shriii_contracts.schema_validation import iter_errors

PSEUDO_MODULES = {"A": {"cross_episode"}, "B": {"cross_module"}}
FIELD_ROOTS = {"payload", "condition", "task", "timing", "context", "versions", "derived", "session"}


@cache
def _yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def shared() -> dict[str, Any]:
    return dict(_yaml(scoring_dir() / "dictionary" / "shared.yaml"))


def pathway(p: str) -> dict[str, Any]:
    return dict(_yaml(scoring_dir() / "dictionary" / f"dictionary.{p}.yaml"))


def hypotheses() -> dict[str, Any]:
    return dict(_yaml(scoring_dir() / "hypotheses.yaml"))


def gates() -> dict[str, Any]:
    return dict(_yaml(scoring_dir() / "gates.yaml"))


@cache
def instrument_scales() -> set[str]:
    out: set[str] = set()
    for f in sorted((content_dir() / "instruments").glob("*.yaml")):
        d = _yaml(f)
        for s in d["subscales"]:
            out.add(f"{d['instrument_id']}.{s['scale_id']}")
    return out


def construct_ids() -> list[str]:
    common = json.loads((schemas_dir() / "common.v1.schema.json").read_text(encoding="utf-8"))
    return list(common["$defs"]["construct_id"]["enum"])


def indicators(p: str) -> list[dict[str, Any]]:
    return list(pathway(p)["indicators"])


# ------------------------------------------------------------------ schema validity


@pytest.mark.parametrize(
    ("contract", "loader"),
    [
        ("scoring-dictionary-shared", shared),
        ("scoring-dictionary-pathway", lambda: pathway("A")),
        ("scoring-dictionary-pathway", lambda: pathway("B")),
        ("hypotheses", hypotheses),
        ("gates", gates),
    ],
    ids=["shared", "dictionary.A", "dictionary.B", "hypotheses", "gates"],
)
def test_documents_match_their_json_schema(contract: str, loader: Any) -> None:
    data = loader()
    errors = [f"{list(e.absolute_path)}: {e.message}" for e in iter_errors(contract, data)]
    assert errors == []
    parse_contract(contract, data, strict=True)  # Pydantic mirror agrees and nothing unknown is present


# ------------------------------------------------------------------ 17 constructs everywhere (SCR-03 AC)


def test_exactly_17_constructs_in_all_files() -> None:
    ids = [c["id"] for c in shared()["constructs"]]
    assert len(ids) == len(set(ids)) == 17
    assert set(ids) == set(construct_ids())
    assert sorted(c["number"] for c in shared()["constructs"]) == list(range(1, 18))
    assert shared()["construct_count"] == 17
    assert {c["construct"] for c in hypotheses()["coverage"]} == set(ids)
    assert len(hypotheses()["coverage"]) == 17


def test_tiers_and_kinds_follow_plan_section_4() -> None:
    by_id = {c["id"]: c for c in shared()["constructs"]}
    tier1 = {
        "self_control",
        "adaptability",
        "problem_solving",
        "decisiveness",
        "risk_preference",
        "persistence",
        "teamwork",
        "emotional_regulation",
    }
    assert {k for k, c in by_id.items() if c["tier"] == 1} == tier1
    assert {k for k, c in by_id.items() if c["kind"] == "S"} == {
        "response_consistency",
        "persistence_of_style",
        "stability",
    }
    assert {k for k, c in by_id.items() if c["kind"] == "M"} == {"teamwork", "judgement", "integrity"}
    assert {k for k, c in by_id.items() if c["restricted"]} == {"integrity", "risk_preference"}
    for c in by_id.values():
        expected = "repeated_measure_property" if c["kind"] == "S" else "trait_indicator"
        assert c["modelled_as"] == expected, c["id"]


def test_a_only_constructs_are_withheld_for_b() -> None:
    by_id = {c["id"]: c for c in shared()["constructs"]}
    assert by_id["emotional_regulation"]["pathways"]["B"]["status"] == "withheld"
    assert by_id["judgement"]["pathways"]["B"]["status"] == "withheld"
    assert {(w["construct"], w["pathway"]) for w in gates()["permanent_withhold"]} == {
        ("emotional_regulation", "B"),
        ("judgement", "B"),
    }
    for c in by_id.values():
        for p in ("A", "B"):
            st = c["pathways"][p]
            if st["status"] != "scored":
                assert st["reason"], f"{c['id']} {p} needs a reason"


# ------------------------------------------------------------------ indicator integrity


@pytest.mark.parametrize("p", ["A", "B"])
def test_indicator_references_resolve(p: str) -> None:
    sh = shared()
    exclusions = {r["id"] for r in sh["exclusion_rules"]}
    missing = {m["id"] for m in sh["missing_data_policies"]}
    transforms = {t["id"] for t in sh["transformations"]}
    modules = {m["id"]: m for m in pathway(p)["modules"]}
    ids = [i["id"] for i in indicators(p)]
    assert len(ids) == len(set(ids)), "duplicate indicator ids"
    for ind in indicators(p):
        iid = ind["id"]
        assert iid.split(".")[0] == ind["construct"], iid
        assert set(ind["exclusions"]) <= exclusions, iid
        assert ind["missing_data"] in missing, iid
        assert ind["transformation"] in transforms, iid
        assert set(ind["event_inputs"]) <= set(EVENT_TYPES), iid
        assert {f.split(".")[0] for f in ind["required_fields"]} <= FIELD_ROOTS, iid
        mod = ind["source"]["module_id"]
        assert mod in modules or mod in PSEUDO_MODULES[p], f"{iid}: unknown module {mod}"
        if mod in modules:
            assert ind["source"]["slot"] == modules[mod]["slot"], iid
            if p == "A":
                assert ind["source"]["episode_id"] == mod, iid
        assert ind["source"]["task"].split(".")[0] in {mod, *PSEUDO_MODULES[p]}, iid
        assert set(ind["convergent_criteria"]) <= instrument_scales(), iid
        if ind["source"]["slot"]:
            assert ind["missing_data"] in {"planned_missing_slot", "group_level_only"}, iid


@pytest.mark.parametrize("p", ["A", "B"])
def test_kind_rules(p: str) -> None:
    methods = gates()["reliability_methods"]
    r0 = hypotheses()["defaults"]["r0"]
    for ind in indicators(p):
        iid = ind["id"]
        assert ind["reliability_method"] == methods[ind["kind"]], iid
        if ind["kind"] == "group_only" or ind["group_only"]:
            assert ind["kind"] == "group_only" and ind["group_only"], iid
            assert not ind["gate_eligible"] and ind["expected_r_lower_bound"] is None, iid
            assert ind["sensitivity"] == "high", iid
        if ind["kind"] == "single_event_unscorable":
            assert not ind["gate_eligible"], iid
        if ind["role"] == "exploratory":
            assert not ind["gate_eligible"], iid
        if ind["gate_eligible"]:
            assert ind["expected_r_lower_bound"] == r0, iid
            assert ind["convergent_criteria"], f"{iid}: gate-eligible indicators need a convergent criterion"
        if ind["timing_sensitive"]:
            assert {"timing_flagged", "interrupted_trial"} <= set(ind["exclusions"]), iid
        if ind["kind"] == "difference_slope" and any(e == "context_shift" for e in ind["event_inputs"]):
            assert "missing_context_shift" in ind["exclusions"], iid
        assert ind["status"] == "provisional", f"{iid}: v0 indicators are provisional (no drops before Stage 3)"
        assert ind["level_rule"] == "fixed_level_only", f"{iid}: pilot default level rule"


def test_group_only_indicators_match_gates() -> None:
    group = {i["id"] for p in "AB" for i in indicators(p) if i["group_only"]}
    assert group == set(gates()["group_only_indicators"])
    assert any(i.startswith("integrity.dice") for i in group)


@pytest.mark.parametrize("p", ["A", "B"])
def test_pathway_status_matches_indicators(p: str) -> None:
    """Scored constructs need >= 2 gate-eligible indicators; withheld/group-only constructs have none."""
    eligible: dict[str, list[str]] = defaultdict(list)
    for ind in indicators(p):
        if ind["gate_eligible"]:
            eligible[ind["construct"]].append(ind["id"])
    for c in shared()["constructs"]:
        status = c["pathways"][p]["status"]
        n = len(eligible.get(c["id"], []))
        if status == "scored":
            assert n >= 2, f"{c['id']} in {p} has {n} gate-eligible indicators"
        else:
            assert n == 0, f"{c['id']} is {status} in {p} but has gate-eligible indicators"
        if status == "group_only":
            assert any(i["construct"] == c["id"] and i["group_only"] for i in indicators(p))


def test_each_construct_has_two_tasks_in_some_pathway() -> None:
    """Matrix rule: >= 2 indicators from >= 2 tasks within at least one pathway (plan section 4.3)."""
    for c in shared()["constructs"]:
        ok = False
        for p in "AB":
            inds = [i for i in indicators(p) if i["construct"] == c["id"] and i["gate_eligible"]]
            tasks = {i["source"]["task"] for i in inds}
            if len(inds) >= 2 and len(tasks) >= 2:
                ok = True
        assert ok, c["id"]


def test_plan_minimums_are_respected() -> None:
    by_b = {i["id"]: i for i in indicators("B")}
    by_a = {i["id"]: i for i in indicators("A")}
    assert by_b["self_control.nogo_commission_rate"]["min_valid_trials"]["count"] >= 20
    assert by_a["self_control.nogo_commission_rate"]["min_valid_trials"]["count"] >= 8
    assert by_b["adaptability.perseverative_errors"]["min_valid_trials"]["count"] >= 20  # >= 10 per switch, 2 switches
    assert by_b["persistence.time_on_unsolvable"]["min_valid_trials"]["count"] >= 2
    assert by_b["persistence_of_style.cross_segment_style_r"]["min_valid_trials"]["count"] >= 4
    assert by_a["persistence_of_style.cross_segment_style_r"]["min_valid_trials"]["count"] >= 4
    for iid in (
        "judgement.credit_taking",
        "judgement.blame_shifting",
        "integrity.bribe_acceptance",
        "integrity.overpayment_return",
    ):
        assert by_a[iid]["min_valid_trials"]["count"] >= 3, iid
    assert by_a["emotional_regulation.mirroring"]["min_valid_trials"]["count"] >= 12
    assert by_a["emotional_regulation.tone_after_provocation"]["min_valid_trials"]["count"] >= 8
    assert by_b["response_consistency.choice_entropy_repeats"]["min_valid_trials"]["count"] >= 10


def test_shared_paradigm_ids_have_same_construct_and_direction() -> None:
    a = {i["id"]: i for i in indicators("A")}
    b = {i["id"]: i for i in indicators("B")}
    for iid in sorted(set(a) & set(b)):
        assert a[iid]["construct"] == b[iid]["construct"], iid
        assert a[iid]["direction"] == b[iid]["direction"], iid
        assert a[iid]["formula"]["ref"] == b[iid]["formula"]["ref"], iid


# ------------------------------------------------------------------ criterion relations and hypotheses


def test_criterion_references_resolve() -> None:
    scales = instrument_scales()
    for c in shared()["constructs"]:
        rel = c["criterion_relations"]
        for r in rel["convergent"] + rel["discriminant"]:
            assert r["criterion"] in scales, f"{c['id']}: {r['criterion']}"
        for n in rel["nomological"]:
            assert n["criterion"] in scales, f"{c['id']}: {n['criterion']}"
    for h in hypotheses()["hypotheses"]:
        for crit in [h["criterion"], *h["convergent_criteria"], *h["discriminant_criteria"]]:
            if crit is not None:
                assert crit in scales, f"{h['id']}: {crit}"


def test_every_referenced_hypothesis_exists() -> None:
    hyp_ids = {h["id"] for h in hypotheses()["hypotheses"]}
    assert len(hyp_ids) == len(hypotheses()["hypotheses"]), "duplicate hypothesis ids"
    for c in shared()["constructs"]:
        rel = c["criterion_relations"]
        refs = [r["hypothesis_id"] for r in rel["convergent"] + rel["discriminant"] if r["hypothesis_id"]]
        refs += [n["id"] for n in rel["nomological"]]
        assert set(refs) <= hyp_ids, f"{c['id']}: {set(refs) - hyp_ids}"


def test_hypotheses_are_consistent_with_dictionary() -> None:
    families = {f["id"]: f for f in hypotheses()["families"]}
    by_id = {c["id"]: c for c in shared()["constructs"]}
    inds = {p: {i["id"] for i in indicators(p)} for p in "AB"}
    for h in hypotheses()["hypotheses"]:
        assert h["family"] in families, h["id"]
        c = by_id[h["construct"]]
        for p in h["pathways"]:
            allowed = {"group_only"} if h["type"] == "group_level" else {"scored"}
            assert c["pathways"][p]["status"] in allowed, f"{h['id']} targets {p}"
        for iid in h["indicators"]:
            assert any(iid in inds[p] for p in h["pathways"]), f"{h['id']}: {iid}"
            assert iid.split(".")[0] == h["construct"], h["id"]
        if h["type"] == "convergent_lower_bound" and h["family"] != "exploratory":
            assert h["r0"] == hypotheses()["defaults"]["r0"], h["id"]
            assert h["expected_sign"] is not None, h["id"]
        if h["type"] == "discriminant_pattern":
            assert h["convergent_criteria"] and h["discriminant_criteria"], h["id"]


def test_primary_family_is_one_holm_test_per_tier1_construct() -> None:
    fam = next(f for f in hypotheses()["families"] if f["id"] == "primary")
    assert fam["kind"] == "confirmatory" and fam["correction"] == "holm"
    primary = [h for h in hypotheses()["hypotheses"] if h["family"] == "primary"]
    tier1 = {c["id"] for c in shared()["constructs"] if c["tier"] == 1}
    assert sorted(h["construct"] for h in primary) == sorted(tier1)
    assert len(primary) == 8


def test_coverage_matches_dictionary_status() -> None:
    by_id = {c["id"]: c for c in shared()["constructs"]}
    for row in hypotheses()["coverage"]:
        c = by_id[row["construct"]]
        for p in "AB":
            st = c["pathways"][p]["status"]
            if st == "withheld":
                expected = "withheld"
            elif st == "group_only":
                expected = "group_only"
            else:
                expected = "confirmatory" if c["tier"] == 1 else "exploratory"
            assert row[p] == expected, f"{c['id']} {p}"


def test_teamwork_exception_and_caps() -> None:
    exc = {e["construct"]: e for e in hypotheses()["exceptions"]}
    assert exc["teamwork"]["cap_status"] == "validated_broad_style"
    caps = {c["construct"]: c for c in gates()["caps"]}
    for k in ("integrity", "risk_preference", "teamwork"):
        assert caps[k]["max_status"] == "validated_broad_style", k
    assert caps["integrity"]["stricter_flag"] and caps["risk_preference"]["stricter_flag"]
    order = ["withheld", "unvalidated", "research_only", "validated_broad_style", "validated_banded"]
    for c in shared()["constructs"]:
        if c["id"] in caps:
            assert order.index(c["report"]["max_status"]) <= order.index(caps[c["id"]]["max_status"]), c["id"]


def test_report_phrase_keys_exist_in_line_catalogue() -> None:
    catalogue = _yaml(content_dir() / "i18n" / "lines.yaml")
    ids = {line["id"] for line in catalogue["lines"]}
    for c in shared()["constructs"]:
        for key in c["report"]["phrase_keys"].values():
            assert key in ids, key


# ------------------------------------------------------------------ gates sanity (non-negotiables)


def test_gate_non_negotiables() -> None:
    g = gates()
    assert g["fail_closed"] is True
    assert g["battery_gate"]["min_language_groups"] >= 2
    assert g["battery_gate"]["closed_behaviour"] == "thank_you_only"
    assert g["trait_gate"]["retest"]["statistic"] == "icc_a1"
    assert g["trait_gate"]["retest"]["pearson_allowed"] is False
    assert g["trait_gate"]["convergent"]["observed_only"] is True
    assert g["trait_gate"]["convergent"]["upper_bound"] is None
    assert g["rules"]["disattenuated_feeds_gates"] is False
    assert g["rules"]["evaluate_only_can_promote"] is False
    assert g["display_rule"]["battery_gate"] == "open"
    assert set(g["display_rule"]["trait_status_in"]) == {"validated_banded", "validated_broad_style"}
    assert g["display_rule"]["report_mode"] == "player_report"
    assert g["report"]["band_count"] == 3 and g["report"]["disclaimer_required"] is True
    assert g["stage_exits"]["stage2_allows_drops"] is False
    assert {"device_familiarity", "input_mode"} <= set(g["trait_gate"]["invariance"]["required_groupings"])


def test_thresholds_are_only_in_yaml() -> None:
    """Guard: the retest target is configurable in gates.yaml (0.60 by default, plan section 7.7)."""
    assert 0 < gates()["trait_gate"]["retest"]["point_min"] <= 1
    assert gates()["trait_gate"]["retest"]["lower_bound_min"] < gates()["trait_gate"]["retest"]["point_min"]
