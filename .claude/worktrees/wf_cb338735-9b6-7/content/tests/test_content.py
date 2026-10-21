"""Content validation: instruments (CRT-02/03), voice-line catalogue (VOX-07) and game configs (ENG-04, ONB-08)."""

from __future__ import annotations

import json
import re
from collections import Counter
from functools import cache
from pathlib import Path
from typing import Any

import pytest
import yaml
from shriii_contracts import parse_contract
from shriii_contracts.paths import content_dir, scoring_dir
from shriii_contracts.schema_validation import iter_errors

PLACEHOLDER = "[licensed item text — load from licensed source]"


@cache
def _yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


@cache
def _json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def instrument_files() -> list[Path]:
    return sorted((content_dir() / "instruments").glob("*.yaml"))


def instruments() -> dict[str, dict[str, Any]]:
    return {_yaml(f)["instrument_id"]: _yaml(f) for f in instrument_files()}


def game_files() -> list[Path]:
    return sorted(p for p in (content_dir() / "games").rglob("*.json") if p.name != "session-plan.json")


def games() -> dict[str, dict[str, Any]]:
    return {_json(p)["module_id"]: _json(p) for p in game_files()}


def plan() -> dict[str, Any]:
    return dict(_json(content_dir() / "games" / "session-plan.json"))


def lines() -> dict[str, dict[str, Any]]:
    return {line["id"]: line for line in _yaml(content_dir() / "i18n" / "lines.yaml")["lines"]}


def dictionary(p: str) -> dict[str, Any]:
    return dict(_yaml(scoring_dir() / "dictionary" / f"dictionary.{p}.yaml"))


# ------------------------------------------------------------------ instruments


@pytest.mark.parametrize("path", instrument_files(), ids=lambda p: p.stem)
def test_instrument_schema(path: Path) -> None:
    data = _yaml(path)
    assert [e.message for e in iter_errors("instrument", data)] == []
    parse_contract("instrument", data, strict=True)


def test_required_instruments_present() -> None:
    required = {
        "bfi2_s",
        "bfi2_xs",
        "bscs",
        "erq",
        "ders16",
        "cfi",
        "grit_s",
        "hexaco_hh",
        "moral_identity",
        "gdms",
        "partner_rating",
        "tol_board",
        "general_risk",
        "observed_cooperation",
        "card_sort_criterion",
        "attention_checks",
    }
    assert required <= set(instruments())


def test_item_counts_match_published_specs() -> None:
    expected = {
        "bfi2_s": 30,
        "bfi2_xs": 15,
        "bscs": 13,
        "erq": 10,
        "ders16": 16,
        "cfi": 20,
        "grit_s": 8,
        "hexaco_hh": 10,
        "moral_identity": 10,
        "gdms": 25,
        "general_risk": 1,
        "attention_checks": 3,
        "tol_board": 8,
    }
    inst = instruments()
    for iid, n in expected.items():
        assert len(inst[iid]["items"]) == n, iid


def test_no_copyrighted_wording_is_committed() -> None:
    for path in instrument_files():
        data = _yaml(path)
        for it in data["items"]:
            assert it["item_text"] == PLACEHOLDER, it["item_id"]
            assert it["item_text_source"]["reference"]
        assert data["administration"]["public_kiosk_allowed"] is False


@pytest.mark.parametrize("iid", sorted(instruments()))
def test_scales_and_items_are_consistent(iid: str) -> None:
    d = instruments()[iid]
    item_ids = [i["item_id"] for i in d["items"]]
    assert len(item_ids) == len(set(item_ids))
    assert all(i.startswith(f"{iid}.") for i in item_ids)
    scale_ids = {s["scale_id"] for s in d["subscales"]}
    for s in d["subscales"]:
        assert set(s["items"]) <= set(item_ids), s["scale_id"]
        assert s["parent"] is None or s["parent"] in scale_ids
    for it in d["items"]:
        assert it["subscales"], it["item_id"]
        assert set(it["subscales"]) <= scale_ids, it["item_id"]
        for sid in it["subscales"]:
            scale = next(s for s in d["subscales"] if s["scale_id"] == sid)
            assert it["item_id"] in scale["items"], (it["item_id"], sid)
    if any(i["reverse_keyed"] for i in d["items"]):
        assert d["response_scale"]["reverse_formula"] == "min_plus_max_minus_x"
    assert d["licensing"]["permission_status"] in {"not_requested", "requested", "granted", "denied", "not_required"}


def _rev(iid: str) -> set[int]:
    return {it["number"] for it in instruments()[iid]["items"] if it["reverse_keyed"]}


def test_reverse_keys_match_published_keys() -> None:
    assert _rev("bfi2_s") == {1, 3, 7, 8, 10, 14, 17, 19, 20, 21, 24, 26, 27, 28, 30}  # Soto & John (2017) A.2
    assert _rev("bfi2_xs") == {1, 3, 7, 8, 10, 14}  # A.3: first three items of each domain
    assert _rev("bscs") == {2, 3, 4, 5, 7, 9, 10, 12, 13}
    assert _rev("erq") == set()
    assert _rev("ders16") == set()
    assert _rev("cfi") == {2, 4, 7, 9, 11, 15}
    assert _rev("grit_s") == {1, 3, 5, 6}
    hh_rev = {int(it["item_id"].split("_")[-1]) for it in instruments()["hexaco_hh"]["items"] if it["reverse_keyed"]}
    assert hh_rev == {12, 24, 30, 42, 48, 60}
    assert _rev("moral_identity") == {4, 7}


def test_subscale_assignments_spot_checks() -> None:
    def items_of(iid: str, sid: str) -> set[int]:
        d = instruments()[iid]
        ids = next(s for s in d["subscales"] if s["scale_id"] == sid)["items"]
        return {it["number"] for it in d["items"] if it["item_id"] in ids}

    assert items_of("erq", "reappraisal") == {1, 3, 5, 7, 8, 10}
    assert items_of("erq", "suppression") == {2, 4, 6, 9}
    assert items_of("ders16", "strategies") == {5, 6, 12, 14, 16}
    assert items_of("ders16", "nonacceptance") == {9, 10, 13}
    assert items_of("bfi2_s", "extraversion") == {1, 6, 11, 16, 21, 26}
    assert items_of("bfi2_s", "organization") == {3, 18}
    assert items_of("bfi2_xs", "conscientiousness") == {3, 8, 13}
    assert items_of("moral_identity", "internalization") == {1, 2, 4, 7, 10}


def test_battery_blocks_match_crt02() -> None:
    blocks: Counter[str] = Counter()
    for iid, d in instruments().items():
        if iid == "bfi2_s":
            # Items 1-15 are the BFI-2-XS (counted there); 16-30 are block C.
            blocks.update(it["block"] for it in d["items"] if it["number"] > 15)
            continue
        if d["kind"] in ("questionnaire", "single_item"):
            blocks.update(it["block"] for it in d["items"])
    # Core X: BFI-2-XS 15 + BSCS 13 + DERS-16 16 + Grit-S 8 + HEXACO-HH 10
    #         + GDMS rational/avoidant 10 + general risk 1 + 3 attention checks.
    assert blocks["X"] == 15 + 13 + 16 + 8 + 10 + 10 + 1 + 3
    assert blocks["A"] == 10 + 10  # ERQ + moral identity
    assert blocks["B"] == 20  # CFI
    assert blocks["C"] == 15 + 15  # remaining BFI-2-S + remaining GDMS


# ------------------------------------------------------------------ voice-line catalogue


def test_line_catalogue_schema_and_rules() -> None:
    data = _yaml(content_dir() / "i18n" / "lines.yaml")
    assert [e.message for e in iter_errors("voice-line-catalogue", data)] == []
    parse_contract("voice-line-catalogue", data, strict=True)
    ids = [line["id"] for line in data["lines"]]
    assert len(ids) == len(set(ids))
    for line in data["lines"]:
        assert set(line["recording"]) == set(data["languages"]), line["id"]
        if line["id"].startswith("optin.digit."):
            assert line["voice_forbidden"], line["id"]
        if line["category"] == "report":
            assert not re.search(r"\d", line["reference_text"]), f"{line['id']}: reports contain no numbers"


def test_every_module_audio_key_exists() -> None:
    known = set(lines())
    for m, g in games().items():
        assert set(g["audio_keys"]) <= known, m


# ------------------------------------------------------------------ game configs


@pytest.mark.parametrize("path", game_files(), ids=lambda p: p.stem)
def test_game_config_schema(path: Path) -> None:
    data = _json(path)
    assert [e.message for e in iter_errors("game-config", data)] == []
    parse_contract("game-config", data, strict=True)


def test_session_plan_schema() -> None:
    assert [e.message for e in iter_errors("session-plan", plan())] == []
    parse_contract("session-plan", plan(), strict=True)


def _duration(g: dict[str, Any], level: str, bot: str, trimmed: bool) -> int:
    spt = g["levels"][level]["seconds_per_trial"][bot]
    total: float = g["budget"]["intro_ms"] + g["budget"]["outro_ms"]
    for b in g["blocks"]:
        n = b["min_trials"] if trimmed else b["trials"]
        total += n * (b["budget_trial_ms"] if b["budget_trial_ms"] is not None else spt * 1000)
    return round(total)


@pytest.mark.parametrize("module", sorted(games()))
def test_budget_estimates_are_recomputable(module: str) -> None:
    g = games()[module]
    for level in ("L1", "L2", "L3"):
        est = g["levels"][level]["estimated_duration_ms"]
        assert est["median"] == _duration(g, level, "median", False)
        assert est["slow"] == _duration(g, level, "slow", False)
        assert est["slow_trimmed"] == _duration(g, level, "slow", True)
        assert est["median"] <= g["budget"]["soft_cap_ms"] <= g["budget"]["hard_cap_ms"], level
        assert est["slow_trimmed"] <= g["budget"]["hard_cap_ms"], level
    assert g["budget"]["target_ms_l2"] == g["levels"]["L2"]["estimated_duration_ms"]["median"]
    for b in g["blocks"]:
        assert b["min_trials"] <= b["trials"], b["block_id"]
        if b["phase"] in ("practice", "warmup"):
            assert b["scorable"] is False, b["block_id"]
    for key, minimum in g["min_counts"].items():
        if key in g["planned_counts"]:
            assert minimum <= g["planned_counts"][key], key
    assert g["requires_numeracy"] is False


def test_b_modules_last_60_to_120_s_at_every_level() -> None:
    sp = plan()
    lo, hi = sp["b_module_duration_s"]["min"] * 1000, sp["b_module_duration_s"]["max"] * 1000
    for m in [*sp["pathways"]["B"]["core_order"], *sp["pathways"]["B"]["slot_candidates"]]:
        g = games()[m]
        assert g["budget"]["hard_cap_ms"] <= hi, m
        for level in ("L1", "L2", "L3"):
            est = g["levels"][level]["estimated_duration_ms"]
            assert lo <= est["median"] <= hi, (m, level)
            assert lo <= est["slow_trimmed"] <= hi, (m, level)


def test_a_episodes_run_about_3_3_minutes() -> None:
    sp = plan()
    for m in sp["pathways"]["A"]["order"]:
        med = games()[m]["levels"]["L2"]["estimated_duration_ms"]["median"] / 1000
        assert sp["a_episode_median_s"]["min"] <= med <= sp["a_episode_median_s"]["max"], m


def test_session_budgets_fit_section_4_4() -> None:
    sp = plan()
    g = games()
    segments = sum(sp["segments_max_s"].values())
    assert sp["segments_max_s"]["practice_warmup"] * 1000 >= g["warmup"]["budget"]["hard_cap_ms"]
    b = sp["pathways"]["B"]
    b_caps = sum(g[m]["budget"]["hard_cap_ms"] for m in b["core_order"]) + max(
        g[s]["budget"]["hard_cap_ms"] for s in b["slot_candidates"]
    )
    a_caps = sum(g[m]["budget"]["hard_cap_ms"] for m in sp["pathways"]["A"]["order"])
    for caps in (b_caps, a_caps):
        assert segments + caps / 1000 <= sp["session_target_max_s"] <= sp["session_cap_s"]
    lo, hi = sp["scored_play_median_s"]["min"], sp["scored_play_median_s"]["max"]
    core_med = sum(g[m]["levels"]["L2"]["estimated_duration_ms"]["median"] for m in b["core_order"])
    for s in b["slot_candidates"]:
        total = (core_med + g[s]["levels"]["L2"]["estimated_duration_ms"]["median"]) / 1000
        assert lo <= total <= hi, s
    a_med = sum(g[m]["levels"]["L2"]["estimated_duration_ms"]["median"] for m in sp["pathways"]["A"]["order"]) / 1000
    assert lo <= a_med <= hi
    assert len(b["core_order"]) == 5 and len(b["slot_candidates"]) == 4
    assert b["core_order"] == ["dont_tap", "card_sort", "balloon", "tower", "share_pot"]  # MG-10 fixed order


def test_modules_match_dictionary_and_cover_two_constructs() -> None:
    """ENG-04: every module declares indicators covering >= 2 constructs; ids resolve in the pathway dictionary."""
    substudy = set(plan()["pathways"]["A"]["optional_substudy"])
    for p in "AB":
        d = dictionary(p)
        known = {i["id"]: i for i in d["indicators"]}
        for mod in d["modules"]:
            path = content_dir().parent / mod["config"]
            assert path.is_file(), mod["config"]
            g = _json(path)
            assert g["module_id"] == mod["id"] and g["slot"] == mod["slot"]
            assert p in g["pathways"]
            assert set(g["indicators"]) <= set(known), mod["id"]
            own = {i for i, v in known.items() if v["source"]["module_id"] == mod["id"]}
            assert own <= set(g["indicators"]), mod["id"]
            constructs = {known[i]["construct"] for i in g["indicators"]}
            assert constructs == set(g["constructs"]), mod["id"]
            if mod["id"] not in substudy:  # substudy episodes sit outside the scored 15-minute schedule
                assert len(constructs) >= 2, mod["id"]


def test_scheduler_minimums_meet_dictionary_minimums() -> None:
    g = games()
    assert g["dont_tap"]["min_counts"]["nogo"] >= 20
    assert g["stall"]["min_counts"]["gng"] >= 30 and g["stall"]["min_counts"]["nogo"] >= 8
    assert g["stall"]["min_counts"]["provocations"] >= 8 and g["stall"]["min_counts"]["tone_choices"] >= 12
    assert g["stall"]["min_counts"]["tone_levels"] >= 3
    assert (
        g["card_sort"]["min_counts"]["post_switch_per_switch"] >= 10 and g["card_sort"]["min_counts"]["switches"] == 2
    )
    assert g["tower"]["min_counts"]["unsolvable"] >= 2 and g["tower"]["min_counts"]["solvable"] == 4
    assert g["share_pot"]["min_counts"]["rounds"] == 8
    assert g["weighing_post"]["min_counts"]["decisions"] >= 12 and g["weighing_post"]["min_counts"]["post_shift"] >= 6
    for k in ("bribe", "overpayment", "assistant_mistake", "fraud_found"):
        assert g["weighing_post"]["min_counts"][k] >= 3, k
    assert g["four_stalls"]["min_counts"]["repeat_probes"] >= 10
    assert g["private_dice"]["constraints"]["true_outcome_logged"] is False
    assert 15 <= g["balloon"]["planned_counts"]["balloons"] <= 20
    # Stall and Weighing have exactly one context shift (EPI-01, EPI-02).
    for m in ("stall", "weighing_post", "road_home"):
        assert g[m]["context_shift"] is not None, m
    assert g["road_home"]["context_shift"]["announced"] is False  # unannounced reversal
    assert g["card_sort"]["context_shift"]["announced"] is False
