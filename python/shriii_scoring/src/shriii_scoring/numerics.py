"""Pure numeric building blocks for indicator formulas (unit-tested against hand computations)."""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Callable, Hashable, Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import ArrayLike, NDArray
from scipy import optimize

__all__ = [
    "EZResult",
    "MAPFit",
    "detrend",
    "eb_normal_shrinkage",
    "entropy_bits",
    "ez_diffusion",
    "fisher_z",
    "fit_hyperbolic_map",
    "hyperbolic_value",
    "lag1_autocorrelation",
    "levenshtein",
    "logit_corrected",
    "max_variance",
    "relative_variability_index",
]

FloatArray = NDArray[np.float64]


def logit_corrected(k: float, n: int) -> float:
    """Logit of (k + 0.5) / (n + 1) (shared.yaml transformation ``logit_corrected``)."""
    p = (k + 0.5) / (n + 1.0)
    return math.log(p / (1.0 - p))


def fisher_z(r: float, clip: float = 0.999999) -> float:
    """atanh(r) with clipping so that |r| = 1 stays finite."""
    return math.atanh(max(-clip, min(clip, r)))


def max_variance(mean: float, lo: float, hi: float, n: int) -> float:
    """Maximum possible sample variance (n - 1 denominator) of ``n`` values in [lo, hi] with mean ``mean``.

    The maximum puts as many values as possible at the bounds: ``k`` at ``hi``, ``n - k - 1`` at ``lo``
    and one value in between (Mestdagh et al., 2018, relativeVariability).
    """
    if n < 2 or hi <= lo:
        raise ValueError("max_variance needs n >= 2 and hi > lo")
    if mean <= lo or mean >= hi:
        return 0.0
    total = n * mean
    k = math.floor((total - n * lo) / (hi - lo))
    k = min(k, n - 1)
    rest = total - k * hi - (n - k - 1) * lo
    values = [hi] * k + [lo] * (n - k - 1) + [rest]
    return float(sum((v - mean) ** 2 for v in values) / (n - 1))


def relative_variability_index(values: Sequence[float], lo: float, hi: float) -> float:
    """Relative SD: sample SD divided by the maximum SD attainable given the mean, ``n`` and bounds."""
    x = np.asarray(values, dtype=float)
    if x.size < 2:
        return math.nan
    x = np.clip(x, lo, hi)
    mv = max_variance(float(x.mean()), lo, hi, int(x.size))
    if mv <= 0:
        return math.nan
    return float(math.sqrt(float(np.var(x, ddof=1)) / mv))


def detrend(values: Sequence[float] | FloatArray, index: Sequence[float] | FloatArray | None = None) -> FloatArray:
    """Remove a linear trend on ``index`` while keeping the mean (fatigue/practice drift)."""
    y = np.asarray(values, dtype=float)
    if y.size < 3:
        return y.copy()
    x = np.asarray(index if index is not None else np.arange(y.size), dtype=float)
    if np.ptp(x) == 0:
        return y.copy()
    slope, intercept = np.polyfit(x, y, 1)
    return np.asarray(y - (slope * x + intercept) + y.mean(), dtype=float)


def entropy_bits(choices: Sequence[Hashable]) -> float:
    """Shannon entropy (bits) of a sequence of categorical choices."""
    n = len(choices)
    if n == 0:
        return math.nan
    counts = Counter(choices)
    return float(-sum((c / n) * math.log2(c / n) for c in counts.values()))


def lag1_autocorrelation(segments: Sequence[Sequence[float]], min_linear: int = 6) -> tuple[float, int]:
    """Pooled lag-1 autocorrelation of within-segment deviations.

    Segments of at least ``min_linear`` values are linearly detrended, shorter ones only demeaned. Returns
    ``(r, n_pairs)``; segments shorter than 2 contribute nothing.
    """
    num = 0.0
    den = 0.0
    pairs = 0
    for seg in segments:
        y = np.asarray(seg, dtype=float)
        if y.size < 2:
            continue
        e = detrend(y) - y.mean() if y.size >= min_linear else y - y.mean()
        num += float(np.sum(e[:-1] * e[1:]))
        den += float(np.sum(e * e))
        pairs += int(y.size - 1)
    if pairs == 0 or den <= 0:
        return math.nan, pairs
    return num / den, pairs


def levenshtein(a: Sequence[Hashable], b: Sequence[Hashable]) -> int:
    """Edit distance (insertions, deletions, substitutions) between two sequences."""
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if ca == cb else 1))
        prev = cur
    return prev[-1]


@dataclass(frozen=True, slots=True)
class EZResult:
    """EZ-diffusion parameters (Wagenmakers, van der Maas & Grasman, 2007), scaling s = 0.1."""

    drift: float
    boundary: float
    nondecision: float
    edge_corrected: bool


def ez_diffusion(pc: float, vrt: float, mrt: float, n: int | None = None, s: float = 0.1) -> EZResult:
    """EZ-diffusion from proportion correct ``pc``, correct-RT variance ``vrt`` (s^2) and mean ``mrt`` (s).

    Edge correction: pc = 1 becomes 1 - 1/(2n) and pc = 0 becomes 1/(2n) when ``n`` is given; pc = 0.5
    exactly has zero drift and an undefined boundary (NaN).
    """
    edge = False
    if n is not None and n > 0:
        if pc >= 1.0:
            pc, edge = 1.0 - 1.0 / (2.0 * n), True
        elif pc <= 0.0:
            pc, edge = 1.0 / (2.0 * n), True
    if not 0.0 < pc < 1.0 or vrt <= 0.0:
        return EZResult(math.nan, math.nan, math.nan, edge)
    if pc == 0.5:
        return EZResult(0.0, math.nan, math.nan, edge)
    s2 = s * s
    lg = math.log(pc / (1.0 - pc))
    x = lg * (lg * pc * pc - lg * pc + pc - 0.5) / vrt
    v = math.copysign(1.0, pc - 0.5) * s * x**0.25
    a = s2 * lg / v
    y = -v * a / s2
    mdt = (a / (2.0 * v)) * (1.0 - math.exp(y)) / (1.0 + math.exp(y))
    return EZResult(drift=v, boundary=a, nondecision=mrt - mdt, edge_corrected=edge)


def hyperbolic_value(amount: FloatArray, cost: FloatArray, log_k: float) -> FloatArray:
    """Hyperbolic discounted value A / (1 + k D) (delay or effort as ``cost``)."""
    return np.asarray(amount / (1.0 + math.exp(log_k) * cost), dtype=float)


@dataclass(frozen=True, slots=True)
class MAPFit:
    """Penalised-likelihood (MAP) fit of a hyperbolic chooser for one person."""

    log_k: float
    log_beta: float
    log_k_sd: float
    n: int
    converged: bool
    p_larger: FloatArray


def fit_hyperbolic_map(
    small_amount: ArrayLike,
    small_cost: ArrayLike,
    large_amount: ArrayLike,
    large_cost: ArrayLike,
    chose_large: ArrayLike,
    *,
    log_k_prior: tuple[float, float],
    log_beta_prior: tuple[float, float],
    log_k_bounds: tuple[float, float],
    log_beta_bounds: tuple[float, float],
    start: tuple[float, float] | None = None,
) -> MAPFit:
    """MAP estimate of (log k, log beta) for P(large) = logistic(beta * (V_large - V_small) / max amount).

    Values are scaled by the largest amount so beta is unit-free. The posterior SD of log k comes from the
    observed information of the penalised log likelihood (Laplace approximation). Without ``start`` the
    optimiser is run from three starting points (the prior mean and the midpoints of the log k bounds) and
    the best optimum is kept; with ``start`` (warm start) it runs once from there.
    """
    sa = np.asarray(small_amount, dtype=float)
    sc = np.asarray(small_cost, dtype=float)
    la = np.asarray(large_amount, dtype=float)
    lc = np.asarray(large_cost, dtype=float)
    y = np.asarray(chose_large, dtype=float)
    scale = float(max(np.max(la), np.max(sa), 1e-9))
    mk, sk = log_k_prior
    mb, sb = log_beta_prior

    def nlp(theta: FloatArray) -> float:
        lk, lb = float(theta[0]), float(theta[1])
        diff = (hyperbolic_value(la, lc, lk) - hyperbolic_value(sa, sc, lk)) / scale
        eta = math.exp(lb) * diff
        ll = float(np.sum(y * eta - np.logaddexp(0.0, eta)))
        return -ll + 0.5 * ((lk - mk) / sk) ** 2 + 0.5 * ((lb - mb) / sb) ** 2

    def grad(theta: FloatArray) -> FloatArray:
        lk, lb = float(theta[0]), float(theta[1])
        k = math.exp(lk)
        b = math.exp(lb)
        diff = (hyperbolic_value(la, lc, lk) - hyperbolic_value(sa, sc, lk)) / scale
        d_diff = (-la * k * lc / (1.0 + k * lc) ** 2 + sa * k * sc / (1.0 + k * sc) ** 2) / scale
        eta = b * diff
        resid = y - 1.0 / (1.0 + np.exp(-eta))
        g_lk = -float(np.sum(resid * b * d_diff)) + (lk - mk) / (sk * sk)
        g_lb = -float(np.sum(resid * eta)) + (lb - mb) / (sb * sb)
        return np.array([g_lk, g_lb])

    starts = [start] if start is not None else [(mk, mb), (log_k_bounds[0] / 2.0, mb), (log_k_bounds[1] / 2.0, mb)]
    best: optimize.OptimizeResult | None = None
    for x0 in starts:
        res = optimize.minimize(
            nlp,
            x0=np.array(x0, dtype=float),
            jac=grad,
            method="L-BFGS-B",
            bounds=[log_k_bounds, log_beta_bounds],
        )
        if best is None or res.fun < best.fun:
            best = res
    assert best is not None
    lk, lb = float(best.x[0]), float(best.x[1])
    h = _hessian(nlp, np.array([lk, lb]))
    try:
        cov = np.linalg.inv(h)
        sd = float(math.sqrt(cov[0, 0])) if cov[0, 0] > 0 else math.nan
    except np.linalg.LinAlgError:
        sd = math.nan
    diff = (hyperbolic_value(la, lc, lk) - hyperbolic_value(sa, sc, lk)) / scale
    p = 1.0 / (1.0 + np.exp(-math.exp(lb) * diff))
    return MAPFit(log_k=lk, log_beta=lb, log_k_sd=sd, n=int(y.size), converged=bool(best.success), p_larger=p)


def _hessian(f: Callable[[FloatArray], float], x: FloatArray, h: float = 1e-4) -> FloatArray:
    n = x.size
    out = np.zeros((n, n))
    for i in range(n):
        for j in range(i, n):
            e_i = np.zeros(n)
            e_j = np.zeros(n)
            e_i[i] = h
            e_j[j] = h
            v = (f(x + e_i + e_j) - f(x + e_i - e_j) - f(x - e_i + e_j) + f(x - e_i - e_j)) / (4 * h * h)
            out[i, j] = out[j, i] = v
    return out


def eb_normal_shrinkage(estimates: ArrayLike, variances: ArrayLike) -> tuple[FloatArray, FloatArray, float, float]:
    """Empirical-Bayes normal-normal shrinkage.

    ``estimates[i] ~ N(theta_i, variances[i])`` with ``theta_i ~ N(mu, tau2)``; ``mu`` and ``tau2`` by the
    method of moments (tau2 floored at a small positive value). Returns posterior means, posterior SDs,
    ``mu`` and ``tau2``.
    """
    y = np.asarray(estimates, dtype=float)
    v = np.asarray(variances, dtype=float)
    mu = float(np.mean(y))
    tau2 = max(float(np.var(y, ddof=1)) - float(np.mean(v)), 1e-6 * max(float(np.var(y, ddof=1)), 1e-12))
    for _ in range(100):
        w = 1.0 / (tau2 + v)
        mu_new = float(np.sum(w * y) / np.sum(w))
        tau2_new = max(float(np.sum(w * w * ((y - mu_new) ** 2 - v)) / np.sum(w * w)), tau2 * 1e-3, 1e-12)
        if abs(mu_new - mu) < 1e-10 and abs(tau2_new - tau2) < 1e-10:
            mu, tau2 = mu_new, tau2_new
            break
        mu, tau2 = mu_new, tau2_new
    post_var = 1.0 / (1.0 / tau2 + 1.0 / v)
    post_mean = post_var * (y / v + mu / tau2)
    return post_mean, np.sqrt(post_var), mu, tau2
