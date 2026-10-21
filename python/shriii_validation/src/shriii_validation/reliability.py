"""Reliability evidence (VAL-04, VAL-05; spec section 6.1).

* split-half for trial data (permutation-based random splits, stratified, Spearman-Brown) with CI;
* Cronbach's alpha (Feldt CI) and McDonald's omega (one-factor ML, bootstrap CI) with assumption checks;
* ICC(1,1), ICC(A,1), ICC(C,1), ICC(1,k), ICC(A,k), ICC(C,k) with F-based CIs (Shrout & Fleiss, 1979;
  McGraw & Wong, 1996);
* test-retest (ICC(A,1) primary, ICC(C,1), Pearson reported but never for gates), SEM, SDC,
  Bland-Altman, practice effects;
* generalizability theory for fully crossed random designs (any number of facets) and D-studies;
* reliability of difference scores, model-based (posterior) reliability, Mosier composite reliability,
  group-wise reliability.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

import numpy as np
from numpy.typing import ArrayLike, NDArray
from scipy import optimize, stats

from shriii_validation.results import AssumptionCheck, EvidenceResult, make_provenance

__all__ = [
    "ICCKind",
    "composite_reliability",
    "cronbach_alpha",
    "difference_score_reliability",
    "g_study",
    "groupwise",
    "icc",
    "icc_all",
    "mcdonald_omega",
    "model_based_reliability",
    "one_way_variance_decomposition",
    "retest_reliability",
    "sem_from_reliability",
    "spearman_brown",
    "split_half_permutation",
]

ICCKind = Literal["ICC1", "ICC_A1", "ICC_C1", "ICC1k", "ICC_Ak", "ICC_Ck"]
FloatArray = NDArray[np.float64]


def spearman_brown(r: float, k: float = 2.0) -> float:
    """Spearman-Brown prophecy: reliability of a test ``k`` times as long."""
    return k * r / (1.0 + (k - 1.0) * r)


def sem_from_reliability(sd: float, reliability: float) -> float:
    """Standard error of measurement ``SD * sqrt(1 - rel)``."""
    return sd * math.sqrt(max(0.0, 1.0 - reliability))


# ---------------------------------------------------------------- split-half


def split_half_permutation(
    person: ArrayLike,
    value: ArrayLike,
    *,
    stratum: ArrayLike | None = None,
    n_splits: int = 5000,
    seed: int = 0,
    ci_level: float = 0.95,
    min_trials_per_half: int = 1,
) -> EvidenceResult:
    """Permutation split-half reliability of person means, stratified by ``stratum`` (condition, block).

    For each of ``n_splits`` random splits, every person's trials are randomly halved within each stratum,
    half-means are correlated across persons and corrected by Spearman-Brown. The estimate is the mean of
    the corrected coefficients (Parsons, Kruijt & Fox, 2019). The CI is the Fisher-z interval of the mean
    half-test correlation (n persons) carried through Spearman-Brown; the 2.5/97.5 percentiles of the split
    distribution are reported in ``details`` (they describe split variability, not sampling error).
    """
    pid = np.asarray(person)
    y = np.asarray(value, dtype=float)
    strata = np.asarray(stratum) if stratum is not None else np.zeros(y.size, dtype=int)
    ok = np.isfinite(y)
    pid, y, strata = pid[ok], y[ok], strata[ok]
    order = np.lexsort((strata, pid))
    pid, y, strata = pid[order], y[order], strata[order]
    persons, p_idx = np.unique(pid, return_inverse=True)
    cell_keys = np.char.add(np.char.add(pid.astype(str), "\u0001"), strata.astype(str))
    _, c_idx, c_counts = np.unique(cell_keys, return_inverse=True, return_counts=True)
    prov = make_provenance("split_half_permutation", p_idx, y, c_idx, seed=seed, params={"n_splits": n_splits})
    n_persons = persons.size
    if n_persons < 4:
        return EvidenceResult.unavailable(
            "split_half",
            "permutation_split_half_sb",
            "fewer than 4 persons",
            n=n_persons,
            status="insufficient",
            provenance=prov,
        )
    # Persons need >= 2 * min_trials_per_half trials overall.
    trials_per_person = np.bincount(p_idx)
    if np.any(trials_per_person < 2 * min_trials_per_half):
        keep = trials_per_person[p_idx] >= 2 * min_trials_per_half
        return split_half_permutation(
            pid[keep],
            y[keep],
            stratum=strata[keep],
            n_splits=n_splits,
            seed=seed,
            ci_level=ci_level,
            min_trials_per_half=min_trials_per_half,
        )
    rng = np.random.default_rng(seed)
    cell_start = np.concatenate([[0], np.cumsum(c_counts)[:-1]])
    half_size = c_counts[c_idx] // 2
    odd = (c_counts[c_idx] % 2) == 1
    sb_values: list[float] = []
    r_values: list[float] = []
    chunk = max(1, min(n_splits, 2_000_000 // max(y.size, 1)))
    done = 0
    while done < n_splits:
        s = min(chunk, n_splits - done)
        # Random keys offset by cell index: sorting gives a random permutation within each (contiguous) cell.
        keys = rng.random((s, y.size)) + c_idx[None, :]
        ranks = np.empty_like(keys, dtype=np.int64)
        order2 = np.argsort(keys, axis=1, kind="stable")
        rows = np.arange(s)[:, None]
        ranks[rows, order2] = np.arange(y.size)[None, :]
        within = ranks - cell_start[c_idx][None, :]
        # Odd cells: the extra trial goes to half A or B at random (balanced on average).
        coin = rng.random((s, y.size)) < 0.5
        in_a = (within < half_size[None, :]) | (odd[None, :] & (within == half_size[None, :]) & coin)
        sums_a = np.zeros((s, n_persons))
        sums_b = np.zeros((s, n_persons))
        cnt_a = np.zeros((s, n_persons))
        cnt_b = np.zeros((s, n_persons))
        for j in range(s):
            a = in_a[j]
            sums_a[j] = np.bincount(p_idx[a], weights=y[a], minlength=n_persons)
            cnt_a[j] = np.bincount(p_idx[a], minlength=n_persons)
            sums_b[j] = np.bincount(p_idx[~a], weights=y[~a], minlength=n_persons)
            cnt_b[j] = np.bincount(p_idx[~a], minlength=n_persons)
        with np.errstate(invalid="ignore", divide="ignore"):
            ma = sums_a / cnt_a
            mb = sums_b / cnt_b
        for j in range(s):
            ok_j = np.isfinite(ma[j]) & np.isfinite(mb[j])
            if ok_j.sum() < 4 or ma[j][ok_j].std() == 0 or mb[j][ok_j].std() == 0:
                continue
            r = float(np.corrcoef(ma[j][ok_j], mb[j][ok_j])[0, 1])
            r_values.append(r)
            sb_values.append(spearman_brown(r))
        done += s
    if not sb_values:
        return EvidenceResult.unavailable(
            "split_half", "permutation_split_half_sb", "no valid split", n=n_persons, status="failed", provenance=prov
        )
    r_bar = float(np.tanh(np.mean(np.arctanh(np.clip(r_values, -0.999999, 0.999999)))))
    zc = stats.norm.ppf(0.5 + ci_level / 2.0)
    half = zc / math.sqrt(max(n_persons - 3, 1))
    lo_r, hi_r = math.tanh(math.atanh(r_bar) - half), math.tanh(math.atanh(r_bar) + half)
    est = float(np.mean(sb_values))
    warnings: list[str] = []
    if est < 0:
        warnings.append("negative split-half reliability")
    return EvidenceResult(
        analysis="split_half",
        estimate=est,
        ci_low=spearman_brown(lo_r),
        ci_high=spearman_brown(hi_r),
        ci_level=ci_level,
        n=n_persons,
        method="permutation_split_half_spearman_brown",
        warnings=tuple(warnings),
        details={
            "n_splits": len(sb_values),
            "mean_half_r": r_bar,
            "split_percentiles": [float(np.percentile(sb_values, 2.5)), float(np.percentile(sb_values, 97.5))],
            "n_strata": int(np.unique(strata).size),
            "n_trials": int(y.size),
        },
        provenance=prov,
    )


# ---------------------------------------------------------------- internal consistency


def _complete_rows(items: ArrayLike) -> FloatArray:
    x = np.asarray(items, dtype=float)
    return x[np.all(np.isfinite(x), axis=1)]


def _alpha_value(x: FloatArray) -> float:
    k = x.shape[1]
    item_var = x.var(axis=0, ddof=1).sum()
    total_var = x.sum(axis=1).var(ddof=1)
    return float(k / (k - 1.0) * (1.0 - item_var / total_var))


def _one_factor_ml(cov: FloatArray, max_iter: int = 2000) -> tuple[FloatArray, FloatArray, bool]:
    """One-factor ML loadings/uniquenesses on a covariance matrix (Joreskog's iteration via scipy)."""
    p = cov.shape[0]
    sd = np.sqrt(np.diag(cov))
    corr = cov / np.outer(sd, sd)
    w, v = np.linalg.eigh(corr)
    lam0 = v[:, -1] * math.sqrt(max(w[-1], 1e-6))
    if lam0.sum() < 0:
        lam0 = -lam0
    psi0 = np.clip(1.0 - lam0**2, 0.05, 0.95)

    def f(theta: FloatArray) -> float:
        lam = theta[:p]
        psi = np.exp(theta[p:])
        sigma = np.outer(lam, lam) + np.diag(psi)
        sign, logdet = np.linalg.slogdet(sigma)
        if sign <= 0:
            return 1e10
        return float(logdet + np.trace(corr @ np.linalg.inv(sigma)))

    res = optimize.minimize(f, np.concatenate([lam0, np.log(psi0)]), method="L-BFGS-B", options={"maxiter": max_iter})
    lam = res.x[:p]
    if lam.sum() < 0:
        lam = -lam
    psi = np.exp(res.x[p:])
    return lam * sd, psi * sd**2, bool(res.success)


def _assumptions(x: FloatArray) -> tuple[list[AssumptionCheck], list[str]]:
    checks: list[AssumptionCheck] = []
    warnings: list[str] = []
    corr = np.corrcoef(x, rowvar=False)
    eig = np.sort(np.linalg.eigvalsh(corr))[::-1]
    ratio = float(eig[0] / eig[1]) if eig.size > 1 and eig[1] > 0 else math.inf
    checks.append(
        AssumptionCheck(
            "unidimensionality_eigen_ratio",
            ratio >= 3.0,
            ratio,
            "first / second eigenvalue of the item correlation matrix (>= 3 suggests one factor)",
        )
    )
    total = x.sum(axis=1)
    itc = [float(np.corrcoef(x[:, j], total - x[:, j])[0, 1]) for j in range(x.shape[1])]
    neg = [j for j, r in enumerate(itc) if r < 0]
    checks.append(
        AssumptionCheck(
            "no_negative_item_rest_correlations",
            not neg,
            min(itc),
            f"items with negative corrected item-total r: {neg}" if neg else "all positive",
        )
    )
    if neg:
        warnings.append("negative item-rest correlations: check reverse keying")
    return checks, warnings


def cronbach_alpha(items: ArrayLike, *, ci_level: float = 0.95) -> EvidenceResult:
    """Cronbach's alpha (listwise complete rows) with the Feldt (1965) F-based CI and assumption checks.

    Alpha equals reliability only under (essential) tau-equivalence; when one-factor loadings differ by more
    than a factor of 1.5 a warning recommends omega.
    """
    x = _complete_rows(items)
    n, k = x.shape
    prov = make_provenance("cronbach_alpha", x, params={"ci_level": ci_level})
    if k < 2 or n < 3:
        return EvidenceResult.unavailable(
            "cronbach_alpha",
            "cronbach_alpha_feldt",
            "need >= 2 items and >= 3 rows",
            n=n,
            status="insufficient",
            provenance=prov,
        )
    a = _alpha_value(x)
    g = 1.0 - ci_level
    df1, df2 = n - 1, (n - 1) * (k - 1)
    lo = 1.0 - (1.0 - a) * stats.f.ppf(1.0 - g / 2.0, df1, df2)
    hi = 1.0 - (1.0 - a) * stats.f.ppf(g / 2.0, df1, df2)
    checks, warnings = _assumptions(x)
    lam, _, _ = _one_factor_ml(np.cov(x, rowvar=False))
    std_lam = lam / x.std(axis=0, ddof=1)
    spread = float(np.max(np.abs(std_lam)) / max(np.min(np.abs(std_lam)), 1e-9))
    checks.append(
        AssumptionCheck(
            "tau_equivalence_loading_spread",
            spread <= 1.5,
            spread,
            "max / min standardised one-factor loading (<= 1.5 is roughly tau-equivalent)",
        )
    )
    if spread > 1.5:
        warnings.append("loadings are not tau-equivalent: alpha underestimates reliability; report omega")
    return EvidenceResult(
        "cronbach_alpha",
        a,
        float(lo),
        float(hi),
        ci_level,
        n,
        "cronbach_alpha_feldt_ci",
        assumptions=tuple(checks),
        warnings=tuple(warnings),
        details={"k": k},
        provenance=prov,
    )


def _omega_value(x: FloatArray) -> tuple[float, bool]:
    lam, psi, ok = _one_factor_ml(np.cov(x, rowvar=False))
    s = lam.sum() ** 2
    return float(s / (s + psi.sum())), ok


def mcdonald_omega(items: ArrayLike, *, ci_level: float = 0.95, n_boot: int = 1000, seed: int = 0) -> EvidenceResult:
    """McDonald's omega total from a one-factor ML model, percentile bootstrap CI over persons."""
    x = _complete_rows(items)
    n, k = x.shape
    prov = make_provenance("mcdonald_omega", x, seed=seed, params={"n_boot": n_boot})
    if k < 3 or n < 10:
        return EvidenceResult.unavailable(
            "mcdonald_omega",
            "omega_total_one_factor_ml",
            "need >= 3 items and >= 10 rows",
            n=n,
            status="insufficient",
            provenance=prov,
        )
    est, converged = _omega_value(x)
    rng = np.random.default_rng(seed)
    boots = []
    for _ in range(n_boot):
        b, _ = _omega_value(x[rng.integers(0, n, n)])
        if np.isfinite(b):
            boots.append(b)
    lo, hi = np.percentile(boots, [100 * (1 - ci_level) / 2, 100 * (1 + ci_level) / 2])
    checks, warnings = _assumptions(x)
    if not converged:
        warnings.append("one-factor ML did not converge")
    return EvidenceResult(
        "mcdonald_omega",
        est,
        float(lo),
        float(hi),
        ci_level,
        n,
        "omega_total_one_factor_ml_bootstrap",
        assumptions=tuple(checks),
        warnings=tuple(warnings),
        details={"k": k, "n_boot": len(boots)},
        provenance=prov,
    )


# ---------------------------------------------------------------- ICC


@dataclass(frozen=True, slots=True)
class _MeanSquares:
    n: int
    k: int
    msr: float
    msc: float
    mse: float
    msw: float


def _mean_squares(x: FloatArray) -> _MeanSquares:
    n, k = x.shape
    grand = x.mean()
    ssr = k * float(np.sum((x.mean(axis=1) - grand) ** 2))
    ssc = n * float(np.sum((x.mean(axis=0) - grand) ** 2))
    sst = float(np.sum((x - grand) ** 2))
    sse = sst - ssr - ssc
    ssw = sst - ssr
    return _MeanSquares(n, k, ssr / (n - 1), ssc / (k - 1), sse / ((n - 1) * (k - 1)), ssw / (n * (k - 1)))


def icc(data: ArrayLike, kind: ICCKind = "ICC_A1", *, ci_level: float = 0.95) -> EvidenceResult:
    """Intraclass correlation for an n (targets) x k (raters / occasions) matrix (complete rows only).

    ``ICC1`` one-way random; ``ICC_A1`` two-way, absolute agreement, single (Shrout-Fleiss ICC(2,1));
    ``ICC_C1`` two-way, consistency, single (ICC(3,1)); ``*k`` the average-measure forms. CIs follow
    McGraw & Wong (1996), with the Satterthwaite approximation for the absolute-agreement forms.
    """
    x = _complete_rows(data)
    n, k = x.shape
    prov = make_provenance(f"icc:{kind}", x, params={"ci_level": ci_level})
    if n < 3 or k < 2:
        return EvidenceResult.unavailable(
            kind, "icc_anova", "need >= 3 targets and >= 2 ratings", n=n, status="insufficient", provenance=prov
        )
    ms = _mean_squares(x)
    a = 1.0 - ci_level

    def fq(d1: float, d2: float) -> float:
        return float(stats.f.ppf(1.0 - a / 2.0, d1, d2))

    if kind in ("ICC1", "ICC1k"):
        f_obs = ms.msr / ms.msw
        df1, df2 = n - 1, n * (k - 1)
        fl, fu = f_obs / fq(df1, df2), f_obs * fq(df2, df1)
        if kind == "ICC1":
            est = (ms.msr - ms.msw) / (ms.msr + (k - 1) * ms.msw)
            lo, hi = (fl - 1) / (fl + k - 1), (fu - 1) / (fu + k - 1)
        else:
            est = (ms.msr - ms.msw) / ms.msr
            lo, hi = 1 - 1 / fl, 1 - 1 / fu
        p = float(stats.f.sf(f_obs, df1, df2))
    elif kind in ("ICC_C1", "ICC_Ck"):
        f_obs = ms.msr / ms.mse
        df1, df2 = n - 1, (n - 1) * (k - 1)
        fl, fu = f_obs / fq(df1, df2), f_obs * fq(df2, df1)
        if kind == "ICC_C1":
            est = (ms.msr - ms.mse) / (ms.msr + (k - 1) * ms.mse)
            lo, hi = (fl - 1) / (fl + k - 1), (fu - 1) / (fu + k - 1)
        else:
            est = (ms.msr - ms.mse) / ms.msr
            lo, hi = 1 - 1 / fl, 1 - 1 / fu
        p = float(stats.f.sf(f_obs, df1, df2))
    else:
        f_obs = ms.msr / ms.mse
        p = float(stats.f.sf(f_obs, n - 1, (n - 1) * (k - 1)))
        icc1 = (ms.msr - ms.mse) / (ms.msr + (k - 1) * ms.mse + k * (ms.msc - ms.mse) / n)
        aa = k * icc1 / (n * (1 - icc1))
        bb = 1 + k * icc1 * (n - 1) / (n * (1 - icc1))
        v = (aa * ms.msc + bb * ms.mse) ** 2 / ((aa * ms.msc) ** 2 / (k - 1) + (bb * ms.mse) ** 2 / ((n - 1) * (k - 1)))
        fl = fq(n - 1, v)
        fu = fq(v, n - 1)
        if kind == "ICC_A1":
            est = icc1
            lo = n * (ms.msr - fl * ms.mse) / (fl * (k * ms.msc + (k * n - k - n) * ms.mse) + n * ms.msr)
            hi = n * (fu * ms.msr - ms.mse) / (k * ms.msc + (k * n - k - n) * ms.mse + n * fu * ms.msr)
        else:
            est = (ms.msr - ms.mse) / (ms.msr + (ms.msc - ms.mse) / n)
            lo = n * (ms.msr - fl * ms.mse) / (fl * (ms.msc - ms.mse) + n * ms.msr)
            hi = n * (fu * ms.msr - ms.mse) / (ms.msc - ms.mse + n * fu * ms.msr)
    return EvidenceResult(
        analysis=kind,
        estimate=float(est),
        ci_low=float(lo),
        ci_high=float(hi),
        ci_level=ci_level,
        n=n,
        method="icc_anova_mcgraw_wong",
        details={"k": k, "F": float(f_obs), "p": p, "msr": ms.msr, "msc": ms.msc, "mse": ms.mse, "msw": ms.msw},
        provenance=prov,
    )


def icc_all(data: ArrayLike, *, ci_level: float = 0.95) -> dict[str, EvidenceResult]:
    """All six ICC forms."""
    kinds: tuple[ICCKind, ...] = ("ICC1", "ICC_A1", "ICC_C1", "ICC1k", "ICC_Ak", "ICC_Ck")
    return {k: icc(data, k, ci_level=ci_level) for k in kinds}


# ---------------------------------------------------------------- test-retest


def retest_reliability(
    t1: ArrayLike,
    t2: ArrayLike,
    *,
    ci_level: float = 0.95,
    min_pairs: int = 30,
    practice_d_flag: float = 0.30,
) -> dict[str, EvidenceResult]:
    """Test-retest evidence (VAL-05): ICC(A,1) primary, ICC(C,1), Pearson (never for gates), SEM and SDC
    from ICC(A,1), Bland-Altman limits, and the practice effect (paired mean change, d_z, d_av, CI).

    Fewer than ``min_pairs`` complete pairs returns ``insufficient`` for every result.
    """
    a = np.asarray(t1, dtype=float)
    b = np.asarray(t2, dtype=float)
    ok = np.isfinite(a) & np.isfinite(b)
    a, b = a[ok], b[ok]
    n = int(a.size)
    prov = make_provenance("retest_reliability", a, b, params={"min_pairs": min_pairs})
    names = ("icc_a1", "icc_c1", "pearson", "sem", "sdc", "bland_altman", "practice_effect")
    if n < min_pairs:
        return {
            k: EvidenceResult.unavailable(
                k,
                "retest_reliability",
                f"{n} pairs < {min_pairs} required",
                n=n,
                status="insufficient",
                provenance=prov,
            )
            for k in names
        }
    x = np.column_stack([a, b])
    out: dict[str, EvidenceResult] = {
        "icc_a1": icc(x, "ICC_A1", ci_level=ci_level),
        "icc_c1": icc(x, "ICC_C1", ci_level=ci_level),
    }
    r = float(np.corrcoef(a, b)[0, 1])
    zc = float(stats.norm.ppf(0.5 + ci_level / 2))
    half = zc / math.sqrt(n - 3)
    out["pearson"] = EvidenceResult(
        "pearson_retest",
        r,
        math.tanh(math.atanh(r) - half),
        math.tanh(math.atanh(r) + half),
        ci_level,
        n,
        "pearson_fisher_z",
        warnings=("Pearson r is never used for gates",),
        provenance=prov,
    )
    rel = out["icc_a1"].estimate or 0.0
    sd = float(np.std(np.concatenate([a, b]), ddof=1))
    sem = sem_from_reliability(sd, rel)
    out["sem"] = EvidenceResult("sem", sem, None, None, None, n, "sd_pooled_x_sqrt(1-icc_a1)", provenance=prov)
    out["sdc"] = EvidenceResult(
        "sdc", zc * math.sqrt(2.0) * sem, None, None, None, n, "z x sqrt(2) x SEM", provenance=prov
    )
    d = b - a
    mean_d = float(d.mean())
    sd_d = float(d.std(ddof=1))
    out["bland_altman"] = EvidenceResult(
        "bland_altman",
        mean_d,
        mean_d - zc * sd_d,
        mean_d + zc * sd_d,
        ci_level,
        n,
        "bland_altman_limits_of_agreement",
        details={"sd_difference": sd_d},
        provenance=prov,
    )
    se = sd_d / math.sqrt(n)
    tcrit = float(stats.t.ppf(0.5 + ci_level / 2, n - 1))
    d_z = mean_d / sd_d if sd_d > 0 else 0.0
    sd_av = math.sqrt((a.var(ddof=1) + b.var(ddof=1)) / 2.0)
    d_av = mean_d / sd_av if sd_av > 0 else 0.0
    t_stat = mean_d / se if se > 0 else 0.0
    warnings = (f"practice effect |d_av| > {practice_d_flag}",) if abs(d_av) > practice_d_flag else ()
    out["practice_effect"] = EvidenceResult(
        "practice_effect",
        mean_d,
        mean_d - tcrit * se,
        mean_d + tcrit * se,
        ci_level,
        n,
        "paired_mean_change_t",
        warnings=warnings,
        details={
            "d_z": d_z,
            "d_av": d_av,
            "t": t_stat,
            "p": float(2 * stats.t.sf(abs(t_stat), n - 1)),
            "flagged": bool(warnings),
        },
        provenance=prov,
    )
    return out


# ---------------------------------------------------------------- generalizability theory


def g_study(data: ArrayLike, facets: Sequence[str], d_study: Mapping[str, int] | None = None) -> EvidenceResult:
    """Variance components for a fully crossed random design (persons x facets) and G coefficients.

    ``data`` has shape (persons, n_facet1, n_facet2, ...) with one observation per cell. Variance
    components come from the ANOVA expected mean squares (negative estimates set to 0 with a warning);
    the highest-order interaction is confounded with residual error. ``d_study`` maps facet -> number of
    levels for the decision study (default: as observed). Returns the relative G coefficient (E rho^2) as
    the estimate and the absolute (Phi) coefficient in ``details``.
    """
    x = np.asarray(data, dtype=float)
    names = ["p", *facets]
    if x.ndim != len(names):
        raise ValueError("data must have one axis per facet plus persons")
    if not np.all(np.isfinite(x)):
        raise ValueError("g_study needs a complete balanced array (no missing cells)")
    levels = dict(zip(names, x.shape, strict=True))
    effects = [frozenset(c) for r in range(1, len(names) + 1) for c in itertools.combinations(names, r)]
    grand = float(x.mean())
    ms: dict[frozenset[str], float] = {}
    for eff in effects:
        axes_keep = [i for i, nme in enumerate(names) if nme in eff]
        # Effect estimate by inclusion-exclusion of marginal means.
        effect_arr = np.zeros([x.shape[i] for i in axes_keep])
        for r in range(len(axes_keep) + 1):
            for sub in itertools.combinations(axes_keep, r):
                drop = tuple(i for i in range(x.ndim) if i not in sub)
                marg = x.mean(axis=drop) if drop else x
                # Broadcast the marginal to the effect's axes.
                shape = [x.shape[i] if i in sub else 1 for i in axes_keep]
                marg_b = np.asarray(marg).reshape(shape) if sub else np.full([1] * len(axes_keep), grand)
                effect_arr = effect_arr + (-1) ** (len(axes_keep) - r) * marg_b
        other = math.prod(levels[nme] for nme in names if nme not in eff)
        ss = other * float(np.sum(effect_arr**2))
        df = math.prod(levels[nme] - 1 for nme in eff)
        ms[eff] = ss / df
    var: dict[frozenset[str], float] = {}
    warnings: list[str] = []
    for eff in sorted(effects, key=len, reverse=True):
        coef = math.prod(levels[nme] for nme in names if nme not in eff)
        higher = sum(
            math.prod(levels[nme] for nme in names if nme not in sup) * var[sup] for sup in effects if eff < sup
        )
        v = (ms[eff] - higher) / coef
        if v < 0:
            warnings.append(f"negative variance component for {'x'.join(sorted(eff))} set to 0")
            v = 0.0
        var[eff] = v
    nd = {f: (d_study or {}).get(f, levels[f]) for f in facets}
    vp = var[frozenset(["p"])]
    rel_err = sum(var[e] / math.prod(nd[f] for f in e - {"p"}) for e in effects if "p" in e and e != frozenset(["p"]))
    abs_err = rel_err + sum(var[e] / math.prod(nd[f] for f in e) for e in effects if "p" not in e)
    erho = vp / (vp + rel_err) if vp + rel_err > 0 else math.nan
    phi = vp / (vp + abs_err) if vp + abs_err > 0 else math.nan
    total = sum(var.values())
    return EvidenceResult(
        analysis="g_study",
        estimate=erho,
        ci_low=None,
        ci_high=None,
        ci_level=None,
        n=levels["p"],
        method="random_effects_anova_ems",
        warnings=tuple(warnings),
        details={
            "phi": phi,
            "variance_components": {"x".join(sorted(e, key=names.index)): v for e, v in var.items()},
            "variance_shares": {
                "x".join(sorted(e, key=names.index)): (v / total if total > 0 else math.nan) for e, v in var.items()
            },
            "d_study": nd,
        },
        provenance=make_provenance("g_study", x, params={"facets": list(facets), "d_study": nd}),
    )


def one_way_variance_decomposition(person: ArrayLike, value: ArrayLike, *, ci_level: float = 0.95) -> EvidenceResult:
    """Unbalanced one-way random-effects decomposition of trial values into between-person and within-person
    variance; returns ICC(1) for single trials with the n0-adjusted ANOVA estimator and its F-based CI."""
    pid = np.asarray(person)
    y = np.asarray(value, dtype=float)
    ok = np.isfinite(y)
    pid, y = pid[ok], y[ok]
    groups, idx, counts = np.unique(pid, return_inverse=True, return_counts=True)
    g = groups.size
    n = y.size
    prov = make_provenance("one_way_variance_decomposition", idx, y)
    if g < 3 or n <= g:
        return EvidenceResult.unavailable(
            "variance_decomposition",
            "one_way_anova",
            "too few persons or trials",
            n=g,
            status="insufficient",
            provenance=prov,
        )
    means = np.bincount(idx, weights=y) / counts
    grand = y.mean()
    ssb = float(np.sum(counts * (means - grand) ** 2))
    ssw = float(np.sum((y - means[idx]) ** 2))
    msb, msw = ssb / (g - 1), ssw / (n - g)
    n0 = (n - np.sum(counts**2) / n) / (g - 1)
    vb = max((msb - msw) / n0, 0.0)
    est = vb / (vb + msw) if vb + msw > 0 else 0.0
    f_obs = msb / msw
    a = 1 - ci_level
    fl = f_obs / stats.f.ppf(1 - a / 2, g - 1, n - g)
    fu = f_obs * stats.f.ppf(1 - a / 2, n - g, g - 1)
    return EvidenceResult(
        "variance_decomposition",
        float(est),
        float((fl - 1) / (fl + n0 - 1)),
        float((fu - 1) / (fu + n0 - 1)),
        ci_level,
        g,
        "one_way_random_anova_n0",
        details={"between_var": vb, "within_var": msw, "n0": float(n0)},
        provenance=prov,
    )


# ---------------------------------------------------------------- other reliability forms


def difference_score_reliability(r_xx: float, r_yy: float, r_xy: float, sd_x: float = 1.0, sd_y: float = 1.0) -> float:
    """Reliability of X - Y from component reliabilities and their correlation (plan SCR-06).

    With equal SDs this is ``(r_xx + r_yy - 2 r_xy) / (2 - 2 r_xy)``.
    """
    num = sd_x**2 * r_xx + sd_y**2 * r_yy - 2 * r_xy * sd_x * sd_y
    den = sd_x**2 + sd_y**2 - 2 * r_xy * sd_x * sd_y
    return num / den


def model_based_reliability(
    estimates: ArrayLike, posterior_sd: ArrayLike, *, ci_level: float = 0.95, n_boot: int = 2000, seed: int = 0
) -> EvidenceResult:
    """Empirical (posterior-variance-ratio) reliability ``var(est) / (var(est) + mean(posterior var))``
    for model-based person estimates, with a percentile bootstrap CI over persons."""
    e = np.asarray(estimates, dtype=float)
    s = np.asarray(posterior_sd, dtype=float)
    ok = np.isfinite(e) & np.isfinite(s)
    e, s = e[ok], s[ok]
    n = e.size
    prov = make_provenance("model_based_reliability", e, s, seed=seed)
    if n < 10:
        return EvidenceResult.unavailable(
            "model_based_reliability",
            "posterior_variance_ratio",
            "fewer than 10 persons",
            n=n,
            status="insufficient",
            provenance=prov,
        )

    def rel(ev: FloatArray, sv: FloatArray) -> float:
        v = float(ev.var(ddof=1))
        return v / (v + float(np.mean(sv**2)))

    rng = np.random.default_rng(seed)
    boots = [rel(e[i], s[i]) for i in (rng.integers(0, n, n) for _ in range(n_boot))]
    lo, hi = np.percentile(boots, [100 * (1 - ci_level) / 2, 100 * (1 + ci_level) / 2])
    return EvidenceResult(
        "model_based_reliability",
        rel(e, s),
        float(lo),
        float(hi),
        ci_level,
        n,
        "posterior_variance_ratio_bootstrap",
        provenance=prov,
    )


def composite_reliability(
    weights: Sequence[float], sds: Sequence[float], reliabilities: Sequence[float], correlations: ArrayLike
) -> float:
    """Mosier (1943) reliability of a weighted composite of components with known reliabilities."""
    w = np.asarray(weights, dtype=float)
    sd = np.asarray(sds, dtype=float)
    r = np.asarray(reliabilities, dtype=float)
    c = np.asarray(correlations, dtype=float)
    cov = c * np.outer(sd, sd)
    var_comp = float(w @ cov @ w)
    err = float(np.sum(w**2 * sd**2 * (1 - r)))
    return 1.0 - err / var_comp


def groupwise(
    fn: Callable[..., EvidenceResult],
    groups: Mapping[str, tuple[object, ...]],
    *,
    min_n: int = 30,
) -> dict[str, EvidenceResult]:
    """Apply a reliability function per group (``groups`` maps label -> positional args); groups whose
    result has n < ``min_n`` are returned as ``insufficient``."""
    out: dict[str, EvidenceResult] = {}
    for label, args in sorted(groups.items()):
        res = fn(*args)
        if res.n < min_n:
            res = EvidenceResult.unavailable(
                res.analysis,
                res.method,
                f"group n={res.n} < {min_n}",
                n=res.n,
                status="insufficient",
                provenance=res.provenance,
            )
        out[label] = res
    return out
