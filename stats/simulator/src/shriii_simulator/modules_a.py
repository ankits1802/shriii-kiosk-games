"""Pathway A episode generators (block structure from ``content/games/pathway-a``)."""

from __future__ import annotations

import math

import numpy as np

from shriii_simulator.builder import SessionWriter
from shriii_simulator.common import (
    Occasion,
    contribution_round,
    gng_trial,
    hold,
    jitter,
    option_xy,
    probe_block,
    scaled,
    sigmoid,
    tone_choice,
)
from shriii_simulator.params import SimParams
from shriii_simulator.population import Person

__all__ = ["A_MODULES"]


def _probe(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, style: np.ndarray, module: str
) -> None:
    probe_block(
        w,
        p,
        rng,
        prm,
        style,
        module_id=module,
        groups=[(f"{module}.probe_1", 2), (f"{module}.probe_2", 2)],
        episode=True,
    )


def stall(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
) -> None:
    g = "gng."
    w.module_start("stall", "episode", ["go_nogo", "tone_choice", "timed_rush"], episode=True)
    for i in range(2):
        gng_trial(
            w,
            p,
            rng,
            prm,
            occ,
            module_id="stall",
            block="practice",
            trial_type="go" if i == 0 else "nogo",
            phase="practice",
            condition_id="standard",
            window_ms=1300,
            isi_ms=600,
            pressure=False,
            episode=True,
        )
    service = ["nogo"] * scaled(prm, "stall.service_nogo") + ["go"] * scaled(prm, "stall.service_go")
    service = [str(x) for x in rng.permutation(service)]
    feedback_positions = {1, 4, 7, 10, 13, 16}
    drop = prm.f(g + "feedback_drop_logit") - prm.f(g + "feedback_drop_regulation") * p.z("emotional_regulation")
    since_feedback = 99
    for pos, tt in enumerate(service):
        lapse = max(0.0, drop) if since_feedback <= 3 else 0.0
        gng_trial(
            w,
            p,
            rng,
            prm,
            occ,
            module_id="stall",
            block="service",
            trial_type=tt,
            phase="main",
            condition_id="standard",
            window_ms=1300,
            isi_ms=600,
            pressure=False,
            episode=True,
            feedback="negative" if pos in feedback_positions else "none",
            accuracy_drop=lapse,
        )
        since_feedback = 1 if pos in feedback_positions else since_feedback + 1
    for level in rng.permutation([0, 0, 1, 1, 1, 2, 2, 2]):
        tone_choice(
            w,
            p,
            rng,
            prm,
            module_id="stall",
            block="tone_calm",
            phase="main",
            condition_id="calm_customers",
            level=int(level),
            run_position=None,
            episode=True,
        )
    rush_types = ["nogo"] * scaled(prm, "stall.rush_nogo") + ["go"] * scaled(prm, "stall.rush_go")
    rush = [str(x) for x in rng.permutation(rush_types)]
    for tt in rush:
        gng_trial(
            w,
            p,
            rng,
            prm,
            occ,
            module_id="stall",
            block="timed_rush",
            trial_type=tt,
            phase="pressure",
            condition_id="timed_rush",
            window_ms=1000,
            isi_ms=600,
            pressure=True,
            episode=True,
        )
    w.context_shift("stall", "rude_customer_run", False, w.trial_counters["stall"], episode=True)
    for k, level in enumerate(rng.permutation([3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4])):
        tone_choice(
            w,
            p,
            rng,
            prm,
            module_id="stall",
            block="rude_run",
            phase="shift_post",
            condition_id="rude_run",
            level=int(level),
            run_position=k,
            episode=True,
            shift_active=True,
        )
    _probe(w, p, rng, prm, style=style, module="stall")
    w.module_end("stall", episode=True)


def weighing_post(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
) -> None:
    c = "weighing."
    w.module_start(
        "weighing_post", "episode", ["weighing_decision", "dilemma", "private_report", "rule_change"], episode=True
    )
    z_dec = p.z("decisiveness")

    def decision(block: str, phase: str, new_rule: bool) -> None:
        correct_code = str(rng.choice(["approve", "warn", "fine"]))
        compliant = ["fine"] if new_rule and correct_code != "approve" else [correct_code]
        required = int(rng.integers(0, 2))
        cond = w.condition(phase, "new_rule" if new_rule else "standard", shift_active=new_rule)
        h = w.start_trial(
            "weighing_post",
            block,
            "weigh_decision",
            cond,
            params={"required_inspections": required, "compliant_responses": compliant},
            response_window_ms=8000,
            episode=True,
            audio_prompt="weighing.weight_spoken",
            audio_ms=1500,
        )
        extra = int(rng.poisson(prm.f(c + "inspect_extra_rate") * math.exp(-prm.f(c + "inspect_decisiveness") * z_dec)))
        for _ in range(required + extra):
            w.advance(float(rng.uniform(500, 1200)))
            w.tap(h, "on_target", target_id="weighing.inspect_more", xy=jitter(rng, (0.85, 0.3)))
        if new_rule:
            p_ok = sigmoid(
                prm.f(c + "compliance_logit")
                + prm.f(c + "compliance_adaptability") * p.z("adaptability")
                + prm.f(c + "compliance_stability") * p.z("stability")
            )
            code = (
                compliant[0]
                if rng.random() < p_ok
                else str(rng.choice([x for x in ("approve", "warn", "fine") if x not in compliant]))
            )
        else:
            p_ok = sigmoid(prm.f(c + "accuracy_logit") + 0.5 * p.ability)
            code = (
                correct_code
                if rng.random() < p_ok
                else str(rng.choice([x for x in ("approve", "warn", "fine") if x != correct_code]))
            )
        if p.strategy == "same_position":
            code = "approve"
        lat = float(
            rng.lognormal(
                math.log(prm.f(c + "decision_ms")) - prm.f(c + "decision_decisiveness") * z_dec,
                prm.f(c + "decision_log_sd"),
            )
        )
        lat = max(lat, w.t - h.anchor_ms + 200.0)
        n_rev = int(rng.poisson(prm.f(c + "revision_rate") * math.exp(-prm.f(c + "revision_decisiveness") * z_dec)))
        revs = [
            (str(rng.choice(["approve", "warn", "fine"])), h.anchor_ms + lat * (i + 1) / (n_rev + 2))
            for i in range(n_rev)
        ]
        w.respond(
            h,
            code,
            latency_ms=lat,
            correctness=code in compliant,
            xy=option_xy(rng, p, code),
            revisions=revs,
            anchor="audio_end",
            tap_target=f"weighing.{code}",
        )
        w.end_trial(h, "correct" if code in compliant else "incorrect", code in compliant, 1)
        w.advance(1200)

    for _ in range(7):
        decision("decisions_pre", "shift_pre", False)
    dilemmas = ["bribe", "overpayment", "assistant_mistake", "fraud_found"] * 3
    for kind_raw in rng.permutation(dilemmas):
        kind = str(kind_raw)
        cond = w.condition("main", "dilemmas")
        h = w.start_trial(
            "weighing_post",
            "dilemmas",
            kind,
            cond,
            params={},
            response_window_ms=9000,
            episode=True,
            audio_prompt=f"weighing.{kind}",
            audio_ms=2500,
        )
        lat = float(rng.lognormal(math.log(2600), 0.3))
        if kind == "bribe":
            accept = rng.random() < sigmoid(prm.f(c + "bribe_logit") - prm.f(c + "bribe_integrity") * p.z("integrity"))
            code = "accept" if accept else "decline"
            w.respond(h, code, latency_ms=lat, correctness=None, xy=option_xy(rng, p, code), anchor="audio_end")
        elif kind == "overpayment":
            ret = rng.random() < sigmoid(prm.f(c + "return_logit") + prm.f(c + "return_integrity") * p.z("integrity"))
            code = "return" if ret else "keep"
            w.respond(h, code, latency_ms=lat, correctness=None, xy=option_xy(rng, p, code), anchor="audio_end")
        elif kind == "assistant_mistake":
            shift = rng.random() < sigmoid(
                prm.f(c + "blame_shift_logit") - prm.f(c + "blame_shift_judgement") * p.z("judgement")
            )
            target = str(rng.choice(["assistant", "chance"])) if shift else "self"
            w.advance(lat)
            w.trial_event(
                h,
                "credit_allocation",
                {
                    "allocation_context": "assistant_mistake",
                    "outcome": "failure",
                    "target": target,
                    "self_share": 0.0 if shift else 1.0,
                },
            )
        else:
            mean = sigmoid(prm.f(c + "credit_logit") - prm.f(c + "credit_judgement") * p.z("judgement"))
            share = float(np.clip(round(float(rng.beta(mean * 6 + 0.5, (1 - mean) * 6 + 0.5)) * 4) / 4, 0.0, 1.0))
            w.advance(lat)
            w.trial_event(
                h,
                "credit_allocation",
                {
                    "allocation_context": "fraud_found",
                    "outcome": "success",
                    "target": "self" if share >= 0.75 else "shared" if share >= 0.25 else "assistant",
                    "self_share": share,
                },
            )
        w.end_trial(h, "not_applicable", None, 1)
        w.advance(800)
    for _ in range(3):
        cond = w.condition("main", "gamble_inspection")
        h = w.start_trial(
            "weighing_post",
            "gamble",
            "gamble_inspection",
            cond,
            params={},
            response_window_ms=9000,
            episode=True,
            audio_prompt="weighing.gamble",
            audio_ms=2000,
        )
        gamble = rng.random() < sigmoid(prm.f(c + "gamble_logit") + prm.f(c + "gamble_risk") * p.z("risk_preference"))
        code = "gamble" if gamble else "inspect"
        w.respond(
            h,
            code,
            latency_ms=float(rng.lognormal(math.log(2200), 0.3)),
            correctness=None,
            xy=option_xy(rng, p, code),
            anchor="audio_end",
        )
        w.end_trial(h, "not_applicable", None, 1)
        w.advance(800)
    q = sigmoid(
        prm.f("private_report.overreport_logit") - prm.f("private_report.overreport_integrity") * p.z("integrity")
    )
    for i in range(4):
        cond = w.condition("main", "private_report")
        h = w.start_trial(
            "weighing_post",
            "luck_tokens",
            "luck_token",
            cond,
            params={},
            response_window_ms=5500,
            private_report=True,
            episode=True,
        )
        value = 6 if (p.strategy == "over_reporter" or rng.random() < q) else int(rng.integers(1, 7))
        w.advance(2500)
        w.trial_event(
            h,
            "report",
            {
                "report_context": "luck_token",
                "report_index": i,
                "reported_value": value,
                "headset": False,
                "onlooker_reported": False,
            },
        )
        w.end_trial(h, "not_applicable", None, 1)
        w.advance(400)
    w.context_shift("weighing_post", "new_market_rule", True, w.trial_counters["weighing_post"], episode=True)
    for _ in range(7):
        decision("decisions_post", "shift_post", True)
    _probe(w, p, rng, prm, style=style, module="weighing_post")
    w.module_end("weighing_post", episode=True)


def road_home(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
) -> None:
    r = "road_home."
    w.module_start(
        "road_home", "episode", ["route_planning", "errands", "rule_reversal", "public_goods", "effort"], episode=True
    )
    z_to = p.z("task_organisation")
    z_ps = p.z("problem_solving")
    fork_acc = sigmoid(prm.f(r + "fork_accuracy_logit") + 0.4 * p.ability)

    def errand_map(k: int) -> None:
        errands = [f"errand_{k}_{j}" for j in range(4)]
        params = {
            "map_id": f"map_{occ.form_id}_{k}",
            "optimal_order": errands,
            "optimal_cost": 10,
            "optimal_fuel": 10,
            "n_errands": 4,
        }
        cond = w.condition("shift_pre", "standard")
        h = w.start_trial(
            "road_home", "errand_maps", "errand_map", cond, params=params, response_window_ms=None, episode=True
        )
        w.advance(
            float(
                rng.lognormal(
                    math.log(prm.f(r + "planning_ms"))
                    + prm.f(r + "planning_initiative") * p.z("initiative")
                    + prm.f(r + "planning_problem_solving") * z_ps,
                    0.3,
                )
            )
        )
        order = list(errands)
        swaps = (
            0
            if p.strategy == "optimal"
            else int(rng.poisson(prm.f(r + "swap_rate") * math.exp(-prm.f(r + "swap_task_organisation") * z_to)))
        )
        for _ in range(swaps):
            i, j = rng.choice(4, 2, replace=False)
            order[i], order[j] = order[j], order[i]
        revisits = (
            0
            if p.strategy == "optimal"
            else int(rng.poisson(prm.f(r + "revisit_rate") * math.exp(-prm.f(r + "revisit_task_organisation") * z_to)))
        )
        excess = (
            0.0
            if p.strategy == "optimal"
            else prm.f(r + "excess_cost")
            * math.exp(-prm.f(r + "excess_cost_problem_solving") * z_ps + float(rng.normal(0, 0.3)))
        )
        total_cost = round(10 * (1 + excess))
        n_steps = 4 + revisits
        costs = [1] * n_steps
        for _ in range(total_cost - n_steps):
            costs[int(rng.integers(0, n_steps))] += 1
        nodes = ["home"]
        errand_steps = sorted(rng.choice(n_steps, 4, replace=False).tolist()) if revisits else list(range(4))
        p_forget = (
            0.0
            if p.strategy == "optimal"
            else sigmoid(prm.f(r + "forget_errand_logit") - prm.f(r + "forget_errand_task_organisation") * z_to)
        )
        forgotten = {e for e in order if rng.random() < p_forget}
        fuel = 12
        e_iter = iter(order)
        for s in range(n_steps):
            gap = float(
                rng.lognormal(
                    math.log(prm.f(r + "step_gap_ms")) - prm.f(r + "step_gap_task_organisation") * z_to,
                    prm.f(r + "step_gap_log_sd"),
                )
            )
            w.advance(gap)
            if s in errand_steps:
                planned = next(e_iter)
                errand = None if planned in forgotten else planned
                to_node = f"node_{planned}"
            else:
                errand = None
                to_node = nodes[-2] if len(nodes) >= 2 else "home"
            fuel = max(0, fuel - costs[s])
            w.trial_event(
                h,
                "route_step",
                {
                    "map_id": params["map_id"],
                    "from_node": nodes[-1],
                    "to_node": to_node,
                    "step_index": s,
                    "cost_units": costs[s],
                    "fuel_after_units": fuel,
                    "blocked": False,
                    "errand_completed": errand,
                },
            )
            nodes.append(to_node)
        w.advance(500)
        w.end_trial(h, "correct", True, 0)
        w.advance(800)

    def optional() -> None:
        lines = ["road_home.optional_hint"]
        cond = w.condition("shift_pre", "standard")
        h = w.start_trial(
            "road_home",
            "errand_maps",
            "optional_opportunity",
            cond,
            params={"mentioning_lines": lines},
            response_window_ms=6000,
            episode=True,
        )
        if rng.random() < 0.3:
            w.advance(800)
            w.trial_event(h, "prompt_audio_end", {"line_id": lines[0], "audio_end_ms": round(w.t, 3)})
        take = rng.random() < sigmoid(
            prm.f(r + "optional_logit") + prm.f(r + "optional_initiative") * p.z("initiative")
        )
        lat = float(rng.lognormal(math.log(2500), 0.4))
        if take:
            w.respond(
                h, "take", latency_ms=max(lat, w.t - h.anchor_ms + 100), correctness=None, xy=option_xy(rng, p, "take")
            )
        else:
            w.t = max(w.t, h.anchor_ms + 6000)
            w.respond(h, None, latency_ms=None, correctness=None)
        w.end_trial(h, "not_applicable", None, int(take))
        w.advance(600)

    def fork(block: str, phase: str, post: bool, j: int) -> bool:
        rule_option = "right" if post else "left"
        old = "left" if post else "right"
        cond = w.condition(phase, "rule_reversed" if post else "standard", shift_active=post)
        h = w.start_trial(
            "road_home",
            block,
            "fork_choice",
            cond,
            params={"rule_option": rule_option, "old_rule_option": old},
            response_window_ms=7000,
            episode=True,
        )
        if post:
            z_ad = p.z("adaptability")
            rv = "road_home.reversal_"
            pers = sigmoid(
                prm.f(rv + "perseveration_logit")
                - prm.f(rv + "perseveration_adaptability") * z_ad
                - prm.f(rv + "perseveration_stability") * p.z("stability")
            ) * math.exp(-j / (prm.f(rv + "decay_trials") * math.exp(-prm.f(rv + "decay_adaptability") * z_ad)))
            choice = old if rng.random() < pers else (rule_option if rng.random() < fork_acc else old)
        else:
            choice = rule_option if rng.random() < fork_acc else old
        lat = float(rng.lognormal(math.log(1600) - 0.1 * p.speed + occ.practice_log_rt, 0.25))
        w.respond(h, choice, latency_ms=lat, correctness=choice == rule_option, xy=option_xy(rng, p, choice))
        w.end_trial(h, "correct" if choice == rule_option else "incorrect", choice == rule_option, 1)
        w.advance(700)
        return choice == rule_option

    # practice
    cond = w.condition("practice", "standard")
    h = w.start_trial(
        "road_home",
        "practice",
        "fork_choice",
        cond,
        params={"rule_option": "left", "old_rule_option": "right"},
        response_window_ms=7000,
        episode=True,
    )
    w.respond(h, "left", latency_ms=1500, correctness=True, xy=option_xy(rng, p, "left"))
    w.end_trial(h, "correct", True, 1)
    for item in [
        "map",
        "opt",
        "fork",
        "fork",
        "map",
        "opt",
        "fork",
        "opt",
        "fork",
        "map",
        "opt",
        "fork",
        "fork",
        "opt",
    ]:
        if item == "map":
            errand_map(sum(1 for t in w.trial_params.values() if "map_id" in t and "optimal_order" in t))
        elif item == "opt":
            optional()
        else:
            fork("errand_maps", "shift_pre", False, 0)
    for b in range(2):
        cond = w.condition("main", "route_blocked")
        h = w.start_trial(
            "road_home",
            "blocked_road",
            "blocked_route",
            cond,
            params={"map_id": f"map_blocked_{b}", "post_block_optimal_cost": 6},
            response_window_ms=None,
            episode=True,
        )
        w.advance(float(rng.lognormal(math.log(2500) - 0.2 * z_ps, 0.3)))
        retries = int(
            rng.poisson(prm.f(r + "retries_rate") * math.exp(prm.f(r + "retries_persistence") * p.z("persistence")))
        )
        for k in range(retries):
            w.trial_event(
                h,
                "route_step",
                {
                    "map_id": f"map_blocked_{b}",
                    "from_node": "fork",
                    "to_node": f"blocked_{k}",
                    "step_index": k,
                    "cost_units": 0,
                    "fuel_after_units": 6,
                    "blocked": True,
                    "errand_completed": None,
                },
            )
            w.advance(float(rng.lognormal(math.log(1500), 0.3)))
        cost = round(6 * (1 + 0.2 * math.exp(-0.6 * z_ps + float(rng.normal(0, 0.3)))))
        for k in range(3):
            step_cost = cost // 3 + (1 if k < cost % 3 else 0)
            w.trial_event(
                h,
                "route_step",
                {
                    "map_id": f"map_blocked_{b}",
                    "from_node": f"n{k}",
                    "to_node": f"n{k + 1}",
                    "step_index": retries + k,
                    "cost_units": step_cost,
                    "fuel_after_units": 6,
                    "blocked": False,
                    "errand_completed": None,
                },
            )
            w.advance(float(rng.lognormal(math.log(1500), 0.3)))
        w.respond(h, "fallback", latency_ms=w.t - h.anchor_ms, correctness=None, xy=option_xy(rng, p, "fallback"))
        w.end_trial(h, "not_applicable", None, 1)
        w.advance(700)
    w.context_shift("road_home", "rule_reversal", False, w.trial_counters["road_home"], episode=True)
    for j in range(12):
        fork("reversal", "shift_post", True, j)
    partners = [
        ("free_rider", False),
        ("cooperative", False),
        ("free_rider", False),
        ("error_prone", True),
        ("free_rider", False),
        ("cooperative", False),
    ]
    prev: tuple[str, bool] | None = None
    for k, (ptype, err) in enumerate(partners):
        contribution_round(
            w,
            p,
            rng,
            prm,
            module_id="road_home",
            block="fuel_pot",
            trial_type="fuel_round",
            round_index=k,
            endowment=4,
            partner_type=ptype,
            is_error=err,
            previous_partner=prev[0] if prev else None,
            previous_error=prev[1] if prev else False,
            episode=True,
        )
        prev = (ptype, err)
    for _ in range(4):
        cond = w.condition("main", "effort")
        h = w.start_trial("road_home", "uphill", "effort_hold", cond, params={}, response_window_ms=None, episode=True)
        hold(w, h, rng, p, prm, target="road_home.cart", required_ms=2500.0)
        w.end_trial(h, "not_applicable", None, 1)
        w.advance(600)
    _probe(w, p, rng, prm, style=style, module="road_home")
    w.module_end("road_home", episode=True)


def coplay(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
) -> None:
    """Live-dyad substudy (EPI-06), from player slot 1's perspective."""
    c = "coplay."
    w.module_start("coplay", "episode", ["coplay", "public_goods", "credit_allocation"], episode=True)
    p_wait = sigmoid(prm.f(c + "wait_logit") + prm.f(c + "wait_teamwork") * p.z("teamwork"))
    for k in range(24):
        slot = 1 + (k % 2)
        cond = w.condition("main", "live_dyad", partner_type="live")
        h = w.start_trial("coplay", "turns", "turn", cond, params={}, response_window_ms=8000, episode=True)
        w.trial_event(h, "turn_event", {"player_slot": slot, "kind": "turn_start", "turn_index": k})
        w.advance(float(rng.uniform(2000, 5000)))
        if slot == 2:
            kind = "wait" if rng.random() < p_wait else "interruption"
            w.trial_event(h, "turn_event", {"player_slot": 1, "kind": kind, "turn_index": k})
        w.trial_event(h, "turn_event", {"player_slot": slot, "kind": "turn_end", "turn_index": k})
        w.end_trial(h, "not_applicable", None, 0)
        w.advance(500)
    for _ in range(4):
        cond = w.condition("main", "credit_round", partner_type="live")
        h = w.start_trial(
            "coplay", "credit_round", "credit_round", cond, params={}, response_window_ms=9000, episode=True
        )
        partner_share = sigmoid(
            prm.f(c + "credit_partner_logit") + prm.f(c + "credit_partner_teamwork") * p.z("teamwork")
        )
        share = float(
            np.clip(round(float(rng.beta(partner_share * 6 + 0.5, (1 - partner_share) * 6 + 0.5)) * 4) / 4, 0, 1)
        )
        w.advance(2500)
        w.trial_event(
            h,
            "credit_allocation",
            {
                "allocation_context": "coplay_outcome",
                "outcome": "success",
                "target": "partner" if share >= 0.5 else "self",
                "self_share": 1.0 - share,
            },
        )
        w.end_trial(h, "not_applicable", None, 1)
        w.advance(500)
    w.module_end("coplay", episode=True)


A_MODULES = {"stall": stall, "weighing_post": weighing_post, "road_home": road_home, "coplay": coplay}
