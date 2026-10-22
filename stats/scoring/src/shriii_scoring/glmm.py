"""Logistic mixed model with a random intercept and one random slope per person (Laplace approximation).

``logit P(y_ij = 1) = x_ij' beta + b0_i + b1_i * s_ij``, ``(b0_i, b1_i) ~ N(0, G)``.

Why it exists: binary outcomes near ceiling (go/no-go accuracy, card-sort correctness) were scored with
the linear-probability mixed model (:mod:`shriii_scoring.lmm`). Near the ceiling the LPM gives every trial
the same weight, so the many uninformative near-certain trials dilute the person slopes and the
homoscedastic residual is wrong. The logistic model weights each trial by ``mu (1 - mu)``.

Estimation follows ``lme4::glmer(nAGQ = 0)``: random effects are written ``b_i = L u_i`` with ``G = L L'``
and ``u_i ~ N(0, I)``; for a given ``theta`` (the Cholesky factor ``L``) the fixed effects and the spherical
random effects are found jointly by penalised iteratively re-weighted least squares (PIRLS, Newton steps
solved with a Schur complement over the per-person 2 x 2 blocks), and the Laplace approximation of the
marginal deviance

    -2 sum_ij log p(y_ij | beta, u) + sum_i u_i'u_i + sum_i log |L' Z_i' W_i Z_i L + I|

is minimised over ``theta`` (L-BFGS-B, multi-start, Nelder-Mead polish). The ``u``-parametrisation keeps the
objective finite when ``G`` is (near) singular. Person estimates are the conditional modes ``b_i`` and
their conditional covariance ``L (L'Z'WZL + I)^-1 L'`` (conditional on ``beta``), which gives posterior SDs
and the model-based reliability ``1 - mean(posterior variance) / G[1, 1]``.

This is the Python counterpart of the R backend design in ``stats/r-psychometrics`` (glmmTMB / lme4
``glmer``); parity with R is checked when that backend is wired in (the R side cannot run locally).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from scipy import optimize
from scipy.special import expit

__all__ = ["GLMMFit", "fit_logistic_glm", "fit_random_slope_glmm"]

FloatArray = NDArray[np.float64]

_LOG_L_BOUNDS = (-7.0, 2.5)  # SD of a logit-scale random effect between ~0.001 and ~12
_ETA_CLIP = 30.0


@dataclass(frozen=True, slots=True)
class GLMMFit:
    """Laplace fit of the logistic random-intercept, random-slope model."""

    beta: FloatArray
    g: FloatArray
    blups: FloatArray
    blup_cov: FloatArray
    groups: tuple[str, ...]
    converged: bool
    deviance: float


def _inv2(m: FloatArray) -> tuple[FloatArray, FloatArray]:
    a, b, c, d = m[:, 0, 0], m[:, 0, 1], m[:, 1, 0], m[:, 1, 1]
    det = a * d - b * c
    inv = np.empty_like(m)
    inv[:, 0, 0] = d / det
    inv[:, 0, 1] = -b / det
    inv[:, 1, 0] = -c / det
    inv[:, 1, 1] = a / det
    return inv, det


def _loglik(y: FloatArray, eta: FloatArray) -> float:
    # log p = y * eta - log(1 + exp(eta)), computed stably.
    return float(np.sum(y * eta - np.logaddexp(0.0, eta)))


def fit_logistic_glm(y: FloatArray, x: FloatArray, maxiter: int = 50) -> FloatArray:
    """Fixed-effects logistic regression by IRLS with a tiny ridge (start values; separation-safe)."""
    beta = np.zeros(x.shape[1])
    ridge = 1e-6 * np.eye(x.shape[1])
    for _ in range(maxiter):
        eta = np.clip(x @ beta, -_ETA_CLIP, _ETA_CLIP)
        mu = expit(eta)
        w = np.maximum(mu * (1 - mu), 1e-10)
        step = np.linalg.solve(x.T @ (w[:, None] * x) + ridge, x.T @ (y - mu) - ridge @ beta)
        beta = beta + step
        if float(np.max(np.abs(step))) < 1e-10:
            break
    return beta


@dataclass(slots=True)
class _Problem:
    """Rows sorted by group, so per-group sums are ``np.add.reduceat`` over contiguous segments."""

    y: FloatArray
    x: FloatArray
    z: FloatArray  # (n, 2): [1, slope]
    inverse: NDArray[np.intp]
    starts: NDArray[np.intp]
    k: int

    def group_sum(self, values: FloatArray) -> FloatArray:
        return np.add.reduceat(values, self.starts, axis=0)


@dataclass(slots=True)
class _Mode:
    beta: FloatArray
    u: FloatArray  # (k, 2)
    h: FloatArray  # (k, 2, 2) = L'Z'WZL + I at the mode
    pdev: float  # -2 loglik + sum u'u at the mode
    ok: bool


def _lower(theta: FloatArray, independent: bool) -> FloatArray:
    l11, l21, l22 = float(theta[0]), float(theta[1]), float(theta[2])
    return np.array([[math.exp(l11), 0.0], [0.0 if independent else l21, math.exp(l22)]])


def _pirls(prob: _Problem, lower: FloatArray, beta0: FloatArray, u0: FloatArray, maxiter: int = 60) -> _Mode:
    y, x, inverse = prob.y, prob.x, prob.inverse
    zl = prob.z @ lower  # (n, 2): row i of Z_i L
    p = x.shape[1]
    beta = beta0.copy()
    u = u0.copy()

    def penalised(beta_: FloatArray, u_: FloatArray) -> tuple[float, FloatArray]:
        eta_ = np.clip(x @ beta_ + np.einsum("nj,nj->n", zl, u_[inverse]), -_ETA_CLIP, _ETA_CLIP)
        return -2.0 * _loglik(y, eta_) + float(np.sum(u_ * u_)), eta_

    pdev, eta = penalised(beta, u)
    ok = False
    eye = np.eye(2)[None, :, :]
    for _ in range(maxiter):
        mu = expit(eta)
        w = np.maximum(mu * (1.0 - mu), 1e-12)
        r = y - mu
        wzl = w[:, None] * zl
        huu = prob.group_sum(wzl[:, :, None] * zl[:, None, :]) + eye
        hub = prob.group_sum(wzl[:, :, None] * x[:, None, :])
        gu = prob.group_sum(zl * r[:, None])
        gu = gu - u
        hbb = x.T @ (w[:, None] * x)
        gb = x.T @ r
        huu_inv, det = _inv2(huu)
        if np.any(det <= 0):
            break
        a = np.einsum("kij,kjl->kil", huu_inv, hub)  # H_uu^-1 H_ub
        schur = hbb - np.einsum("kji,kjl->il", hub, a)
        rhs = gb - np.einsum("kji,kj->i", hub, np.einsum("kij,kj->ki", huu_inv, gu))
        try:
            dbeta = np.linalg.solve(schur + 1e-10 * np.eye(p), rhs)
        except np.linalg.LinAlgError:
            break
        du = np.einsum("kij,kj->ki", huu_inv, gu - np.einsum("kij,j->ki", hub, dbeta))
        step = 1.0
        improved = False
        for _half in range(30):
            nb, nu = beta + step * dbeta, u + step * du
            npdev, neta = penalised(nb, nu)
            if math.isfinite(npdev) and npdev <= pdev + 1e-10:
                improved = True
                break
            step *= 0.5
        if not improved:
            ok = True  # no further descent possible: at the (numerical) mode
            break
        change = pdev - npdev
        beta, u, pdev, eta = nb, nu, npdev, neta
        if change < 1e-9 and step * max(float(np.max(np.abs(dbeta))), float(np.max(np.abs(du)))) < 1e-6:
            ok = True
            break
    mu = expit(eta)
    w = np.maximum(mu * (1.0 - mu), 1e-12)
    wzl = w[:, None] * zl
    h = prob.group_sum(wzl[:, :, None] * zl[:, None, :]) + eye
    return _Mode(beta=beta, u=u, h=h, pdev=pdev, ok=ok)


def fit_random_slope_glmm(
    y: FloatArray,
    x: FloatArray,
    slope: FloatArray,
    groups: NDArray[np.str_] | list[str],
    *,
    maxiter: int = 200,
    independent: bool = False,
) -> GLMMFit:
    """Fit the logistic random-slope model by Laplace (nAGQ = 0). ``x`` includes an intercept column;
    ``slope`` is the covariate with a random slope. ``independent=True`` fixes the intercept-slope
    covariance at zero."""
    yv = np.asarray(y, dtype=float)
    if not np.all((yv == 0.0) | (yv == 1.0)):
        raise ValueError("logistic GLMM needs a 0/1 outcome")
    xv = np.asarray(x, dtype=float)
    s = np.asarray(slope, dtype=float)
    labels = np.asarray(groups)
    uniq, inverse = np.unique(labels, return_inverse=True)
    order = np.argsort(inverse, kind="stable")
    inverse = inverse[order]
    starts = np.flatnonzero(np.r_[True, inverse[1:] != inverse[:-1]])
    yv, xv, s = yv[order], xv[order], s[order]
    prob = _Problem(
        y=yv, x=xv, z=np.column_stack([np.ones_like(s), s]), inverse=inverse, starts=starts, k=int(uniq.size)
    )
    beta_glm = fit_logistic_glm(yv, xv)
    zero_u = np.zeros((prob.k, 2))
    warm: dict[str, tuple[FloatArray, FloatArray]] = {"w": (beta_glm, zero_u)}

    def objective(theta: FloatArray) -> float:
        lower = _lower(theta, independent)
        beta0, u0 = warm["w"]
        try:
            mode = _pirls(prob, lower, beta0, u0)
        except (FloatingPointError, np.linalg.LinAlgError, ValueError, OverflowError):
            return 1e100
        _, det = _inv2(mode.h)
        if np.any(det <= 0):
            return 1e100
        val = mode.pdev + float(np.sum(np.log(det)))
        if math.isfinite(val):
            warm["w"] = (mode.beta, mode.u)
            return val
        return 1e100

    bounds = [_LOG_L_BOUNDS, (-10.0, 10.0), _LOG_L_BOUNDS]
    # Primary start, then the alternatives only if the optimiser did not report convergence (the Laplace
    # deviance in theta is smooth and, in practice, unimodal for these designs; see tests).
    theta_starts = [
        np.array([math.log(0.8), 0.0, math.log(0.4)]),
        np.array([math.log(0.3), 0.0, math.log(0.15)]),
        np.array([math.log(1.5), 0.0, math.log(0.8)]),
    ]
    lo_b = np.array([b[0] for b in bounds])
    hi_b = np.array([b[1] for b in bounds])
    best: optimize.OptimizeResult | None = None
    polished = False
    with np.errstate(all="ignore"):
        for theta0 in theta_starts:
            warm["w"] = (beta_glm, zero_u)
            res = optimize.minimize(objective, theta0, method="L-BFGS-B", bounds=bounds, options={"maxiter": maxiter})
            if best is None or res.fun < best.fun:
                best = res
            if res.success:
                break
        assert best is not None
        theta = np.clip(best.x, lo_b, hi_b)
        if not best.success:
            polish = optimize.minimize(
                lambda t: objective(np.clip(t, lo_b, hi_b)),
                best.x,
                method="Nelder-Mead",
                options={"maxiter": maxiter * 4, "xatol": 1e-6, "fatol": 1e-8},
            )
            polished = bool(polish.success)
            if polish.fun <= best.fun:
                theta = np.clip(polish.x, lo_b, hi_b)
        lower = _lower(theta, independent)
        warm["w"] = (beta_glm, zero_u)
        mode = _pirls(prob, lower, beta_glm, zero_u, maxiter=200)
    h_inv, _ = _inv2(mode.h)
    blups = mode.u @ lower.T  # b_i = L u_i
    blup_cov = np.einsum("ij,kjl,ml->kim", lower, h_inv, lower)
    g = lower @ lower.T
    return GLMMFit(
        beta=mode.beta,
        g=g,
        blups=blups,
        blup_cov=blup_cov,
        groups=tuple(str(v) for v in uniq),
        converged=bool(best.success or polished) and mode.ok,
        deviance=float(objective(theta)),
    )
