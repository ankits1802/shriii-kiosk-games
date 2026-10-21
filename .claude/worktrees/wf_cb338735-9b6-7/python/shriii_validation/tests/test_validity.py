"""Convergent / discriminant validity: CIs, corrections, dependent correlations, pattern statistic, hypotheses."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd  # type: ignore[import-untyped]
import pingouin as pg
import pytest
import yaml
from scipy.stats import spearmanr
from shriii_contracts.paths import scoring_dir
from shriii_validation.validity import (
    benjamini_hochberg,
    cohens_d,
    correlation,
    d_to_r,
    disattenuated,
    evaluate_hypotheses,
    holm,
    lower_bound_test,
    mtmm,
    partial_correlation,
    pattern_contrast,
    r_contrast_cv,
    r_to_d,
    steiger_dependent,
    zou_dependent_ci,
)
from statsmodels.stats.multitest import multipletests


def _pair(r: float, n: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    x = rng.normal(size=n)
    return x, r * x + math.sqrt(1 - r * r) * rng.normal(size=n)


def test_fisher_ci_hand_value() -> None:
    x, y = _pair(0.5, 100, 1)
    res = correlation(x, y)
    z = math.atanh(res.est)
    half = 1.959964 / math.sqrt(97)
    assert res.ci_low == pytest.approx(math.tanh(z - half), abs=1e-6)
    assert res.ci_high == pytest.approx(math.tanh(z + half), abs=1e-6)


def test_spearman_and_bootstrap_cis() -> None:
    x, y = _pair(0.4, 300, 2)
    sp = correlation(x, y, kind="spearman")
    assert sp.estimate == pytest.approx(float(spearmanr(x, y).statistic), abs=1e-12)
    bp = correlation(x, y, ci="bootstrap_percentile", n_boot=800)
    bca = correlation(x, y, ci="bootstrap_bca", n_boot=800)
    for r in (bp, bca):
        assert r.lo < r.est < r.hi


def test_partial_correlation_matches_pingouin() -> None:
    rng = np.random.default_rng(3)
    z = rng.normal(size=400)
    x = z + rng.normal(size=400)
    y = z + 0.3 * x + rng.normal(size=400)
    res = partial_correlation(x, y, z)
    ref = pg.partial_corr(pd.DataFrame({"x": x, "y": y, "z": z}), "x", "y", covar="z")
    assert res.estimate == pytest.approx(float(ref["r"].iloc[0]), abs=1e-9)


def test_holm_and_bh_match_statsmodels() -> None:
    p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216]
    h_adj, h_rej = holm(p)
    b_adj, b_rej = benjamini_hochberg(p)
    rej, adj, _, _ = multipletests(p, method="holm")
    assert np.allclose(h_adj, adj) and list(rej) == h_rej
    rej, adj, _, _ = multipletests(p, method="fdr_bh")
    assert np.allclose(b_adj, adj) and list(rej) == b_rej


def test_steiger_zero_and_symmetry() -> None:
    z, p = steiger_dependent(0.4, 0.4, 0.3, 200)
    assert z == pytest.approx(0.0) and p == pytest.approx(1.0)
    z1, _ = steiger_dependent(0.5, 0.2, 0.3, 200)
    z2, _ = steiger_dependent(0.2, 0.5, 0.3, 200)
    assert z1 == pytest.approx(-z2)


def test_zou_ci_coverage_simulation() -> None:
    rng = np.random.default_rng(4)
    cov = np.array([[1, 0.4, 0.15], [0.4, 1, 0.3], [0.15, 0.3, 1]])
    hits = 0
    reps = 300
    for _ in range(reps):
        d = rng.multivariate_normal(np.zeros(3), cov, size=150)
        c = np.asarray(np.corrcoef(d, rowvar=False), dtype=float)
        lo, hi = zou_dependent_ci(c[0, 1], c[0, 2], c[1, 2], 150)
        hits += lo <= 0.25 <= hi
    assert 0.91 <= hits / reps <= 0.98


def test_lower_bound_test_and_effect_sizes() -> None:
    assert lower_bound_test(0.25, 470, 0.10) < 0.00625
    assert lower_bound_test(0.12, 100, 0.10) > 0.3
    assert lower_bound_test(-0.25, 470, 0.10, expected_sign=-1) < 0.00625
    assert d_to_r(r_to_d(0.3)) == pytest.approx(0.3)
    rng = np.random.default_rng(5)
    d = cohens_d(rng.normal(0.5, 1, 4000), rng.normal(0, 1, 4000))
    assert d.estimate == pytest.approx(0.5, abs=0.06)


def test_disattenuated_is_secondary() -> None:
    res = disattenuated(0.3, 0.6, 0.7, n=300, r_xx_se=0.05, r_yy_se=0.05)
    assert res.estimate == pytest.approx(0.3 / math.sqrt(0.42))
    assert res.details["never_feeds_gates"] is True
    assert any("never feed gates" in w for w in res.warnings)


def test_pattern_contrast_detects_planted_pattern() -> None:
    rng = np.random.default_rng(6)
    n = 600
    m = rng.normal(size=n)
    conv1 = 0.4 * m + rng.normal(size=n) * math.sqrt(1 - 0.16)
    conv2 = -0.35 * m + rng.normal(size=n) * math.sqrt(1 - 0.35**2)
    disc1, disc2 = rng.normal(size=n), rng.normal(size=n)
    res = pattern_contrast(
        m,
        {"c1": conv1, "c2": conv2},
        {"d1": disc1, "d2": disc2},
        expected_signs={"c1": 1, "c2": -1},
        n_boot=300,
        n_perm=300,
    )
    assert res.est > 0 and res.lo > 0 and res.details["pattern_holds"]
    null = pattern_contrast(m, {"c1": disc1}, {"d1": disc2}, n_boot=300, n_perm=300)
    assert not null.details["pattern_holds"] or null.lo < 0.1


def test_mtmm_campbell_fiske() -> None:
    rng = np.random.default_rng(7)
    a, b = rng.normal(size=500), rng.normal(size=500)
    data = {
        "game_a": a + rng.normal(size=500),
        "self_a": a + rng.normal(size=500),
        "game_b": b + rng.normal(size=500),
        "self_b": b + rng.normal(size=500),
    }
    res = mtmm(
        data,
        traits={"game_a": "A", "self_a": "A", "game_b": "B", "self_b": "B"},
        methods={"game_a": "game", "game_b": "game", "self_a": "self", "self_b": "self"},
    )
    assert len(res.validity_diagonal) == 2 and len(res.heterotrait_heteromethod) == 2
    assert all(res.campbell_fiske.values())


def test_evaluate_hypotheses_primary_family_holm() -> None:
    hyp = yaml.safe_load((scoring_dir() / "hypotheses.yaml").read_text(encoding="utf-8"))
    rng = np.random.default_rng(8)
    n = 900
    sc = rng.normal(size=n)
    indicators = {"self_control.nogo_commission_rate": -sc + rng.normal(size=n)}
    criteria = {
        "bscs.total": 0.45 * sc + rng.normal(size=n) * 0.9,
        "bfi2_xs.extraversion": rng.normal(size=n),
        "gdms.spontaneous": rng.normal(size=n),
        "bfi2_xs.conscientiousness": 0.3 * sc + rng.normal(size=n),
    }
    out = evaluate_hypotheses(
        hyp, indicators, criteria, indicator_signs={"self_control.nogo_commission_rate": -1}, pathway="B", n_boot=200
    )
    by = {r.hypothesis_id: r for r in out}
    h1 = by["h1.self_control"]
    assert h1.status == "ok" and h1.estimate is not None and h1.estimate > 0.15 and h1.passed
    assert h1.p_adjusted is not None and h1.p is not None and h1.p_adjusted >= h1.p
    assert by["h1.decisiveness"].status == "insufficient"
    assert by["hr.response_consistency"].status == "not_available"
    hp = by["hp.self_control"]
    assert hp.status == "ok" and hp.passed


def test_zou_overlapping_reference_example() -> None:
    """Zou (2007), overlapping-correlation example: r12 = .396, r13 = .179, r23 = .088, n = 66 gives the
    95% CI (-.093, .517) for rho12 - rho13."""
    lo, hi = zou_dependent_ci(0.396, 0.179, 0.088, 66)
    assert lo == pytest.approx(-0.093, abs=1e-3)
    assert hi == pytest.approx(0.517, abs=1e-3)


def test_r_contrast_two_criteria_matches_meng_rosenthal_rubin() -> None:
    """With weights (1, -1) the contrast Z is Meng, Rosenthal & Rubin's (1992) test of two correlated
    correlations: Z = (z1 - z2) sqrt((N - 3) / (2 (1 - r_x) h)), h = (1 - f rbar^2) / (1 - r_x)."""
    r1, r2, rx, n = 0.45, 0.20, 0.30, 120
    r2bar = (r1**2 + r2**2) / 2
    f = min(1.0, (1 - rx) / (2 * (1 - r2bar)))
    h = (1 - f * r2bar) / (1 - rx)
    z_ref = (math.atanh(r1) - math.atanh(r2)) * math.sqrt((n - 3) / (2 * (1 - rx) * h))
    _, rc, zc = r_contrast_cv([r1, r2], [1.0, -1.0], rx, n)
    assert zc == pytest.approx(z_ref, rel=1e-12)
    assert rc == pytest.approx(math.sqrt(z_ref**2 / (z_ref**2 + n)), rel=1e-12)
