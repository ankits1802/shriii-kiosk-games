"""Fairness: DIF detection power and type-I rate, TOST logic, differential prediction, calibration, disparity."""

from __future__ import annotations

import numpy as np
import pytest
from shriii_simulator.criterion import simulate_item_responses
from shriii_validation.fairness import (
    calibration_by_group,
    device_familiarity_effect,
    differential_prediction,
    disparity,
    linear_dif,
    logistic_dif,
    ordinal_dif,
    tost_one_sample,
    tost_proportions,
    tost_two_sample,
)


def _dif_rates(reps: int, *, n: int, shift: float, impact: float = 0.0, seed: int = 0) -> tuple[float, float]:
    hits = 0
    fp = 0.0
    for r in range(reps):
        y, g, _ = simulate_item_responses(
            n, 20, seed=seed + r, uniform_dif={0: shift} if shift else None, group_mean_difference=impact
        )
        res = logistic_dif(y, g)
        flagged = set(res.flagged())
        hits += "item_0" in flagged
        fp += len(flagged - {"item_0"}) / 19
    return hits / reps, fp / reps


def test_dif_detects_planted_uniform_dif() -> None:
    power, fp = _dif_rates(20, n=500, shift=1.0, seed=100)
    assert power >= 0.9
    assert fp <= 0.05


def test_dif_not_flagged_for_impact_without_dif() -> None:
    _, fp = _dif_rates(20, n=500, shift=0.0, impact=0.5, seed=200)
    assert fp <= 0.05


@pytest.mark.slow
def test_dif_power_and_type_one_rate_100_replications() -> None:
    power, fp_planted = _dif_rates(100, n=500, shift=1.0, seed=1000)
    _, fp_clean = _dif_rates(100, n=500, shift=0.0, seed=2000)
    assert power >= 0.90  # plan section 9.2 / VAL-09 AC
    assert fp_planted <= 0.05 and fp_clean <= 0.05


def test_nonuniform_dif_and_classification() -> None:
    y, g, _ = simulate_item_responses(800, 15, seed=3, nonuniform_dif={2: -1.2}, uniform_dif={2: 1.0})
    res = logistic_dif(y, g)
    item = next(i for i in res.items if i.item == "item_2")
    assert item.flagged and item.jodoin_gierl in ("B", "C")
    assert item.p_nonuniform < 0.05
    assert "item_2" not in res.anchors


def test_linear_dif_continuous() -> None:
    rng = np.random.default_rng(4)
    n = 600
    g = np.repeat([0, 1], n // 2)
    theta = rng.normal(size=n)
    vals = np.column_stack([theta + rng.normal(size=n) for _ in range(5)])
    vals[:, 0] += 0.6 * g
    rows = linear_dif(vals, g, theta)
    assert rows[0]["flagged"] and not any(r["flagged"] for r in rows[1:])


def test_tost_never_equates_non_significance_with_equivalence() -> None:
    rng = np.random.default_rng(5)
    small = tost_two_sample(rng.normal(0, 1, 15), rng.normal(0, 1, 15), bound=0.2)
    assert not small.details["equivalent"]  # underpowered: no difference found, but no equivalence either
    big = tost_two_sample(rng.normal(0, 1, 4000), rng.normal(0, 1, 4000), bound=0.2)
    assert big.details["equivalent"]
    shifted = tost_two_sample(rng.normal(0.5, 1, 4000), rng.normal(0, 1, 4000), bound=0.2)
    assert not shifted.details["equivalent"]
    honest = tost_one_sample(0.004, 0.008, low=-0.03, high=0.03)
    assert honest.details["equivalent"]
    assert tost_proportions(510, 1000, 500, 1000, bound=0.06).details["equivalent"]


def test_cleary_slope_difference() -> None:
    rng = np.random.default_rng(6)
    n = 1000
    g = np.repeat(["a", "b"], n // 2)
    x = rng.normal(size=n)
    y = x * np.where(g == "b", 0.3, 0.8) + rng.normal(size=n)
    res = differential_prediction(y, x, g)
    assert res.details["conclusion"] == "slope_difference"
    y2 = 0.6 * x + rng.normal(size=n)
    assert differential_prediction(y2, x, g).details["p_omnibus"] > 0.001


def test_calibration_and_disparity_and_device_effect() -> None:
    rng = np.random.default_rng(7)
    n = 600
    g = np.repeat(["hi", "ta"], n // 2)
    pred = rng.normal(size=n)
    y = pred + np.where(g == "ta", 0.5, 0.0) + rng.normal(0, 0.5, n)
    cal = calibration_by_group(y, pred, g)
    assert abs(cal["hi"].details["mean_residual"]) < 0.1 and cal["ta"].details["mean_residual"] > 0.35
    flags = np.concatenate([rng.random(300) < 0.9, rng.random(300) < 0.7]).astype(float)
    dis = disparity(flags, g, threshold_pp=5.0, min_cell_n=30)
    assert dis.details["exceeds_threshold"]
    fam = np.repeat(["never", "sometimes", "daily"], 200)
    ability = rng.normal(size=600)
    yy = ability + rng.normal(size=600)
    dev = device_familiarity_effect(yy, fam, ability)
    assert dev.details["p"] > 0.001


def test_ordinal_dif_on_likert_items() -> None:
    rng = np.random.default_rng(9)
    n = 500
    g = np.repeat([0, 1], n // 2)
    theta = rng.normal(size=n)
    lat = theta[:, None] * 0.9 + rng.logistic(size=(n, 4)) * 0.6
    lat[:, 0] += 1.2 * g
    y = np.digitize(lat, [-1.5, -0.5, 0.5, 1.5]) + 1
    res = ordinal_dif(y, g)
    assert res.flagged() == ["item_0"]
