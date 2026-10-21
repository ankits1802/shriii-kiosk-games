"""Factor structure (VAL-07, VAL-08a; spec section 6.3).

* EFA (ML extraction; factor_analyzer rotation/KMO/Bartlett) with oblimin rotation, cross-loading and Heywood
  detection;
* Horn's parallel analysis (principal components and common-factor eigenvalues);
* CFA via semopy with CFI, TLI, RMSEA and SRMR (SRMR computed from the model-implied covariance);
  CFA is refused for constructs with fewer than 3 indicators (VAL-07 AC);
* competing-model comparison (chi-square difference for nested models, AIC/BIC);
* multi-group CFA invariance (configural, metric, scalar, optionally partial scalar) by maximum likelihood
  with a mean structure, implemented here because semopy has no cross-group equality constraints; the
  configural chi-square equals the sum of single-group chi-squares (unit-tested). Ordinal/WLSMV
  invariance, automated partial-invariance search and Bayesian approximate invariance go to the R backend;
* redundancy detection.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
import pandas as pd  # type: ignore[import-untyped]
from numpy.typing import ArrayLike, NDArray
from scipy import optimize, stats

from shriii_validation.params import ValidationParams, load_validation_params
from shriii_validation.results import AssumptionCheck, EvidenceResult, make_provenance

__all__ = [
    "MultiGroupFit",
    "cfa",
    "compare_models",
    "efa",
    "fit_multigroup_cfa",
    "measurement_invariance",
    "parallel_analysis",
    "redundancy",
]

FloatArray = NDArray[np.float64]
Level = Literal["configural", "metric", "scalar"]


# ---------------------------------------------------------------- EFA and parallel analysis


def parallel_analysis(
    data: ArrayLike,
    *,
    iterations: int | None = None,
    quantile: float | None = None,
    seed: int = 0,
    params: ValidationParams | None = None,
) -> EvidenceResult:
    """Horn's parallel analysis: number of components / factors whose observed eigenvalue exceeds the
    ``quantile`` of eigenvalues from random normal data of the same size. Factor eigenvalues use the
    reduced correlation matrix (squared multiple correlations on the diagonal)."""
    prm = params or load_validation_params()
    it = iterations or prm.i("structure.parallel_analysis_iterations")
    q = quantile or prm.f("structure.parallel_analysis_quantile")
    x = np.asarray(data, dtype=float)
    x = x[np.all(np.isfinite(x), axis=1)]
    n, p = x.shape
    prov = make_provenance("parallel_analysis", x, seed=seed, params={"iterations": it, "quantile": q})
    if n < p + 2:
        return EvidenceResult.unavailable(
            "parallel_analysis", "horn", "fewer rows than variables + 2", n=n, status="insufficient", provenance=prov
        )

    def eig(c: FloatArray, reduced: bool) -> FloatArray:
        if reduced:
            smc = 1 - 1 / np.diag(np.linalg.pinv(c))
            c = c.copy()
            np.fill_diagonal(c, smc)
        return np.sort(np.linalg.eigvalsh(c))[::-1]

    corr = np.asarray(np.corrcoef(x, rowvar=False), dtype=float)
    obs_pc, obs_fa = eig(corr, False), eig(corr, True)
    rng = np.random.default_rng(seed)
    sim_pc = np.empty((it, p))
    sim_fa = np.empty((it, p))
    for i in range(it):
        r = np.asarray(np.corrcoef(rng.normal(size=(n, p)), rowvar=False), dtype=float)
        sim_pc[i], sim_fa[i] = eig(r, False), eig(r, True)
    thr_pc, thr_fa = np.quantile(sim_pc, q, axis=0), np.quantile(sim_fa, q, axis=0)

    def count(obs: FloatArray, thr: FloatArray) -> int:
        k = 0
        for o, t in zip(obs, thr, strict=True):
            if o > t:
                k += 1
            else:
                break
        return k

    n_pc, n_fa = count(obs_pc, thr_pc), count(obs_fa, thr_fa)
    return EvidenceResult(
        "parallel_analysis",
        float(n_fa),
        None,
        None,
        None,
        n,
        "horn_parallel_analysis",
        details={
            "n_factors": n_fa,
            "n_components": n_pc,
            "observed_pc": obs_pc.tolist(),
            "threshold_pc": thr_pc.tolist(),
            "observed_fa": obs_fa.tolist(),
            "threshold_fa": thr_fa.tolist(),
        },
        provenance=prov,
    )


def _ml_factors(corr: FloatArray, m: int) -> tuple[FloatArray, FloatArray, bool]:
    """Maximum-likelihood common-factor extraction on a correlation matrix (unrotated loadings, uniquenesses).

    Implemented directly (L-BFGS on the ML discrepancy from a principal-axis start) because
    factor_analyzer 0.5's fitting routine is incompatible with the installed scikit-learn; its rotation,
    KMO and Bartlett utilities are still used.
    """
    p = corr.shape[0]
    w, v = np.linalg.eigh(corr)
    order = np.argsort(w)[::-1][:m]
    lam0 = v[:, order] * np.sqrt(np.clip(w[order], 1e-6, None))
    psi0 = np.clip(1 - np.sum(lam0**2, axis=1), 0.05, 0.95)

    def f(theta: FloatArray) -> float:
        lam = theta[: p * m].reshape(p, m)
        psi = np.exp(theta[p * m :])
        sigma = lam @ lam.T + np.diag(psi)
        sign, logdet = np.linalg.slogdet(sigma)
        if sign <= 0:
            return 1e10
        return float(logdet + np.trace(corr @ np.linalg.inv(sigma)))

    res = optimize.minimize(
        f, np.concatenate([lam0.ravel(), np.log(psi0)]), method="L-BFGS-B", options={"maxiter": 5000}
    )
    lam = res.x[: p * m].reshape(p, m)
    psi = np.exp(res.x[p * m :])
    return lam, psi, bool(res.success)


def efa(
    data: pd.DataFrame,
    n_factors: int,
    *,
    rotation: str | None = "oblimin",
    params: ValidationParams | None = None,
) -> EvidenceResult:
    """Exploratory ML factor analysis with assumption checks (KMO, Bartlett), rotated loadings,
    communalities, cross-loadings (|loading| >= ``structure.cross_loading_min`` on more than one factor) and
    Heywood cases (uniqueness near 0 / communality >= 1)."""
    from factor_analyzer import Rotator, calculate_bartlett_sphericity, calculate_kmo  # noqa: PLC0415 - heavy

    prm = params or load_validation_params()
    df = data.dropna()
    n, p = df.shape
    prov = make_provenance("efa", df.to_numpy(), params={"n_factors": n_factors, "rotation": rotation})
    if n < 3 * p or n_factors >= p:
        return EvidenceResult.unavailable(
            "efa",
            "efa_ml",
            "need n >= 3p and fewer factors than variables",
            n=n,
            status="insufficient",
            provenance=prov,
        )
    chi2, p_bart = calculate_bartlett_sphericity(df)
    _, kmo = calculate_kmo(df)
    corr = np.corrcoef(df.to_numpy(), rowvar=False)
    lam, psi, converged = _ml_factors(corr, n_factors)
    phi = np.eye(n_factors)
    if n_factors > 1 and rotation:
        rot = Rotator(method=rotation)
        lam = rot.fit_transform(lam)
        if getattr(rot, "phi_", None) is not None:
            phi = np.asarray(rot.phi_)
    comm = 1 - psi
    thr = prm.f("structure.cross_loading_min")
    cross = [str(c) for c, row in zip(df.columns, lam, strict=True) if np.sum(np.abs(row) >= thr) > 1]
    heywood = [str(c) for c, u in zip(df.columns, psi, strict=True) if u < 0.005]
    checks = (
        AssumptionCheck("kmo_adequacy", bool(kmo >= 0.6), float(kmo), "KMO >= .60"),
        AssumptionCheck("bartlett_sphericity", bool(p_bart < 0.05), float(chi2), f"p = {p_bart:.3g}"),
    )
    warnings = []
    if heywood:
        warnings.append(f"Heywood cases (uniqueness ~ 0): {heywood}")
    if cross:
        warnings.append(f"cross-loading items: {cross}")
    if not converged:
        warnings.append("ML extraction did not converge")
    prop = np.sum(lam**2, axis=0) / p
    return EvidenceResult(
        "efa",
        float(np.sum(prop)),
        None,
        None,
        None,
        n,
        f"efa_ml_{rotation}",
        assumptions=checks,
        warnings=tuple(warnings),
        details={
            "loadings": {str(c): row.tolist() for c, row in zip(df.columns, lam, strict=True)},
            "communalities": dict(zip((str(c) for c in df.columns), comm.tolist(), strict=True)),
            "factor_correlations": phi.tolist(),
            "proportion_variance": prop.tolist(),
            "cross_loadings": cross,
            "heywood": heywood,
        },
        provenance=prov,
    )


# ---------------------------------------------------------------- CFA (semopy)


def _srmr(sample_cov: FloatArray, implied: FloatArray) -> float:
    d = np.sqrt(np.diag(sample_cov))
    resid = (sample_cov - implied) / np.outer(d, d)
    idx = np.tril_indices_from(resid)
    return float(math.sqrt(np.mean(resid[idx] ** 2)))


def cfa(
    data: pd.DataFrame, factors: Mapping[str, Sequence[str]], *, params: ValidationParams | None = None
) -> EvidenceResult:
    """Confirmatory factor analysis (semopy, ML). Returns CFI as the estimate and all fit indices, loadings,
    Heywood cases and convergence in details. Refused when any factor has fewer than 3 indicators."""
    import semopy  # noqa: PLC0415 - heavy, loaded on demand

    prm = params or load_validation_params()
    min_ind = prm.i("structure.min_indicators_for_cfa")
    variables = [v for vs in factors.values() for v in vs]
    df = data[variables].dropna()
    prov = make_provenance("cfa", df.to_numpy(), params={"factors": {k: list(v) for k, v in factors.items()}})
    short = [f for f, vs in factors.items() if len(vs) < min_ind]
    if short:
        return EvidenceResult.unavailable(
            "cfa",
            "semopy_ml",
            f"CFA refused: factors with < {min_ind} indicators: {short}",
            n=len(df),
            status="insufficient",
            provenance=prov,
        )
    desc = "\n".join(f"{f} =~ " + " + ".join(vs) for f, vs in factors.items())
    model = semopy.Model(desc)
    res = model.fit(df)
    st = semopy.calc_stats(model)
    implied = np.asarray(model.calc_sigma()[0])
    order = list(model.vars["observed"])
    s = df[order].cov(ddof=0).to_numpy()
    est = model.inspect()
    resvar = est[(est["op"] == "~~") & (est["lval"] == est["rval"]) & (est["lval"].isin(variables))]
    heywood = [str(r.lval) for r in resvar.itertuples() if float(r.Estimate) <= 0]
    loads = est[(est["op"] == "~") & (est["rval"].isin(list(factors)))]
    stats_row = st.iloc[0]
    fit = {k: float(stats_row[k]) for k in ("chi2", "DoF", "CFI", "TLI", "RMSEA", "AIC", "BIC") if k in stats_row}
    fit["SRMR"] = _srmr(s, implied)
    warnings = [f"Heywood case (non-positive residual variance): {heywood}"] if heywood else []
    converged = bool(getattr(res, "success", True))
    if not converged:
        warnings.append("semopy optimiser did not report convergence")
    return EvidenceResult(
        "cfa",
        fit.get("CFI"),
        None,
        None,
        None,
        len(df),
        "semopy_ml",
        warnings=tuple(warnings),
        details={
            "fit": fit,
            "loadings": {f"{r.rval}->{r.lval}": float(r.Estimate) for r in loads.itertuples()},
            "heywood": heywood,
            "converged": converged,
            "description": desc,
        },
        provenance=prov,
    )


def compare_models(fit_a: Mapping[str, float], fit_b: Mapping[str, float]) -> dict[str, float]:
    """Compare two fitted models: chi-square difference (``a`` nested in ``b``: more df), dAIC, dBIC."""
    dchi = fit_a["chi2"] - fit_b["chi2"]
    ddf = fit_a["DoF"] - fit_b["DoF"]
    out = {"delta_chi2": dchi, "delta_df": ddf, "p": float(stats.chi2.sf(dchi, ddf)) if ddf > 0 else math.nan}
    for k in ("AIC", "BIC", "CFI", "RMSEA"):
        if k in fit_a and k in fit_b:
            out[f"delta_{k}"] = fit_a[k] - fit_b[k]
    return out


# ---------------------------------------------------------------- multi-group CFA


@dataclass(frozen=True, slots=True)
class MultiGroupFit:
    """ML multi-group CFA fit at one invariance level."""

    level: str
    chi2: float
    df: int
    cfi: float
    tli: float
    rmsea: float
    srmr: float
    n: int
    groups: tuple[str, ...]
    converged: bool
    loadings: Mapping[str, FloatArray] = field(default_factory=dict)
    intercepts: Mapping[str, FloatArray] = field(default_factory=dict)
    factor_means: Mapping[str, FloatArray] = field(default_factory=dict)
    freed_intercepts: tuple[str, ...] = ()


def fit_multigroup_cfa(
    data: Mapping[str, ArrayLike],
    variables: Sequence[str],
    factors: Mapping[str, Sequence[str]],
    level: Level = "configural",
    *,
    free_intercepts: Sequence[str] = (),
    maxiter: int = 5000,
) -> MultiGroupFit:
    """Maximum-likelihood multi-group CFA with a mean structure.

    ``data``: group label -> (n_g x p) array in ``variables`` order. Each variable loads on one factor.
    Identification: configural - factor variances 1 and means 0 in every group; metric - loadings equal,
    variances 1 and means 0 in the first group only (others free variances); scalar - loadings and
    intercepts equal (except ``free_intercepts``, which are free in every group but the first),
    first-group means 0, other groups' means free.
    """
    groups = tuple(sorted(data))
    var_idx = {v: i for i, v in enumerate(variables)}
    fnames = list(factors)
    m = len(fnames)
    p = len(variables)
    owner = np.zeros(p, dtype=int)
    for j, f in enumerate(fnames):
        for v in factors[f]:
            owner[var_idx[v]] = j
    xs = [np.asarray(data[g], dtype=float) for g in groups]
    xs = [x[np.all(np.isfinite(x), axis=1)] for x in xs]
    ns = np.array([x.shape[0] for x in xs], dtype=float)
    means = [x.mean(axis=0) for x in xs]
    covs = [np.cov(x, rowvar=False, ddof=0) for x in xs]
    logdet_s = [float(np.linalg.slogdet(s)[1]) for s in covs]
    gcount = len(groups)
    free_set = {var_idx[v] for v in free_intercepts}
    shared_load = level in ("metric", "scalar")
    shared_int = level == "scalar"
    n_chol = m * (m + 1) // 2

    # Parameter layout.
    layout: list[tuple[str, int, int]] = []  # (name, group or -1 shared, length)
    if shared_load:
        layout.append(("lam", -1, p))
    if shared_int:
        layout.append(("nu", -1, p))
    for g in range(gcount):
        if not shared_load:
            layout.append(("lam", g, p))
        if shared_int:
            # Partial scalar: the reference group keeps the shared intercept of a freed item; every other
            # group gets its own (one extra parameter per freed item per non-reference group).
            if free_set and g > 0:
                layout.append(("nu_free", g, len(free_set)))
        else:
            layout.append(("nu", g, p))
        layout.append(("theta", g, p))
        layout.append(("chol", g, n_chol))
        if shared_load and g > 0:
            layout.append(("logsd", g, m))
        if shared_int and g > 0:
            layout.append(("kappa", g, m))
    offsets: dict[tuple[str, int], tuple[int, int]] = {}
    pos = 0
    for name, g, length in layout:
        offsets[(name, g)] = (pos, length)
        pos += length
    n_par = pos
    free_sorted = sorted(free_set)

    def seg(theta: FloatArray, name: str, g: int) -> FloatArray:
        a, length = offsets[(name, g)]
        return theta[a : a + length]

    def group_mats(theta: FloatArray, g: int) -> tuple[FloatArray, FloatArray]:
        lam_v = seg(theta, "lam", -1 if shared_load else g)
        lam = np.zeros((p, m))
        lam[np.arange(p), owner] = lam_v
        if shared_int:
            nu = seg(theta, "nu", -1).copy()
            if free_set and g > 0:
                nu[free_sorted] = seg(theta, "nu_free", g)
        else:
            nu = seg(theta, "nu", g)
        th = np.exp(seg(theta, "theta", g))
        lc = np.zeros((m, m))
        lc[np.tril_indices(m)] = seg(theta, "chol", g)
        np.fill_diagonal(lc, np.abs(np.diag(lc)) + 1e-8)
        lc = lc / np.linalg.norm(lc, axis=1, keepdims=True)
        corr = lc @ lc.T
        if shared_load and g > 0:
            d = np.exp(seg(theta, "logsd", g))
            phi = corr * np.outer(d, d)
        else:
            phi = corr
        kappa = seg(theta, "kappa", g) if (shared_int and g > 0) else np.zeros(m)
        sigma = lam @ phi @ lam.T + np.diag(th)
        mu = nu + lam @ kappa
        return sigma, mu

    def objective(theta: FloatArray) -> float:
        total = 0.0
        for g in range(gcount):
            sigma, mu = group_mats(theta, g)
            sign, logdet = np.linalg.slogdet(sigma)
            if sign <= 0:
                return 1e12
            inv = np.linalg.inv(sigma)
            diff = means[g] - mu
            f = logdet + float(np.trace(covs[g] @ inv)) - logdet_s[g] - p + float(diff @ inv @ diff)
            total += ns[g] * f
        return total

    theta0 = np.zeros(n_par)
    pooled_sd = np.sqrt(np.mean([np.diag(s) for s in covs], axis=0))
    pooled_mean = np.mean(means, axis=0)
    for (name, g), (a, length) in offsets.items():
        if name == "lam":
            theta0[a : a + length] = 0.7 * pooled_sd
        elif name == "nu":
            theta0[a : a + length] = pooled_mean if g == -1 else means[g]
        elif name == "nu_free":
            theta0[a : a + length] = means[g][free_sorted]
        elif name == "theta":
            theta0[a : a + length] = np.log(0.5 * pooled_sd**2)
        elif name == "chol":
            lc = np.eye(m)
            theta0[a : a + length] = lc[np.tril_indices(m)]
    with np.errstate(all="ignore"):
        res = optimize.minimize(
            objective, theta0, method="L-BFGS-B", options={"maxiter": maxiter, "maxfun": maxiter * 50}
        )
    chi2 = float(res.fun)
    moments = gcount * (p * (p + 1) // 2 + p)
    n_free_chol = gcount * (m * (m - 1) // 2)  # unit-norm rows: only correlations are free
    n_eff_par = n_par - gcount * n_chol + n_free_chol
    df = int(moments - n_eff_par)
    base_chi2 = float(sum(ns[g] * (np.sum(np.log(np.diag(covs[g]))) - logdet_s[g]) for g in range(gcount)))
    base_df = gcount * p * (p - 1) // 2
    n_tot = float(ns.sum())
    d_m = max(chi2 - df, 0.0)
    d_b = max(base_chi2 - base_df, d_m, 0.0)
    cfi = 1.0 - d_m / d_b if d_b > 0 else 1.0
    tli = ((base_chi2 / base_df) - (chi2 / df)) / ((base_chi2 / base_df) - 1.0) if df > 0 and base_df > 0 else math.nan
    rmsea = math.sqrt(gcount) * math.sqrt(d_m / (df * n_tot)) if df > 0 else 0.0
    srmr = float(sum(ns[g] * _srmr(covs[g], group_mats(res.x, g)[0]) for g in range(gcount)) / n_tot)
    loadings = {groups[g]: seg(res.x, "lam", -1 if shared_load else g).copy() for g in range(gcount)}
    intercepts = {groups[g]: group_mats(res.x, g)[1] - (np.zeros(p)) for g in range(gcount)}
    fmeans = {
        groups[g]: (seg(res.x, "kappa", g).copy() if shared_int and g > 0 else np.zeros(m)) for g in range(gcount)
    }
    return MultiGroupFit(
        level,
        chi2,
        df,
        cfi,
        tli,
        rmsea,
        srmr,
        int(n_tot),
        groups,
        bool(res.success),
        loadings,
        intercepts,
        fmeans,
        tuple(free_intercepts),
    )


def measurement_invariance(
    data: Mapping[str, ArrayLike],
    variables: Sequence[str],
    factors: Mapping[str, Sequence[str]],
    *,
    free_intercepts: Sequence[str] = (),
    max_freed_share: float | None = None,
    params: ValidationParams | None = None,
) -> dict[str, EvidenceResult]:
    """Configural -> metric -> scalar invariance decision table (VAL-08a).

    Each step passes when CFI drops by at most ``invariance.delta_cfi_max_drop`` and RMSEA rises by at most
    ``invariance.delta_rmsea_max_increase`` relative to the previous step (Chen, 2007); the chi-square
    difference test and the change in SRMR (a warning above ``invariance.delta_srmr_<level>_max``) are
    reported alongside. ``free_intercepts`` gives a partial scalar model; its share of
    intercepts must not exceed ``max_freed_share`` (``gates.yaml`` ``trait_gate.invariance.max_freed_parameter_share``).
    """
    prm = params or load_validation_params()
    prov = make_provenance(
        "measurement_invariance",
        *[np.asarray(data[g], dtype=float) for g in sorted(data)],
        params={"free_intercepts": list(free_intercepts)},
    )
    fits = {
        "configural": fit_multigroup_cfa(data, variables, factors, "configural"),
        "metric": fit_multigroup_cfa(data, variables, factors, "metric"),
        "scalar": fit_multigroup_cfa(data, variables, factors, "scalar", free_intercepts=free_intercepts),
    }
    out: dict[str, EvidenceResult] = {}
    prev: MultiGroupFit | None = None
    holds = True
    for level in ("configural", "metric", "scalar"):
        f = fits[level]
        details: dict[str, Any] = {
            "chi2": f.chi2,
            "df": f.df,
            "CFI": f.cfi,
            "TLI": f.tli,
            "RMSEA": f.rmsea,
            "SRMR": f.srmr,
            "converged": f.converged,
        }
        warnings: list[str] = []
        passed = True
        if prev is not None:
            d_cfi = f.cfi - prev.cfi
            d_rmsea = f.rmsea - prev.rmsea
            dchi, ddf = f.chi2 - prev.chi2, f.df - prev.df
            p_diff = float(stats.chi2.sf(dchi, ddf)) if ddf > 0 else math.nan
            passed = d_cfi >= -prm.f("invariance.delta_cfi_max_drop") and d_rmsea <= prm.f(
                "invariance.delta_rmsea_max_increase"
            )
            d_srmr = f.srmr - prev.srmr
            srmr_max = prm.f(f"invariance.delta_srmr_{level}_max")
            if d_srmr > srmr_max:
                # Supplementary Chen (2007) criterion: reported, not part of the pass rule (SRMR here is
                # covariance-only, so intercept non-invariance is invisible to it).
                warnings.append(f"delta SRMR {d_srmr:.3f} exceeds {srmr_max:.3f}")
            details.update(
                {
                    "delta_CFI": d_cfi,
                    "delta_RMSEA": d_rmsea,
                    "delta_SRMR": d_srmr,
                    "delta_chi2": dchi,
                    "delta_df": ddf,
                    "p_chi2_diff": p_diff,
                }
            )
        if level == "scalar" and free_intercepts:
            share = len(free_intercepts) / len(variables)
            details["freed_share"] = share
            details["freed_intercepts"] = list(free_intercepts)
            if max_freed_share is not None and share > max_freed_share:
                passed = False
                warnings.append(f"freed intercept share {share:.2f} exceeds {max_freed_share:.2f}")
        if not f.converged:
            warnings.append("optimiser did not converge")
        holds = holds and passed
        details["passed"] = bool(passed)
        details["invariance_holds_through_this_level"] = bool(holds)
        out[level] = EvidenceResult(
            f"invariance_{level}",
            f.cfi,
            None,
            None,
            None,
            f.n,
            "multigroup_ml_cfa",
            warnings=tuple(warnings),
            details=details,
            provenance=prov,
        )
        prev = f
    return out


# ---------------------------------------------------------------- redundancy


def redundancy(
    data: pd.DataFrame, *, reliabilities: Mapping[str, float] | None = None, params: ValidationParams | None = None
) -> list[dict[str, Any]]:
    """Pairs of indicators that are empirically redundant: |r| >= ``structure.redundancy_r`` or, when
    reliabilities are given, disattenuated |r| >= ``structure.redundancy_disattenuated``."""
    prm = params or load_validation_params()
    thr = prm.f("structure.redundancy_r")
    thr_d = prm.f("structure.redundancy_disattenuated")
    corr = data.corr()
    out: list[dict[str, Any]] = []
    cols = list(corr.columns)
    for i in range(len(cols)):
        for j in range(i + 1, len(cols)):
            r = float(corr.iloc[i, j])
            if not np.isfinite(r):
                continue
            rd = None
            if reliabilities and cols[i] in reliabilities and cols[j] in reliabilities:
                rd = r / math.sqrt(reliabilities[cols[i]] * reliabilities[cols[j]])
            if abs(r) >= thr or (rd is not None and abs(rd) >= thr_d):
                out.append({"a": cols[i], "b": cols[j], "r": r, "r_disattenuated": rd})
    return out
