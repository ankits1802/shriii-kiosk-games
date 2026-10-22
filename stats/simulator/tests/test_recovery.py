"""Parameter recovery: the scoring + validation pipeline recovers planted parameters (QA-02, plan section 9.2).

Heavy runs (RECOVERY_N persons x 2 parallel occasions per pathway) are marked slow. Recovery shows that the
pipeline is internally correct; it is not evidence that the games measure the traits.
"""

from __future__ import annotations

import gc
import math
from typing import Any, cast

import numpy as np
import pytest
import yaml
from shriii_contracts.paths import scoring_dir
from shriii_scoring.criterion import score_criterion
from shriii_scoring.engine import IndicatorEngine
from shriii_simulator.criterion import simulate_criterion
from shriii_simulator.recovery import RecoveryReport, run_recovery
from shriii_simulator.session import simulate_study
from shriii_validation.validity import evaluate_hypotheses

#: Slow recovery design: RECOVERY_N persons x 2 parallel occasions per pathway, replicated over
#: RECOVERY_SEEDS. The criterion r >= sqrt(rel) - .05 compares two sample correlations; from one n = 400 study
#: the standard error of their difference (~.03, more for low-reliability indicators) is close to the .05
#: tolerance, so a single draw failed indicators whose population gap is about -.01 (Pathway A on the Linux
#: runner: optional actions and errand order missed by .001, while the Windows draw and VAL-02 at n = 500
#: pass them with >= .02 margin; the simulated draw differs by platform through libm rounding). The core
#: criterion is therefore applied to the replicate means (Fisher z) of r and of the parallel reliability.
#: The criterion and tolerance are unchanged.
RECOVERY_N = 400
RECOVERY_SEEDS = (11, 12, 13)

#: Smoke-run size: risk_preference.adjusted_pumps needs 10 unexploded balloons, which about 20% of simulated
#: sessions miss, so at n = 40 the paired count sat exactly at min_n = 30 and fell below it on some platforms.
SMOKE_N = 60

#: Indicators whose simulated true score is dominated by one planted latent: the plan criterion
#: r(estimate, latent) >= sqrt(parallel-form reliability) - .05 is asserted for these.
CORE = {
    "B": [
        "adaptability.perseverative_errors",
        "composure.pressure_slope_rt",
        "decisiveness.commit_rvi",
        "decisiveness.reversals_before_confirm",
        "decisiveness.time_to_collect",
        "expressive_restraint.premature_taps",
        "initiative.unprompted_share",
        "persistence.give_up",
        "persistence.time_on_unsolvable",
        "problem_solving.excess_moves",
        "risk_preference.adjusted_pumps",
        "task_organisation.illegal_move_attempts",
        "teamwork.mean_contribution",
    ],
    "A": [
        "adaptability.reversal_trials_to_reacquire",
        "decisiveness.info_gathered",
        "decisiveness.reversals_before_confirm",
        "decisiveness.time_to_commit",
        "emotional_regulation.mirroring",
        "emotional_regulation.tone_after_provocation",
        "initiative.optional_actions_unprompted",
        "integrity.bribe_acceptance",
        "judgement.credit_taking",
        "problem_solving.excess_route_cost",
        "problem_solving.replan_quality",
        "response_consistency.rt_rvi",
        "task_organisation.errand_order_efficiency",
        "task_organisation.idle_time",
        "teamwork.coplay_credit_share",
        "teamwork.mean_contribution",
        "teamwork.turn_waiting",
    ],
}

#: Indicators with low signal or deliberately shared variance in the generative model (documented):
#: difference scores and shift slopes overlap composure / adaptability / stability by design, the error-type
#: shift's sign depends on whether pressure costs speed or inhibition, and lag-1 autocorrelation over
#: 2-4 trial probe runs is dominated by sampling noise.
KNOWN_LOW_SIGNAL = {
    "composure.error_type_shift",
    "composure.pressure_slope_accuracy",
    "persistence_of_style.lag1_autocorr",
    "persistence_of_style.post_loss_adjustment",
    "emotional_regulation.recovery_after_feedback",
    "stability.shift_slope",
    "stability.shift_slope_pressure",
    "stability.shift_slope_rule_switch",
    "stability.shift_slope_new_rule",
    "stability.shift_slope_reversal",
    "response_consistency.choice_entropy_repeats",
    "judgement.consistency_across_dilemmas",
    # Scorable since the 2026-10 indicator review (docs/science/indicator-review.md). The simulator plants no
    # restraint effect on inter-tap-interval variability, and the rude-run shift slope contrasts tone under
    # rude vs calm customers, which the generative model drives by emotional regulation, not stability.
    "expressive_restraint.iti_rvi",
    "stability.shift_slope_rude_run",
}


def _zmean(values: list[float]) -> float:
    """Mean of correlations on the Fisher-z scale."""
    return math.tanh(float(np.mean([math.atanh(max(-0.999999, min(0.999999, v))) for v in values])))


def _pooled(reports: list[RecoveryReport]) -> dict[str, tuple[float, float, float]]:
    """Per indicator scored in every replicate: (mean r latent, mean parallel reliability, threshold)."""
    by = [r.by_id() for r in reports]
    common = set(by[0]).intersection(*by[1:])
    out: dict[str, tuple[float, float, float]] = {}
    for ind in sorted(common):
        rows = [b[ind] for b in by]
        r_lat = _zmean([x.r_latent for x in rows])
        rel = _zmean([x.parallel_reliability for x in rows])
        threshold = rows[0].purity * math.sqrt(max(rel, 0.0)) - reports[0].tolerance
        out[ind] = (r_lat, rel, threshold)
    return out


def _check_core(reports: list[RecoveryReport]) -> None:
    pooled = _pooled(reports)
    failures = []
    for ind in CORE[reports[0].pathway]:
        assert ind in pooled, f"{ind} not scored in every replicate"
        r_lat, rel, threshold = pooled[ind]
        if not r_lat >= threshold:
            failures.append(f"{ind}: mean r={r_lat:.3f} < sqrt({rel:.3f}) - .05 = {threshold:.3f}")
    assert not failures, failures


def _check_directional(reports: list[RecoveryReport]) -> None:
    for ind, (r_lat, _, _) in _pooled(reports).items():
        if ind in KNOWN_LOW_SIGNAL:
            continue
        assert r_lat > 0.1, f"{ind}: mean r={r_lat:.3f}"


def test_fast_recovery_smoke() -> None:
    report = run_recovery(SMOKE_N, "B", seed=21, min_n=30)
    by = report.by_id()
    for ind in (
        "self_control.nogo_commission_rate",
        "risk_preference.adjusted_pumps",
        "teamwork.mean_contribution",
        "problem_solving.excess_moves",
    ):
        assert by[ind].r_latent > 0.5, ind


def _summary_only(report: RecoveryReport) -> RecoveryReport:
    """Keep the per-indicator results and drop the simulated events and scoring rows: the module-scoped
    fixtures would otherwise hold every replicate's full study in memory at once."""
    light = RecoveryReport(
        pathway=report.pathway,
        n_persons=report.n_persons,
        tolerance=report.tolerance,
        results=report.results,
        study=cast(Any, None),
        scoring=cast(Any, None),
        skipped=report.skipped,
    )
    del report
    gc.collect()
    return light


@pytest.fixture(scope="module")
def reports_b() -> list[RecoveryReport]:
    return [_summary_only(run_recovery(RECOVERY_N, "B", seed=s)) for s in RECOVERY_SEEDS]


@pytest.fixture(scope="module")
def reports_a() -> list[RecoveryReport]:
    return [_summary_only(run_recovery(RECOVERY_N, "A", seed=s)) for s in RECOVERY_SEEDS]


@pytest.mark.slow
def test_recovery_pathway_b(reports_b: list[RecoveryReport]) -> None:
    _check_core(reports_b)
    _check_directional(reports_b)


@pytest.mark.slow
def test_recovery_pathway_a(reports_a: list[RecoveryReport]) -> None:
    _check_core(reports_a)
    _check_directional(reports_a)


@pytest.mark.slow
def test_model_based_slope_reliability_near_parallel_form(
    reports_b: list[RecoveryReport], reports_a: list[RecoveryReport]
) -> None:
    # Mean gap over the replicate studies (same rule as the core criterion): a single study's gap
    # between two reliability estimates of the same data is noise-sensitive (mirroring ranged .02-.10
    # across seeds once the wave 2 dictionary phases changed the simulated trial streams).
    for reports, ind in (
        (reports_b, "composure.pressure_slope_rt"),
        (reports_a, "emotional_regulation.mirroring"),
    ):
        gaps = []
        for report in reports:
            r = report.by_id()[ind]
            assert r.model_reliability is not None
            gaps.append(abs(r.model_reliability - r.parallel_reliability))
        assert sum(gaps) / len(gaps) <= 0.06, (ind, gaps)


@pytest.mark.slow
def test_mtmm_pattern_recovered_from_simulated_battery() -> None:
    study = simulate_study(500, "B", seed=31)
    engine = IndicatorEngine(pathways=("B",), allow_synthetic=True, partition_keys=("pathway",))
    scored = engine.score(study.events, study.trial_params)
    persons = study.persons
    crit = simulate_criterion(persons, seed=32)
    scores = score_criterion(crit.responses, attention_key=crit.attention_key, performance_keys=crit.performance_keys)
    pid_index = {p.pid: i for i, p in enumerate(persons)}
    n = len(persons)
    indicators: dict[str, np.ndarray] = {}
    signs: dict[str, int] = {}
    for row in scored.rows:
        if row.status != "ok" or row.value is None or row.participant_pid is None:
            continue
        arr = indicators.setdefault(row.indicator_id, np.full(n, np.nan))
        arr[pid_index[row.participant_pid]] = row.value
        signs[row.indicator_id] = 1 if row.direction == "higher_more" else -1
    criteria: dict[str, np.ndarray] = {}
    for s in scores.scores:
        key = f"{s['instrument_id']}.{s['scale_id']}"
        arr = criteria.setdefault(key, np.full(n, np.nan))
        if s["score"] is not None:
            arr[pid_index[s["pid"]]] = s["score"]
    hyp = yaml.safe_load((scoring_dir() / "hypotheses.yaml").read_text(encoding="utf-8"))
    out = {
        r.hypothesis_id: r
        for r in evaluate_hypotheses(hyp, indicators, criteria, indicator_signs=signs, pathway="B", n_boot=300)
    }
    for hid in ("h1.self_control", "h1.risk_preference", "h1.teamwork", "h1.problem_solving", "h1.decisiveness"):
        assert out[hid].passed, (hid, out[hid].estimate, out[hid].ci_low)
    assert out["hp.self_control"].passed
    est = out["h1.self_control"].estimate
    assert est is not None and math.isfinite(est)
