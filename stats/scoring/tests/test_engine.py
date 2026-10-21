"""Engine end-to-end on simulated, contract-valid sessions: provenance, invariance, reproducibility, statuses."""

from __future__ import annotations

import copy
import random
from collections import Counter

import pytest
from shriii_scoring.canonical import canonicalise
from shriii_scoring.engine import GroupIndicatorRow, IndicatorEngine, ScoringResult
from shriii_scoring.formulas import MissingTrialParamsError
from shriii_simulator.session import SimulatedStudy


def test_every_row_has_lineage(scored_b: ScoringResult, scored_a: ScoringResult) -> None:
    for res in (scored_b, scored_a):
        assert res.rows
        for r in res.rows:
            assert r.scoring_run_id == res.manifest.scoring_run_id
            assert len(r.dictionary_sha256) == 64 and len(r.shared_sha256) == 64 and len(r.params_sha256) == 64
            assert r.algorithm_version and r.dictionary_version
            assert r.exploratory  # v0 dictionaries are unfrozen
            if r.status == "ok":
                assert r.source_seq_min is not None and r.source_seq_max is not None
                assert r.source_seq_min <= r.source_seq_max
                assert r.value is not None


def test_most_scored_indicators_are_ok(scored_b: ScoringResult, scored_a: ScoringResult) -> None:
    for res in (scored_b, scored_a):
        by = Counter(r.indicator_id for r in res.rows if r.status == "ok")
        ids = {r.indicator_id for r in res.rows}
        assert len(by) >= 0.7 * len(ids)


def test_planned_missing_and_group_only_statuses(scored_b: ScoringResult) -> None:
    statuses = Counter((r.indicator_id, r.status) for r in scored_b.rows)
    assert statuses[("integrity.dice_overreport_rate", "ok")] == 0
    assert any(s == "planned_missing" for (_, s) in statuses)
    assert all(r.value is None for r in scored_b.rows if r.status == "group_only")
    for g in scored_b.group_rows:
        assert isinstance(g, GroupIndicatorRow)
        assert not hasattr(g, "session_id") and not hasattr(g, "participant_pid")


def test_single_event_indicators_are_not_individually_scorable(scored_b: ScoringResult) -> None:
    rows = [r for r in scored_b.rows if r.indicator_id == "teamwork.response_to_partner_error"]
    assert rows and all(r.status in ("unscorable_individual", "insufficient_trials") for r in rows)
    assert all(not r.gate_eligible for r in rows)


def test_withheld_constructs_are_flagged(scored_b: ScoringResult) -> None:
    rows = [r for r in scored_b.rows if r.construct == "emotional_regulation"]
    assert rows and all("construct_withheld_for_pathway" in r.flags for r in rows)


def test_row_order_invariance(engine: IndicatorEngine, study_b: SimulatedStudy, scored_b: ScoringResult) -> None:
    events = copy.deepcopy(study_b.events)
    random.Random(5).shuffle(events)
    res = engine.score(events, study_b.trial_params)
    a = {(r.session_id, r.indicator_id): (r.status, r.value) for r in scored_b.rows}
    b = {(r.session_id, r.indicator_id): (r.status, r.value) for r in res.rows}
    assert a.keys() == b.keys()
    for k, (st_a, v_a) in a.items():
        st_b, v_b = b[k]
        assert st_a == st_b
        assert (v_a is None and v_b is None) or v_a == pytest.approx(v_b, abs=1e-8)
    assert res.manifest.scoring_run_id == scored_b.manifest.scoring_run_id


def test_duplicates_do_not_change_results(
    engine: IndicatorEngine, study_b: SimulatedStudy, scored_b: ScoringResult
) -> None:
    events = study_b.events + copy.deepcopy(study_b.events[:500])
    res = engine.score(events, study_b.trial_params)
    assert [r.value for r in res.rows] == [r.value for r in scored_b.rows]


def test_synthetic_sessions_are_excluded_by_default(study_b: SimulatedStudy) -> None:
    engine = IndicatorEngine(pathways=("B",))
    res = engine.score(study_b.sessions[0].events, study_b.trial_params)
    assert {r.status for r in res.rows} <= {"session_excluded", "planned_missing", "module_absent", "not_applicable"}


def test_missing_trial_params_fail_fast(engine: IndicatorEngine, study_b: SimulatedStudy) -> None:
    with pytest.raises(MissingTrialParamsError):
        engine.score(study_b.sessions[0].events, None)
    lenient = IndicatorEngine(
        pathways=("B",), allow_synthetic=True, partition_keys=("pathway",), on_missing_params="flag"
    )
    res = lenient.score(study_b.sessions[0].events, None)
    assert any(r.status == "error" and "missing_trial_params" in r.flags for r in res.rows)


def test_consistency_warnings_are_reported(engine: IndicatorEngine, scored_a: ScoringResult) -> None:
    assert scored_a.manifest.consistency_warnings == tuple(engine.consistency_warnings)
    assert any("weighing_post.decisions" in w for w in engine.consistency_warnings)


def test_model_partitions_report_reliability(scored_b: ScoringResult) -> None:
    slopes = [pm for pm in scored_b.partition_models if pm.indicator_id == "composure.pressure_slope_rt"]
    assert slopes and slopes[0].details["method"] == "lmm_reml_random_slope"
    assert 0.0 <= slopes[0].details["model_reliability"] <= 1.0
    rows = [r for r in scored_b.rows if r.indicator_id == "composure.pressure_slope_rt" and r.status == "ok"]
    assert rows and all(r.se is not None and "descriptive_delta" in r.details for r in rows)


def test_to_polars_and_wide(scored_b: ScoringResult) -> None:
    df = scored_b.to_polars()
    assert df.height == len(scored_b.rows)
    wide = scored_b.wide()
    first = next(iter(wide.values()))
    assert "calibration_level" in first and "self_control.nogo_commission_rate" in first


def test_canonicalise_detects_gaps_and_conflicts(study_b: SimulatedStudy) -> None:
    events = copy.deepcopy(study_b.sessions[0].events)
    del events[10]
    clash = copy.deepcopy(events[20])
    clash["event_id"] = clash["event_id"][:-4] + "ffff"
    events.append(clash)
    s = canonicalise(events, None)[0]
    assert 10 in s.seq_gaps
    assert events[20]["seq"] in s.seq_conflicts
