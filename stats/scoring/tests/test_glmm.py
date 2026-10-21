"""Logistic random-slope GLMM (Laplace): parameter recovery, ceiling behaviour and the slope-indicator wiring."""

from __future__ import annotations

import numpy as np
import pytest
from scipy.special import expit
from shriii_scoring.formulas.models import fit_random_slopes
from shriii_scoring.glmm import fit_logistic_glm, fit_random_slope_glmm
from shriii_scoring.lmm import fit_random_slope_lmm


def _simulate(seed: int, k: int = 160, m: int = 48, slope_sd: float = 0.6) -> tuple[np.ndarray, ...]:
    """Go/no-go-like accuracy: high baseline, a hard trial type, a pressure contrast with person slopes."""
    rng = np.random.default_rng(seed)
    off = 0.1 if slope_sd > 0 else 0.0
    b = rng.multivariate_normal([0.0, 0.0], [[0.8, off], [off, slope_sd**2]], k)
    person = np.repeat(np.arange(k), m)
    s = np.tile(np.r_[np.zeros(m // 2), np.ones(m // 2)], k)
    hard = (rng.random(k * m) < 0.3).astype(float)
    eta = 3.0 - 3.5 * hard - 0.5 * s + b[person, 0] + b[person, 1] * s
    y = (rng.random(k * m) < expit(eta)).astype(float)
    sc = s - s.mean()
    x = np.column_stack([np.ones(k * m), sc, hard])
    return y, x, sc, person.astype(str), b


def test_glm_start_values_recover_fixed_effects() -> None:
    rng = np.random.default_rng(3)
    x = np.column_stack([np.ones(4000), rng.normal(size=4000)])
    y = (rng.random(4000) < expit(0.5 + 1.2 * x[:, 1])).astype(float)
    beta = fit_logistic_glm(y, x)
    assert beta == pytest.approx([0.5, 1.2], abs=0.12)


def test_glmm_recovers_fixed_effects_and_slope_variance() -> None:
    y, x, sc, groups, b = _simulate(1)
    fit = fit_random_slope_glmm(y, x, sc, groups)
    assert fit.converged
    assert fit.beta[1] == pytest.approx(-0.5, abs=0.2)
    assert fit.beta[2] == pytest.approx(-3.5, abs=0.3)
    assert fit.g[1, 1] == pytest.approx(0.36, abs=0.2)
    index = {g: i for i, g in enumerate(fit.groups)}
    est = np.array([fit.blups[index[str(i)], 1] for i in range(len(b))])
    assert np.corrcoef(est, b[:, 1])[0, 1] > 0.5
    rel = 1.0 - float(np.mean(fit.blup_cov[:, 1, 1])) / float(fit.g[1, 1])
    assert 0.2 < rel < 0.9


def test_glmm_slopes_recover_at_least_as_well_as_the_linear_probability_model() -> None:
    wins = 0
    for seed in (5, 6, 7):
        y, x, sc, groups, b = _simulate(seed)
        g = fit_random_slope_glmm(y, x, sc, groups)
        lm = fit_random_slope_lmm(y, x, sc, groups)
        gi = {v: i for i, v in enumerate(g.groups)}
        li = {v: i for i, v in enumerate(lm.groups)}
        r_g = np.corrcoef([g.blups[gi[str(i)], 1] for i in range(len(b))], b[:, 1])[0, 1]
        r_l = np.corrcoef([lm.blups[li[str(i)], 1] for i in range(len(b))], b[:, 1])[0, 1]
        wins += int(r_g >= r_l - 0.01)
    assert wins >= 2


def test_glmm_handles_no_slope_variance() -> None:
    y, x, sc, groups, _ = _simulate(9, slope_sd=0.0)
    fit = fit_random_slope_glmm(y, x, sc, groups, independent=True)
    assert np.isfinite(fit.deviance)
    assert fit.g[1, 1] < 0.1


def test_glmm_rejects_non_binary_outcomes() -> None:
    with pytest.raises(ValueError, match="0/1"):
        fit_random_slope_glmm(np.array([0.0, 0.5, 1.0]), np.ones((3, 1)), np.zeros(3), ["a", "a", "b"])


def test_slope_driver_binomial_family_uses_the_glmm() -> None:
    y, _, sc, groups, _ = _simulate(11, k=60, m=40)
    data: dict[str, list[tuple[float, float, tuple[float, ...]]]] = {}
    for yi, si, gi in zip(y, sc, groups, strict=True):
        data.setdefault(str(gi), []).append((float(yi), float(si > 0), ()))
    fit = fit_random_slopes(data, family="binomial")
    assert fit.method == "glmm_laplace_logit_random_slope"
    assert fit.model_reliability is not None and 0.0 <= fit.model_reliability <= 1.0
    assert set(fit.estimates) == set(data)
    with pytest.raises(ValueError, match="family"):
        fit_random_slopes(data, family="poisson")
