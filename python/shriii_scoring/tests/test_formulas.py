"""Every session formula against hand-computed fixtures (SCR-02 AC)."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pytest
from shriii_scoring.canonical import ContextShift, Hold, Trial
from shriii_scoring.dictionary import load_dictionary
from shriii_scoring.formulas import REGISTRY, MissingTrialParamsError
from shriii_scoring.formulas.base import BatchContext, BatchUnit, IndicatorValue
from shriii_scoring.params import load_params
from shriii_scoring.testing import make_context, make_response, make_session, make_tap, make_trial


def run(
    ref: str,
    indicator: str,
    trials: list[Trial],
    *,
    pathway: str = "B",
    shifts: dict[str, list[ContextShift]] | None = None,
    game_configs: dict[str, Any] | None = None,
) -> IndicatorValue:
    session = make_session(trials, shifts=shifts)
    ctx = make_context(indicator, session, pathway=pathway, game_configs=game_configs)
    result: IndicatorValue = REGISTRY[ref].fn(trials, ctx)
    return result


def shift(kind: str, index: int) -> ContextShift:
    return ContextShift(seq=0, t_ms=0.0, kind=kind, announced=False, shift_index=index, trial_id=None)


# ---------------------------------------------------------------- go / no-go


def gng(
    tt: str, responded: bool, *, phase: str = "main", index: int = 0, rt: float = 400.0, feedback: str = "none"
) -> Trial:
    correct = responded if tt == "go" else not responded
    resp = make_response("serve" if responded else None, latency=rt if responded else None, correct=correct)
    return make_trial(
        tt, module="dont_tap", phase=phase, index=index, response=resp, params={"feedback": feedback}, window=540
    )


def test_commission_rate_counts_nogo_responses() -> None:
    trials = [gng("nogo", True), gng("nogo", False), gng("nogo", False), gng("nogo", True), gng("go", True)]
    v = run("gng.commission_rate", "self_control.nogo_commission_rate", trials)
    assert v.value == pytest.approx(0.5)
    assert v.n_valid == 4
    assert v.details == {"k": 2, "n": 4}


def test_error_type_shift() -> None:
    off = [gng("nogo", True, phase="main"), gng("go", False, phase="main"), gng("go", False, phase="main")]
    on = [gng("nogo", True, phase="pressure"), gng("nogo", True, phase="pressure"), gng("go", False, phase="pressure")]
    v = run("gng.error_type_shift", "composure.error_type_shift", off + on)
    # off: 1 commission of 3 errors -> 1.5/4; on: 2 of 3 -> 2.5/4
    assert v.value == pytest.approx(2.5 / 4 - 1.5 / 4)


def test_post_feedback_recovery() -> None:
    trials = [
        gng("go", True, index=0, feedback="negative"),
        gng("go", False, index=1),
        gng("go", False, index=2),
        gng("go", True, index=3),
        gng("go", True, index=4),
        gng("go", True, index=5),
    ]
    v = run("gng.post_feedback_recovery", "emotional_regulation.recovery_after_feedback", trials, pathway="A")
    assert v.n_valid == 1
    assert v.value == pytest.approx(1 / 3 - 4 / 6)


def test_ez_drift_has_se_and_boundary() -> None:
    rng = np.random.default_rng(1)
    trials = [gng("go", True, index=i, rt=float(rng.normal(420, 60))) for i in range(50)]
    trials += [gng("nogo", i % 4 == 0, index=50 + i) for i in range(20)]
    v = run("ezdiffusion.drift_nogo", "self_control.ezd_drift_nogo", trials)
    assert v.value is not None and v.value > 0
    assert v.se is not None and v.se > 0
    assert "boundary" in v.details


def test_taps_premature_and_extra() -> None:
    trials = [
        make_trial("go", taps=[make_tap("premature"), make_tap("on_target", offset=100.0), make_tap("extra")]),
        make_trial("go", taps=[make_tap("on_target", offset=420.0), make_tap("multi_touch_interference")]),
    ]
    pre = run("taps.premature_rate", "expressive_restraint.premature_taps", trials)
    extra = run("taps.extra_rate", "expressive_restraint.extra_taps", trials)
    assert pre.value == pytest.approx(1.0)  # 2 premature taps (class + <150 ms on-target) over 2 trials
    assert extra.value == pytest.approx(0.5)


# ---------------------------------------------------------------- BART


def balloon(pumps: int, exploded: bool, index: int) -> Trial:
    ev = [
        {"pump_index": k, "exploded": exploded and k == pumps, "collected": False, "_t_ms": 1000.0 + 300 * k}
        for k in range(1, pumps + 1)
    ]
    if not exploded:
        ev.append({"pump_index": pumps, "exploded": False, "collected": True, "_t_ms": 1000.0 + 300 * pumps + 700})
    return make_trial(
        "balloon",
        module="balloon",
        block="balloons",
        index=index,
        pumps=ev,
        params={"risk_colour": "low_risk", "explosion_point": 99, "max_pumps": 32},
        onset=900.0,
    )


def test_bart_adjusted_pumps_and_explosion_rate() -> None:
    # Lejuez et al. (2002) adjusted average pumps: mean pumps on unexploded balloons only.
    trials = [balloon(5, False, 0), balloon(8, True, 1), balloon(7, False, 2), balloon(3, False, 3)]
    adj = run("balloon.adjusted_pumps", "risk_preference.adjusted_pumps", trials)
    rate = run("balloon.explosion_rate", "risk_preference.explosion_rate", trials)
    assert adj.value == pytest.approx(5.0)
    assert adj.n_valid == 3
    assert rate.value == pytest.approx(0.25)
    collect = run("balloon.time_to_collect", "decisiveness.time_to_collect", trials)
    assert collect.value == pytest.approx(700.0)
    post = run("balloon.post_loss_adjustment", "persistence_of_style.post_loss_adjustment", trials)
    assert post.value == pytest.approx(abs(7 - 5) / 5)


# ---------------------------------------------------------------- Tower


def tower(
    tt: str,
    legal: int,
    illegal: int,
    *,
    index: int,
    min_moves: int | None,
    solved: bool = True,
    first_move: float = 3000.0,
    skip_at: float | None = None,
) -> Trial:
    moves = [{"legal": True, "_t_ms": first_move + i * 1000} for i in range(legal)]
    moves += [{"legal": False, "_t_ms": first_move + 500} for _ in range(illegal)]
    params = {"problem_id": f"p{index}", "skip_icon_ms": 15000.0}
    if min_moves is not None:
        params["min_moves"] = min_moves
    else:
        params["cap_ms"] = 24000.0
    resp = make_response("skip", latency=skip_at, t=skip_at) if skip_at is not None else None
    end = skip_at if skip_at is not None else first_move + legal * 1000.0
    return make_trial(
        tt,
        module="tower",
        block="problems",
        index=index,
        moves=moves,
        params=params,
        onset=0.0,
        end=end,
        outcome="correct" if solved and tt == "solvable" else "not_applicable",
        response=resp,
    )


def test_tower_optimal_bot_scores_zero_excess() -> None:
    trials = [tower("solvable", m, 0, index=i, min_moves=m) for i, m in enumerate([2, 3, 4, 5])]
    assert run("tower.excess_moves", "problem_solving.excess_moves", trials).value == 0.0


def test_tower_indicators() -> None:
    trials = [
        tower("solvable", 4, 1, index=0, min_moves=2, first_move=2000.0),
        tower("unsolvable", 3, 0, index=1, min_moves=None, skip_at=15500.0),
        tower("solvable", 6, 0, index=2, min_moves=3, first_move=4000.0),
        tower("unsolvable", 5, 0, index=3, min_moves=None, skip_at=21000.0),
        tower("solvable", 4, 0, index=4, min_moves=4, first_move=3000.0),
        tower("solvable", 5, 0, index=5, min_moves=5, first_move=5000.0),
    ]
    solv = [t for t in trials if t.trial_type == "solvable"]
    uns = [t for t in trials if t.trial_type == "unsolvable"]
    assert run("tower.excess_moves", "problem_solving.excess_moves", solv).value == pytest.approx(2 + 3)
    assert run("tower.planning_time", "problem_solving.planning_time", solv).value == pytest.approx(3500.0)
    assert run("tower.illegal_move_rate", "task_organisation.illegal_move_attempts", solv).value == pytest.approx(0.25)
    rec = run("tower.recovery_after_failure", "problem_solving.recovery_after_failure", trials)
    # post-failure problems: index 2 (3/6 = .5) and 4 (4/4 = 1) -> .75; baseline: 0 (2/4) and 5 (1) -> .75
    assert rec.value == pytest.approx(0.0)
    assert rec.n_valid == 2
    tou = run("tower.time_on_unsolvable", "persistence.time_on_unsolvable", uns)
    assert tou.value == pytest.approx((15.5 + 21.0) / 2)
    gu = run("tower.give_up_rate", "persistence.give_up", uns)
    assert gu.value == pytest.approx(0.5)  # 15.5 s is within 2 s of the 15 s skip icon; 21 s is not


def test_tower_missing_solver_output_fails_fast() -> None:
    t = tower("solvable", 3, 0, index=0, min_moves=None)
    t.params = {"problem_id": "p0", "skip_icon_ms": 15000.0}
    with pytest.raises(MissingTrialParamsError):
        run("tower.excess_moves", "problem_solving.excess_moves", [t])


# ---------------------------------------------------------------- Road Home


def errand_map(
    order: list[str], costs: list[int], *, revisit_after: int | None = None, gaps: list[float] | None = None
) -> Trial:
    steps = []
    nodes = ["home"]
    t = 2000.0
    for i, (e, c) in enumerate(zip(order, costs, strict=True)):
        t += (gaps or [1000.0] * len(order))[i]
        to = f"node_{e}"
        steps.append(
            {
                "step_index": i,
                "from_node": nodes[-1],
                "to_node": to,
                "cost_units": c,
                "blocked": False,
                "errand_completed": e,
                "_t_ms": t,
            }
        )
        nodes.append(to)
        if revisit_after == i:
            t += 1000.0
            steps.append(
                {
                    "step_index": i + 100,
                    "from_node": to,
                    "to_node": "home",
                    "cost_units": 1,
                    "blocked": False,
                    "errand_completed": None,
                    "_t_ms": t,
                }
            )
            nodes.append("home")
    params = {
        "map_id": "m1",
        "optimal_order": ["a", "b", "c", "d"],
        "optimal_cost": 10,
        "optimal_fuel": 10,
        "n_errands": 4,
    }
    return make_trial(
        "errand_map",
        module="road_home",
        block="errand_maps",
        route_steps=steps,
        params=params,
        onset=0.0,
        end=t + 500.0,
    )


def test_errand_indicators() -> None:
    m = errand_map(["a", "c", "b", "d"], [3, 3, 2, 2], revisit_after=0, gaps=[1000.0, 4000.0, 1000.0, 1000.0])
    eff = run("errands.order_edit_distance", "task_organisation.errand_order_efficiency", [m], pathway="A")
    assert eff.value == pytest.approx(1 - 2 / 4)
    rev = run("errands.revisits", "task_organisation.revisits", [m], pathway="A")
    assert rev.value == 1.0
    cfg = {"road_home": {"constraints": {"idle_gap_log_ms": 3000}}}
    idle = run("errands.idle_proportion", "task_organisation.idle_time", [m], pathway="A", game_configs=cfg)
    times = [s["_t_ms"] for s in m.route_steps]
    span = (m.end_ms or 0) - times[0]
    assert idle.value == pytest.approx(4000.0 / span)
    fuel = run("errands.fuel_efficiency", "task_organisation.resource_allocation_efficiency", [m], pathway="A")
    assert fuel.value == pytest.approx((4 / 11) / (4 / 10))
    cost = run("route.excess_cost", "problem_solving.excess_route_cost", [m], pathway="A")
    assert cost.value == pytest.approx(0.1)
    plan = run("route.planning_time", "initiative.route_planning_time", [m], pathway="A")
    assert plan.value == pytest.approx(3000.0)


def test_blocked_route_indicators() -> None:
    steps = [
        {"step_index": 0, "blocked": True, "cost_units": 0, "_t_ms": 2500.0},
        {"step_index": 1, "blocked": True, "cost_units": 0, "_t_ms": 4000.0},
        {"step_index": 2, "blocked": False, "cost_units": 4, "_t_ms": 5000.0},
        {"step_index": 3, "blocked": False, "cost_units": 3, "_t_ms": 6000.0},
    ]
    t = make_trial(
        "blocked_route",
        module="road_home",
        block="blocked_road",
        route_steps=steps,
        params={"map_id": "b", "post_block_optimal_cost": 6},
        onset=0.0,
        end=7000.0,
    )
    assert run("route.replan_quality", "problem_solving.replan_quality", [t], pathway="A").value == pytest.approx(
        1 - 1 / 6
    )
    assert run("route.replan_latency", "problem_solving.replan_latency", [t], pathway="A").value == pytest.approx(
        2500.0
    )
    assert run("route.retries_after_block", "persistence.retries_on_blocked_route", [t], pathway="A").value == 2.0


def test_optional_unprompted() -> None:
    trials = [
        make_trial("optional_opportunity", response=make_response("take"), params={"mentioning_lines": []}),
        make_trial("optional_opportunity", response=make_response(None, latency=None), params={"mentioning_lines": []}),
    ]
    v = run("optional.unprompted_rate", "initiative.optional_actions_unprompted", trials, pathway="A")
    assert v.value == pytest.approx(0.5)


# ---------------------------------------------------------------- flexibility


def sort_trial(index: int, choice: str, rule: str, prev: str | None, post: bool, *, ordinal: int = 1) -> Trial:
    matches = {"colour_pattern": "pile_1", "shape": "pile_2", "count": "pile_3"}
    return make_trial(
        "sort",
        module="card_sort",
        block="switch_1" if post else "initial_rule",
        index=index,
        response=make_response(choice, correct=choice == matches[rule]),
        params={"rule": rule, "previous_rule": prev, "matches": matches},
        shift_kind="rule_switch" if post else None,
        shift_ordinal=ordinal if post else 0,
        since_shift=index - 3 if post else None,
        phase="shift_post" if post else "shift_pre",
    )


def test_card_sort_perseveration_and_reacquisition() -> None:
    trials = [sort_trial(i, "pile_1", "colour_pattern", None, False) for i in range(3)]
    post_choices = ["pile_1", "pile_1", "pile_3", "pile_2", "pile_2", "pile_2", "pile_2"]
    trials += [sort_trial(3 + i, c, "shape", "colour_pattern", True) for i, c in enumerate(post_choices)]
    shifts = {"card_sort": [shift("rule_switch", 3)]}
    pers = run("card_sort.perseverative_error_rate", "adaptability.perseverative_errors", trials, shifts=shifts)
    assert pers.value == pytest.approx(2 / 7)
    reacq = run("card_sort.trials_to_reacquire", "adaptability.trials_to_reacquire", trials, shifts=shifts)
    assert reacq.value == pytest.approx(6.0)  # third consecutive correct at post-switch position 6


def test_missing_context_shift_is_an_error_status() -> None:
    trials = [sort_trial(3 + i, "pile_2", "shape", "colour_pattern", True) for i in range(5)]
    v = run("card_sort.perseverative_error_rate", "adaptability.perseverative_errors", trials)
    assert v.status == "missing_context_shift"
    assert v.value is None


def test_reversal_and_rule_compliance() -> None:
    forks = [
        make_trial(
            "fork_choice",
            module="road_home",
            block="reversal",
            index=10 + i,
            response=make_response(c),
            params={"rule_option": "right", "old_rule_option": "left"},
            shift_kind="rule_reversal",
            shift_ordinal=1,
            since_shift=i,
        )
        for i, c in enumerate(["left", "left", "right", "right", "right", "left"])
    ]
    shifts = {"road_home": [shift("rule_reversal", 10)]}
    err = run(
        "reversal.perseverative_error_rate", "adaptability.post_reversal_errors", forks, pathway="A", shifts=shifts
    )
    assert err.value == pytest.approx(3 / 6)
    re = run(
        "reversal.trials_to_reacquire", "adaptability.reversal_trials_to_reacquire", forks, pathway="A", shifts=shifts
    )
    assert re.value == pytest.approx(5.0)
    decisions = [
        make_trial(
            "weigh_decision",
            module="weighing_post",
            block="decisions_post",
            index=i,
            response=make_response(c),
            params={"compliant_responses": ["fine"], "required_inspections": 0},
            shift_kind="new_market_rule",
            shift_ordinal=1,
            since_shift=i,
        )
        for i, c in enumerate(["fine", "warn", "fine", "fine"])
    ]
    comp = run(
        "rule.compliance_post_shift",
        "adaptability.rule_compliance_post_shift",
        decisions,
        pathway="A",
        shifts={"weighing_post": [shift("new_market_rule", 0)]},
    )
    assert comp.value == pytest.approx(0.75)


# ---------------------------------------------------------------- decisiveness


def test_decision_indicators() -> None:
    trials = [
        make_trial(
            "weigh_decision",
            response=make_response("fine", latency=1000.0, revisions=["warn"]),
            params={"required_inspections": 1, "compliant_responses": ["fine"]},
            taps=[make_tap("on_target", target="weighing.inspect_more")] * 3,
        ),
        make_trial(
            "weigh_decision",
            response=make_response("warn", latency=3000.0),
            params={"required_inspections": 0, "compliant_responses": ["warn"]},
        ),
    ]
    assert run("choice.time_to_commit", "decisiveness.time_to_commit", trials, pathway="A").value == pytest.approx(
        2000.0
    )
    assert (
        run("choice.revisions_per_decision", "decisiveness.reversals_before_confirm", trials, pathway="A").value == 0.5
    )
    assert run("choice.inspect_more_rate", "decisiveness.info_gathered", trials, pathway="A").value == pytest.approx(
        1.0
    )


# ---------------------------------------------------------------- social


def round_trial(index: int, share: float, partner: str, *, error: bool = False, unprompted: bool = False) -> Trial:
    return make_trial(
        "round",
        module="share_pot",
        block="rounds",
        index=index,
        partner_type=partner,
        contributions=[{"endowment_tokens": 10, "contributed_tokens": int(share * 10), "unprompted": unprompted}],
        partner_actions=[{"partner_type": partner, "is_error": error}],
        response=make_response("contribute", revisions=["tokens_3"] if index == 0 else []),
    )


def test_public_goods_indicators() -> None:
    trials = [
        round_trial(0, 0.8, "cooperative", unprompted=True),
        round_trial(1, 0.8, "free_rider"),
        round_trial(2, 0.4, "cooperative"),
        round_trial(3, 0.8, "error_prone", error=True),
        round_trial(4, 0.6, "cooperative", unprompted=True),
    ]
    mean = run("public_goods.mean_contribution", "teamwork.mean_contribution", trials)
    assert mean.value == pytest.approx((0.8 + 0.8 + 0.4 + 0.8 + 0.6) / 5)
    post = run("public_goods.post_defection_maintenance", "teamwork.response_to_partner_defection", trials)
    c = load_params().f("public_goods.ratio_smoothing")
    others = np.mean([0.8, 0.8, 0.8, 0.6])
    assert post.value == pytest.approx((0.4 + c) / (others + c))
    err = run("public_goods.post_error_contribution", "teamwork.response_to_partner_error", trials)
    assert err.value == pytest.approx(0.6 - np.mean([0.8, 0.8, 0.4, 0.8]))
    unp = run("public_goods.unprompted_share_rate", "initiative.unprompted_share", trials)
    assert unp.value == pytest.approx(0.4)


def test_coplay_and_credit() -> None:
    turns = [
        make_trial(
            "turn",
            module="coplay",
            block="turns",
            index=i,
            turns=[
                {"kind": "turn_start", "player_slot": 2},
                {"kind": "interruption" if i == 0 else "wait", "player_slot": 1},
            ],
        )
        for i in range(4)
    ]
    assert run("coplay.turn_waiting_rate", "teamwork.turn_waiting", turns, pathway="A").value == pytest.approx(0.75)
    assert run("coplay.interruption_rate", "teamwork.interruptions", turns, pathway="A").value == pytest.approx(0.25)
    credit = [
        make_trial(
            "credit_round",
            module="coplay",
            block="credit_round",
            credit=[{"allocation_context": "coplay_outcome", "self_share": s}],
        )
        for s in (0.25, 0.75)
    ]
    assert run("coplay.credit_share", "teamwork.coplay_credit_share", credit, pathway="A").value == pytest.approx(0.5)
    fraud = [
        make_trial("fraud_found", credit=[{"allocation_context": "fraud_found", "self_share": s}])
        for s in (1.0, 0.5, 0.5)
    ]
    blame = [
        make_trial(
            "assistant_mistake",
            credit=[
                {"allocation_context": "assistant_mistake", "target": t, "self_share": 1.0 if t == "self" else 0.0}
            ],
        )
        for t in ("self", "assistant", "chance")
    ]
    assert run("credit.self_share_success", "judgement.credit_taking", fraud, pathway="A").value == pytest.approx(2 / 3)
    assert run("credit.blame_shift_failure", "judgement.blame_shifting", blame, pathway="A").value == pytest.approx(
        2 / 3
    )
    cons = run("credit.cross_dilemma_consistency", "judgement.consistency_across_dilemmas", fraud + blame, pathway="A")
    vals = [0.0, 0.5, 0.5, 1.0, 0.0, 0.0]
    assert cons.value == pytest.approx(1 - 2 * float(np.std(vals)))


def test_dilemma_rates_and_tone() -> None:
    bribes = [make_trial("bribe", response=make_response(c)) for c in ("accept", "decline", "decline")]
    assert run(
        "dilemma.bribe_acceptance_rate", "integrity.bribe_acceptance", bribes, pathway="A"
    ).value == pytest.approx(1 / 3)
    tones = [
        make_trial(
            "tone_choice",
            module="stall",
            block="rude_run",
            tone_level=lvl,
            response=make_response(c),
            shift_kind="rude_customer_run",
            since_shift=i,
        )
        for i, (lvl, c) in enumerate([(4, "firm"), (3, "warm"), (2, "warm")])
    ]
    prov = run("tone.after_provocation", "emotional_regulation.tone_after_provocation", tones, pathway="A")
    assert prov.value == pytest.approx(1.0)  # levels >= 3: firm (0) and warm (2)
    single = run("tone.after_unfair_loss", "emotional_regulation.tone_after_unfair_loss_b", tones[:1])
    assert single.value == 0.0


# ---------------------------------------------------------------- style


def test_choice_entropy_and_high_variance_share() -> None:
    trials = [
        make_trial(
            "choice",
            index=i,
            response=make_response(c),
            params={"repeat_group_id": g, "high_variance_stalls": ["stall_c", "stall_d"]},
        )
        for i, (g, c) in enumerate(
            [
                ("g1", "stall_a"),
                ("g1", "stall_a"),
                ("g2", "stall_a"),
                ("g2", "stall_c"),
                (None, "stall_c"),
                (None, "stall_d"),
            ]
        )
    ]
    ent = run("style.choice_entropy_repeats", "response_consistency.choice_entropy_repeats", trials)
    assert ent.value == pytest.approx(0.5)  # g1: 0 bits, g2: 1 bit
    hv = run("igt.high_variance_share", "risk_preference.high_variance_stall_share", trials)
    assert hv.value == pytest.approx(1.0)


def test_rvi_rt_unaffected_by_linear_fatigue() -> None:
    rng = np.random.default_rng(0)
    noise = rng.normal(0, 40, 40)
    flat = [gng("go", True, index=i, rt=400 + noise[i]) for i in range(40)]
    drift = [gng("go", True, index=i, rt=400 + noise[i] + 3.0 * (i - 20)) for i in range(40)]
    a = run("style.rvi_rt", "response_consistency.rt_rvi", flat).value
    b = run("style.rvi_rt", "response_consistency.rt_rvi", drift).value
    assert a is not None and b is not None
    assert b == pytest.approx(a, rel=0.05)


def test_lag1_needs_segments() -> None:
    probes = [
        make_trial(
            "probe",
            module=m,
            block="probe",
            index=i,
            probe_group=f"{m}.probe",
            response=make_response("safe", latency=1000.0 + 50 * ((i % 2) * 2 - 1)),
        )
        for m in ("dont_tap", "card_sort", "balloon", "tower")
        for i in range(4)
    ]
    v = run("style.lag1_autocorrelation", "persistence_of_style.lag1_autocorr", probes)
    assert v.n_valid == 4
    assert v.value is not None and v.value < 0


def test_group_dice_estimators_have_no_individual_key() -> None:
    d = load_dictionary("B")
    spec = d.indicators["integrity.dice_overreport_rate"]
    units = []
    for k in range(40):
        trials = [
            make_trial(
                "report", module="private_dice", block="reports", index=i, reports=[{"reported_value": (i + k) % 6 + 1}]
            )
            for i in range(6)
        ]
        units.append(BatchUnit(make_session(trials), trials))
    ctx = BatchContext(
        spec=spec, dictionary=d, params=load_params(), game_configs={}, anticipatory_ms=150.0, partition={}, cache={}
    )
    gv = REGISTRY["group.dice_overreport_rate"].fn(units, ctx)
    assert gv.estimate == pytest.approx(0.0, abs=1e-12)  # exactly uniform reports -> no over-reporting
    assert not hasattr(gv, "session_id")
    skew = REGISTRY["group.dice_distribution_skew"].fn(units, ctx)
    assert skew.estimate == pytest.approx(0.0, abs=1e-12)


def test_effort_completion_counts_chosen_holds() -> None:
    hold_ok = Hold(seq=0, t_ms=0.0, target_id="pad", hold_ms=2600.0, required_hold_ms=2500.0, completed=True)
    hold_bad = Hold(seq=0, t_ms=0.0, target_id="pad", hold_ms=900.0, required_hold_ms=2500.0, completed=False)
    trials = [
        make_trial("effort_choice", response=make_response("hard"), holds=[hold_ok]),
        make_trial("effort_choice", response=make_response("hard"), holds=[hold_bad]),
        make_trial("effort_choice", response=make_response("easy")),
    ]
    v = run("effort.completion_rate", "persistence.effort_completion_rate", trials)
    assert v.value == pytest.approx(0.5)
    assert v.n_valid == 2


def test_every_dictionary_formula_is_registered() -> None:
    refs = {i.formula_ref for p in ("A", "B") for i in load_dictionary(p).indicators.values()}
    assert refs <= set(REGISTRY)
    assert all(REGISTRY[r].doc for r in refs)
    assert math.isfinite(len(refs))


def test_group_dice_estimators_suppress_small_groups() -> None:
    """A group estimate over fewer than min_group_participants would describe identifiable people."""
    d = load_dictionary("B")
    spec = d.indicators["integrity.dice_overreport_rate"]
    params = load_params()
    min_group = params.i("private_report.min_group_participants")
    units = []
    for _ in range(min_group - 1):
        trials = [
            make_trial("report", module="private_dice", block="reports", index=i, reports=[{"reported_value": 6}])
            for i in range(6)
        ]
        units.append(BatchUnit(make_session(trials), trials))
    ctx = BatchContext(
        spec=spec, dictionary=d, params=params, game_configs={}, anticipatory_ms=150.0, partition={}, cache={}
    )
    for ref in ("group.dice_overreport_rate", "group.dice_distribution_skew"):
        gv = REGISTRY[ref].fn(units, ctx)
        assert gv.estimate is None and gv.ci_low is None and gv.ci_high is None
        assert gv.details["suppressed_small_group"] is True
        assert gv.n_participants == min_group - 1
