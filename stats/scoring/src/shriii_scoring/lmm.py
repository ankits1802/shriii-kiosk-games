"""Fast REML linear mixed model with a random intercept and one random slope per person.

``y_ij = x_ij' beta + b0_i + b1_i * s_ij + e_ij``, ``(b0_i, b1_i) ~ N(0, G)``, ``e_ij ~ N(0, sigma^2)``.

The REML criterion is evaluated from per-person sufficient statistics (Woodbury identity with 2 x 2
blocks), so one evaluation costs O(persons) small-matrix operations instead of the per-group dense solves
of a general mixed-model package. Results agree with ``statsmodels`` MixedLM (REML) to optimiser tolerance;
the parity is unit-tested. BLUPs and their conditional (posterior) covariances ``sigma^2 (sigma^2 G^-1 +
Z'Z)^-1`` are returned for model-based reliability.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from scipy import optimize

__all__ = ["LMMFit", "fit_random_slope_lmm"]

FloatArray = NDArray[np.float64]


@dataclass(frozen=True, slots=True)
class LMMFit:
    """REML fit of the random-intercept, random-slope model."""

    beta: FloatArray
    g: FloatArray
    sigma2: float
    blups: FloatArray
    blup_cov: FloatArray
    groups: tuple[str, ...]
    converged: bool
    reml_criterion: float


def _inv2(m: FloatArray) -> tuple[FloatArray, FloatArray]:
    """Batched inverse and determinant of (k, 2, 2) matrices."""
    a, b, c, d = m[:, 0, 0], m[:, 0, 1], m[:, 1, 0], m[:, 1, 1]
    det = a * d - b * c
    inv = np.empty_like(m)
    inv[:, 0, 0] = d / det
    inv[:, 0, 1] = -b / det
    inv[:, 1, 0] = -c / det
    inv[:, 1, 1] = a / det
    return inv, det


def fit_random_slope_lmm(
    y: FloatArray,
    x: FloatArray,
    slope: FloatArray,
    groups: NDArray[np.str_] | list[str],
    *,
    maxiter: int = 500,
    independent: bool = False,
) -> LMMFit:
    """Fit by REML. ``x`` is the fixed-effects design (include an intercept column); ``slope`` is the
    covariate with a random slope (the random intercept is always included). ``independent=True`` fixes
    the intercept-slope covariance at zero (``(1 | person) + (0 + slope | person)``)."""
    y = np.asarray(y, dtype=float)
    x = np.asarray(x, dtype=float)
    s = np.asarray(slope, dtype=float)
    labels = np.asarray(groups)
    uniq, inverse = np.unique(labels, return_inverse=True)
    k = uniq.size
    p = x.shape[1]
    z = np.column_stack([np.ones_like(s), s])
    ztz = np.zeros((k, 2, 2))
    ztx = np.zeros((k, 2, p))
    zty = np.zeros((k, 2))
    np.add.at(ztz, inverse, z[:, :, None] * z[:, None, :])
    np.add.at(ztx, inverse, z[:, :, None] * x[:, None, :])
    np.add.at(zty, inverse, z * y[:, None])
    xtx = x.T @ x
    xty = x.T @ y
    yty = float(y @ y)
    n = y.size

    def unpack(theta: FloatArray) -> tuple[FloatArray, float]:
        l11, l21, l22, log_s2 = theta
        if independent:
            l21 = 0.0
        lower = np.array([[math.exp(l11), 0.0], [l21, math.exp(l22)]])
        return lower @ lower.T, math.exp(log_s2)

    def pieces(theta: FloatArray) -> tuple[float, FloatArray, FloatArray, FloatArray, float]:
        # Inverse-free form, stable when G is (near) singular:
        #   A_i = (s2 I + G Z'Z_i)^-1 G  (= (s2 G^-1 + Z'Z_i)^-1)
        #   log|V_i| = (n_i - 2) log s2 + log|s2 I + G Z'Z_i|
        g, s2 = unpack(theta)
        c = s2 * np.eye(2)[None, :, :] + np.einsum("ij,kjl->kil", g, ztz)
        c_inv, det_c = _inv2(c)
        if np.any(det_c <= 0):
            raise FloatingPointError("non-positive determinant")
        a = np.einsum("kij,jl->kil", c_inv, g)
        a = 0.5 * (a + np.transpose(a, (0, 2, 1)))
        azx = np.einsum("kij,kjl->kil", a, ztx)
        azy = np.einsum("kij,kj->ki", a, zty)
        xvx = (xtx - np.einsum("kji,kjl->il", ztx, azx)) / s2
        xvy = (xty - np.einsum("kji,kj->i", ztx, azy)) / s2
        yvy = (yty - float(np.einsum("ki,ki->", zty, azy))) / s2
        logdet_v = (n - 2 * k) * math.log(s2) + float(np.sum(np.log(det_c)))
        return logdet_v, xvx, xvy, a, yvy

    def reml(theta: FloatArray) -> float:
        try:
            logdet_v, xvx, xvy, _, yvy = pieces(theta)
            sign, logdet_x = np.linalg.slogdet(xvx)
            if sign <= 0:
                return 1e100
            beta = np.linalg.solve(xvx, xvy)
            quad = yvy - float(beta @ xvy)
            val = logdet_v + logdet_x + quad
            return val if math.isfinite(val) else 1e100
        except (np.linalg.LinAlgError, FloatingPointError, ValueError, OverflowError):
            return 1e100

    def theta_of(g: FloatArray, s2: float) -> FloatArray:
        g = g + np.eye(2) * 1e-10
        l11 = math.sqrt(max(g[0, 0], 1e-12))
        l21 = g[1, 0] / l11
        l22 = math.sqrt(max(g[1, 1] - l21 * l21, 1e-12))
        return np.array([math.log(l11), l21, math.log(l22), math.log(max(s2, 1e-12))])

    # Multi-start: fixed fractions of the OLS residual variance plus a moment-based start from per-person
    # OLS lines; each start is refined by L-BFGS-B then polished by Nelder-Mead; the best criterion wins.
    beta0, *_ = np.linalg.lstsq(x, y, rcond=None)
    resid = y - x @ beta0
    v0 = max(float(np.var(resid)), 1e-8)
    starts = [
        theta_of(np.diag([0.3 * v0, 0.1 * v0]), 0.6 * v0),
        theta_of(np.diag([0.05 * v0, 0.01 * v0]), 0.9 * v0),
        theta_of(np.diag([0.6 * v0, 0.4 * v0]), 0.3 * v0),
    ]
    coefs: list[FloatArray] = []
    res_vars: list[float] = []
    for gi in range(k):
        mask = inverse == gi
        if mask.sum() >= 3 and np.ptp(s[mask]) > 0:
            zz = z[mask]
            b, *_ = np.linalg.lstsq(zz, resid[mask], rcond=None)
            coefs.append(b)
            r_i = resid[mask] - zz @ b
            res_vars.append(float(r_i @ r_i) / max(mask.sum() - 2, 1))
    if len(coefs) >= 3:
        cov_b = np.cov(np.asarray(coefs), rowvar=False)
        starts.append(theta_of(0.5 * cov_b + np.diag([1e-6 * v0, 1e-6 * v0]), float(np.mean(res_vars))))
    best: optimize.OptimizeResult | None = None
    with np.errstate(all="ignore"):
        for theta0 in starts:
            res = optimize.minimize(reml, theta0, method="L-BFGS-B", options={"maxiter": maxiter})
            polish = optimize.minimize(
                reml, res.x, method="Nelder-Mead", options={"maxiter": maxiter * 4, "xatol": 1e-8, "fatol": 1e-10}
            )
            cand = polish if polish.fun <= res.fun else res
            if best is None or cand.fun < best.fun:
                best = cand
    assert best is not None
    res = best
    _, xvx, xvy, a, _ = pieces(res.x)
    beta = np.linalg.solve(xvx, xvy)
    g, s2 = unpack(res.x)
    resid_z = zty - np.einsum("kil,l->ki", ztx, beta)
    blups = np.einsum("kij,kj->ki", a, resid_z)
    blup_cov = s2 * a
    return LMMFit(
        beta=beta,
        g=g,
        sigma2=s2,
        blups=blups,
        blup_cov=blup_cov,
        groups=tuple(str(u) for u in uniq),
        converged=bool(res.success),
        reml_criterion=float(res.fun),
    )
