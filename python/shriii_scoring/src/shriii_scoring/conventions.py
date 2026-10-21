"""Event-emission conventions the indicator engine relies on (the scoring side of ENG-05/ENG-08).

The event envelope (``packages/contracts``) fixes *which* events exist; this module fixes the closed
vocabularies *inside* them that formulas read: ``trial_start.payload.trial_type`` values, committed
``response_value`` codes and the per-trial ``GameTrialSpec.params`` keys (the scheduler/solver output
that the scoring engine joins by ``(session_id, trial_id)``). The simulator emits exactly these
conventions, and the kiosk modules must too (see the package README for the table).

Task selectors map a dictionary ``source.task`` (e.g. ``dont_tap.gng``) to blocks and trial types of
the content configs. Blocks are authoritative for selection; dictionary ``phases`` are cross-checked
against the content configs by :func:`phase_mismatches` and reported, never silently "fixed".

General conventions
-------------------
* ``task.block_id`` is ``"<module_id>.<block_id>"`` (block ids from ``content/games/**``); a bare block
  id is accepted too.
* ``task.trial_index`` counts every trial of the module from 0 (practice included);
  ``context_shift.payload.shift_index`` is the trial index of the first trial under the new condition.
* A trial is the events between ``trial_start`` and ``trial_end`` with the same ``task.trial_id``;
  the committed response is the last ``response`` event of the trial.
* Timeouts are ``response`` events with ``input_mode = timeout`` and ``latency_ms = null`` (withholding
  on a no-go trial is a timeout with ``correctness = true``).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Final

__all__ = [
    "CROSS_EPISODE_PROBE_MODULES",
    "CROSS_MODULE_PROBE_MODULES",
    "MODULE_TRIAL_TYPES",
    "PARAM_KEYS",
    "RESPONSE_CODES",
    "SHIFT_PERFORMANCE",
    "TASKS",
    "TaskComponent",
    "TaskSelector",
    "phase_mismatches",
]


@dataclass(frozen=True, slots=True)
class TaskComponent:
    """Blocks and trial types of one module that belong to a task."""

    module_id: str
    blocks: tuple[str, ...]
    trial_types: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class TaskSelector:
    """A dictionary task: one or more module components (cross-module tasks pool several)."""

    task: str
    components: tuple[TaskComponent, ...]

    @property
    def modules(self) -> frozenset[str]:
        return frozenset(c.module_id for c in self.components)


def _t(task: str, *components: TaskComponent) -> TaskSelector:
    return TaskSelector(task, tuple(components))


def _c(module: str, blocks: Iterable[str], types: Iterable[str]) -> TaskComponent:
    return TaskComponent(module, tuple(blocks), tuple(types))


GNG_TYPES: Final = ("go", "nogo")
PROBE: Final = ("probe",)

#: Trial types emitted per module (``trial_start.payload.trial_type``).
MODULE_TRIAL_TYPES: Final[Mapping[str, tuple[str, ...]]] = {
    "dont_tap": ("go", "nogo", "probe"),
    "card_sort": ("sort", "probe"),
    "balloon": ("balloon", "probe"),
    "tower": ("solvable", "unsolvable", "probe"),
    "share_pot": ("round", "tone_choice", "probe"),
    "wait_or_now": ("delay_choice", "effort_choice", "probe"),
    "steady_hands": ("target", "probe"),
    "four_stalls": ("choice", "probe"),
    "private_dice": ("report", "probe"),
    "stall": ("go", "nogo", "tone_choice", "probe"),
    "weighing_post": (
        "weigh_decision",
        "bribe",
        "overpayment",
        "assistant_mistake",
        "fraud_found",
        "gamble_inspection",
        "luck_token",
        "probe",
    ),
    "road_home": (
        "errand_map",
        "optional_opportunity",
        "fork_choice",
        "blocked_route",
        "fuel_round",
        "effort_hold",
        "probe",
    ),
    "coplay": ("turn", "credit_round", "rating_handoff"),
}

#: Committed ``response_value`` codes per trial type (closed vocabularies).
RESPONSE_CODES: Final[Mapping[str, tuple[str, ...]]] = {
    "go": ("serve",),
    "nogo": ("serve",),
    "sort": ("pile_1", "pile_2", "pile_3", "pile_4"),
    "balloon": ("collect",),
    "solvable": ("skip",),
    "unsolvable": ("skip",),
    "round": ("contribute",),
    "fuel_round": ("contribute",),
    "tone_choice": ("firm", "neutral", "warm"),
    "delay_choice": ("now", "wait"),
    "effort_choice": ("easy", "hard"),
    "target": ("tap",),
    "choice": ("stall_a", "stall_b", "stall_c", "stall_d"),
    "weigh_decision": ("approve", "warn", "fine"),
    "bribe": ("accept", "decline"),
    "overpayment": ("return", "keep"),
    "gamble_inspection": ("gamble", "inspect"),
    "optional_opportunity": ("take", "skip"),
    "fork_choice": ("left", "right"),
    "blocked_route": ("fallback",),
    "probe": ("safe", "risky"),
}

#: ``GameTrialSpec.params`` keys required by formulas, per trial type (scheduler / solver output).
PARAM_KEYS: Final[Mapping[str, tuple[str, ...]]] = {
    "sort": ("rule", "previous_rule", "matches"),
    "balloon": ("risk_colour", "explosion_point", "max_pumps"),
    "solvable": ("problem_id", "min_moves", "skip_icon_ms"),
    "unsolvable": ("problem_id", "skip_icon_ms", "cap_ms"),
    "delay_choice": ("ss_amount", "ss_delay", "ll_amount", "ll_delay"),
    "effort_choice": ("easy_amount", "easy_effort", "hard_amount", "hard_effort"),
    "target": ("distractor",),
    "choice": ("repeat_group_id", "high_variance_stalls"),
    "weigh_decision": ("required_inspections", "compliant_responses"),
    "errand_map": ("map_id", "optimal_order", "optimal_cost", "optimal_fuel", "n_errands"),
    "optional_opportunity": ("mentioning_lines",),
    "fork_choice": ("rule_option", "old_rule_option"),
    "blocked_route": ("map_id", "post_block_optimal_cost"),
    "probe": ("repeat_group_id",),
    "go": ("feedback",),
    "nogo": ("feedback",),
}

#: Performance variable used for shift slopes (stability) per (module, trial type): ``correct`` is the
#: trial correctness, ``tone`` the ordinal tone, ``compliance`` rule compliance.
SHIFT_PERFORMANCE: Final[Mapping[tuple[str, str], str]] = {
    ("card_sort", "sort"): "correct",
    ("dont_tap", "go"): "correct",
    ("dont_tap", "nogo"): "correct",
    ("stall", "tone_choice"): "tone",
    ("weighing_post", "weigh_decision"): "compliance",
    ("road_home", "fork_choice"): "correct",
}

CROSS_MODULE_PROBE_MODULES: Final = (
    "dont_tap",
    "card_sort",
    "balloon",
    "tower",
    "share_pot",
    "wait_or_now",
    "steady_hands",
    "four_stalls",
    "private_dice",
)
CROSS_EPISODE_PROBE_MODULES: Final = ("stall", "weighing_post", "road_home")

TASKS: Final[Mapping[str, TaskSelector]] = {
    s.task: s
    for s in (
        # ---------------------------------------------------------------- Pathway B
        _t("dont_tap.gng", _c("dont_tap", ("main", "pressure"), GNG_TYPES)),
        _t("dont_tap.pressure_block", _c("dont_tap", ("main", "pressure"), GNG_TYPES)),
        _t("card_sort.switch", _c("card_sort", ("initial_rule", "switch_1", "reversal"), ("sort",))),
        _t("balloon.pumping", _c("balloon", ("balloons",), ("balloon",))),
        _t("balloon.collect", _c("balloon", ("balloons",), ("balloon",))),
        _t("balloon.post_explosion", _c("balloon", ("balloons",), ("balloon",))),
        _t("tower.solvable", _c("tower", ("problems",), ("solvable",))),
        _t("tower.unsolvable", _c("tower", ("problems",), ("unsolvable",))),
        _t("tower.post_failure", _c("tower", ("problems",), ("solvable", "unsolvable"))),
        _t("share_pot.rounds", _c("share_pot", ("rounds",), ("round",))),
        _t("share_pot.contribution", _c("share_pot", ("rounds",), ("round",))),
        _t("share_pot.free_rider_rounds", _c("share_pot", ("rounds",), ("round",))),
        _t("share_pot.error_round", _c("share_pot", ("rounds",), ("round",))),
        _t("share_pot.unfair_loss_probe", _c("share_pot", ("tone_probe",), ("tone_choice",))),
        _t("wait_or_now.delay", _c("wait_or_now", ("delay",), ("delay_choice",))),
        _t("wait_or_now.effort", _c("wait_or_now", ("effort",), ("effort_choice",))),
        _t("steady_hands.distractors", _c("steady_hands", ("free", "held"), ("target",))),
        _t("steady_hands.blocks", _c("steady_hands", ("free", "held"), ("target",))),
        _t("four_stalls.choices", _c("four_stalls", ("choices",), ("choice",))),
        _t("four_stalls.repeats", _c("four_stalls", ("choices",), ("choice",))),
        _t("private_dice.reports", _c("private_dice", ("reports",), ("report",))),
        _t(
            "cross_module.rt_trials",
            _c("dont_tap", ("main", "pressure"), ("go",)),
            _c("card_sort", ("initial_rule", "switch_1", "reversal"), ("sort",)),
            _c("steady_hands", ("free", "held"), ("target",)),
            _c("four_stalls", ("choices",), ("choice",)),
        ),
        _t("cross_module.probe_segments", *(_c(m, ("probe",), PROBE) for m in CROSS_MODULE_PROBE_MODULES)),
        _t(
            "cross_module.context_shifts",
            _c("card_sort", ("initial_rule", "switch_1", "reversal"), ("sort",)),
            _c("dont_tap", ("main", "pressure"), GNG_TYPES),
        ),
        # ---------------------------------------------------------------- Pathway A
        _t("stall.dont_serve", _c("stall", ("service", "timed_rush"), GNG_TYPES)),
        _t("stall.timed_rush", _c("stall", ("service", "timed_rush"), GNG_TYPES)),
        _t("stall.feedback_recovery", _c("stall", ("service",), GNG_TYPES)),
        _t("stall.tone_choices", _c("stall", ("tone_calm", "rude_run"), ("tone_choice",))),
        _t("stall.rude_run", _c("stall", ("tone_calm", "rude_run"), ("tone_choice",))),
        _t("weighing_post.decisions", _c("weighing_post", ("decisions_pre", "decisions_post"), ("weigh_decision",))),
        _t("weighing_post.new_rule", _c("weighing_post", ("decisions_pre", "decisions_post"), ("weigh_decision",))),
        _t("weighing_post.bribe", _c("weighing_post", ("dilemmas",), ("bribe",))),
        _t("weighing_post.overpayment", _c("weighing_post", ("dilemmas",), ("overpayment",))),
        _t("weighing_post.assistant_mistake", _c("weighing_post", ("dilemmas",), ("assistant_mistake",))),
        _t("weighing_post.fraud_found", _c("weighing_post", ("dilemmas",), ("fraud_found",))),
        _t("weighing_post.dilemmas", _c("weighing_post", ("dilemmas",), ("assistant_mistake", "fraud_found"))),
        _t("weighing_post.gamble_inspection", _c("weighing_post", ("gamble",), ("gamble_inspection",))),
        _t("weighing_post.luck_tokens", _c("weighing_post", ("luck_tokens",), ("luck_token",))),
        _t("road_home.errands", _c("road_home", ("errand_maps",), ("errand_map",))),
        _t("road_home.resource_planning", _c("road_home", ("errand_maps",), ("errand_map",))),
        _t("road_home.route_planning", _c("road_home", ("errand_maps",), ("errand_map",))),
        _t("road_home.optional", _c("road_home", ("errand_maps",), ("optional_opportunity",))),
        _t("road_home.blocked_route", _c("road_home", ("blocked_road",), ("blocked_route",))),
        _t("road_home.reversal", _c("road_home", ("errand_maps", "reversal"), ("fork_choice",))),
        _t("road_home.fuel_pot", _c("road_home", ("fuel_pot",), ("fuel_round",))),
        _t("road_home.partner_error", _c("road_home", ("fuel_pot",), ("fuel_round",))),
        _t("road_home.uphill_effort", _c("road_home", ("uphill",), ("effort_hold",))),
        _t("coplay.turn_taking", _c("coplay", ("turns",), ("turn",))),
        _t("coplay.credit_round", _c("coplay", ("credit_round",), ("credit_round",))),
        _t(
            "cross_episode.rt_trials",
            _c("stall", ("service", "timed_rush"), ("go",)),
            _c("weighing_post", ("decisions_pre", "decisions_post"), ("weigh_decision",)),
            _c("road_home", ("errand_maps", "reversal"), ("fork_choice",)),
        ),
        _t("cross_episode.probes", *(_c(m, ("probe",), PROBE) for m in CROSS_EPISODE_PROBE_MODULES)),
        _t("cross_episode.probe_segments", *(_c(m, ("probe",), PROBE) for m in CROSS_EPISODE_PROBE_MODULES)),
        _t(
            "cross_episode.context_shifts",
            _c("stall", ("tone_calm", "rude_run"), ("tone_choice",)),
            _c("weighing_post", ("decisions_pre", "decisions_post"), ("weigh_decision",)),
            _c("road_home", ("errand_maps", "reversal"), ("fork_choice",)),
        ),
    )
}

#: Context-shift kinds that define pre/post contrasts per module (plan SCR-06: switch points come only
#: from ``context_shift`` events). Pressure contrasts use ``condition.phase == pressure`` instead.
SHIFT_KINDS: Final[Mapping[str, tuple[str, ...]]] = {
    "card_sort": ("rule_switch", "rule_reversal"),
    "stall": ("rude_customer_run",),
    "weighing_post": ("new_market_rule",),
    "road_home": ("rule_reversal",),
}


def phase_mismatches(
    dictionary_phases: Mapping[str, tuple[str, ...]], block_phases: Mapping[tuple[str, str], str]
) -> list[tuple[str, str, str, str]]:
    """Blocks a task selects whose content-config phase is not in the dictionary's ``phases``.

    ``dictionary_phases`` maps indicator id -> (task, phases...) flattened as {indicator: (task, *phases)};
    ``block_phases`` maps (module, block) -> phase. Returns (indicator, task, block, block_phase) tuples.
    """
    out: list[tuple[str, str, str, str]] = []
    for indicator, (task, *phases) in sorted(dictionary_phases.items()):
        selector = TASKS.get(task)
        if selector is None:
            continue
        for comp in selector.components:
            for block in comp.blocks:
                phase = block_phases.get((comp.module_id, block))
                if phase is not None and phase not in phases:
                    out.append((indicator, task, f"{comp.module_id}.{block}", phase))
    return out
