"""Data-quality flags (trigger and non-trigger cases), gaming bots, differential exclusion, exclusion rules."""

from __future__ import annotations

import dataclasses

import pytest
from shriii_scoring.canonical import canonicalise
from shriii_scoring.dictionary import load_dictionary
from shriii_scoring.exclusions import ExclusionContext, apply_exclusions, evaluate_rule, ms_since_mentioning_prompt
from shriii_scoring.params import load_params
from shriii_scoring.quality import assess_session, differential_exclusion
from shriii_scoring.testing import make_response, make_session, make_trial
from shriii_simulator.session import simulate_study

PARAMS = load_params()
DICT = load_dictionary("B")


def choice_trials(n: int, *, latency: float = 900.0, xy=(0.2, 0.8), value: str = "pile_1"):  # type: ignore[no-untyped-def]
    return [
        make_trial(
            "sort",
            module="card_sort",
            block="switch_1",
            index=i,
            response=make_response(value if i % 2 else "pile_2", latency=latency + i, xy=xy if i % 2 else (0.8, 0.2)),
        )
        for i in range(n)
    ]


def test_clean_session_is_usable() -> None:
    q = assess_session(make_session(choice_trials(20)), PARAMS)
    assert q.grade == "usable" and q.flags == ()
    assert q.valid_for_report and q.valid_for_validation


def test_fast_run_flag() -> None:
    trials = [make_trial("go", index=i, response=make_response("serve", latency=90.0)) for i in range(6)]
    q = assess_session(make_session(trials), PARAMS)
    assert "careless_fast_runs" in q.flags and q.grade == "exclude"
    trials = [make_trial("go", index=i, response=make_response("serve", latency=400.0 + i)) for i in range(6)]
    assert "careless_fast_runs" not in assess_session(make_session(trials), PARAMS).flags
    mixed = [
        make_trial("go", index=i, response=make_response("serve", latency=90.0 if i % 3 == 0 else 400.0))
        for i in range(12)
    ]
    q_mixed = assess_session(make_session(mixed), PARAMS)
    assert q_mixed.details["fast_run_longest"] == 1 and "careless_fast_runs" in q_mixed.flags  # share >= 30 %


def test_same_position_flag() -> None:
    same = [
        make_trial("sort", index=i, response=make_response("pile_1", latency=800.0 + i, xy=(0.21, 0.81)))
        for i in range(12)
    ]
    q = assess_session(make_session(same), PARAMS)
    assert "careless_same_position" in q.flags
    assert "careless_same_position" not in assess_session(make_session(choice_trials(12)), PARAMS).flags


def test_zero_variance_flag() -> None:
    trials = [
        make_trial(
            "round",
            module="share_pot",
            index=i,
            response=make_response("contribute", latency=1000.0 + 3 * i),
            contributions=[{"contributed_tokens": 10, "endowment_tokens": 10}],
        )
        for i in range(8)
    ]
    q = assess_session(make_session(trials), PARAMS)
    assert "careless_zero_variance" in q.flags and q.grade == "caution"


def test_private_reports_never_flag_individuals() -> None:
    trials = [
        make_trial(
            "report",
            module="private_dice",
            index=i,
            reports=[{"reported_value": 6}],
            response=make_response("six", latency=900.0, xy=(0.5, 0.5)),
        )
        for i in range(12)
    ]
    q = assess_session(make_session(trials), PARAMS)
    assert not any(f.startswith("careless") for f in q.flags)


def test_device_and_integrity_flags() -> None:
    trials = choice_trials(20)
    for t in trials[:6]:
        t.timing_flag = "frame_drop"
    s = dataclasses.replace(
        make_session(trials), timing_profile="uncertified-dev", seq_gaps=(5,), onlooker_reports=1, walkaway_prompts=2
    )
    q = assess_session(s, PARAMS)
    assert {"device_timing_exclude", "device_uncertified_timing", "seq_gap", "possible_assistance", "walkaway"} <= set(
        q.flags
    )
    assert q.grade == "exclude" and not q.valid_for_report


@pytest.mark.parametrize("strategy", ["speed_tapper", "same_position", "always_share"])
def test_gaming_bots_are_flagged(strategy: str) -> None:
    study = simulate_study(20, "B", seed=9, strategies={strategy: 20}, slot_form="four_stalls")  # type: ignore[dict-item]
    sessions = canonicalise(study.events, study.trial_params)
    flagged = sum(1 for s in sessions if assess_session(s, PARAMS).flags)
    assert flagged / len(sessions) >= 0.95


def test_differential_exclusion_warning() -> None:
    sessions = [make_session(choice_trials(20)) for _ in range(2)]
    q_ok = assess_session(sessions[0], PARAMS)
    q_bad = dataclasses.replace(q_ok, grade="exclude")
    quals = []
    groups = {}
    for i in range(100):
        sid = f"s{i}"
        lang = "hi-IN" if i < 50 else "ta-IN"
        quals.append(dataclasses.replace(q_bad if (lang == "ta-IN" and i % 5 == 0) else q_ok, session_id=sid))
        groups[sid] = {"language": lang}
    res = differential_exclusion(quals, groups, ["language"], threshold_pp=5.0, min_cell_n=30)
    assert res[0].warning and res[0].max_difference_pp == pytest.approx(20.0)


def test_exclusion_rules_trigger_and_not() -> None:
    s = make_session([])
    ctx = ExclusionContext(session=s, quality_grade="usable")
    rules = DICT.exclusion_rules
    fast = make_trial("go", response=make_response("serve", latency=100.0))
    slow = make_trial("go", response=make_response("serve", latency=400.0))
    assert evaluate_rule(rules["anticipatory_response"], fast, ctx)
    assert not evaluate_rule(rules["anticipatory_response"], slow, ctx)
    to = make_trial("go", response=make_response(None, latency=None))
    assert evaluate_rule(rules["timeout_latency"], to, ctx) and not evaluate_rule(rules["timeout_latency"], slow, ctx)
    pr = make_trial("practice", phase="practice")
    pr.scorable = False
    assert evaluate_rule(rules["not_scorable"], pr, ctx) and not evaluate_rule(rules["not_scorable"], slow, ctx)
    glitch = make_trial("go", response=make_response("serve", latency=400.0))
    glitch.timing_flag = "frame_drop"
    assert evaluate_rule(rules["timing_flagged"], glitch, ctx) and not evaluate_rule(rules["timing_flagged"], slow, ctx)
    assert evaluate_rule(
        rules["synthetic_session"], None, ExclusionContext(dataclasses.replace(s, synthetic=True), "usable")
    )
    assert evaluate_rule(rules["session_quality_exclude"], None, ExclusionContext(s, "exclude"))
    assert evaluate_rule(
        rules["level_not_fixed_l2"], None, ExclusionContext(dataclasses.replace(s, calibration_level="L1"), "usable")
    )
    opt = make_trial(
        "optional_opportunity",
        response=make_response("take", t=5000.0),
        params={"mentioning_lines": ["hint"]},
        prompt_ends=[("hint", 4000.0)],
    )
    assert ms_since_mentioning_prompt(opt) == pytest.approx(1000.0)
    assert evaluate_rule(rules["prompted_optional_action"], opt, ctx)


def test_latency_only_rules_mask_instead_of_drop() -> None:
    s = make_session([])
    ctx = ExclusionContext(session=s, quality_grade="usable")
    trials = [
        make_trial("nogo", response=make_response(None, latency=None)),
        make_trial("go", response=make_response("serve", latency=420.0)),
    ]
    out = apply_exclusions(trials, ["timeout_latency"], DICT.exclusion_rules, ctx, frozenset({"timeout_latency"}))
    assert len(out.kept) == 2
    assert out.kept[0].latency_valid is False and out.kept[1].latency_valid is True
    dropped = apply_exclusions(trials, ["timeout_latency"], DICT.exclusion_rules, ctx)
    assert len(dropped.kept) == 1
