"""Factor structure: parallel analysis, EFA, CFA (semopy), multi-group invariance, redundancy."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from shriii_validation.structure import (
    cfa,
    compare_models,
    efa,
    fit_multigroup_cfa,
    measurement_invariance,
    parallel_analysis,
    redundancy,
)

VARS = [f"x{i}" for i in range(1, 7)]
FACTORS = {"F1": ["x1", "x2", "x3"], "F2": ["x4", "x5", "x6"]}


def two_factor(
    n: int, seed: int, *, intercept_shift: float = 0.0, loading_shift: float = 0.0, mean: float = 0.0
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    f = rng.multivariate_normal([mean, mean], [[1, 0.3], [0.3, 1]], size=n)
    lam = np.array([0.8, 0.7, 0.6, 0.8, 0.7, 0.6])
    lam_used = lam.copy()
    lam_used[0] += loading_shift
    owner = np.array([0, 0, 0, 1, 1, 1])
    x = f[:, owner] * lam_used + rng.normal(size=(n, 6)) * np.sqrt(1 - lam**2)
    x[:, 1] += intercept_shift
    return np.asarray(x, dtype=float)


def test_parallel_analysis_two_factors() -> None:
    res = parallel_analysis(two_factor(800, 1), iterations=100)
    assert res.details["n_factors"] == 2


def test_efa_loadings_and_checks() -> None:
    df = pd.DataFrame(two_factor(800, 2), columns=VARS)
    res = efa(df, 2)
    assert all(a.passed for a in res.assumptions)
    load = np.abs(np.array([res.details["loadings"][v] for v in VARS]))
    assert (load[:3, :].argmax(axis=1) == load[0].argmax()).all()
    assert (load[3:, :].argmax(axis=1) != load[0].argmax()).all()


def test_cfa_fit_and_refusal() -> None:
    df = pd.DataFrame(two_factor(1000, 3), columns=VARS)
    good = cfa(df, FACTORS)
    assert good.ok and good.details["fit"]["CFI"] > 0.97 and good.details["fit"]["RMSEA"] < 0.05
    assert good.details["fit"]["SRMR"] < 0.05
    bad = cfa(df, {"F1": VARS})
    assert bad.details["fit"]["CFI"] < good.details["fit"]["CFI"]
    cmp = compare_models(bad.details["fit"], good.details["fit"])
    assert cmp["delta_df"] == 1 and cmp["p"] < 0.001
    refused = cfa(df, {"F1": ["x1", "x2"], "F2": ["x4", "x5", "x6"]})
    assert refused.status == "insufficient" and "refused" in refused.warnings[0]


def test_single_group_ml_matches_semopy_chi2() -> None:
    x = two_factor(1000, 4)
    ours = fit_multigroup_cfa({"g": x}, VARS, FACTORS, "configural")
    ref = cfa(pd.DataFrame(x, columns=VARS), FACTORS)
    assert ours.df == int(ref.details["fit"]["DoF"])
    assert ours.chi2 == pytest.approx(ref.details["fit"]["chi2"], rel=0.02)


def test_configural_chi2_is_sum_of_groups() -> None:
    xa, xb = two_factor(600, 5), two_factor(600, 6)
    joint = fit_multigroup_cfa({"a": xa, "b": xb}, VARS, FACTORS, "configural")
    sa = fit_multigroup_cfa({"a": xa}, VARS, FACTORS, "configural")
    sb = fit_multigroup_cfa({"b": xb}, VARS, FACTORS, "configural")
    assert joint.chi2 == pytest.approx(sa.chi2 + sb.chi2, rel=1e-4, abs=1e-3)
    assert joint.df == sa.df + sb.df


def test_invariance_holds_for_invariant_groups() -> None:
    data = {"hi-IN": two_factor(800, 7), "mr-IN": two_factor(800, 8, mean=0.3)}
    res = measurement_invariance(data, VARS, FACTORS)
    assert res["metric"].details["passed"] and res["scalar"].details["passed"]
    assert res["scalar"].details["invariance_holds_through_this_level"]


def test_scalar_noninvariance_detected_and_partial_model() -> None:
    data = {"hi-IN": two_factor(1000, 9), "ta-IN": two_factor(1000, 10, intercept_shift=0.8)}
    res = measurement_invariance(data, VARS, FACTORS)
    assert res["metric"].details["passed"]
    assert not res["scalar"].details["passed"]
    partial = measurement_invariance(data, VARS, FACTORS, free_intercepts=["x2"], max_freed_share=0.2)
    assert partial["scalar"].details["passed"]
    too_many = measurement_invariance(data, VARS, FACTORS, free_intercepts=["x2", "x3"], max_freed_share=0.2)
    assert not too_many["scalar"].details["passed"]


def test_redundancy() -> None:
    rng = np.random.default_rng(11)
    a = rng.normal(size=300)
    df = pd.DataFrame({"a": a, "a_copy": a + rng.normal(0, 0.1, 300), "b": rng.normal(size=300)})
    pairs = redundancy(df)
    assert [(p["a"], p["b"]) for p in pairs] == [("a", "a_copy")]


def test_invariance_degrees_of_freedom() -> None:
    """2 groups, 6 indicators, 2 factors: 54 moments. Configural 38 free parameters (df 16); metric frees
    2 latent variances but equates 6 loadings (df 20); scalar adds 2 latent means but equates 6 intercepts
    (df 24); each freed intercept costs one df per non-reference group (df 23 with one freed)."""
    data = {"hi-IN": two_factor(500, 12), "ta-IN": two_factor(500, 13, intercept_shift=0.8)}
    conf = fit_multigroup_cfa(data, VARS, FACTORS, "configural")
    metric = fit_multigroup_cfa(data, VARS, FACTORS, "metric")
    scalar = fit_multigroup_cfa(data, VARS, FACTORS, "scalar")
    partial = fit_multigroup_cfa(data, VARS, FACTORS, "scalar", free_intercepts=["x2"])
    assert (conf.df, metric.df, scalar.df, partial.df) == (16, 20, 24, 23)
    assert partial.chi2 < scalar.chi2
    # The freed intercept is estimated separately in the focal group (shift ~ 0.8).
    shift = partial.intercepts["ta-IN"][1] - partial.intercepts["hi-IN"][1]
    assert shift == pytest.approx(0.8, abs=0.2)
