"""Parameter recovery: the scoring + validation pipeline recovers planted parameters (QA-02, plan section 9.2).

Heavy runs (400 persons x 2 parallel occasions per pathway) are marked slow. Recovery shows that the
pipeline is internally correct; it is not evidence that the games measure the traits.
"""

from __future__ import annotations

import math

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
}


def _check_core(report: RecoveryReport) -> None:
    by = report.by_id()
    failures = []
    for ind in CORE[report.pathway]:
        r = by[ind]
        if not r.passed:
            failures.append(f"{ind}: r={r.r_latent:.3f} < sqrt({r.parallel_reliability:.3f}) - .05 = {r.threshold:.3f}")
    assert not failures, failures


def _check_directional(report: RecoveryReport) -> None:
    for r in report.results:
        if r.indicator_id in KNOWN_LOW_SIGNAL:
            continue
        assert r.r_latent > 0.1, f"{r.indicator_id}: r={r.r_latent:.3f}"


def test_fast_recovery_smoke() -> None:
    report = run_recovery(40, "B", seed=21, min_n=30)
    by = report.by_id()
    for ind in (
        "self_control.nogo_commission_rate",
        "risk_preference.adjusted_pumps",
        "teamwork.mean_contribution",
        "problem_solving.excess_moves",
    ):
        assert by[ind].r_latent > 0.5, ind


@pytest.fixture(scope="module")
def report_b() -> RecoveryReport:
    return run_recovery(400, "B", seed=11)


@pytest.fixture(scope="module")
def report_a() -> RecoveryReport:
    return run_recovery(400, "A", seed=11)


@pytest.mark.slow
def test_recovery_pathway_b(report_b: RecoveryReport) -> None:
    _check_core(report_b)
    _check_directional(report_b)


@pytest.mark.slow
def test_recovery_pathway_a(report_a: RecoveryReport) -> None:
    _check_core(report_a)
    _check_directional(report_a)


@pytest.mark.slow
def test_model_based_slope_reliability_near_parallel_form(report_b: RecoveryReport, report_a: RecoveryReport) -> None:
    for report, ind in ((report_b, "composure.pressure_slope_rt"), (report_a, "emotional_regulation.mirroring")):
        r = report.by_id()[ind]
        assert r.model_reliability is not None
        gap = abs(r.model_reliability - r.parallel_reliability)
        assert gap <= 0.06, (ind, r.model_reliability, r.parallel_reliability)


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
