"""Pathway B micro-game generators (block structure from ``content/games/pathway-b``)."""

from __future__ import annotations

import math

import numpy as np

from shriii_simulator.builder import SessionWriter, TrialHandle
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
    staircase_step,
    tone_choice,
)
from shriii_simulator.params import SimParams
from shriii_simulator.population import Person

__all__ = ["B_MODULES"]


def _probe(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, style: np.ndarray, module: str
) -> None:
    probe_block(w, p, rng, prm, style, module_id=module, groups=[(f"{module}.probe", 4)], episode=False)


def dont_tap(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
) -> None:
    w.module_start("dont_tap", "micro", ["go_nogo"])
    for i in range(4):
        gng_trial(
            w,
            p,
            rng,
            prm,
            occ,
            module_id="dont_tap",
            block="practice",
            trial_type="nogo" if i == 2 else "go",
            phase="practice",
            condition_id="standard",
            window_ms=600,
            isi_ms=560,
            pressure=False,
        )
    for block, phase, cond, pressure, isi in (
        ("main", "main", "standard", False, 520),
        ("pressure", "pressure", "pressure", True, 440),
    ):
        types = ["nogo"] * scaled(prm, "dont_tap.nogo_per_block") + ["go"] * scaled(prm, "dont_tap.go_per_block")
        order = _no_long_runs(rng, types, "nogo", 2)
        if pressure:
            w.context_shift("dont_tap", "pressure_on", True, w.trial_counters["dont_tap"])
        for tt in order:
            gng_trial(
                w,
                p,
                rng,
                prm,
                occ,
                module_id="dont_tap",
                block=block,
                trial_type=tt,
                phase=phase,
                condition_id=cond,
                window_ms=540,
                isi_ms=isi,
                pressure=pressure,
            )
    _probe(w, p, rng, prm, style=style, module="dont_tap")
    w.module_end("dont_tap")


def _no_long_runs(rng: np.random.Generator, items: list[str], token: str, max_run: int) -> list[str]:
    for _ in range(1000):
        order = list(rng.permutation(items))
        run = best = 0
        for x in order:
            run = run + 1 if x == token else 0
            best = max(best, run)
        if best <= max_run:
            return [str(x) for x in order]
    return [str(x) for x in items]


DIMENSIONS = ("colour_pattern", "shape", "count")
PILES = ("pile_1", "pile_2", "pile_3", "pile_4")


def card_sort(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
) -> None:
    c = "card_sort."
    w.module_start("card_sort", "micro", ["card_sort", "set_shifting"])
    rules = list(rng.permutation(DIMENSIONS))
    r1, r2 = str(rules[0]), str(rules[1])
    plan: list[tuple[str, str, str, str | None, int]] = [
        ("practice", "practice", r1, None, 3),
        ("initial_rule", "shift_pre", r1, None, scaled(prm, "card_sort.initial_rule")),
        ("switch_1", "shift_post", r2, r1, scaled(prm, "card_sort.switch_1")),
        ("reversal", "shift_post", r1, r2, scaled(prm, "card_sort.reversal")),
    ]
    z_ad = p.z("adaptability")
    z_st = p.z("stability")
    pers0 = sigmoid(
        prm.f(c + "perseveration_logit")
        - prm.f(c + "perseveration_adaptability") * z_ad
        - prm.f(c + "perseveration_stability") * z_st
    )
    decay = prm.f(c + "perseveration_decay_trials") * math.exp(-prm.f(c + "decay_adaptability") * z_ad)
    base = sigmoid(prm.f(c + "base_accuracy_logit") + prm.f(c + "ability_coef") * p.ability)
    cost = (
        prm.f(c + "switch_cost_log")
        - prm.f(c + "switch_cost_adaptability") * z_ad
        - prm.f(c + "switch_cost_stability") * z_st
    )
    for block, phase, rule, prev, n in plan:
        if block == "switch_1":
            w.context_shift("card_sort", "rule_switch", False, w.trial_counters["card_sort"])
        if block == "reversal":
            w.context_shift("card_sort", "rule_reversal", False, w.trial_counters["card_sort"])
        for j in range(n):
            piles = list(rng.permutation(PILES))
            matches = {d: str(piles[k]) for k, d in enumerate(DIMENSIONS)}
            cond = w.condition(phase, f"rule_{rule}", shift_active=prev is not None)
            h = w.start_trial(
                "card_sort",
                block,
                "sort",
                cond,
                params={"rule": rule, "previous_rule": prev, "matches": matches},
                response_window_ms=3500,
            )
            lapse = prm.f(c + "shift_lapse") * sigmoid(-prm.f(c + "shift_lapse_stability") * z_st)
            if prev is not None and rng.random() < pers0 * math.exp(-j / decay):
                choice = matches[prev]
            elif prev is not None and j < prm.f(c + "shift_lapse_trials") and rng.random() < lapse:
                choice = str(rng.choice([x for x in PILES if x not in (matches[rule], matches[prev])]))
            elif block == "initial_rule" and j < 2:
                choice = str(rng.choice(PILES))
            elif rng.random() < base:
                choice = matches[rule]
            else:
                choice = str(rng.choice([x for x in PILES if x != matches[rule]]))
            if p.strategy == "same_position":
                choice = "pile_1"
            log_rt = math.log(prm.f(c + "rt_ms")) - 0.12 * p.speed + occ.practice_log_rt
            if prev is not None:
                log_rt += cost * math.exp(-j / prm.f(c + "switch_cost_decay_trials")) + cost * 0.5
            rt = float(rng.lognormal(log_rt, prm.f(c + "rt_log_sd")))
            if p.strategy == "speed_tapper":
                rt = float(rng.uniform(60, 140))
            correct = choice == matches[rule]
            if rt > 3500:
                w.t = max(w.t, h.anchor_ms + 3500)
                w.respond(h, None, latency_ms=None, correctness=False)
                correct = False
            else:
                w.respond(
                    h,
                    choice,
                    latency_ms=rt,
                    correctness=correct,
                    xy=option_xy(rng, p, choice),
                    tap_target=f"card_sort.{choice}",
                )
            w.end_trial(h, "correct" if correct else "incorrect", correct, 1)
            w.advance(600 + 350)
    _probe(w, p, rng, prm, style=style, module="card_sort")
    w.module_end("card_sort")


def balloon(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
) -> None:
    b = "balloon."
    w.module_start("balloon", "micro", ["bart"])
    colours = ["low_risk", "high_risk"] * scaled(prm, "balloon.balloons_per_colour")
    colours = [str(x) for x in rng.permutation(colours)]
    sd = prm.f(b + "noise_log_sd") * math.exp(-prm.f(b + "noise_consistency") * p.z("response_consistency"))
    adjust = prm.f(b + "post_loss_adjust") * math.exp(-prm.f(b + "post_loss_persistence") * p.z("persistence_of_style"))
    exploded_last = False
    for i, colour in enumerate(["low_risk", *colours]):
        practice = i == 0
        max_pumps = int(prm.f(b + ("max_pumps_low_risk" if colour == "low_risk" else "max_pumps_high_risk")))
        explosion = int(rng.integers(1, max_pumps + 1))
        cond = w.condition("practice" if practice else "main", "standard")
        h = w.start_trial(
            "balloon",
            "practice" if practice else "balloons",
            "balloon",
            cond,
            params={"risk_colour": colour, "explosion_point": explosion, "max_pumps": max_pumps},
        )
        target = prm.f(b + "target_pumps") * math.exp(prm.f(b + "risk_log_coef") * p.z("risk_preference"))
        if colour == "high_risk":
            target *= prm.f(b + "high_risk_factor")
        log_target = math.log(target) + float(rng.normal(0, sd)) - (adjust if exploded_last else 0.0)
        pumps_wanted = int(np.clip(round(math.exp(log_target)), 1, max_pumps))
        exploded = False
        n = 0
        for k in range(1, pumps_wanted + 1):
            w.advance(float(rng.gamma(4.0, 60.0)) + 120)
            n = k
            exploded = k >= explosion
            w.trial_event(
                h,
                "pump",
                {"balloon_index": i, "pump_index": k, "risk_colour": colour, "exploded": exploded, "collected": False},
            )
            if exploded:
                break
        if not exploded:
            lat = float(
                rng.lognormal(
                    math.log(prm.f(b + "collect_ms")) - prm.f(b + "collect_decisiveness") * p.z("decisiveness"),
                    prm.f(b + "collect_log_sd") * math.exp(-prm.f(b + "collect_sd_decisiveness") * p.z("decisiveness")),
                )
            )
            w.advance(lat)
            w.trial_event(
                h,
                "pump",
                {"balloon_index": i, "pump_index": n, "risk_colour": colour, "exploded": False, "collected": True},
            )
            w.respond(
                h,
                "collect",
                latency_ms=w.t - h.anchor_ms,
                correctness=None,
                xy=jitter(rng, (0.8, 0.85)),
                tap_target="balloon.collect",
            )
            w.advance(600)
        else:
            w.advance(800)
        if not practice:
            exploded_last = exploded
        w.end_trial(h, "incorrect" if exploded else "correct", not exploded, 0 if exploded else 1)
        w.advance(300)
    _probe(w, p, rng, prm, style=style, module="balloon")
    w.module_end("balloon")


def tower(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
) -> None:
    t = "tower."
    w.module_start("tower", "micro", ["tower_of_london"])
    problems = [
        ("practice", 2, True),
        ("problems", 2, True),
        ("problems", 0, False),
        ("problems", 3, True),
        ("problems", 0, False),
        ("problems", 4, True),
        ("problems", 5, True),
    ]
    z_ps = p.z("problem_solving")
    previous_failed = False
    for k, (block, min_moves, solvable) in enumerate(problems):
        practice = block == "practice"
        ttype = "solvable" if solvable else "unsolvable"
        params: dict[str, object] = {"problem_id": f"tol.{occ.form_id}.p{k}", "skip_icon_ms": prm.f(t + "skip_icon_ms")}
        if solvable:
            params["min_moves"] = min_moves
        else:
            params["cap_ms"] = prm.f(t + "unsolvable_cap_ms")
        cond = w.condition("practice" if practice else "main", "standard")
        h = w.start_trial("tower", block, ttype, cond, params=params, stimulus_id=f"tower.problem.{occ.form_id}.{k}")
        plan_ms = float(
            rng.lognormal(
                math.log(prm.f(t + "planning_ms"))
                + prm.f(t + "planning_problem_solving") * z_ps
                + prm.f(t + "planning_initiative") * p.z("initiative"),
                prm.f(t + "planning_log_sd"),
            )
        )
        w.advance(plan_ms)
        illegal_rate = prm.f(t + "illegal_rate") * math.exp(
            -prm.f(t + "illegal_task_organisation") * p.z("task_organisation")
        )
        move_index = 0

        def move(legal: bool, h: TrialHandle = h, params: dict[str, object] = params) -> None:
            nonlocal move_index
            w.trial_event(
                h,
                "move",
                {
                    "problem_id": str(params["problem_id"]),
                    "item_id": f"ball_{move_index % 3}",
                    "from_slot": f"peg_{move_index % 3}",
                    "to_slot": f"peg_{(move_index + 1) % 3}",
                    "legal": legal,
                    "move_index": move_index,
                },
            )
            move_index += 1
            w.advance(float(rng.lognormal(math.log(prm.f(t + "move_interval_ms")), 0.3)))

        if solvable:
            lam = prm.f(t + "excess_rate") * math.exp(-prm.f(t + "excess_problem_solving") * z_ps) * min_moves / 3.5
            if previous_failed and not practice:
                lam *= math.exp(prm.f(t + "post_failure_log") - prm.f(t + "post_failure_problem_solving") * z_ps)
            excess = 0 if p.strategy == "optimal" else int(rng.poisson(lam))
            illegal_at = set(rng.integers(0, min_moves + excess, int(rng.poisson(illegal_rate))).tolist())
            for m_i in range(min_moves + excess):
                if m_i in illegal_at:
                    move(False)
                move(True)
            solved = w.t - h.onset_ms < prm.f(t + "solvable_cap_ms")
            w.end_trial(h, "correct" if solved else "timeout", solved, 0)
            previous_failed = not solved
        else:
            time_on = float(
                rng.lognormal(
                    math.log(prm.f(t + "unsolvable_ms")) + prm.f(t + "unsolvable_persistence") * p.z("persistence"),
                    prm.f(t + "unsolvable_log_sd"),
                )
            )
            icon = prm.f(t + "skip_icon_ms")
            cap = prm.f(t + "unsolvable_cap_ms")
            stop = max(time_on, icon + float(rng.uniform(300, 1500))) if time_on < icon else time_on
            while w.t - h.onset_ms + prm.f(t + "move_interval_ms") < min(stop, cap):
                move(True)
            if stop < cap:
                w.t = max(w.t, h.onset_ms + stop)
                w.respond(
                    h,
                    "skip",
                    latency_ms=w.t - h.anchor_ms,
                    correctness=None,
                    xy=jitter(rng, (0.85, 0.15)),
                    tap_target="tower.skip",
                )
                w.end_trial(h, "not_applicable", None, 1)
            else:
                w.t = max(w.t, h.onset_ms + cap)
                w.end_trial(h, "timeout", None, 0)
            previous_failed = True
        w.advance(800)
    _probe(w, p, rng, prm, style=style, module="tower")
    w.module_end("tower")


SHARE_POT_PARTNERS = [
    ("cooperative", False),
    ("free_rider", False),
    ("cooperative", False),
    ("free_rider", False),
    ("error_prone", True),
    ("free_rider", False),
    ("cooperative", False),
    ("cooperative", False),
]


def share_pot(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
) -> None:
    w.module_start("share_pot", "micro", ["public_goods"])
    prev: tuple[str, bool] | None = None
    for r, (ptype, err) in enumerate(SHARE_POT_PARTNERS):
        if r == 4:
            w.context_shift("share_pot", "partner_error", False, w.trial_counters["share_pot"])
        contribution_round(
            w,
            p,
            rng,
            prm,
            module_id="share_pot",
            block="rounds",
            trial_type="round",
            round_index=r,
            endowment=10,
            partner_type=ptype,
            is_error=err,
            previous_partner=prev[0] if prev else None,
            previous_error=prev[1] if prev else False,
        )
        prev = (ptype, err)
    tone_choice(
        w,
        p,
        rng,
        prm,
        module_id="share_pot",
        block="tone_probe",
        phase="main",
        condition_id="unfair_loss_probe",
        level=None,
        run_position=None,
        episode=False,
    )
    _probe(w, p, rng, prm, style=style, module="share_pot")
    w.module_end("share_pot")


def wait_or_now(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
) -> None:
    d = "discounting."
    w.module_start("wait_or_now", "micro", ["delay_discounting", "effort_discounting"])
    log_k = (
        prm.f(d + "log_k")
        - prm.f(d + "log_k_self_control") * p.z("self_control")
        + float(rng.normal(0, prm.f(d + "log_k_noise_sd")))
    )
    beta = prm.f(d + "beta")
    cycle = [int(v) for v in prm.get("design.wait_or_now.delays")]
    delays = [cycle[i % len(cycle)] for i in range(scaled(prm, "wait_or_now.delay_choices"))]
    ss_by_delay = dict.fromkeys(set(delays), 5.0)
    step_by_delay = dict.fromkeys(set(delays), 2.5)
    for dl in delays:
        ss = round(ss_by_delay[dl], 2)
        cond = w.condition("main", "delay")
        h = w.start_trial(
            "wait_or_now",
            "delay",
            "delay_choice",
            cond,
            params={"ss_amount": ss, "ss_delay": 0, "ll_amount": 10, "ll_delay": dl},
            response_window_ms=7000,
            audio_prompt="wait_or_now.offer",
            audio_ms=1800,
        )
        v_ll = 10.0 / (1.0 + math.exp(log_k) * dl)
        chose_ll = rng.random() < sigmoid(beta * (v_ll - ss) / 10.0)
        code = "wait" if chose_ll else "now"
        w.respond(
            h,
            code,
            latency_ms=float(rng.lognormal(math.log(2200), 0.3)),
            correctness=None,
            xy=option_xy(rng, p, code),
            anchor="audio_end",
            tap_target=f"wait_or_now.{code}",
        )
        w.end_trial(h, "not_applicable", None, 1)
        w.advance(700)
        ss_by_delay[dl] = min(10.0, ss + step_by_delay[dl]) if chose_ll else max(0.0, ss - step_by_delay[dl])
        step_by_delay[dl] /= 2.0
    log_ke = prm.f(d + "effort_log_k") - prm.f(d + "effort_log_k_self_control") * p.z("self_control")
    design = str(prm.get("design.wait_or_now.effort_design"))
    tit = "design.wait_or_now.effort_titration."
    schedule: list[float] | None = None
    if design == "fixed":
        fixed_amounts = [float(a) for a in prm.get(d + "effort_amounts")]
        schedule = fixed_amounts
        n_effort = len(fixed_amounts)
        easy_amount, hard_effort = 2.0, 2.5
    elif design == "titrated":
        n_effort = int(prm.f(tit + "trials"))
        easy_amount, hard_effort = prm.f(tit + "easy_amount"), prm.f(tit + "hard_effort")
    else:
        raise ValueError(f"unknown effort design {design!r}")
    amount = prm.f(tit + "start_amount")
    step = prm.f(tit + "start_step")
    direction = 0
    for i in range(n_effort):
        if schedule is not None:
            amount = schedule[i]
        offer = round(amount, 2)
        cond = w.condition("main", "effort")
        h = w.start_trial(
            "wait_or_now",
            "effort",
            "effort_choice",
            cond,
            params={"easy_amount": easy_amount, "easy_effort": 0.0, "hard_amount": offer, "hard_effort": hard_effort},
            response_window_ms=7000,
            audio_prompt="wait_or_now.effort_offer",
            audio_ms=1800,
        )
        v_hard = offer / (1.0 + math.exp(log_ke) * hard_effort)
        hard = rng.random() < sigmoid(beta * (v_hard - easy_amount) / offer)
        code = "hard" if hard else "easy"
        w.respond(
            h,
            code,
            latency_ms=float(rng.lognormal(math.log(2000), 0.3)),
            correctness=None,
            xy=option_xy(rng, p, code),
            anchor="audio_end",
            tap_target=f"wait_or_now.{code}",
        )
        if hard:
            hold(w, h, rng, p, prm, target="wait_or_now.hold_pad", required_ms=hard_effort * 1000.0)
        w.end_trial(h, "not_applicable", None, 1)
        w.advance(700)
        if schedule is None:
            amount, step, direction = staircase_step(
                amount, step, direction, hard, lo=prm.f(tit + "min_amount"), hi=prm.f(tit + "max_amount")
            )
    _probe(w, p, rng, prm, style=style, module="wait_or_now")
    w.module_end("wait_or_now")


def steady_hands(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
) -> None:
    s = "steady_hands."
    w.module_start("steady_hands", "micro", ["held_vs_free_responding"])
    order = ["free", "held"] if rng.random() < 0.5 else ["held", "free"]
    z_rest = p.z("expressive_restraint")
    for bi, block in enumerate(order):
        if bi == 1:
            w.context_shift(
                "steady_hands",
                "held_block" if block == "held" else "free_block",
                True,
                w.trial_counters["steady_hands"],
            )
        n_block = scaled(prm, "steady_hands.trials_per_block")
        n_dist = min(n_block - 1, scaled(prm, "steady_hands.distractors_per_block"))
        distractors = [True] * n_dist + [False] * (n_block - n_dist)
        for dist in rng.permutation(distractors):
            cond = w.condition("main", block, shift_active=block == "held")
            h = w.start_trial(
                "steady_hands", block, "target", cond, params={"distractor": bool(dist)}, response_window_ms=1200
            )
            log_rt = math.log(prm.f(s + "rt_ms")) - 0.1 * p.speed + occ.practice_log_rt
            if dist:
                log_rt += prm.f(s + "distractor_log") - prm.f(s + "distractor_composure") * p.z("composure")
            rt = float(
                rng.lognormal(
                    log_rt,
                    prm.f(s + "rt_log_sd") * math.exp(-prm.f(s + "rt_sd_consistency") * p.z("response_consistency")),
                )
            )
            rate = math.exp(
                prm.f(s + "unneeded_log_rate")
                + (prm.f(s + "free_extra_log") - prm.f(s + "free_extra_restraint") * z_rest if block == "free" else 0.0)
            )
            for _ in range(int(rng.poisson(rate))):
                w.tap(
                    h,
                    "premature",
                    target_id="steady_hands.target",
                    xy=jitter(rng, (0.5, 0.5)),
                    at=h.onset_ms + float(rng.uniform(5, 140)),
                )
            w.respond(
                h, "tap", latency_ms=rt, correctness=True, xy=jitter(rng, (0.5, 0.5)), tap_target="steady_hands.target"
            )
            if block == "held":
                w.trial_event(
                    h,
                    "input.hold",
                    {
                        "target_id": "steady_hands.hold_pad",
                        "hold_ms": round(rt + 300, 3),
                        "required_hold_ms": 0.0,
                        "completed": True,
                    },
                )
            for _ in range(int(rng.poisson(rate))):
                w.advance(float(rng.uniform(40, 120)))
                w.tap(h, "extra", target_id="steady_hands.target", xy=jitter(rng, (0.5, 0.5)))
            w.end_trial(h, "correct", True, 1)
            w.advance(440)
    _probe(w, p, rng, prm, style=style, module="steady_hands")
    w.module_end("steady_hands")


STALLS = ("stall_a", "stall_b", "stall_c", "stall_d")
HIGH_VARIANCE = ["stall_c", "stall_d"]


def four_stalls(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
) -> None:
    f = "four_stalls."
    w.module_start("four_stalls", "micro", ["igt_lite"])
    theta = prm.f(f + "inverse_temperature") * math.exp(
        prm.f(f + "temperature_consistency") * p.z("response_consistency")
    )
    bias = prm.f(f + "risk_bias") * p.z("risk_preference")
    q = np.zeros(4)
    n_groups = int(prm.f(f + "repeat_groups"))
    n_pres = int(prm.f(f + "repeat_presentations"))
    repeat_slots = [f"stalls_repeat_{g}" for g in range(n_groups) for _ in range(n_pres)]
    n_choices = max(scaled(prm, "four_stalls.choices"), len(repeat_slots))
    kinds: list[str | None] = [*repeat_slots, *([None] * (n_choices - len(repeat_slots)))]
    kinds = [None if k is None else str(k) for k in rng.permutation(np.array(kinds, dtype=object))]
    situation = {f"stalls_repeat_{g}": rng.normal(0, 0.6, 4) for g in range(n_groups)}
    for gid in kinds:
        cond = w.condition("main", "standard")
        h = w.start_trial(
            "four_stalls",
            "choices",
            "choice",
            cond,
            params={"repeat_group_id": gid, "high_variance_stalls": HIGH_VARIANCE},
            response_window_ms=4500,
            audio_prompt="four_stalls.prompt",
            audio_ms=1200,
        )
        util = q.copy() if gid is None else situation[gid].copy()
        util[2:] += bias
        probs = np.exp(theta * (util - util.max()))
        probs /= probs.sum()
        k = int(rng.choice(4, p=probs))
        if p.strategy == "same_position":
            k = 0
        code = STALLS[k]
        lat = float(
            rng.lognormal(
                math.log(prm.f(f + "decision_ms")) - prm.f(f + "decision_decisiveness") * p.z("decisiveness"),
                prm.f(f + "decision_log_sd")
                * math.exp(-prm.f(f + "decision_sd_consistency") * p.z("response_consistency")),
            )
        )
        if p.strategy == "speed_tapper":
            lat = float(rng.uniform(60, 140))
        w.respond(
            h,
            code,
            latency_ms=lat,
            correctness=None,
            xy=option_xy(rng, p, code),
            anchor="audio_end",
            tap_target=f"four_stalls.{code}",
        )
        if gid is None:
            payoff = float(rng.normal(1.0, 0.3)) if k < 2 else float(rng.choice([3.0, -4.0], p=[0.6, 0.4]))
            q[k] += 0.3 * (payoff - q[k])
        w.advance(800)
        w.end_trial(h, "not_applicable", None, 1)
        w.advance(300)
    _probe(w, p, rng, prm, style=style, module="four_stalls")
    w.module_end("four_stalls")


def private_dice(
    w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
) -> None:
    d = "private_report."
    w.module_start("private_dice", "micro", ["private_report"])
    q = sigmoid(
        prm.f(d + "overreport_logit")
        - prm.f(d + "overreport_integrity") * p.z("integrity")
        + p.group_offsets.get("dice_overreport_logit", 0.0)
    )
    for i in range(10):
        cond = w.condition("main", "private_report")
        h = w.start_trial(
            "private_dice", "reports", "report", cond, params={}, response_window_ms=5500, private_report=True
        )
        roll = int(rng.integers(1, 7))
        value = roll
        if p.strategy == "over_reporter" or rng.random() < q:
            value = 6
        w.advance(2400 + float(rng.uniform(300, 1500)))
        w.trial_event(
            h,
            "report",
            {
                "report_context": "private_dice",
                "report_index": i,
                "reported_value": value,
                "headset": False,
                "onlooker_reported": False,
            },
        )
        w.end_trial(h, "not_applicable", None, 1)
        w.advance(400)
    _probe(w, p, rng, prm, style=style, module="private_dice")
    w.module_end("private_dice")


B_MODULES = {
    "dont_tap": dont_tap,
    "card_sort": card_sort,
    "balloon": balloon,
    "tower": tower,
    "share_pot": share_pot,
    "wait_or_now": wait_or_now,
    "steady_hands": steady_hands,
    "four_stalls": four_stalls,
    "private_dice": private_dice,
}
