"""Numeric building blocks checked against hand computations and published values."""

from __future__ import annotations

import math

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from shriii_scoring.lmm import fit_random_slope_lmm
from shriii_scoring.numerics import (
    detrend,
    eb_normal_shrinkage,
    entropy_bits,
    ez_diffusion,
    fisher_z,
    fit_hyperbolic_map,
    lag1_autocorrelation,
    levenshtein,
    logit_corrected,
    max_variance,
    relative_variability_index,
)
from statsmodels.regression.mixed_linear_model import MixedLM, MixedLMParams


def test_logit_corrected_hand_value() -> None:
    # (0 + .5) / (20 + 1) = .5 / 21 -> logit = log(.5 / 20.5)
    assert logit_corrected(0, 20) == pytest.approx(math.log(0.5 / 20.5))
    assert logit_corrected(10, 20) == pytest.approx(0.0)


def test_max_variance_hand_value() -> None:
    # mean 3 in [1, 5], n = 4: two values at 5 and two at 1 -> variance 16/3.
    assert max_variance(3.0, 1.0, 5.0, 4) == pytest.approx(16 / 3)
    assert max_variance(5.0, 1.0, 5.0, 4) == 0.0


def test_rvi_bounds() -> None:
    assert relative_variability_index([1, 5, 1, 5], 1, 5) == pytest.approx(1.0)
    assert relative_variability_index([3, 3, 3, 3], 1, 5) == pytest.approx(0.0)
    mid = relative_variability_index([2, 4, 2, 4], 1, 5)
    assert 0 < mid < 1


@given(st.lists(st.floats(min_value=200, max_value=800), min_size=5, max_size=40))
@settings(max_examples=50, deadline=None)
def test_rvi_in_unit_interval(values: list[float]) -> None:
    r = relative_variability_index(values, 150, 900)
    assert math.isnan(r) or 0.0 <= r <= 1.0 + 1e-9


def test_entropy_and_levenshtein() -> None:
    assert entropy_bits(["a", "b"]) == pytest.approx(1.0)
    assert entropy_bits(["a"] * 4) == pytest.approx(0.0)
    assert entropy_bits(["a", "b", "c", "d"]) == pytest.approx(2.0)
    assert levenshtein("kitten", "sitting") == 3
    assert levenshtein([1, 2, 3], [1, 2, 3]) == 0


def test_ez_diffusion_published_example() -> None:
    # Wagenmakers, van der Maas & Grasman (2007): Pc = .802, VRT = .112, MRT = .723 -> v = .1, a = .14, Ter = .3
    ez = ez_diffusion(0.802, 0.112, 0.723)
    assert ez.drift == pytest.approx(0.0999, abs=5e-4)
    assert ez.boundary == pytest.approx(0.1400, abs=5e-4)
    assert ez.nondecision == pytest.approx(0.300, abs=2e-3)


def test_ez_edge_correction() -> None:
    ez = ez_diffusion(1.0, 0.01, 0.5, n=40)
    assert ez.edge_corrected
    assert ez.drift > 0
    assert math.isnan(ez_diffusion(1.0, 0.01, 0.5).drift)


def test_ez_recovers_drift_from_wiener_simulation() -> None:
    rng = np.random.default_rng(3)
    v, a, ter, s, dt = 0.25, 0.12, 0.3, 0.1, 0.001
    n = 3000
    x = np.full(n, a / 2)
    t = np.zeros(n)
    done = np.zeros(n, dtype=bool)
    hit_upper = np.zeros(n, dtype=bool)
    while not done.all():
        idx = ~done
        x[idx] += v * dt + s * math.sqrt(dt) * rng.normal(size=idx.sum())
        t[idx] += dt
        up = idx & (x >= a)
        lo = idx & (x <= 0)
        hit_upper |= up
        done |= up | lo
    rt = t[hit_upper] + ter
    ez = ez_diffusion(float(hit_upper.mean()), float(rt.var(ddof=1)), float(rt.mean()), n=n)
    assert ez.drift == pytest.approx(v, rel=0.12)
    assert ez.boundary == pytest.approx(a, rel=0.08)
    assert ez.nondecision == pytest.approx(ter, abs=0.02)


def test_detrend_and_lag1() -> None:
    assert np.allclose(detrend([1, 2, 3, 4, 5]), [3, 3, 3, 3, 3])
    r, pairs = lag1_autocorrelation([[1.0, -1.0, 1.0, -1.0]], min_linear=10)
    assert r == pytest.approx(-0.75)
    assert pairs == 3


def test_fisher_z_clip() -> None:
    assert math.isfinite(fisher_z(1.0))
    assert fisher_z(0.5) == pytest.approx(math.atanh(0.5))


def test_hyperbolic_map_recovers_planted_log_k() -> None:
    rng = np.random.default_rng(7)
    log_k, beta = -2.0, 8.0
    n = 300
    ll_amount = np.full(n, 10.0)
    delay = rng.choice([1, 2, 4, 8, 16], n).astype(float)
    ss = rng.uniform(0.5, 9.5, n)
    v_ll = ll_amount / (1 + math.exp(log_k) * delay)
    p = 1 / (1 + np.exp(-beta * (v_ll - ss) / 10))
    y = (rng.random(n) < p).astype(int)
    fit = fit_hyperbolic_map(
        ss,
        np.zeros(n),
        ll_amount,
        delay,
        y,
        log_k_prior=(-3.0, 5.0),
        log_beta_prior=(2.0, 2.0),
        log_k_bounds=(-12.0, 4.0),
        log_beta_bounds=(-3.0, 5.0),
    )
    assert fit.log_k == pytest.approx(log_k, abs=0.3)
    assert 0 < fit.log_k_sd < 0.5


def test_eb_shrinkage_equal_variances() -> None:
    y = np.array([0.0, 1.0, 2.0, 3.0, 4.0, 5.0])
    v = np.full(6, 1.0)
    post, sd, mu, tau2 = eb_normal_shrinkage(y, v)
    assert mu == pytest.approx(2.5)
    shrink = tau2 / (tau2 + 1.0)
    assert np.allclose(post, mu + shrink * (y - mu))
    assert np.allclose(sd, math.sqrt(1 / (1 / tau2 + 1)))


def _lmm_data(seed: int, k: int = 120, n: int = 30) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    g = np.repeat(np.arange(k), n).astype(str)
    s = np.tile((np.arange(n) >= n // 2).astype(float), k)
    b = rng.multivariate_normal([0, 0], [[1, 0.3], [0.3, 0.5]], size=k)
    idx = np.repeat(np.arange(k), n)
    y = 1 + 0.5 * s + b[idx, 0] + b[idx, 1] * s + rng.normal(0, 1, k * n)
    x = np.column_stack([np.ones_like(s), s])
    return y, x, s, g


def test_lmm_matches_statsmodels_reml() -> None:
    y, x, s, g = _lmm_data(1)
    fit = fit_random_slope_lmm(y, x, s, g)
    model = MixedLM(y, x, groups=g, exog_re=x)
    model.reml = True
    ref = model.fit(reml=True, method=["lbfgs"])
    assert np.allclose(fit.beta, np.asarray(ref.fe_params), atol=1e-3)
    assert fit.sigma2 == pytest.approx(ref.scale, rel=1e-3)
    # Our optimum is at least as good as statsmodels' under statsmodels' own REML likelihood.
    ours = MixedLMParams.from_components(fit.beta, cov_re=fit.g / fit.sigma2)
    assert model.loglike(ours, profile_fe=False) >= ref.llf - 1e-4
    blups = np.array([np.asarray(ref.random_effects[gr]) for gr in fit.groups])
    assert np.max(np.abs(blups - fit.blups)) < 5e-3


def test_lmm_independent_has_zero_covariance() -> None:
    y, x, s, g = _lmm_data(2)
    fit = fit_random_slope_lmm(y, x, s, g, independent=True)
    assert fit.g[0, 1] == pytest.approx(0.0, abs=1e-12)
    assert fit.g[1, 1] > 0
