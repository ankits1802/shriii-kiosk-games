"""VAL-02 machinery: Spearman-Brown projection, study engine, design scaling, effort designs, indicator fixes."""

from __future__ import annotations

import math
from collections import Counter
from typing import Literal

import numpy as np
import pytest
import yaml
from shriii_contracts.paths import scoring_dir
from shriii_simulator.discounting_design import EffortDesign, simulate_effort_choices
from shriii_simulator.params import load_sim_params
from shriii_simulator.session import simulate_study
from shriii_simulator.studies import IndicatorStat, StudyEngine, parallel_stats, simulate_parallel
from shriii_simulator.val02 import (
    fit_spearman_brown,
    load_val02_config,
    render_markdown,
    required_units,
    scheduled_seconds,
    spearman_brown,
    summarise_requirements,
)


def test_spearman_brown_round_trip() -> None:
    assert spearman_brown(1, 0.3) == pytest.approx(0.3)
    assert spearman_brown(4, 0.2) == pytest.approx(0.5)
    for rho in (0.02, 0.1, 0.4):
        for target in (0.6, 0.7):
            n = required_units(target, rho)
            assert spearman_brown(n, rho) == pytest.approx(target)
    assert required_units(0.6, 0.0) == math.inf
    assert required_units(0.6, 0.8) == 1.0


def test_spearman_brown_fit_recovers_single_unit_reliability() -> None:
    rho = 0.08
    pts = [(n, spearman_brown(n, rho)) for n in (5, 10, 20, 40)]
    est, rmse = fit_spearman_brown(pts)
    assert est == pytest.approx(rho, abs=1e-4)
    assert rmse < 1e-4
    assert math.isnan(fit_spearman_brown([])[0])


def test_config_has_targets_and_profiles() -> None:
    cfg = load_val02_config("local")
    assert cfg.targets == (0.6, 0.7)
    assert cfg.n_persons > 0 and cfg.fractions[-1] == 1.0
    full = load_val02_config("full")
    assert full.n_persons >= cfg.n_persons and len(full.fractions) >= len(cfg.fractions)
    assert {d.name for d in full.effort_designs} >= {"fixed4_v0", "titrated8"}


def test_scheduled_seconds_use_content_configs() -> None:
    engine = StudyEngine(pathways=("B",))
    trials, seconds = scheduled_seconds(engine, "B", "self_control.nogo_commission_rate", "L2")
    # Don't-Tap main + pressure blocks: 68 trials at 1.17 s (L2 median, content/games/pathway-b/dont-tap.json).
    assert trials == 68
    assert seconds == pytest.approx(68 * 1.17)


def test_summarise_requirements_verdicts() -> None:
    cfg = load_val02_config("local")

    def stat(n: float, rel: float) -> IndicatorStat:
        return IndicatorStat("self_control.nogo_commission_rate", "self_control", 100, n, 0.7, rel, None, None)

    rho = 0.05
    curves = {
        (1.0, 0.5): {"self_control.nogo_commission_rate": [stat(11, spearman_brown(11, rho))]},
        (1.0, 1.0): {"self_control.nogo_commission_rate": [stat(22, spearman_brown(22, rho))]},
    }
    (req,) = summarise_requirements(cfg, "B", curves)
    assert req.rho == pytest.approx(rho, abs=1e-3)
    assert req.required["0.6"] == math.ceil(required_units(0.6, rho))
    assert req.verdict["0.6"] == "needs_more_trials"
    assert req.seconds_per_unit == pytest.approx(68 * 1.17 / 22)
    md = render_markdown(
        {
            "profile": "test",
            "n_persons": 100,
            "seeds": [1],
            "fractions": [0.5, 1.0],
            "scales": [1.0],
            "targets": [0.6, 0.7],
            "requirements": [
                {
                    **{k: getattr(req, k) for k in req.__dataclass_fields__},
                    "points": [p.__dict__ if hasattr(p, "__dict__") else _asdict(p) for p in req.points],
                }
            ],
        }
    )
    assert "self_control.nogo_commission_rate" in md


def _asdict(p: object) -> dict[str, object]:
    return {f: getattr(p, f) for f in p.__dataclass_fields__}  # type: ignore[attr-defined]


def test_design_scale_lengthens_blocks() -> None:
    base = load_sim_params()
    one = simulate_study(1, "B", seed=4, params=base, slot_form="steady_hands")
    two = simulate_study(1, "B", seed=4, params=base.with_overrides({"design.scale": 2.0}), slot_form="steady_hands")

    def counts(study: object) -> Counter[tuple[str, str]]:
        c: Counter[tuple[str, str]] = Counter()
        for e in study.sessions[0].events:  # type: ignore[attr-defined]
            if e["event_type"] == "trial_start":
                c[(e["task"]["module_id"], e["task"]["block_id"])] += 1
        return c

    c1, c2 = counts(one), counts(two)
    assert c1[("dont_tap", "dont_tap.main")] == 36
    assert c2[("dont_tap", "dont_tap.main")] == 72
    assert c2[("card_sort", "card_sort.switch_1")] == 2 * c1[("card_sort", "card_sort.switch_1")]
    assert c2[("steady_hands", "steady_hands.free")] == 60
    assert c1[("tower", "tower.problems")] == c2[("tower", "tower.problems")]  # not scalable


def test_titrated_effort_design_in_the_session_simulator() -> None:
    prm = load_sim_params().with_overrides({"design.wait_or_now.effort_design": "titrated"})
    study = simulate_study(1, "B", seed=8, params=prm, slot_form="wait_or_now")
    s = study.sessions[0]
    offers = [
        s.trial_params[e["task"]["trial_id"]]["hard_amount"]
        for e in s.events
        if e["event_type"] == "trial_start" and e["payload"]["trial_type"] == "effort_choice"
    ]
    assert len(offers) == int(prm.f("design.wait_or_now.effort_titration.trials"))
    assert offers[0] == pytest.approx(prm.f("design.wait_or_now.effort_titration.start_amount"))
    assert len(set(offers)) > 1
    with pytest.raises(ValueError, match="effort design"):
        simulate_study(
            1,
            "B",
            seed=8,
            params=prm.with_overrides({"design.wait_or_now.effort_design": "x"}),
            slot_form="wait_or_now",
        )


def test_effort_staircase_moves_towards_indifference() -> None:
    design = EffortDesign("t", "titrated", trials=8, start_amounts=(6.0,), start_step=2.0)
    rng = np.random.default_rng(0)
    # A chooser who is nearly deterministic and discounts steeply: hard only for large amounts.
    _, _, la, _, y = simulate_effort_choices(design, log_k=1.0, beta=200.0, rng=rng)
    assert len(la) == 8
    # Indifference: A* = 2 (1 + e * 2.5) ~ 15.6 > max 12 -> the staircase climbs to the ceiling.
    assert la[-1] == pytest.approx(12.0, abs=0.6)
    assert sum(y) <= 2
    fixed = EffortDesign("f", "fixed", amounts=(5, 6, 8, 10))
    assert simulate_effort_choices(fixed, -1.0, 8.0, rng)[2] == [5.0, 6.0, 8.0, 10.0]


def test_study_engine_truncates_blocks_and_scores_subsets() -> None:
    study = simulate_parallel(22, "B", seed=5, slot_form="steady_hands")
    ids = ["self_control.nogo_commission_rate", "expressive_restraint.premature_taps"]
    full, _ = parallel_stats(study, StudyEngine(pathways=("B",), indicators=ids), min_n=10)
    half, _ = parallel_stats(study, StudyEngine(pathways=("B",), indicators=ids, fraction=0.5), min_n=10)
    assert set(full) == set(ids)
    for ind in ids:
        assert half[ind].median_n_valid < full[ind].median_n_valid
    assert full["self_control.nogo_commission_rate"].median_n_valid == 22  # 11 no-go per block x 2
    with pytest.raises(ValueError, match="fraction"):
        StudyEngine(pathways=("B",), fraction=0.0)


def test_previously_unscorable_indicators_now_score() -> None:
    """Indicator review fixes: event mappings / minimums that made indicators impossible to score."""
    cases: list[tuple[Literal["A", "B"], list[str]]] = [
        (
            "A",
            ["stability.shift_slope_rude_run", "response_consistency.loc_scale_sigma", "expressive_restraint.iti_rvi"],
        ),
        ("B", ["expressive_restraint.iti_rvi"]),
    ]
    for pathway, ids in cases:
        slot = "steady_hands" if pathway == "B" else None
        study = simulate_study(22, pathway, seed=6, include_coplay=False, slot_form=slot)
        engine = StudyEngine(pathways=(pathway,), indicators=ids, min_valid_override=None, partition_keys=("pathway",))
        result = engine.score(study.events, study.trial_params)
        for ind in ids:
            ok = sum(1 for r in result.rows if r.indicator_id == ind and r.status == "ok")
            assert ok >= 15, (pathway, ind, ok)


def test_not_scorable_v1_indicators_are_marked_and_not_gate_eligible() -> None:
    marked = 0
    for pathway in ("A", "B"):
        doc = yaml.safe_load((scoring_dir() / "dictionary" / f"dictionary.{pathway}.yaml").read_text(encoding="utf-8"))
        for ind in doc["indicators"]:
            notes = ind.get("notes") or ""
            if notes.startswith("not_scorable_v1:"):
                marked += 1
                assert not ind["gate_eligible"], ind["id"]
    assert marked >= 2
