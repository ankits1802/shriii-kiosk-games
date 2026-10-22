"""Reliability against published worked examples, reference implementations and simulated truth."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pingouin as pg
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from shriii_simulator.criterion import simulate_retest_scores
from shriii_validation.reliability import (
    composite_reliability,
    cronbach_alpha,
    difference_score_reliability,
    g_study,
    groupwise,
    icc,
    icc_all,
    mcdonald_omega,
    model_based_reliability,
    one_way_variance_decomposition,
    retest_reliability,
    sem_from_reliability,
    spearman_brown,
    split_half_permutation,
)

# Shrout & Fleiss (1979), Table 2: 6 targets rated by 4 judges.
SF = np.array([[9, 2, 5, 8], [6, 1, 3, 2], [8, 4, 6, 8], [7, 1, 2, 6], [10, 5, 6, 9], [6, 2, 4, 7]], dtype=float)


def test_shrout_fleiss_published_point_estimates() -> None:
    res = icc_all(SF)
    expected = {"ICC1": 0.17, "ICC_A1": 0.29, "ICC_C1": 0.71, "ICC1k": 0.44, "ICC_Ak": 0.62, "ICC_Ck": 0.91}
    for k, v in expected.items():
        assert res[k].estimate == pytest.approx(v, abs=0.005), k


def test_shrout_fleiss_cis_match_reference_implementation() -> None:
    df = pd.DataFrame([(i, j, SF[i, j]) for i in range(6) for j in range(4)], columns=["t", "r", "s"])
    ref = pg.intraclass_corr(df, "t", "r", "s").set_index("Type")
    names = {
        "ICC1": "ICC(1,1)",
        "ICC_A1": "ICC(A,1)",
        "ICC_C1": "ICC(C,1)",
        "ICC1k": "ICC(1,k)",
        "ICC_Ak": "ICC(A,k)",
        "ICC_Ck": "ICC(C,k)",
    }
    res = icc_all(SF)
    for ours, theirs in names.items():
        assert res[ours].estimate == pytest.approx(float(ref.loc[theirs, "ICC"]), abs=1e-6)
        lo, hi = ref.loc[theirs, "CI95"]
        assert res[ours].ci_low == pytest.approx(float(lo), abs=0.006)
        assert res[ours].ci_high == pytest.approx(float(hi), abs=0.006)


@given(st.permutations(range(6)))
@settings(max_examples=30, deadline=None)
def test_icc_invariant_to_subject_order(order: list[int]) -> None:
    a = icc(SF, "ICC_A1").estimate
    b = icc(SF[list(order)], "ICC_A1").estimate
    assert a == pytest.approx(b, abs=1e-12)


def test_icc_consistency_ignores_rater_shift_but_agreement_does_not() -> None:
    rng = np.random.default_rng(0)
    t = rng.normal(size=200)
    x = np.column_stack([t + rng.normal(0, 0.3, 200), t + 2.0 + rng.normal(0, 0.3, 200)])
    assert icc(x, "ICC_C1").est > 0.85
    assert icc(x, "ICC_A1").est < 0.35


def test_alpha_known_covariance_and_feldt_ci() -> None:
    rng = np.random.default_rng(1)
    k, c = 6, 0.4
    cov = np.full((k, k), c) + np.eye(k) * (1 - c)
    x = rng.multivariate_normal(np.zeros(k), cov, size=3000)
    pop = k * c / (1 + (k - 1) * c)
    res = cronbach_alpha(x)
    assert res.estimate == pytest.approx(pop, abs=0.02)
    ref_alpha, ref_ci = pg.cronbach_alpha(pd.DataFrame(x[:200]))
    small = cronbach_alpha(x[:200])
    assert small.estimate == pytest.approx(ref_alpha, abs=1e-9)
    assert small.ci_low == pytest.approx(ref_ci[0], abs=1e-3) and small.ci_high == pytest.approx(ref_ci[1], abs=1e-3)
    # Shrout-Fleiss data: alpha equals ICC(C,k).
    assert cronbach_alpha(SF).estimate == pytest.approx(icc(SF, "ICC_Ck").estimate, abs=1e-12)


def test_omega_recovers_congeneric_population_value_and_warns_alpha() -> None:
    rng = np.random.default_rng(2)
    lam = np.array([0.85, 0.75, 0.6, 0.45, 0.3])
    f = rng.normal(size=4000)
    x = f[:, None] * lam + rng.normal(size=(4000, 5)) * np.sqrt(1 - lam**2)
    pop = lam.sum() ** 2 / (lam.sum() ** 2 + (1 - lam**2).sum())
    om = mcdonald_omega(x, n_boot=100)
    assert om.estimate == pytest.approx(pop, abs=0.015)
    assert om.lo < om.est < om.hi
    al = cronbach_alpha(x)
    assert any("tau-equivalent" in w for w in al.warnings)


def test_alpha_flags_unreversed_item() -> None:
    rng = np.random.default_rng(3)
    f = rng.normal(size=500)
    x = np.column_stack([f + rng.normal(size=500) for _ in range(4)] + [-f + rng.normal(size=500)])
    res = cronbach_alpha(x)
    assert any(not a.passed for a in res.assumptions if a.name == "no_negative_item_rest_correlations")


def test_spearman_brown_and_split_half_recovers_simulated_reliability() -> None:
    assert spearman_brown(0.5) == pytest.approx(2 / 3)
    assert spearman_brown(0.5, 3) == pytest.approx(0.75)
    rng = np.random.default_rng(4)
    n_p, n_t = 400, 40
    # Person-mean reliability .70 with 40 trials: var_true / (var_true + var_err / 40) = .7
    var_err = 1.0
    var_true = 0.7 / 0.3 * var_err / n_t
    person = np.repeat(np.arange(n_p), n_t)
    stratum = np.tile(np.arange(n_t) % 2, n_p)
    y = rng.normal(0, np.sqrt(var_true), n_p)[person] + rng.normal(0, np.sqrt(var_err), n_p * n_t) + 0.3 * stratum
    res = split_half_permutation(person, y, stratum=stratum, n_splits=500, seed=1)
    assert res.estimate == pytest.approx(0.70, abs=0.03)
    assert res.lo < res.est < res.hi
    assert res.details["n_strata"] == 2


def test_g_study_identities() -> None:
    g = g_study(SF, ["rater"])
    assert g.estimate == pytest.approx(icc(SF, "ICC_Ck").estimate, abs=1e-10)
    assert g.details["phi"] == pytest.approx(icc(SF, "ICC_Ak").estimate, abs=1e-10)
    single = g_study(SF, ["rater"], d_study={"rater": 1})
    assert single.estimate == pytest.approx(icc(SF, "ICC_C1").estimate, abs=1e-10)
    assert single.details["phi"] == pytest.approx(icc(SF, "ICC_A1").estimate, abs=1e-10)


def test_g_study_two_facets_recovers_components() -> None:
    rng = np.random.default_rng(5)
    n_p, n_i, n_o = 300, 10, 2
    p = rng.normal(0, 1.0, (n_p, 1, 1))
    po = rng.normal(0, 0.5, (n_p, 1, n_o))
    e = rng.normal(0, 1.0, (n_p, n_i, n_o))
    g = g_study(p + po + e, ["trial", "occasion"])
    vc = g.details["variance_components"]
    assert vc["p"] == pytest.approx(1.0, abs=0.15)
    assert vc["pxoccasion"] == pytest.approx(0.25, abs=0.06)


def test_retest_with_planted_icc_and_practice_shift() -> None:
    t1, t2 = simulate_retest_scores(1200, 0.70, practice_shift=0.3, seed=6)
    res = retest_reliability(t1, t2)
    assert res["icc_a1"].estimate == pytest.approx(0.70, abs=0.05)
    assert res["practice_effect"].estimate == pytest.approx(0.3, abs=0.08)
    assert res["icc_c1"].est > res["icc_a1"].est
    assert "never used for gates" in res["pearson"].warnings[0]
    assert res["sem"].estimate == pytest.approx(
        sem_from_reliability(np.std(np.concatenate([t1, t2]), ddof=1), res["icc_a1"].est)
    )
    few = retest_reliability(t1[:10], t2[:10])
    assert all(r.status == "insufficient" for r in few.values())


def test_difference_score_reliability_formula() -> None:
    assert difference_score_reliability(0.8, 0.8, 0.5) == pytest.approx((0.8 + 0.8 - 1.0) / (2 - 1.0))
    assert difference_score_reliability(0.8, 0.8, 0.8) == pytest.approx(0.0)


def test_model_based_and_composite_reliability() -> None:
    rng = np.random.default_rng(7)
    true = rng.normal(0, 1, 500)
    se = np.full(500, 0.6)
    est = true * (1 / (1 + 0.36)) + rng.normal(0, 0.0, 500)
    res = model_based_reliability(est + rng.normal(0, 0.01, 500), se)
    assert 0 < res.est < 1
    assert composite_reliability([1, 1], [1, 1], [0.8, 0.8], [[1, 0.5], [0.5, 1]]) == pytest.approx(1 - 0.4 / 3)


def test_variance_decomposition_and_groupwise() -> None:
    rng = np.random.default_rng(8)
    person = np.repeat(np.arange(100), 20)
    y = rng.normal(0, 1, 100)[person] + rng.normal(0, 2, 2000)
    res = one_way_variance_decomposition(person, y)
    assert res.estimate == pytest.approx(0.2, abs=0.06)
    out = groupwise(
        lambda a, b: retest_reliability(a, b)["icc_a1"],
        {"hi-IN": (y[:50], y[50:100]), "mr-IN": (y[:10], y[10:20])},
        min_n=30,
    )
    assert out["mr-IN"].status == "insufficient"


def test_omega_bootstrap_survives_resamples_with_a_constant_item() -> None:
    # Small n with a nearly constant item: some bootstrap resamples make it constant (zero variance),
    # which must drop that draw rather than fail the analysis (LinAlgError on a NaN matrix).
    rng = np.random.default_rng(3)
    n = 12
    f = rng.normal(size=n)
    items = np.column_stack([f + rng.normal(scale=0.5, size=n) for _ in range(3)])
    rare = np.zeros(n)
    rare[0] = 1.0
    items = np.column_stack([items, rare])
    res = mcdonald_omega(items, n_boot=200, seed=1)
    assert res.n == n


def test_omega_is_unavailable_when_an_item_is_constant() -> None:
    rng = np.random.default_rng(4)
    f = rng.normal(size=20)
    items = np.column_stack([f + rng.normal(scale=0.5, size=20) for _ in range(3)] + [np.ones(20)])
    res = mcdonald_omega(items, n_boot=50, seed=1)
    assert res.status == "insufficient"
