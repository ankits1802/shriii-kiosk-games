"""Predictive validity (leakage guards, grouped nested CV, incremental validity) and weighted norming."""

from __future__ import annotations

import numpy as np
import pytest
from shriii_validation.norming import (
    continuous_norms,
    kish_effective_n,
    percentile_norms,
    percentile_rank,
    poststratification_weights,
    rake,
    weighted_quantile,
)
from shriii_validation.prediction import (
    LeakageError,
    assert_no_group_leakage,
    grouped_cv,
    hierarchical_regression,
    holdout_split,
    predictive_comparisons,
)


def test_leakage_guard() -> None:
    assert_no_group_leakage(["a", "b"], ["c"])
    with pytest.raises(LeakageError):
        assert_no_group_leakage(["a", "b"], ["b", "c"])


def test_holdout_is_deterministic_and_participant_level() -> None:
    ids = np.array([f"P{i:04d}" for i in range(500)] * 2)  # two occasions per participant
    dev, hold = holdout_split(ids, fraction=0.2)
    _, hold2 = holdout_split(ids, fraction=0.2)
    assert (hold == hold2).all()
    assert set(ids[dev]).isdisjoint(set(ids[hold]))
    assert 0.12 < hold.mean() < 0.28


def _data(n: int, seed: int) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    pid = np.repeat(np.arange(n // 2), 2).astype(str)  # two rows (occasions) per participant
    g1 = rng.normal(size=n)
    g2 = rng.normal(size=n)
    b1 = rng.normal(size=n)
    outcome = 0.4 * g1 + 0.4 * b1 + rng.normal(size=n)
    crit = 0.6 * g2 + rng.normal(size=n)
    return {"pid": pid, "g1": g1, "g2": g2, "b1": b1, "outcome": outcome, "criterion": crit}


def test_grouped_cv_recovers_signal_without_leakage() -> None:
    d = _data(400, 1)
    rep = grouped_cv(
        np.column_stack([d["g2"]]), d["criterion"], d["pid"], model="ridge", outer_folds=5, inner_folds=3, n_boot=200
    )
    assert rep.cv_r2.estimate == pytest.approx(0.6**2 / (0.36 + 1), abs=0.08)
    assert rep.cv_r2.lo < rep.cv_r2.est < rep.cv_r2.hi
    assert len(rep.fold_metrics) == 5


def test_four_comparisons_and_incremental_validity() -> None:
    d = _data(400, 2)
    out = predictive_comparisons(
        d,
        participant="pid",
        game_features=["g1", "g2"],
        battery_features=["b1"],
        criterion="criterion",
        outcome="outcome",
        models=("ridge",),
        min_n=100,
        n_boot=100,
    )
    assert set(out) >= {
        "criterion_from_game",
        "outcome_from_battery",
        "outcome_from_game",
        "outcome_from_game_and_battery",
        "incremental_cv_r2",
    }
    inc = out["incremental_cv_r2"]
    assert not isinstance(inc, dict) and inc.estimate is not None and inc.estimate > 0.05
    assert inc.ci_low is not None and inc.ci_high is not None
    assert 0.0 < inc.ci_low < inc.estimate < inc.ci_high
    assert inc.details["primary_model"] == "ridge"
    refused = predictive_comparisons(
        d,
        participant="pid",
        game_features=["g1"],
        battery_features=["b1"],
        criterion=None,
        outcome="outcome",
        models=("ridge",),
        min_n=10_000,
    )
    assert not isinstance(refused["outcome_from_game"], dict) and refused["outcome_from_game"].status == "insufficient"


@pytest.mark.slow
def test_all_model_families_run_grouped_and_nested() -> None:
    d = _data(300, 9)
    out = predictive_comparisons(
        d,
        participant="pid",
        game_features=["g1", "g2"],
        battery_features=["b1"],
        criterion="criterion",
        outcome="outcome",
        min_n=100,
        n_boot=100,
    )
    full = out["outcome_from_game_and_battery"]
    assert isinstance(full, dict) and set(full) == {"ridge", "elastic_net", "random_forest", "xgboost"}
    for rep in full.values():
        assert rep.cv_r2.estimate is not None and len(rep.best_params) == 5


def test_hierarchical_regression_delta_r2() -> None:
    d = _data(600, 3)
    steps = hierarchical_regression(d["outcome"], [d["b1"], d["g1"]], d["pid"], names=["battery", "game"], n_boot=200)
    assert steps[1].details["block"] == "game"
    assert steps[1].estimate == pytest.approx(0.16 / 1.32, abs=0.05)
    assert steps[1].lo > 0
    small = hierarchical_regression(d["outcome"][:50], [d["b1"][:50]], d["pid"][:50])
    assert small[0].status == "insufficient"


def test_weights_and_effective_n() -> None:
    cells = ["a"] * 80 + ["b"] * 20
    w = poststratification_weights(cells, {"a": 0.5, "b": 0.5}, trim_ratio=10)
    assert w[:80].mean() == pytest.approx(0.625) and w[80:].mean() == pytest.approx(2.5)
    assert kish_effective_n(np.ones(50)) == pytest.approx(50.0)
    assert kish_effective_n(w) < 100
    trimmed = poststratification_weights(cells, {"a": 0.5, "b": 0.5}, trim_ratio=2)
    assert trimmed.max() / np.median(trimmed[trimmed > 0]) <= 2.0 + 1e-9 or trimmed.max() < w.max()


def test_raking_matches_margins() -> None:
    rng = np.random.default_rng(4)
    gender = rng.choice(["w", "m"], 2000, p=[0.3, 0.7])
    edu = rng.choice(["low", "high"], 2000, p=[0.6, 0.4])
    w = rake(
        {"gender": gender, "edu": edu},
        {"gender": {"w": 0.5, "m": 0.5}, "edu": {"low": 0.5, "high": 0.5}},
        trim_ratio=50,
    )
    assert w[gender == "w"].sum() / w.sum() == pytest.approx(0.5, abs=1e-3)
    assert w[edu == "low"].sum() / w.sum() == pytest.approx(0.5, abs=1e-3)


def test_weighted_percentile_norms() -> None:
    rng = np.random.default_rng(5)
    n = 3000
    age = rng.choice(["18_24", "25_34"], n)
    edu = rng.choice(["primary", "secondary"], n)
    score = rng.normal(size=n) + (age == "25_34") * 0.5
    table = percentile_norms(score, age, edu, np.ones(n), trait="self_control", norm_table_version="0.1.0")
    assert table.publishable and len(table.cells) == 4
    assert table.pooled.percentiles[50] == pytest.approx(np.median(score), abs=0.05)
    cell = next(c for c in table.cells if c.cell == "25_34|primary")
    assert percentile_rank(cell.percentiles[50], cell) == pytest.approx(50.0)
    assert weighted_quantile([1, 2, 3, 4], [1, 1, 1, 1], 0.5) == pytest.approx(2.5)
    tiny = percentile_norms(
        score[:40], age[:40], edu[:40], np.ones(40), trait="self_control", norm_table_version="0.1.0"
    )
    assert all(c.suppressed for c in tiny.cells)
    assert tiny.pooled.provisional


def test_continuous_norms_need_r() -> None:
    res = continuous_norms([1.0, 2.0], [20, 30])
    assert res.status == "not_available" and "R" in res.warnings[0]
