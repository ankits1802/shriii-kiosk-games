"""Planning, problem-solving, organisation and persistence indicators (SCR-05, SCR-07)."""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from shriii_scoring.canonical import Trial
from shriii_scoring.formulas.base import FormulaContext, IndicatorValue, median, need_params, session_formula
from shriii_scoring.numerics import levenshtein


def _legal_moves(t: Trial) -> int:
    return sum(1 for m in t.moves if m.get("legal", True))


def _solved(t: Trial) -> bool:
    return t.outcome == "correct" or t.trial_correctness is True


def _first_move_ms(t: Trial) -> float | None:
    if not t.moves:
        return None
    start = t.onset_ms if t.onset_ms is not None else t.start_ms
    return float(min(m["_t_ms"] for m in t.moves)) - start


@session_formula("tower.excess_moves")
def excess_moves(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Legal moves beyond the solver optimum summed over solved problems (optimal bot = 0).

    When some solvable problems are unsolved, the sum is prorated to all presented solvable problems and
    flagged ``prorated_unsolved``. ``n_valid`` = solvable problems presented.
    """
    solved = [t for t in trials if _solved(t)]
    if not solved:
        return IndicatorValue.empty(len(trials), "no_solved_problems")
    excess = [max(0, _legal_moves(t) - int(need_params(t, "min_moves")["min_moves"])) for t in solved]
    total = float(sum(excess))
    flags: tuple[str, ...] = ()
    if len(solved) < len(trials):
        total *= len(trials) / len(solved)
        flags = ("prorated_unsolved",)
    return IndicatorValue(value=total, n_valid=len(trials), flags=flags, details={"solved": len(solved)})


@session_formula("tower.planning_time")
def planning_time(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Median time from problem onset to the first move (ms) on solvable problems."""
    vals = [v for t in trials if (v := _first_move_ms(t)) is not None and v >= 0]
    return IndicatorValue(value=median(vals), n_valid=len(vals))


@session_formula("tower.illegal_move_rate")
def illegal_move_rate(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Illegal move attempts per solvable problem."""
    n = len(trials)
    k = sum(1 for t in trials for m in t.moves if not m.get("legal", True))
    return IndicatorValue(value=k / n if n else None, n_valid=n, details={"illegal": k})


def _efficiency(t: Trial) -> float:
    if not _solved(t):
        return 0.0
    moves = _legal_moves(t)
    return float(need_params(t, "min_moves")["min_moves"]) / moves if moves else 0.0


@session_formula("tower.recovery_after_failure")
def recovery_after_failure(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Efficiency (optimum / moves) on solvable problems right after an unsolvable or failed item,
    minus the efficiency on the other solvable problems. ``n_valid`` = post-failure problems."""
    ordered = sorted(trials, key=lambda t: t.trial_index)
    post: list[float] = []
    base: list[float] = []
    prev_failed = False
    for t in ordered:
        if t.trial_type == "solvable":
            (post if prev_failed else base).append(_efficiency(t))
            prev_failed = not _solved(t)
        else:
            prev_failed = True
    if not post or not base:
        return IndicatorValue.empty(len(post), "no_recovery_contrast")
    return IndicatorValue(value=float(np.mean(post) - np.mean(base)), n_valid=len(post))


def _time_on_item_ms(t: Trial) -> float | None:
    start = t.onset_ms if t.onset_ms is not None else t.start_ms
    r = t.response
    if r is not None and r.value == "skip":
        return r.t_ms - start
    if t.end_ms is not None:
        return t.end_ms - start
    return None


@session_formula("tower.time_on_unsolvable")
def time_on_unsolvable(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Mean seconds on unsolvable items before skipping or reaching the cap (items flagged unsolvable only)."""
    vals = [v / 1000.0 for t in trials if t.trial_type == "unsolvable" and (v := _time_on_item_ms(t)) is not None]
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


@session_formula("tower.give_up_rate")
def give_up_rate(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share of unsolvable items skipped within ``tower.give_up_window_ms`` of the skip icon appearing."""
    window = ctx.params.f("tower.give_up_window_ms")
    items = [t for t in trials if t.trial_type == "unsolvable"]
    k = 0
    for t in items:
        r = t.response
        v = _time_on_item_ms(t)
        if r is not None and r.value == "skip" and v is not None:
            icon = float(need_params(t, "skip_icon_ms")["skip_icon_ms"])
            k += v <= icon + window
    n = len(items)
    return IndicatorValue(value=k / n if n else None, n_valid=n, details={"k": k, "n": n})


# ---------------------------------------------------------------- Road Home errands and routes


def _steps(t: Trial) -> list[dict[str, object]]:
    return sorted(
        (dict(s) for s in t.route_steps), key=lambda s: (int(str(s.get("step_index", 0))), float(str(s["_t_ms"])))
    )


@session_formula("errands.order_edit_distance")
def errand_order_efficiency(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """1 - normalised edit distance between the completed errand order and the solver optimum, per map."""
    vals: list[float] = []
    for t in trials:
        optimal = list(need_params(t, "optimal_order")["optimal_order"])
        done = [s["errand_completed"] for s in _steps(t) if s.get("errand_completed")]
        denom = max(len(optimal), len(done), 1)
        vals.append(1.0 - levenshtein(done, optimal) / denom)
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


@session_formula("errands.revisits")
def revisits(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Steps into an already-visited node, per map."""
    vals: list[float] = []
    for t in trials:
        steps = _steps(t)
        visited: set[object] = set()
        count = 0
        for s in steps:
            if not visited:
                visited.add(s["from_node"])
            if s.get("blocked"):
                continue
            if s["to_node"] in visited:
                count += 1
            visited.add(s["to_node"])
        vals.append(float(count))
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


def _idle_threshold(ctx: FormulaContext) -> float:
    cfg = ctx.game_configs.get("road_home") or {}
    value = (cfg.get("constraints") or {}).get("idle_gap_log_ms")
    return float(value) if value is not None else ctx.params.f("errands.idle_gap_fallback_ms")


@session_formula("errands.idle_proportion")
def idle_proportion(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share of map time spent in inactivity gaps longer than the idle threshold (content config).

    Map time runs from the first route step to the end of the map: the pause before the first step is
    planning time (``route.planning_time``), not idleness.
    """
    threshold = _idle_threshold(ctx)
    vals: list[float] = []
    for t in trials:
        times = sorted(float(str(s["_t_ms"])) for s in t.route_steps)
        end = t.end_ms
        if not times or end is None or end <= times[0]:
            continue
        start = times[0]
        marks = [*times, end]
        gaps = np.diff(marks)
        idle = float(np.sum(gaps[gaps > threshold]))
        vals.append(idle / (end - start))
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


@session_formula("errands.fuel_efficiency")
def fuel_efficiency(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """(Errands completed per fuel unit) / (solver errands per fuel unit), per map."""
    vals: list[float] = []
    for t in trials:
        p = need_params(t, "optimal_fuel", "n_errands")
        steps = _steps(t)
        used = sum(int(str(s.get("cost_units", 0))) for s in steps if not s.get("blocked"))
        done = sum(1 for s in steps if s.get("errand_completed"))
        if used <= 0:
            vals.append(0.0)
            continue
        vals.append((done / used) / (float(p["n_errands"]) / float(p["optimal_fuel"])))
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


@session_formula("route.excess_cost")
def excess_route_cost(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """(Route cost - solver optimum) / optimum, per map."""
    vals: list[float] = []
    for t in trials:
        optimal = float(need_params(t, "optimal_cost")["optimal_cost"])
        cost = sum(int(str(s.get("cost_units", 0))) for s in _steps(t) if not s.get("blocked"))
        vals.append((cost - optimal) / optimal if optimal > 0 else 0.0)
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


@session_formula("route.planning_time")
def route_planning_time(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Median time from map onset to the first route step (ms)."""
    vals: list[float] = []
    for t in trials:
        steps = _steps(t)
        if steps:
            start = t.onset_ms if t.onset_ms is not None else t.start_ms
            vals.append(float(str(steps[0]["_t_ms"])) - start)
    return IndicatorValue(value=median(vals), n_valid=len(vals))


@session_formula("route.replan_quality")
def replan_quality(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """1 - (replanned cost - post-block optimum) / optimum, per road-block event (higher = better)."""
    vals: list[float] = []
    for t in trials:
        optimal = float(need_params(t, "post_block_optimal_cost")["post_block_optimal_cost"])
        cost = sum(int(str(s.get("cost_units", 0))) for s in _steps(t) if not s.get("blocked"))
        vals.append(1.0 - (cost - optimal) / optimal if optimal > 0 else 0.0)
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


@session_formula("route.replan_latency")
def replan_latency(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Median time from the road block (trial onset) to the first step of the new route (ms)."""
    return route_planning_time(trials, ctx)


@session_formula("route.retries_after_block")
def retries_after_block(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Attempts down blocked roads (route steps with ``blocked = true``) per road-block event."""
    vals = [float(sum(1 for s in t.route_steps if s.get("blocked"))) for t in trials]
    return IndicatorValue(value=float(np.mean(vals)) if vals else None, n_valid=len(vals))


@session_formula("optional.unprompted_rate")
def optional_unprompted(trials: Sequence[Trial], ctx: FormulaContext) -> IndicatorValue:
    """Share of optional-action opportunities taken (prompted actions are excluded upstream, SCR-07)."""
    n = len(trials)
    k = sum(1 for t in trials if t.response is not None and t.response.value == "take")
    return IndicatorValue(value=k / n if n else None, n_valid=n, details={"k": k, "n": n})
