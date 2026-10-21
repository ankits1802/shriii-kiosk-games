"""Convergent and discriminant validity (VAL-06; spec section 6.2).

Observed correlations only feed gates; disattenuated correlations are secondary and carry a warning.
Functions: Pearson/Spearman with Fisher-z and bootstrap CIs, partial correlations, MTMM matrix,
dependent-correlation comparisons (Steiger, 1980; Zou, 2007), the Westen & Rosenthal (2003) pattern
statistic, Holm and Benjamini-Hochberg corrections, effect sizes, and construct evidence summaries against
``stats/measurement-model/hypotheses.yaml`` (the confirmatory test is that the lower CI bound exceeds the
pre-registered minimum, Holm-corrected for the primary family).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from numpy.typing import ArrayLike, NDArray
from scipy import stats

from shriii_validation.results import EvidenceResult, make_provenance

__all__ = [
    "HypothesisResult",
    "MTMMResult",
    "benjamini_hochberg",
    "cohens_d",
    "correlation",
    "d_to_r",
    "disattenuated",
    "evaluate_hypotheses",
    "holm",
    "lower_bound_test",
    "mtmm",
    "partial_correlation",
    "pattern_contrast",
    "r_contrast_cv",
    "r_to_d",
    "steiger_dependent",
    "zou_dependent_ci",
]

FloatArray = NDArray[np.float64]


def _pairwise(x: ArrayLike, y: ArrayLike) -> tuple[FloatArray, FloatArray]:
    a = np.asarray(x, dtype=float)
    b = np.asarray(y, dtype=float)
    ok = np.isfinite(a) & np.isfinite(b)
    return a[ok], b[ok]


def _fisher_ci(r: float, n: int, ci_level: float, se: float | None = None) -> tuple[float, float]:
    zc = float(stats.norm.ppf(0.5 + ci_level / 2))
    s = se if se is not None else 1.0 / math.sqrt(max(n - 3, 1))
    z = math.atanh(max(-0.999999, min(0.999999, r)))
    return math.tanh(z - zc * s), math.tanh(z + zc * s)


def _corr(a: FloatArray, b: FloatArray, kind: str) -> float:
    if kind == "spearman":
        a, b = stats.rankdata(a), stats.rankdata(b)
    return float(np.corrcoef(a, b)[0, 1])


def _bca(stat: float, boots: FloatArray, jack: FloatArray, ci_level: float) -> tuple[float, float]:
    prop = np.clip(np.mean(boots < stat), 1e-6, 1 - 1e-6)
    z0 = stats.norm.ppf(prop)
    jm = jack.mean()
    num = np.sum((jm - jack) ** 3)
    den = 6.0 * np.sum((jm - jack) ** 2) ** 1.5
    acc = num / den if den > 0 else 0.0
    out = []
    for q in ((1 - ci_level) / 2, (1 + ci_level) / 2):
        zq = stats.norm.ppf(q)
        adj = stats.norm.cdf(z0 + (z0 + zq) / (1 - acc * (z0 + zq)))
        out.append(float(np.percentile(boots, 100 * adj)))
    return out[0], out[1]


def correlation(
    x: ArrayLike,
    y: ArrayLike,
    *,
    kind: Literal["pearson", "spearman"] = "pearson",
    ci: Literal["fisher", "bootstrap_percentile", "bootstrap_bca"] = "fisher",
    ci_level: float = 0.95,
    n_boot: int = 5000,
    seed: int = 0,
) -> EvidenceResult:
    """Pearson or Spearman correlation (pairwise complete) with a Fisher-z or bootstrap CI.

    The Spearman Fisher interval uses the Bonett & Wright (2000) SE ``sqrt((1 + r^2 / 2) / (n - 3))``.
    """
    a, b = _pairwise(x, y)
    n = int(a.size)
    prov = make_provenance(f"correlation:{kind}", a, b, seed=seed, params={"ci": ci})
    if n < 4 or a.std() == 0 or b.std() == 0:
        return EvidenceResult.unavailable(
            kind, kind, "fewer than 4 pairs or zero variance", n=n, status="insufficient", provenance=prov
        )
    r = _corr(a, b, kind)
    t = r * math.sqrt((n - 2) / max(1e-12, 1 - r * r))
    p = float(2 * stats.t.sf(abs(t), n - 2))
    if ci == "fisher":
        se = math.sqrt((1 + r * r / 2) / (n - 3)) if kind == "spearman" else None
        lo, hi = _fisher_ci(r, n, ci_level, se)
        method = f"{kind}_fisher_z"
    else:
        rng = np.random.default_rng(seed)
        boots = np.empty(n_boot)
        for i in range(n_boot):
            idx = rng.integers(0, n, n)
            aa, bb = a[idx], b[idx]
            boots[i] = _corr(aa, bb, kind) if aa.std() > 0 and bb.std() > 0 else np.nan
        boots = boots[np.isfinite(boots)]
        if ci == "bootstrap_percentile":
            lo, hi = (float(v) for v in np.percentile(boots, [100 * (1 - ci_level) / 2, 100 * (1 + ci_level) / 2]))
        else:
            jack = np.array([_corr(np.delete(a, i), np.delete(b, i), kind) for i in range(n)])
            lo, hi = _bca(r, boots, jack, ci_level)
        method = f"{kind}_{ci}"
    return EvidenceResult(kind, r, lo, hi, ci_level, n, method, details={"p": p}, provenance=prov)


def partial_correlation(x: ArrayLike, y: ArrayLike, covariates: ArrayLike, *, ci_level: float = 0.95) -> EvidenceResult:
    """Partial Pearson correlation of x and y controlling for covariates (residualisation), Fisher CI with
    ``n - 3 - k`` degrees of freedom."""
    a = np.asarray(x, dtype=float)
    b = np.asarray(y, dtype=float)
    c = np.asarray(covariates, dtype=float)
    if c.ndim == 1:
        c = c[:, None]
    ok = np.isfinite(a) & np.isfinite(b) & np.all(np.isfinite(c), axis=1)
    a, b, c = a[ok], b[ok], c[ok]
    n, k = c.shape
    prov = make_provenance("partial_correlation", a, b, c)
    if n - k < 5:
        return EvidenceResult.unavailable(
            "partial_correlation",
            "residualised_pearson",
            "too few cases for covariates",
            n=n,
            status="insufficient",
            provenance=prov,
        )
    design = np.column_stack([np.ones(n), c])
    ra = a - design @ np.linalg.lstsq(design, a, rcond=None)[0]
    rb = b - design @ np.linalg.lstsq(design, b, rcond=None)[0]
    r = float(np.corrcoef(ra, rb)[0, 1])
    lo, hi = _fisher_ci(r, n, ci_level, 1.0 / math.sqrt(max(n - 3 - k, 1)))
    t = r * math.sqrt((n - 2 - k) / max(1e-12, 1 - r * r))
    return EvidenceResult(
        "partial_correlation",
        r,
        lo,
        hi,
        ci_level,
        n,
        "residualised_pearson_fisher_z",
        details={"k_covariates": k, "p": float(2 * stats.t.sf(abs(t), n - 2 - k))},
        provenance=prov,
    )


def lower_bound_test(r: float, n: int, r0: float, *, expected_sign: int = 1) -> float:
    """One-sided Fisher-z p-value for H0: sign * rho <= r0 (the confirmatory lower-bound test)."""
    if n <= 3:
        return 1.0
    z = (math.atanh(max(-0.999999, min(0.999999, expected_sign * r))) - math.atanh(r0)) * math.sqrt(n - 3)
    return float(stats.norm.sf(z))


def steiger_dependent(r_jk: float, r_jh: float, r_kh: float, n: int) -> tuple[float, float]:
    """Steiger's (1980) Z for two dependent correlations sharing variable j (H0: rho_jk = rho_jh).

    Returns (Z, two-sided p).
    """
    z1 = math.atanh(r_jk)
    z2 = math.atanh(r_jh)
    rbar = (r_jk + r_jh) / 2.0
    psi = r_kh * (1 - 2 * rbar**2) - 0.5 * rbar**2 * (1 - 2 * rbar**2 - r_kh**2)
    s = psi / (1 - rbar**2) ** 2
    z = (z1 - z2) * math.sqrt(n - 3) / math.sqrt(2 - 2 * s)
    return float(z), float(2 * stats.norm.sf(abs(z)))


def zou_dependent_ci(r12: float, r13: float, r23: float, n: int, ci_level: float = 0.95) -> tuple[float, float]:
    """Zou's (2007) CI for rho12 - rho13 (overlapping dependent correlations sharing variable 1)."""
    l1, u1 = _fisher_ci(r12, n, ci_level)
    l2, u2 = _fisher_ci(r13, n, ci_level)
    c = ((r23 - 0.5 * r12 * r13) * (1 - r12**2 - r13**2 - r23**2) + r23**3) / ((1 - r12**2) * (1 - r13**2))
    d = r12 - r13
    lower = d - math.sqrt(max((r12 - l1) ** 2 + (u2 - r13) ** 2 - 2 * c * (r12 - l1) * (u2 - r13), 0.0))
    upper = d + math.sqrt(max((u1 - r12) ** 2 + (r13 - l2) ** 2 - 2 * c * (u1 - r12) * (r13 - l2), 0.0))
    return lower, upper


def holm(pvalues: Sequence[float], alpha: float = 0.05) -> tuple[list[float], list[bool]]:
    """Holm step-down adjusted p-values and rejections."""
    p = np.asarray(pvalues, dtype=float)
    m = p.size
    order = np.argsort(p)
    adj = np.empty(m)
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * p[i]))
        adj[i] = running
    return adj.tolist(), (adj <= alpha).tolist()


def benjamini_hochberg(pvalues: Sequence[float], alpha: float = 0.05) -> tuple[list[float], list[bool]]:
    """Benjamini-Hochberg FDR adjusted p-values (step-up) and rejections."""
    p = np.asarray(pvalues, dtype=float)
    m = p.size
    order = np.argsort(p)[::-1]
    adj = np.empty(m)
    running = 1.0
    for idx, i in enumerate(order):
        rank = m - idx
        running = min(running, p[i] * m / rank)
        adj[i] = min(running, 1.0)
    return adj.tolist(), (adj <= alpha).tolist()


def disattenuated(
    r: float,
    r_xx: float,
    r_yy: float,
    *,
    n: int,
    r_xx_se: float = 0.0,
    r_yy_se: float = 0.0,
    ci_level: float = 0.95,
    n_draws: int = 20000,
    seed: int = 0,
) -> EvidenceResult:
    """Correlation corrected for attenuation, ``r / sqrt(r_xx r_yy)`` (secondary only; never feeds gates).

    The CI propagates sampling error of r (Fisher z) and of the reliabilities (normal with the given SEs)
    by Monte Carlo. Corrected values above 1 are flagged.
    """
    prov = make_provenance("disattenuated", [r, r_xx, r_yy, n], seed=seed)
    warnings = ["secondary statistic: disattenuated correlations never feed gates or reports"]
    if r_xx <= 0 or r_yy <= 0:
        return EvidenceResult.unavailable(
            "disattenuated", "spearman_correction", "non-positive reliability", n=n, provenance=prov
        )
    est = r / math.sqrt(r_xx * r_yy)
    rng = np.random.default_rng(seed)
    zr = rng.normal(math.atanh(max(-0.999999, min(0.999999, r))), 1 / math.sqrt(max(n - 3, 1)), n_draws)
    rx = np.clip(rng.normal(r_xx, r_xx_se, n_draws), 0.05, 1.0)
    ry = np.clip(rng.normal(r_yy, r_yy_se, n_draws), 0.05, 1.0)
    draws = np.tanh(zr) / np.sqrt(rx * ry)
    lo, hi = np.percentile(draws, [100 * (1 - ci_level) / 2, 100 * (1 + ci_level) / 2])
    if abs(est) > 1:
        warnings.append("corrected correlation exceeds 1 (reliability underestimated or model misspecified)")
    return EvidenceResult(
        "disattenuated",
        est,
        float(lo),
        float(hi),
        ci_level,
        n,
        "spearman_correction_monte_carlo",
        warnings=tuple(warnings),
        details={"never_feeds_gates": True},
        provenance=prov,
    )


def cohens_d(x: ArrayLike, y: ArrayLike, *, ci_level: float = 0.95) -> EvidenceResult:
    """Standardised mean difference (pooled SD) with Hedges' g in details and a normal-approximation CI."""
    a = np.asarray(x, dtype=float)
    b = np.asarray(y, dtype=float)
    a, b = a[np.isfinite(a)], b[np.isfinite(b)]
    n1, n2 = a.size, b.size
    prov = make_provenance("cohens_d", a, b)
    if n1 < 2 or n2 < 2:
        return EvidenceResult.unavailable(
            "cohens_d", "pooled_sd", "need >= 2 per group", n=n1 + n2, status="insufficient", provenance=prov
        )
    sp = math.sqrt(((n1 - 1) * a.var(ddof=1) + (n2 - 1) * b.var(ddof=1)) / (n1 + n2 - 2))
    d = (a.mean() - b.mean()) / sp if sp > 0 else 0.0
    j = 1 - 3 / (4 * (n1 + n2) - 9)
    se = math.sqrt((n1 + n2) / (n1 * n2) + d * d / (2 * (n1 + n2)))
    zc = float(stats.norm.ppf(0.5 + ci_level / 2))
    return EvidenceResult(
        "cohens_d",
        float(d),
        float(d - zc * se),
        float(d + zc * se),
        ci_level,
        n1 + n2,
        "pooled_sd_normal_ci",
        details={"hedges_g": float(d * j)},
        provenance=prov,
    )


def r_to_d(r: float) -> float:
    return 2 * r / math.sqrt(1 - r * r)


def d_to_r(d: float, n1: int | None = None, n2: int | None = None) -> float:
    a = 4.0 if n1 is None or n2 is None else (n1 + n2) ** 2 / (n1 * n2)
    return d / math.sqrt(d * d + a)


# ---------------------------------------------------------------- pattern statistic


def r_contrast_cv(
    validity_r: Sequence[float], weights: Sequence[float], criterion_intercorr: float, n: int
) -> tuple[float, float, float]:
    """Westen & Rosenthal (2003) construct-validity contrast.

    ``validity_r``: observed correlations of the measure with each criterion; ``weights``: contrast weights
    (sum zero); ``criterion_intercorr``: mean intercorrelation among the criteria. Returns
    ``(r_alerting_cv, r_contrast_cv, Z_contrast)``.
    """
    r = np.clip(np.asarray(validity_r, dtype=float), -0.999999, 0.999999)
    lam = np.asarray(weights, dtype=float)
    z = np.arctanh(r)
    r_alert = float(np.corrcoef(lam, z)[0, 1]) if np.std(z) > 0 else 0.0
    rx = criterion_intercorr
    r2bar = float(np.mean(r**2))
    f = min(1.0, (1 - rx) / (2 * (1 - r2bar)))
    h = (1 - f * r2bar) / (1 - rx)
    zc = float(np.sum(lam * z) * math.sqrt((n - 3) / (np.sum(lam**2) * (1 - rx) * h)))
    rc = math.copysign(math.sqrt(zc * zc / (zc * zc + n)), zc)
    return r_alert, rc, zc


def pattern_contrast(
    measure: ArrayLike,
    convergent: Mapping[str, ArrayLike],
    discriminant: Mapping[str, ArrayLike],
    *,
    expected_signs: Mapping[str, int] | None = None,
    ci_level: float = 0.95,
    n_boot: int = 2000,
    n_perm: int = 2000,
    seed: int = 0,
) -> EvidenceResult:
    """Own > discriminant pattern test with the r_contrast-CV statistic (bootstrap CI, permutation p).

    Convergent correlations are sign-aligned by ``expected_signs`` (default +1); weights are +1 for
    convergent and -1 for discriminant criteria (absolute discriminant correlations), centred to sum zero.
    Complete cases across all variables are used.
    """
    names_c = list(convergent)
    names_d = list(discriminant)
    cols = (
        [np.asarray(measure, dtype=float)]
        + [np.asarray(convergent[k], dtype=float) for k in names_c]
        + [np.asarray(discriminant[k], dtype=float) for k in names_d]
    )
    data = np.column_stack(cols)
    data = data[np.all(np.isfinite(data), axis=1)]
    n = data.shape[0]
    prov = make_provenance("pattern_contrast", data, seed=seed)
    if n < 10 or not names_c or not names_d:
        return EvidenceResult.unavailable(
            "pattern_contrast",
            "r_contrast_cv",
            "need >= 10 complete cases and both convergent and discriminant criteria",
            n=n,
            status="insufficient",
            provenance=prov,
        )
    signs = np.array([(expected_signs or {}).get(k, 1) for k in names_c] + [1] * len(names_d), dtype=float)
    k_c = len(names_c)
    lam = np.array([1.0] * k_c + [-1.0] * len(names_d))
    lam = lam - lam.mean()

    def stat(d: FloatArray) -> tuple[float, float]:
        c = np.asarray(np.corrcoef(d, rowvar=False), dtype=float)
        r = np.asarray(c[0, 1:] * signs, dtype=float)
        r[k_c:] = np.abs(r[k_c:])
        crit = c[1:, 1:]
        off = crit[np.triu_indices_from(crit, 1)]
        rx = float(np.mean(np.abs(off))) if off.size else 0.0
        _, rc, zc = r_contrast_cv(r.tolist(), lam.tolist(), rx, d.shape[0])
        return rc, zc

    rc, zc = stat(data)
    rng = np.random.default_rng(seed)
    boots = [stat(data[rng.integers(0, n, n)])[0] for _ in range(n_boot)]
    lo, hi = np.percentile(boots, [100 * (1 - ci_level) / 2, 100 * (1 + ci_level) / 2])
    perm_hits = 0
    for _ in range(n_perm):
        d2 = data.copy()
        d2[:, 0] = rng.permutation(d2[:, 0])
        perm_hits += stat(d2)[0] >= rc
    p_perm = (perm_hits + 1) / (n_perm + 1)
    obs = np.corrcoef(data, rowvar=False)[0, 1:]
    return EvidenceResult(
        "pattern_contrast",
        rc,
        float(lo),
        float(hi),
        ci_level,
        n,
        "r_contrast_cv_bootstrap_permutation",
        details={
            "z_contrast": zc,
            "p_permutation": p_perm,
            "observed_r": dict(zip(names_c + names_d, (float(v) for v in obs), strict=True)),
            "pattern_holds": bool(lo > 0),
        },
        provenance=prov,
    )


# ---------------------------------------------------------------- MTMM


@dataclass(frozen=True, slots=True)
class MTMMResult:
    """Multitrait-multimethod matrix with labelled blocks."""

    variables: tuple[str, ...]
    traits: Mapping[str, str]
    methods: Mapping[str, str]
    matrix: FloatArray
    n_pairwise: FloatArray
    validity_diagonal: list[tuple[str, str, float]]
    heterotrait_monomethod: list[tuple[str, str, float]]
    heterotrait_heteromethod: list[tuple[str, str, float]]
    campbell_fiske: Mapping[str, bool] = field(default_factory=dict)


def mtmm(data: Mapping[str, ArrayLike], traits: Mapping[str, str], methods: Mapping[str, str]) -> MTMMResult:
    """Pairwise-complete correlation matrix labelled by trait and method (Campbell & Fiske, 1959).

    ``campbell_fiske[trait]`` is True when each validity-diagonal value exceeds every heterotrait value in
    its row and column of the heteromethod block (criterion 2).
    """
    names = tuple(data)
    cols = [np.asarray(data[v], dtype=float) for v in names]
    k = len(names)
    mat = np.full((k, k), np.nan)
    nmat = np.zeros((k, k))
    for i in range(k):
        for j in range(k):
            a, b = _pairwise(cols[i], cols[j])
            nmat[i, j] = a.size
            if a.size >= 4 and a.std() > 0 and b.std() > 0:
                mat[i, j] = float(np.corrcoef(a, b)[0, 1])
    vd: list[tuple[str, str, float]] = []
    htm: list[tuple[str, str, float]] = []
    hth: list[tuple[str, str, float]] = []
    for i in range(k):
        for j in range(i + 1, k):
            va, vb = names[i], names[j]
            same_t = traits[va] == traits[vb]
            same_m = methods[va] == methods[vb]
            entry = (va, vb, float(mat[i, j]))
            if same_t and not same_m:
                vd.append(entry)
            elif not same_t and same_m:
                htm.append(entry)
            elif not same_t and not same_m:
                hth.append(entry)
    cf: dict[str, bool] = {}
    for va, vb, r in vd:
        rivals = [abs(rr) for x, y, rr in hth if va in (x, y) or vb in (x, y)]
        cf[traits[va]] = bool(np.isfinite(r) and all(abs(r) > v for v in rivals if np.isfinite(v)))
    return MTMMResult(names, dict(traits), dict(methods), mat, nmat, vd, htm, hth, cf)


# ---------------------------------------------------------------- hypotheses


@dataclass(frozen=True, slots=True)
class HypothesisResult:
    """Outcome of one pre-registered hypothesis."""

    hypothesis_id: str
    family: str
    construct: str
    pathway: str | None
    kind: str
    estimate: float | None
    ci_low: float | None
    ci_high: float | None
    n: int
    p: float | None
    p_adjusted: float | None
    passed: bool | None
    status: str
    warnings: tuple[str, ...] = ()
    details: Mapping[str, Any] = field(default_factory=dict)


def _composite(columns: Sequence[FloatArray]) -> FloatArray:
    zs = []
    for c in columns:
        sd = np.nanstd(c, ddof=1)
        zs.append((c - np.nanmean(c)) / sd if sd > 0 else np.full_like(c, np.nan))
    stack = np.vstack(zs)
    with np.errstate(invalid="ignore"):
        return np.asarray(np.nanmean(stack, axis=0), dtype=float)


def evaluate_hypotheses(
    hypotheses: Mapping[str, Any],
    indicators: Mapping[str, ArrayLike],
    criteria: Mapping[str, ArrayLike],
    *,
    indicator_signs: Mapping[str, int],
    pathway: str | None = None,
    ci_level: float | None = None,
    n_boot: int = 2000,
    seed: int = 0,
) -> list[HypothesisResult]:
    """Evaluate ``hypotheses.yaml`` on observed data aligned by participant.

    ``indicators`` maps indicator id -> values (one per participant, NaN = missing); ``indicator_signs``
    gives +1/-1 so that composites are construct-keyed (dictionary direction). ``criteria`` maps criterion
    scale ids (``instrument.scale``) -> values. Convergent hypotheses use the unit-weighted z composite of the
    listed indicators that are present; the test is one-sided against ``r0`` in the expected direction and
    adjusted within each family by its declared correction (Holm or BH-FDR). Retest and group-level
    hypotheses need other inputs and are returned as ``not_available``.
    """
    defaults = hypotheses.get("defaults", {})
    level = float(ci_level if ci_level is not None else defaults.get("ci_level", 0.95))
    families = {f["id"]: f for f in hypotheses.get("families", [])}
    raw: list[HypothesisResult] = []
    for h in hypotheses.get("hypotheses", []):
        if pathway is not None and pathway not in h.get("pathways", []):
            continue
        hid, fam, kind = h["id"], h["family"], h["type"]
        base = {"hypothesis_id": hid, "family": fam, "construct": h["construct"], "pathway": pathway, "kind": kind}
        if kind in ("retest_stability", "group_level"):
            raw.append(
                HypothesisResult(
                    **base,
                    estimate=None,
                    ci_low=None,
                    ci_high=None,
                    n=0,
                    p=None,
                    p_adjusted=None,
                    passed=None,
                    status="not_available",
                    warnings=("evaluated by test_retest / group-level estimators",),
                )
            )
            continue
        present = [i for i in h.get("indicators", []) if i in indicators]
        sign_expected = {"positive": 1, "negative": -1}.get(str(h.get("expected_sign")), 0)
        if kind == "discriminant_pattern":
            present = [i for i in indicators if i.split(".")[0] == h["construct"] and i in indicator_signs]
            conv = {c: criteria[c] for c in h.get("convergent_criteria", []) if c in criteria}
            disc = {c: criteria[c] for c in h.get("discriminant_criteria", []) if c in criteria}
            if not present or not conv or not disc:
                raw.append(
                    HypothesisResult(
                        **base,
                        estimate=None,
                        ci_low=None,
                        ci_high=None,
                        n=0,
                        p=None,
                        p_adjusted=None,
                        passed=None,
                        status="insufficient",
                        warnings=("missing indicators or criteria",),
                    )
                )
                continue
            comp = _composite([indicator_signs[i] * np.asarray(indicators[i], dtype=float) for i in present])
            signs = {}
            for c in conv:
                rel = next(
                    (
                        r
                        for r in hypotheses.get("hypotheses", [])
                        if r.get("construct") == h["construct"] and r.get("criterion") == c
                    ),
                    None,
                )
                signs[c] = {"positive": 1, "negative": -1}.get(str((rel or {}).get("expected_sign")), 1)
            res = pattern_contrast(
                comp, conv, disc, expected_signs=signs, ci_level=level, n_boot=n_boot, n_perm=n_boot, seed=seed
            )
            raw.append(
                HypothesisResult(
                    **base,
                    estimate=res.estimate,
                    ci_low=res.ci_low,
                    ci_high=res.ci_high,
                    n=res.n,
                    p=res.details.get("p_permutation") if res.ok else None,
                    p_adjusted=None,
                    passed=None if not res.ok else bool(res.ci_low is not None and res.ci_low > 0),
                    status=res.status,
                    warnings=res.warnings,
                    details={"indicators": present},
                )
            )
            continue
        crit = h.get("criterion")
        if not present or crit not in criteria:
            raw.append(
                HypothesisResult(
                    **base,
                    estimate=None,
                    ci_low=None,
                    ci_high=None,
                    n=0,
                    p=None,
                    p_adjusted=None,
                    passed=None,
                    status="insufficient",
                    warnings=("missing indicators or criterion",),
                )
            )
            continue
        comp = _composite([indicator_signs[i] * np.asarray(indicators[i], dtype=float) for i in present])
        res = correlation(comp, criteria[crit], ci_level=level)
        if not res.ok or res.estimate is None:
            raw.append(
                HypothesisResult(
                    **base,
                    estimate=None,
                    ci_low=None,
                    ci_high=None,
                    n=res.n,
                    p=None,
                    p_adjusted=None,
                    passed=None,
                    status=res.status,
                    warnings=res.warnings,
                )
            )
            continue
        r0 = h.get("r0")
        r0v = float(r0) if r0 is not None else 0.0
        p = lower_bound_test(res.estimate, res.n, r0v, expected_sign=sign_expected or (1 if res.estimate >= 0 else -1))
        if sign_expected == 0:
            p = float(res.details.get("p", 1.0))
        raw.append(
            HypothesisResult(
                **base,
                estimate=res.estimate,
                ci_low=res.ci_low,
                ci_high=res.ci_high,
                n=res.n,
                p=p,
                p_adjusted=None,
                passed=None,
                status="ok",
                details={"indicators": present, "r0": r0v, "expected_sign": sign_expected},
            )
        )
    out: list[HypothesisResult] = []
    by_family: dict[str, list[int]] = {}
    for i, r in enumerate(raw):
        if r.p is not None and r.status == "ok":
            by_family.setdefault(r.family, []).append(i)
    adjusted: dict[int, tuple[float, bool]] = {}
    for fam, idx in by_family.items():
        spec = families.get(fam, {})
        alpha = float(spec.get("alpha", defaults.get("alpha", 0.05)))
        ps = [raw[i].p or 1.0 for i in idx]
        correction = spec.get("correction", "none")
        if correction == "holm":
            adj, rej = holm(ps, alpha)
        elif correction == "bh_fdr":
            adj, rej = benjamini_hochberg(ps, alpha)
        else:
            adj, rej = ps, [p <= alpha for p in ps]
        for i, a, rj in zip(idx, adj, rej, strict=True):
            adjusted[i] = (a, rj)
    for i, r in enumerate(raw):
        if i in adjusted:
            a, rj = adjusted[i]
            passed = rj
            if r.kind == "discriminant_pattern":
                passed = bool(r.ci_low is not None and r.ci_low > 0) and rj
            out.append(
                HypothesisResult(
                    r.hypothesis_id,
                    r.family,
                    r.construct,
                    r.pathway,
                    r.kind,
                    r.estimate,
                    r.ci_low,
                    r.ci_high,
                    r.n,
                    r.p,
                    a,
                    passed,
                    r.status,
                    r.warnings,
                    r.details,
                )
            )
        else:
            out.append(r)
    return out
