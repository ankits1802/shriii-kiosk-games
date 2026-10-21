"""Fairness and measurement equivalence (VAL-08, VAL-09, VAL-16; spec section 6.5).

* logistic-regression DIF (Swaminathan & Rogers, 1990) with uniform / non-uniform / combined likelihood
  ratio tests, Nagelkerke delta R^2 effect sizes classified by Zumbo-Thomas and Jodoin-Gierl, iterative
  purification of the matching score, and BH-FDR across items; a linear-regression analogue for continuous
  items;
* TOST equivalence tests (two-sample Welch, one-sample, proportions) - non-significance is never treated as
  equivalence;
* differential prediction (Cleary model, step-down slope then intercept tests);
* group-wise calibration, completion / missingness disparity, device-familiarity effects.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from numpy.typing import ArrayLike, NDArray
from scipy import stats

from shriii_validation.params import ValidationParams, load_validation_params
from shriii_validation.results import EvidenceResult, make_provenance
from shriii_validation.validity import benjamini_hochberg

__all__ = [
    "DIFItem",
    "DIFResult",
    "calibration_by_group",
    "device_familiarity_effect",
    "differential_prediction",
    "disparity",
    "linear_dif",
    "logistic_dif",
    "ordinal_dif",
    "tost_one_sample",
    "tost_proportions",
    "tost_two_sample",
]

FloatArray = NDArray[np.float64]


# ---------------------------------------------------------------- logistic regression machinery


def _logit_fit(x: FloatArray, y: FloatArray, max_iter: int = 50, ridge: float = 1e-6) -> tuple[FloatArray, float]:
    """Newton-Raphson logistic regression; a tiny ridge keeps separated items finite. Returns (beta, loglik)."""
    beta = np.zeros(x.shape[1])
    for _ in range(max_iter):
        eta = np.clip(x @ beta, -30, 30)
        p = 1.0 / (1.0 + np.exp(-eta))
        w = p * (1 - p)
        grad = x.T @ (y - p) - ridge * beta
        hess = (x * w[:, None]).T @ x + ridge * np.eye(x.shape[1])
        step = np.linalg.solve(hess, grad)
        beta = beta + step
        if np.max(np.abs(step)) < 1e-9:
            break
    eta = np.clip(x @ beta, -30, 30)
    ll = float(np.sum(y * eta - np.logaddexp(0.0, eta)))
    return beta, ll


def _nagelkerke(ll_model: float, ll_null: float, n: int) -> float:
    cs = 1.0 - math.exp((2.0 / n) * (ll_null - ll_model))
    mx = 1.0 - math.exp((2.0 / n) * ll_null)
    return cs / mx if mx > 0 else 0.0


@dataclass(frozen=True, slots=True)
class DIFItem:
    """DIF statistics for one item."""

    item: str
    n: int
    chi2_uniform: float
    p_uniform: float
    chi2_nonuniform: float
    p_nonuniform: float
    chi2_combined: float
    p_combined: float
    p_combined_fdr: float
    delta_r2_uniform: float
    delta_r2_combined: float
    zumbo_thomas: str
    jodoin_gierl: str
    flagged: bool


@dataclass(frozen=True, slots=True)
class DIFResult:
    """Item-level DIF results plus the purified anchor set."""

    items: list[DIFItem]
    anchors: tuple[str, ...]
    iterations: int
    method: str
    warnings: tuple[str, ...] = ()
    details: Mapping[str, Any] = field(default_factory=dict)

    def flagged(self) -> list[str]:
        return [i.item for i in self.items if i.flagged]


def _classify(delta: float, significant: bool, bounds: Mapping[str, float]) -> str:
    if not significant or delta < bounds["moderate"]:
        return "A"
    if delta < bounds["large"]:
        return "B"
    return "C"


def _group_codes(group: ArrayLike, focal: Any | None) -> FloatArray:
    g = np.asarray(group)
    labels = sorted(set(g.tolist()))
    if len(labels) != 2:
        raise ValueError("DIF needs exactly two groups (reference and focal)")
    foc = focal if focal is not None else labels[1]
    return np.asarray(g == foc, dtype=float)


def logistic_dif(
    responses: ArrayLike,
    group: ArrayLike,
    *,
    items: Sequence[str] | None = None,
    focal: Any | None = None,
    matching: ArrayLike | None = None,
    purify: bool = True,
    alpha: float | None = None,
    criterion: Literal["jodoin_gierl", "zumbo_thomas"] = "jodoin_gierl",
    params: ValidationParams | None = None,
) -> DIFResult:
    """Logistic-regression DIF for dichotomous items (persons x items, 0/1, NaN allowed per item).

    Models per item: M0 ``logit(y) ~ theta``, M1 ``+ group``, M2 ``+ theta x group`` with theta the
    standardised matching score (rest score on the current anchor set unless ``matching`` is supplied).
    An item is flagged when the FDR-adjusted combined (2-df) test is significant and its Nagelkerke delta
    R^2 reaches the moderate bound of ``criterion``. With ``purify`` the anchor set excludes flagged items
    and the analysis repeats until the flagged set is stable.
    """
    prm = params or load_validation_params()
    a = alpha if alpha is not None else prm.f("dif.fdr_alpha")
    y_all = np.asarray(responses, dtype=float)
    n, k = y_all.shape
    names = list(items) if items is not None else [f"item_{j}" for j in range(k)]
    g = _group_codes(group, focal)
    zt = prm.get("dif.zumbo_thomas")
    jg = prm.get("dif.jodoin_gierl")
    bounds = jg if criterion == "jodoin_gierl" else zt
    flagged: set[int] = set()
    iterations = 0
    results: list[DIFItem] = []
    max_iter = prm.i("dif.purification_max_iter") if purify else 1
    for _ in range(max_iter):
        iterations += 1
        anchors = [j for j in range(k) if j not in flagged]
        results = []
        raw_p: list[float] = []
        stats_rows: list[tuple[int, float, float, float, float, float, float, float, float]] = []
        for j in range(k):
            yj = y_all[:, j]
            if matching is not None:
                theta = np.asarray(matching, dtype=float)
            else:
                rest = [c for c in anchors if c != j]
                theta = np.nansum(y_all[:, rest], axis=1) if rest else np.zeros(n)
            ok = np.isfinite(yj) & np.isfinite(theta)
            yy, th, gg = yj[ok], theta[ok], g[ok]
            m = int(ok.sum())
            sd = th.std()
            th = (th - th.mean()) / sd if sd > 0 else th - th.mean()
            ones = np.ones(m)
            _, ll_null = _logit_fit(ones[:, None], yy)
            _, ll0 = _logit_fit(np.column_stack([ones, th]), yy)
            _, ll1 = _logit_fit(np.column_stack([ones, th, gg]), yy)
            _, ll2 = _logit_fit(np.column_stack([ones, th, gg, th * gg]), yy)
            c_u = max(2 * (ll1 - ll0), 0.0)
            c_n = max(2 * (ll2 - ll1), 0.0)
            c_c = max(2 * (ll2 - ll0), 0.0)
            r0 = _nagelkerke(ll0, ll_null, m)
            r1 = _nagelkerke(ll1, ll_null, m)
            r2 = _nagelkerke(ll2, ll_null, m)
            p_c = float(stats.chi2.sf(c_c, 2))
            raw_p.append(p_c)
            stats_rows.append(
                (m, c_u, float(stats.chi2.sf(c_u, 1)), c_n, float(stats.chi2.sf(c_n, 1)), c_c, p_c, r1 - r0, r2 - r0)
            )
        adj, rej = benjamini_hochberg(raw_p, a)
        new_flagged: set[int] = set()
        for j, row in enumerate(stats_rows):
            m, c_u, p_u, c_n, p_n, c_c, p_c, d_u, d_c = row
            sig = bool(rej[j])
            zt_class = _classify(d_c, sig, zt)
            jg_class = _classify(d_c, sig, jg)
            flag = sig and d_c >= bounds["moderate"]
            if flag:
                new_flagged.add(j)
            results.append(
                DIFItem(names[j], m, c_u, p_u, c_n, p_n, c_c, p_c, float(adj[j]), d_u, d_c, zt_class, jg_class, flag)
            )
        if not purify or matching is not None or new_flagged == flagged:
            flagged = new_flagged
            break
        flagged = new_flagged
    warnings: tuple[str, ...] = ()
    if purify and matching is None and iterations == max_iter:
        warnings = ("purification reached the iteration limit",)
    return DIFResult(
        results,
        tuple(names[j] for j in range(k) if j not in flagged),
        iterations,
        f"logistic_regression_dif_{criterion}",
        warnings,
        {"alpha_fdr": a, "n": n},
    )


def ordinal_dif(
    responses: ArrayLike,
    group: ArrayLike,
    *,
    items: Sequence[str] | None = None,
    focal: Any | None = None,
    matching: ArrayLike | None = None,
    alpha: float | None = None,
    criterion: Literal["jodoin_gierl", "zumbo_thomas"] = "jodoin_gierl",
    params: ValidationParams | None = None,
) -> DIFResult:
    """Ordinal logistic-regression DIF (proportional-odds models, Zumbo, 1999) for Likert items.

    Same model sequence, tests and effect-size classification as :func:`logistic_dif`; the matching
    variable is the standardised rest score (or ``matching``). No purification iterations (one pass).
    """
    from statsmodels.miscmodels.ordinal_model import OrderedModel  # noqa: PLC0415 - heavy, loaded on demand

    prm = params or load_validation_params()
    a = alpha if alpha is not None else prm.f("dif.fdr_alpha")
    y_all = np.asarray(responses, dtype=float)
    n, k = y_all.shape
    names = list(items) if items is not None else [f"item_{j}" for j in range(k)]
    g = _group_codes(group, focal)
    zt = prm.get("dif.zumbo_thomas")
    jg = prm.get("dif.jodoin_gierl")
    bounds = jg if criterion == "jodoin_gierl" else zt
    rows: list[tuple[int, float, float, float, float, float, float, float, float]] = []
    raw_p: list[float] = []
    for j in range(k):
        yj = y_all[:, j]
        theta = (
            np.asarray(matching, dtype=float)
            if matching is not None
            else np.nansum(np.delete(y_all, j, axis=1), axis=1)
        )
        ok = np.isfinite(yj) & np.isfinite(theta)
        yy, th, gg = yj[ok], theta[ok], g[ok]
        m = int(ok.sum())
        th = (th - th.mean()) / (th.std() or 1.0)
        _, counts = np.unique(yy, return_counts=True)
        ll_null = float(np.sum(counts * np.log(counts / m)))

        def ll(cols: list[FloatArray], yy: FloatArray = yy) -> float:
            res = OrderedModel(yy, np.column_stack(cols), distr="logit").fit(method="bfgs", disp=False, maxiter=500)
            return float(res.llf)

        ll0 = ll([th])
        ll1 = ll([th, gg])
        ll2 = ll([th, gg, th * gg])
        c_u, c_n, c_c = max(2 * (ll1 - ll0), 0.0), max(2 * (ll2 - ll1), 0.0), max(2 * (ll2 - ll0), 0.0)
        r0, r1, r2 = (_nagelkerke(v, ll_null, m) for v in (ll0, ll1, ll2))
        p_c = float(stats.chi2.sf(c_c, 2))
        raw_p.append(p_c)
        rows.append(
            (m, c_u, float(stats.chi2.sf(c_u, 1)), c_n, float(stats.chi2.sf(c_n, 1)), c_c, p_c, r1 - r0, r2 - r0)
        )
    adj, rej = benjamini_hochberg(raw_p, a)
    out: list[DIFItem] = []
    for j, (m, c_u, p_u, c_n, p_n, c_c, p_c, d_u, d_c) in enumerate(rows):
        sig = bool(rej[j])
        out.append(
            DIFItem(
                names[j],
                m,
                c_u,
                p_u,
                c_n,
                p_n,
                c_c,
                p_c,
                float(adj[j]),
                d_u,
                d_c,
                _classify(d_c, sig, zt),
                _classify(d_c, sig, jg),
                sig and d_c >= bounds["moderate"],
            )
        )
    flagged = {i.item for i in out if i.flagged}
    return DIFResult(
        out,
        tuple(x for x in names if x not in flagged),
        1,
        f"ordinal_logistic_dif_{criterion}",
        (),
        {"alpha_fdr": a, "n": n},
    )


def linear_dif(
    values: ArrayLike,
    group: ArrayLike,
    matching: ArrayLike,
    *,
    items: Sequence[str] | None = None,
    focal: Any | None = None,
    alpha: float = 0.05,
) -> list[dict[str, float | str | bool]]:
    """Regression DIF for continuous items/indicators (e.g. RT or rates): y ~ theta (+ group + theta x group),
    nested F tests and delta R^2, BH-FDR across items."""
    y_all = np.asarray(values, dtype=float)
    if y_all.ndim == 1:
        y_all = y_all[:, None]
    g = _group_codes(group, focal)
    theta_all = np.asarray(matching, dtype=float)
    names = list(items) if items is not None else [f"item_{j}" for j in range(y_all.shape[1])]
    rows: list[dict[str, float | str | bool]] = []
    ps: list[float] = []
    for j in range(y_all.shape[1]):
        ok = np.isfinite(y_all[:, j]) & np.isfinite(theta_all)
        y, th, gg = y_all[ok, j], theta_all[ok], g[ok]
        n = y.size
        ones = np.ones(n)

        def rss(x: FloatArray, y: FloatArray = y) -> float:
            b = np.linalg.lstsq(x, y, rcond=None)[0]
            r = y - x @ b
            return float(r @ r)

        tss = float(np.sum((y - y.mean()) ** 2))
        r0 = rss(np.column_stack([ones, th]))
        r2 = rss(np.column_stack([ones, th, gg, th * gg]))
        f = ((r0 - r2) / 2) / (r2 / (n - 4))
        p = float(stats.f.sf(f, 2, n - 4))
        ps.append(p)
        rows.append(
            {
                "item": names[j],
                "n": n,
                "F_combined": f,
                "p_combined": p,
                "delta_r2": (r0 - r2) / tss if tss > 0 else 0.0,
            }
        )
    adj, rej = benjamini_hochberg(ps, alpha)
    for row, a, r in zip(rows, adj, rej, strict=True):
        row["p_fdr"] = a
        row["flagged"] = bool(r)
    return rows


# ---------------------------------------------------------------- equivalence (TOST)


def tost_two_sample(
    x: ArrayLike,
    y: ArrayLike,
    *,
    bound: float | None = None,
    bound_type: Literal["raw", "d"] = "d",
    alpha: float = 0.05,
    params: ValidationParams | None = None,
) -> EvidenceResult:
    """Welch two one-sided tests for equivalence of means within +-``bound`` (raw units or SD units).

    ``estimate`` is the mean difference x - y; the CI is the (1 - 2 alpha) interval. Equivalence is declared
    only when both one-sided tests reject (``details['equivalent']``).
    """
    prm = params or load_validation_params()
    a = np.asarray(x, dtype=float)
    b = np.asarray(y, dtype=float)
    a, b = a[np.isfinite(a)], b[np.isfinite(b)]
    n1, n2 = a.size, b.size
    prov = make_provenance("tost_two_sample", a, b, params={"bound": bound, "bound_type": bound_type})
    if n1 < 2 or n2 < 2:
        return EvidenceResult.unavailable(
            "tost", "welch_tost", "need >= 2 per group", n=n1 + n2, status="insufficient", provenance=prov
        )
    v1, v2 = a.var(ddof=1), b.var(ddof=1)
    diff = float(a.mean() - b.mean())
    se = math.sqrt(v1 / n1 + v2 / n2)
    df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1))
    bnd = bound if bound is not None else prm.f("fairness.tost_bound_d")
    if bound_type == "d":
        sp = math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2))
        bnd = bnd * sp
    p_lower = float(stats.t.sf((diff + bnd) / se, df))
    p_upper = float(stats.t.cdf((diff - bnd) / se, df))
    tq = float(stats.t.ppf(1 - alpha, df))
    p = max(p_lower, p_upper)
    return EvidenceResult(
        "tost",
        diff,
        diff - tq * se,
        diff + tq * se,
        1 - 2 * alpha,
        n1 + n2,
        "welch_tost",
        details={
            "bound": bnd,
            "p_tost": p,
            "p_lower": p_lower,
            "p_upper": p_upper,
            "equivalent": bool(p < alpha),
            "df": df,
        },
        provenance=prov,
    )


def tost_one_sample(
    estimate: float, se: float, *, low: float, high: float, df: float | None = None, alpha: float = 0.05, n: int = 0
) -> EvidenceResult:
    """TOST for a single estimate with standard error ``se`` against the interval [low, high]
    (normal reference unless ``df`` is given)."""
    if df is None:
        p_lower = float(stats.norm.sf((estimate - low) / se))
        p_upper = float(stats.norm.cdf((estimate - high) / se))
        q = float(stats.norm.ppf(1 - alpha))
    else:
        p_lower = float(stats.t.sf((estimate - low) / se, df))
        p_upper = float(stats.t.cdf((estimate - high) / se, df))
        q = float(stats.t.ppf(1 - alpha, df))
    p = max(p_lower, p_upper)
    return EvidenceResult(
        "tost_one_sample",
        estimate,
        estimate - q * se,
        estimate + q * se,
        1 - 2 * alpha,
        n,
        "tost_one_sample",
        details={"low": low, "high": high, "p_tost": p, "equivalent": bool(p < alpha)},
        provenance=make_provenance("tost_one_sample", [estimate, se, low, high]),
    )


def tost_proportions(k1: int, n1: int, k2: int, n2: int, *, bound: float, alpha: float = 0.05) -> EvidenceResult:
    """TOST for the difference of two proportions within +-``bound`` (unpooled normal approximation)."""
    p1, p2 = k1 / n1, k2 / n2
    se = math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2) or 1e-12
    return tost_one_sample(p1 - p2, se, low=-bound, high=bound, alpha=alpha, n=n1 + n2)


# ---------------------------------------------------------------- differential prediction and calibration


def differential_prediction(
    y: ArrayLike, x: ArrayLike, group: ArrayLike, *, focal: Any | None = None, alpha: float = 0.05
) -> EvidenceResult:
    """Cleary-model differential prediction with the step-down sequence (Lautenschlager & Mendoza, 1986):
    omnibus (group + x:group), slope difference (x:group), then intercept difference given a common slope."""
    yy = np.asarray(y, dtype=float)
    xx = np.asarray(x, dtype=float)
    g = _group_codes(group, focal)
    ok = np.isfinite(yy) & np.isfinite(xx)
    yy, xx, g = yy[ok], xx[ok], g[ok]
    n = yy.size
    prov = make_provenance("differential_prediction", yy, xx, g)
    if n < 20:
        return EvidenceResult.unavailable(
            "differential_prediction", "cleary", "fewer than 20 cases", n=n, status="insufficient", provenance=prov
        )
    ones = np.ones(n)

    def fit(xm: FloatArray) -> tuple[FloatArray, float, FloatArray]:
        b = np.linalg.lstsq(xm, yy, rcond=None)[0]
        r = yy - xm @ b
        rss = float(r @ r)
        cov = rss / (n - xm.shape[1]) * np.linalg.pinv(xm.T @ xm)
        return b, rss, cov

    b0, rss0, _ = fit(np.column_stack([ones, xx]))
    b1, rss1, cov1 = fit(np.column_stack([ones, xx, g]))
    b2, rss2, cov2 = fit(np.column_stack([ones, xx, g, xx * g]))
    f_omni = ((rss0 - rss2) / 2) / (rss2 / (n - 4))
    f_slope = (rss1 - rss2) / (rss2 / (n - 4))
    f_int = (rss0 - rss1) / (rss1 / (n - 3))
    p_omni = float(stats.f.sf(f_omni, 2, n - 4))
    p_slope = float(stats.f.sf(f_slope, 1, n - 4))
    p_int = float(stats.f.sf(f_int, 1, n - 3))
    tq = float(stats.t.ppf(1 - alpha / 2, n - 4))
    slope_diff = float(b2[3])
    se_slope = math.sqrt(cov2[3, 3])
    conclusion = "no_differential_prediction"
    if p_omni < alpha:
        conclusion = (
            "slope_difference" if p_slope < alpha else ("intercept_difference" if p_int < alpha else "omnibus_only")
        )
    return EvidenceResult(
        "differential_prediction",
        slope_diff,
        slope_diff - tq * se_slope,
        slope_diff + tq * se_slope,
        1 - alpha,
        n,
        "cleary_step_down",
        details={
            "F_omnibus": f_omni,
            "p_omnibus": p_omni,
            "F_slope": f_slope,
            "p_slope": p_slope,
            "F_intercept": f_int,
            "p_intercept": p_int,
            "intercept_difference": float(b1[2]),
            "intercept_difference_se": math.sqrt(cov1[2, 2]),
            "common_slope": float(b0[1]),
            "conclusion": conclusion,
        },
        provenance=prov,
    )


def calibration_by_group(
    y_true: ArrayLike, y_pred: ArrayLike, group: ArrayLike, *, min_n: int = 30
) -> dict[str, EvidenceResult]:
    """Per-group calibration: slope and intercept of observed on predicted (ideal 1 and 0) and the mean
    residual (calibration-in-the-large). Groups below ``min_n`` are ``insufficient``."""
    yt = np.asarray(y_true, dtype=float)
    yp = np.asarray(y_pred, dtype=float)
    gr = np.asarray(group)
    out: dict[str, EvidenceResult] = {}
    for label in sorted(set(gr.tolist())):
        mask = (gr == label) & np.isfinite(yt) & np.isfinite(yp)
        n = int(mask.sum())
        prov = make_provenance("calibration_by_group", yt[mask], yp[mask])
        if n < min_n:
            out[str(label)] = EvidenceResult.unavailable(
                "calibration", "ols_calibration", f"n={n} < {min_n}", n=n, status="insufficient", provenance=prov
            )
            continue
        xm = np.column_stack([np.ones(n), yp[mask]])
        b, *_ = np.linalg.lstsq(xm, yt[mask], rcond=None)
        resid = yt[mask] - yp[mask]
        r = yt[mask] - xm @ b
        cov = float(r @ r) / (n - 2) * np.linalg.inv(xm.T @ xm)
        tq = float(stats.t.ppf(0.975, n - 2))
        out[str(label)] = EvidenceResult(
            "calibration_slope",
            float(b[1]),
            float(b[1] - tq * math.sqrt(cov[1, 1])),
            float(b[1] + tq * math.sqrt(cov[1, 1])),
            0.95,
            n,
            "ols_observed_on_predicted",
            details={
                "intercept": float(b[0]),
                "mean_residual": float(resid.mean()),
                "rmse": float(math.sqrt(np.mean(resid**2))),
            },
            provenance=prov,
        )
    return out


def disparity(indicator: ArrayLike, group: ArrayLike, *, threshold_pp: float, min_cell_n: int) -> EvidenceResult:
    """Rate disparity (completion, missingness, exclusion) across groups: max difference in percentage
    points against ``threshold_pp`` with a chi-square test; cells below ``min_cell_n`` are suppressed."""
    flag = np.asarray(indicator, dtype=float)
    gr = np.asarray(group)
    rates: dict[str, float] = {}
    counts: dict[str, int] = {}
    table: list[list[float]] = []
    suppressed: list[str] = []
    for label in sorted(set(gr.tolist())):
        mask = (gr == label) & np.isfinite(flag)
        n = int(mask.sum())
        counts[str(label)] = n
        if n < min_cell_n:
            suppressed.append(str(label))
            continue
        k = float(flag[mask].sum())
        rates[str(label)] = k / n
        table.append([k, n - k])
    prov = make_provenance("disparity", flag, params={"threshold_pp": threshold_pp})
    if len(rates) < 2:
        return EvidenceResult.unavailable(
            "disparity",
            "rate_difference",
            "fewer than two reportable groups",
            n=int(np.isfinite(flag).sum()),
            status="insufficient",
            provenance=prov,
        )
    diff = (max(rates.values()) - min(rates.values())) * 100
    tab = np.asarray(table)
    p = float(stats.chi2_contingency(tab)[1]) if np.all(tab.sum(axis=0) > 0) else math.nan
    return EvidenceResult(
        "disparity",
        diff,
        None,
        None,
        None,
        int(sum(counts.values())),
        "max_rate_difference_pp",
        warnings=(f"disparity {diff:.1f} pp exceeds {threshold_pp} pp",) if diff > threshold_pp else (),
        details={
            "rates": rates,
            "counts": counts,
            "suppressed": suppressed,
            "p_chi2": p,
            "exceeds_threshold": bool(diff > threshold_pp),
        },
        provenance=prov,
    )


def device_familiarity_effect(
    y: ArrayLike,
    familiarity: ArrayLike,
    covariates: ArrayLike | None = None,
    *,
    bound_d: float | None = None,
    params: ValidationParams | None = None,
) -> EvidenceResult:
    """Device-familiarity effect on an indicator: ANCOVA F test (familiarity dummies over covariates such as
    ability), partial eta^2, and pairwise TOST equivalence of adjusted means in SD units."""
    prm = params or load_validation_params()
    yy = np.asarray(y, dtype=float)
    fam = np.asarray(familiarity)
    cov = None if covariates is None else np.asarray(covariates, dtype=float)
    if cov is not None and cov.ndim == 1:
        cov = cov[:, None]
    ok = np.isfinite(yy) & (np.all(np.isfinite(cov), axis=1) if cov is not None else True)
    yy, fam = yy[ok], fam[ok]
    cov = cov[ok] if cov is not None else None
    labels = sorted(set(fam.tolist()))
    n = yy.size
    prov = make_provenance("device_familiarity_effect", yy, params={"levels": [str(v) for v in labels]})
    if len(labels) < 2 or n < 10:
        return EvidenceResult.unavailable(
            "device_familiarity",
            "ancova",
            "need >= 2 levels and >= 10 cases",
            n=n,
            status="insufficient",
            provenance=prov,
        )
    base = [np.ones(n)] + ([cov[:, j] for j in range(cov.shape[1])] if cov is not None else [])
    dummies = [(fam == lv).astype(float) for lv in labels[1:]]

    def rss(cols: list[FloatArray]) -> tuple[float, FloatArray]:
        xm = np.column_stack(cols)
        b = np.linalg.lstsq(xm, yy, rcond=None)[0]
        r = yy - xm @ b
        return float(r @ r), r

    rss_r, resid_r = rss(base)
    rss_f, _ = rss(base + dummies)
    df1, df2 = len(dummies), n - len(base) - len(dummies)
    f = ((rss_r - rss_f) / df1) / (rss_f / df2)
    eta = (rss_r - rss_f) / rss_r if rss_r > 0 else 0.0
    sd = float(np.std(yy, ddof=1))
    pairwise: dict[str, Any] = {}
    for i in range(len(labels)):
        for j in range(i + 1, len(labels)):
            a = resid_r[fam == labels[i]]
            b = resid_r[fam == labels[j]]
            res = tost_two_sample(
                a, b, bound=(bound_d if bound_d is not None else prm.f("fairness.tost_bound_d")) * sd, bound_type="raw"
            )
            pairwise[f"{labels[i]}_vs_{labels[j]}"] = {
                "difference": res.estimate,
                "equivalent": res.details.get("equivalent") if res.ok else None,
            }
    return EvidenceResult(
        "device_familiarity",
        float(eta),
        None,
        None,
        None,
        n,
        "ancova_partial_eta2_tost",
        details={"F": f, "p": float(stats.f.sf(f, df1, df2)), "df1": df1, "df2": df2, "pairwise_equivalence": pairwise},
        provenance=prov,
    )
