"""Batch model step: model-based person estimates fitted across the sessions of one partition.

* Difference-based indicators (composure, stability, switch cost, held-vs-free, distractor cost, tone
  mirroring and drift) are **person-level random slopes** from a linear mixed model
  ``y ~ x + covariates + (1 + x | person)`` fitted by REML (:mod:`shriii_scoring.lmm`, parity-tested
  against statsmodels MixedLM). Each person's estimate is the
  fixed slope plus the BLUP; its posterior SD is the conditional SD of the BLUP; the partition's
  model-based reliability is ``1 - mean(posterior variance) / tau^2``. A simple descriptive delta
  (person mean at x = 1 minus x = 0) is written alongside. Binary outcomes (pressure accuracy) use the
  logistic mixed model (:mod:`shriii_scoring.glmm`, Laplace / PIRLS, slopes on the logit scale) when
  ``models.binary_outcome_model`` is ``logistic_glmm``; ``lpm`` keeps the linear-probability mixed model
  (also the fallback when the GLMM fails, flag ``glmm_fallback_lpm``). If the mixed model fails, person
  OLS slopes are shrunk by empirical Bayes (flag ``model_fallback_eb``).
* Delay and effort discounting: hyperbolic chooser fitted per person by penalised likelihood under an
  empirical-Bayes population prior on log k (re-estimated until convergence) - a hierarchical model
  fitted by iterated MAP / Laplace approximation.
* Response consistency: location-scale person residual SD with empirical-Bayes shrinkage on the log scale.
* Persistence of style: per-segment style vectors standardised within the partition, mean Fisher-z of
  the pairwise profile correlations.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd  # type: ignore[import-untyped]

from shriii_scoring.canonical import Trial
from shriii_scoring.conventions import SHIFT_PERFORMANCE, TASKS
from shriii_scoring.formulas.base import (
    BatchContext,
    BatchUnit,
    IndicatorValue,
    batch_formula,
    latency,
    need_params,
)
from shriii_scoring.formulas.executive import gng_correct
from shriii_scoring.formulas.social import tone_ordinal
from shriii_scoring.formulas.style import probe_segments
from shriii_scoring.glmm import fit_random_slope_glmm
from shriii_scoring.lmm import fit_random_slope_lmm
from shriii_scoring.numerics import eb_normal_shrinkage, fisher_z, fit_hyperbolic_map

__all__ = ["SlopeFit", "fit_discounting_eb", "fit_random_slopes"]

Row = tuple[float, float, Sequence[float]]  # (y, x, covariates)


@dataclass(frozen=True, slots=True)
class SlopeFit:
    """Random-slope fit for one partition."""

    estimates: Mapping[str, float]
    posterior_sd: Mapping[str, float]
    descriptive_delta: Mapping[str, float]
    fixed_slope: float
    tau2: float
    model_reliability: float | None
    method: str
    converged: bool
    warnings: tuple[str, ...]
    n_persons: int


def _delta(rows: Sequence[Row]) -> float:
    on = [y for y, x, _ in rows if x >= 0.5]
    off = [y for y, x, _ in rows if x < 0.5]
    if on and off:
        return float(np.mean(on) - np.mean(off))
    xs = np.array([x for _, x, _ in rows])
    ys = np.array([y for y, _, _ in rows])
    if np.ptp(xs) == 0:
        return math.nan
    return float(np.polyfit(xs, ys, 1)[0])


def _ols_slope(rows: Sequence[Row]) -> tuple[float, float]:
    y = np.array([r[0] for r in rows], dtype=float)
    cols = [np.ones(len(rows)), np.array([r[1] for r in rows], dtype=float)]
    k = len(rows[0][2]) if rows else 0
    for j in range(k):
        cols.append(np.array([r[2][j] for r in rows], dtype=float))
    x = np.column_stack(cols)
    beta, *_ = np.linalg.lstsq(x, y, rcond=None)
    resid = y - x @ beta
    dof = max(len(y) - x.shape[1], 1)
    s2 = float(resid @ resid) / dof
    try:
        cov = s2 * np.linalg.pinv(x.T @ x)
        var = float(cov[1, 1])
    except np.linalg.LinAlgError:
        var = math.nan
    return float(beta[1]), var


def _fit_logistic_slopes(  # noqa: PLR0917 - mirrors the REML path's locals
    persons: Sequence[str],
    ys: Sequence[float],
    exog: np.ndarray,
    xc: np.ndarray,
    groups: Sequence[str],
    deltas: Mapping[str, float],
    maxiter: int,
) -> SlopeFit:
    """Logistic random-slope fit (logit scale); same boundary handling as the REML path."""
    caught: list[str] = []
    yv = np.asarray(ys, dtype=float)
    fit = fit_random_slope_glmm(yv, exog, xc, list(groups), maxiter=maxiter)
    g = fit.g
    rho = float(g[0, 1] / math.sqrt(g[0, 0] * g[1, 1])) if g[0, 0] > 0 and g[1, 1] > 0 else 0.0
    if abs(rho) > 0.95:
        caught.append(f"random_effect_correlation_boundary(rho={rho:.3f}); refit_independent")
        fit = fit_random_slope_glmm(yv, exog, xc, list(groups), maxiter=maxiter, independent=True)
    tau2 = float(fit.g[1, 1])
    fixed = float(fit.beta[1])
    if not np.isfinite(tau2) or not np.isfinite(fixed):
        raise FloatingPointError("non-finite mixed-model estimates")
    index = {gid: i for i, gid in enumerate(fit.groups)}
    est = {p: fixed + float(fit.blups[index[p], 1]) for p in persons}
    psd = {p: math.sqrt(max(float(fit.blup_cov[index[p], 1, 1]), 0.0)) for p in persons}
    if tau2 > 1e-8:
        rel: float = float(min(1.0, max(0.0, 1.0 - float(np.mean([s * s for s in psd.values()])) / tau2)))
    else:
        rel = 0.0
        caught.append("zero_slope_variance")
    if not fit.converged:
        caught.append("glmm_not_converged")
    method = "glmm_laplace_logit_random_slope"
    return SlopeFit(est, psd, deltas, fixed, tau2, rel, method, fit.converged, tuple(caught), len(persons))


def fit_random_slopes(data: Mapping[str, Sequence[Row]], maxiter: int = 200, *, family: str = "gaussian") -> SlopeFit:
    """Fit ``y ~ 1 + x + covariates + (1 + x | person)`` and return person slopes (fixed + BLUP).

    ``family="gaussian"``: REML linear mixed model. ``family="binomial"``: logistic mixed model (Laplace);
    if it fails the linear-probability REML fit is used and ``glmm_fallback_lpm`` is recorded.
    """
    persons = sorted(data)
    deltas = {p: _delta(data[p]) for p in persons}
    ys: list[float] = []
    xs: list[float] = []
    covs: list[Sequence[float]] = []
    groups: list[str] = []
    for p in persons:
        for y, x, c in data[p]:
            ys.append(y)
            xs.append(x)
            covs.append(c)
            groups.append(p)
    k = len(covs[0]) if covs else 0
    # Centre the slope covariate (slopes unchanged) to reduce the intercept-slope correlation.
    xc = np.asarray(xs, dtype=float) - float(np.mean(xs))
    exog = np.column_stack([np.ones(len(ys)), xc, *([np.array([c[j] for c in covs]) for j in range(k)])])
    caught: list[str] = []
    if family == "binomial":
        try:
            return _fit_logistic_slopes(persons, ys, exog, xc, groups, deltas, maxiter * 2)
        except (np.linalg.LinAlgError, ValueError, FloatingPointError, IndexError) as exc:
            caught.extend([f"glmm_failed: {type(exc).__name__}", "glmm_fallback_lpm"])
    elif family != "gaussian":
        raise ValueError(f"unknown mixed-model family {family!r}")
    try:
        fit = fit_random_slope_lmm(np.asarray(ys), exog, xc, groups, maxiter=maxiter * 2)
        g = fit.g
        rho = float(g[0, 1] / math.sqrt(g[0, 0] * g[1, 1])) if g[0, 0] > 0 and g[1, 1] > 0 else 0.0
        if abs(rho) > 0.95:
            # Boundary (|rho| -> 1) solutions make slope BLUPs a rescaled copy of the intercept BLUPs;
            # refit with independent random effects so person slopes rest on slope information only.
            caught.append(f"random_effect_correlation_boundary(rho={rho:.3f}); refit_independent")
            fit = fit_random_slope_lmm(np.asarray(ys), exog, xc, groups, maxiter=maxiter * 2, independent=True)
        tau2 = float(fit.g[1, 1])
        fixed = float(fit.beta[1])
        if not np.isfinite(tau2) or not np.isfinite(fixed):
            raise FloatingPointError("non-finite mixed-model estimates")
        index = {g: i for i, g in enumerate(fit.groups)}
        est = {p: fixed + float(fit.blups[index[p], 1]) for p in persons}
        psd = {p: math.sqrt(max(float(fit.blup_cov[index[p], 1, 1]), 0.0)) for p in persons}
        rel: float | None
        if tau2 > 1e-10:
            rel = float(min(1.0, max(0.0, 1.0 - float(np.mean([s * s for s in psd.values()])) / tau2)))
        else:
            rel = 0.0
            caught.append("zero_slope_variance")
        if not fit.converged:
            caught.append("reml_not_converged")
        return SlopeFit(
            est, psd, deltas, fixed, tau2, rel, "lmm_reml_random_slope", fit.converged, tuple(caught), len(persons)
        )
    except (np.linalg.LinAlgError, ValueError, FloatingPointError, IndexError) as exc:
        caught.append(f"lmm_failed: {type(exc).__name__}")
    slopes: dict[str, float] = {}
    variances: dict[str, float] = {}
    for p in persons:
        b, v = _ols_slope(data[p])
        slopes[p] = b
        variances[p] = v if np.isfinite(v) and v > 0 else 1e6
    post, sd, mu, tau2 = eb_normal_shrinkage([slopes[p] for p in persons], [variances[p] for p in persons])
    est = {p: float(post[i]) for i, p in enumerate(persons)}
    psd = {p: float(sd[i]) for i, p in enumerate(persons)}
    rel = float(max(0.0, 1.0 - float(np.mean(sd**2)) / tau2)) if tau2 > 0 else 0.0
    return SlopeFit(
        est, psd, deltas, mu, tau2, rel, "eb_ols_fallback", False, (*caught, "model_fallback_eb"), len(persons)
    )


RowBuilder = Callable[[BatchUnit, BatchContext], tuple[list[Row], int, str | None]]


def _slope_indicator(
    units: Sequence[BatchUnit],
    ctx: BatchContext,
    builder: RowBuilder,
    sign: float = 1.0,
    *,
    binary: bool = False,
) -> dict[str, IndicatorValue]:
    """Shared driver: build rows per session, fit, and package person estimates. ``binary`` outcomes use
    the model named by ``models.binary_outcome_model`` (``logistic_glmm`` or ``lpm``)."""
    min_persons = ctx.params.i("models.min_persons")
    out: dict[str, IndicatorValue] = {}
    data: dict[str, list[Row]] = {}
    counts: dict[str, int] = {}
    for u in units:
        rows, n_valid, problem = builder(u, ctx)
        sid = u.session.session_id
        counts[sid] = n_valid
        if problem is not None:
            out[sid] = IndicatorValue.empty(
                n_valid, problem, status=problem if problem == "missing_context_shift" else None
            )
        elif n_valid < ctx.spec.min_valid_count or not rows:
            out[sid] = IndicatorValue.empty(n_valid)
        else:
            data[sid] = rows
    if len(data) < min_persons:
        for sid in data:
            out[sid] = IndicatorValue.empty(counts[sid], "too_few_persons_for_model", status="model_failed")
        ctx.partition_details.update({"method": "not_estimated", "n_persons": len(data)})
        return out
    family = "gaussian"
    if binary:
        choice = str(ctx.params.get("models.binary_outcome_model"))
        if choice not in ("logistic_glmm", "lpm"):
            raise ValueError(f"models.binary_outcome_model must be logistic_glmm or lpm, not {choice!r}")
        family = "binomial" if choice == "logistic_glmm" else "gaussian"
    fit = fit_random_slopes(data, ctx.params.i("models.mixedlm_maxiter"), family=family)
    ctx.partition_details.update(
        {
            "method": fit.method,
            "fixed_slope": sign * fit.fixed_slope,
            "slope_variance": fit.tau2,
            "model_reliability": fit.model_reliability,
            "converged": fit.converged,
            "warnings": list(fit.warnings),
            "n_persons": fit.n_persons,
        }
    )
    flags = tuple(f for f in ("model_fallback_eb", "glmm_fallback_lpm") if f in fit.warnings)
    for sid in data:
        out[sid] = IndicatorValue(
            value=sign * fit.estimates[sid],
            n_valid=counts[sid],
            se=fit.posterior_sd[sid],
            flags=flags,
            details={
                "descriptive_delta": sign * fit.descriptive_delta[sid],
                "model_reliability": fit.model_reliability,
                "method": fit.method,
            },
        )
    return out


def _position(t: Trial, scale: float = 10.0) -> float:
    return t.block_pos / scale


def _cells_ok(rows: Sequence[Row], ctx: BatchContext) -> bool:
    need = ctx.params.i("models.min_trials_per_cell")
    on = sum(1 for _, x, _ in rows if x >= 0.5)
    return on >= need and len(rows) - on >= need


def _pressure_rows(u: BatchUnit, ctx: BatchContext, rt: bool) -> tuple[list[Row], int, str | None]:
    rows: list[Row] = []
    accuracy_types = frozenset(ctx.params.strs("models.pressure_accuracy_trial_types")) if not rt else frozenset()
    trial_type_effect = bool(ctx.params.get("models.pressure_accuracy_trial_type_effect"))
    for t in u.trials:
        x = 1.0 if t.phase == "pressure" else 0.0
        if rt:
            lat = latency(t)
            if t.trial_type != "go" or not gng_correct(t) or lat is None or lat <= 0:
                continue
            rows.append((math.log(lat), x, (_position(t),)))
        elif t.trial_type in accuracy_types:
            # Trial type (no-go = 1) is a fixed effect: go and no-go accuracy have very different baselines.
            covs: tuple[float, ...] = (_position(t),)
            if len(accuracy_types) > 1 and trial_type_effect:
                covs = (*covs, 1.0 if t.trial_type == "nogo" else 0.0)
            rows.append((1.0 if gng_correct(t) else 0.0, x, covs))
    if not _cells_ok(rows, ctx):
        return [], len(rows), "missing_pressure_contrast"
    return rows, len(rows), None


@batch_formula("hier.pressure_slope_accuracy")
def pressure_slope_accuracy(units: Sequence[BatchUnit], ctx: BatchContext) -> dict[str, IndicatorValue]:
    """Person random slope of accuracy on pressure (off = 0, on = 1), detrended on block position, with
    trial type as a fixed effect; logistic mixed model (logit scale) unless ``models.binary_outcome_model``
    is ``lpm``. Trial types come from ``models.pressure_accuracy_trial_types``."""
    return _slope_indicator(units, ctx, lambda u, c: _pressure_rows(u, c, rt=False), binary=True)


@batch_formula("hier.pressure_slope_rt")
def pressure_slope_rt(units: Sequence[BatchUnit], ctx: BatchContext) -> dict[str, IndicatorValue]:
    """Person random slope of log correct go-RT on pressure, detrended on block position."""
    return _slope_indicator(units, ctx, lambda u, c: _pressure_rows(u, c, rt=True))


def _distractor_rows(u: BatchUnit, ctx: BatchContext) -> tuple[list[Row], int, str | None]:
    rows: list[Row] = []
    for t in u.trials:
        lat = latency(t)
        if lat is None or lat <= 0:
            continue
        x = 1.0 if need_params(t, "distractor")["distractor"] else 0.0
        rows.append((math.log(lat), x, (_position(t), 1.0 if t.block == "held" else 0.0)))
    if not _cells_ok(rows, ctx):
        return [], len(rows), None
    return rows, len(u.trials), None


@batch_formula("hier.distractor_slope")
def distractor_slope(units: Sequence[BatchUnit], ctx: BatchContext) -> dict[str, IndicatorValue]:
    """Person random slope of log RT on distractor presence (block and position as covariates)."""
    return _slope_indicator(units, ctx, _distractor_rows)


UNNEEDED_TAPS = frozenset({"extra", "premature", "during_isi"})


def _held_free_rows(u: BatchUnit, ctx: BatchContext) -> tuple[list[Row], int, str | None]:
    rows: list[Row] = []
    for t in u.trials:
        extra = float(sum(1 for tp in t.taps if tp.classification in UNNEEDED_TAPS))
        rows.append((extra, 1.0 if t.block == "free" else 0.0, (_position(t),)))
    if not _cells_ok(rows, ctx):
        return [], len(rows), None
    return rows, len(rows), None


@batch_formula("hier.held_vs_free_slope")
def held_vs_free(units: Sequence[BatchUnit], ctx: BatchContext) -> dict[str, IndicatorValue]:
    """Person random slope of unnecessary taps per trial in free (1) vs held (0) blocks.

    Coded free minus held so that higher values mean less restraint (dictionary direction higher_less).
    """
    return _slope_indicator(units, ctx, _held_free_rows)


def _has_shift(u: BatchUnit, module: str) -> bool:
    m = u.session.modules.get(module)
    return bool(m and m.shifts)


def _switch_rows(u: BatchUnit, ctx: BatchContext) -> tuple[list[Row], int, str | None]:
    if not _has_shift(u, "card_sort"):
        return [], 0, "missing_context_shift"
    rows: list[Row] = []
    post = 0
    for t in u.trials:
        lat = latency(t)
        if lat is None or lat <= 0:
            continue
        x = 1.0 if t.post_shift else 0.0
        post += int(t.post_shift)
        rows.append((math.log(lat), x, (_position(t),)))
    if not _cells_ok(rows, ctx):
        return [], post, None
    return rows, post, None


@batch_formula("hier.switch_cost_slope")
def switch_cost(units: Sequence[BatchUnit], ctx: BatchContext) -> dict[str, IndicatorValue]:
    """Person random slope: log RT ~ post_switch + trial_in_run + (1 + post_switch | person) (SCR-06)."""
    return _slope_indicator(units, ctx, _switch_rows)


def _mirroring_rows(u: BatchUnit, ctx: BatchContext) -> tuple[list[Row], int, str | None]:
    rows: list[Row] = []
    levels: set[int] = set()
    for t in u.trials:
        v = tone_ordinal(t, ctx)
        if v is None or t.customer_tone_level is None:
            continue
        levels.add(int(t.customer_tone_level))
        rows.append((v, (float(t.customer_tone_level) - 2.0), ()))
    if len(levels) < ctx.params.i("tone.min_distinct_levels_mirroring"):
        return [], len(rows), "fewer_tone_levels_than_required"
    return rows, len(rows), None


@batch_formula("hier.tone_mirroring_slope")
def tone_mirroring(units: Sequence[BatchUnit], ctx: BatchContext) -> dict[str, IndicatorValue]:
    """Mirroring = minus the person slope of chosen tone (0 firm .. 2 warm) on customer tone level (0-4)."""
    return _slope_indicator(units, ctx, _mirroring_rows, sign=-1.0)


def _drift_rows(u: BatchUnit, ctx: BatchContext) -> tuple[list[Row], int, str | None]:
    if not _has_shift(u, "stall"):
        return [], 0, "missing_context_shift"
    rows: list[Row] = []
    for t in u.trials:
        if t.shift_kind != "rude_customer_run":
            continue
        v = tone_ordinal(t, ctx)
        if v is None or t.trials_since_shift is None:
            continue
        rows.append((v, t.trials_since_shift / 10.0, ()))
    return rows, len(rows), None


@batch_formula("hier.tone_drift_slope")
def tone_drift(units: Sequence[BatchUnit], ctx: BatchContext) -> dict[str, IndicatorValue]:
    """Person random slope of tone over successive rude-run trials (per 10 trials; deterioration < 0)."""
    return _slope_indicator(units, ctx, _drift_rows)


def _performance(t: Trial, ctx: BatchContext) -> float | None:
    kind = SHIFT_PERFORMANCE.get((t.module_id, t.trial_type))
    if kind == "correct":
        if t.module_id in ("dont_tap", "stall"):
            return 1.0 if gng_correct(t) else 0.0
        if t.module_id == "road_home":
            p = need_params(t, "rule_option")
            return 1.0 if t.response is not None and t.response.value == p["rule_option"] else 0.0
        c = t.correct
        return None if c is None else float(c)
    if kind == "tone":
        return tone_ordinal(t, ctx)
    if kind == "compliance":
        p = need_params(t, "compliant_responses")
        return 1.0 if t.response is not None and t.response.value in set(p["compliant_responses"]) else 0.0
    return None


def _shift_x(t: Trial) -> float:
    if t.module_id == "dont_tap":
        return 1.0 if t.phase == "pressure" else 0.0
    return 1.0 if t.post_shift else 0.0


def _standardised_shift_rows(
    u: BatchUnit, ctx: BatchContext, components: Sequence[str]
) -> tuple[list[Row], int, str | None]:
    by_mod: dict[str, list[tuple[float, float, Trial]]] = defaultdict(list)
    window = ctx.params.get("models.shift_window_trials")
    for t in u.trials:
        y = _performance(t, ctx)
        if y is None:
            continue
        x = _shift_x(t)
        # Optional early-window contrast: only the first `window` trials after each shift count as "post"
        # (shift effects in the paradigms are transient; later post-shift trials dilute the contrast).
        if window is not None and x >= 0.5 and t.trials_since_shift is not None and t.trials_since_shift >= window:
            continue
        by_mod[t.module_id].append((y, x, t))
    rows: list[Row] = []
    contrasts = 0
    for j, mod in enumerate(components):
        items = by_mod.get(mod, [])
        if mod != "dont_tap" and not _has_shift(u, mod):
            if items:
                return [], contrasts, "missing_context_shift"
            continue
        on = sum(1 for _, x, _ in items if x >= 0.5)
        if on < ctx.params.i("models.min_trials_per_cell") or len(items) - on < ctx.params.i(
            "models.min_trials_per_cell"
        ):
            continue
        contrasts += 1
        ys = np.array([y for y, _, _ in items])
        sd = float(ys.std(ddof=0))
        mean = float(ys.mean())
        n_idx = max((t.trial_index for _, _, t in items), default=1) or 1
        dummies = [1.0 if k == j else 0.0 for k in range(1, len(components))]
        for y, x, t in items:
            z = (y - mean) / sd if sd > 0 else 0.0
            rows.append((z, x, (t.trial_index / n_idx, *dummies)))
    return rows, contrasts, None


def _components(ctx: BatchContext) -> list[str]:
    seen: list[str] = []
    for c in TASKS[ctx.spec.task].components:
        if c.module_id not in seen:
            seen.append(c.module_id)
    return seen


@batch_formula("hier.shift_slope_single", "hier.shift_slope_pooled")
def shift_slope(units: Sequence[BatchUnit], ctx: BatchContext) -> dict[str, IndicatorValue]:
    """Person random slope of within-person standardised performance on shift (post vs pre).

    Reported as the decrement (pre minus post, standardised units): higher = larger change = less stable
    (dictionary direction higher_less). Detrended on module trial index; pooled models add component
    fixed effects. For ``_single`` the contrast count is reported in trials, for ``_pooled`` in shifts.
    """
    comps = _components(ctx)
    pooled = ctx.spec.formula_ref.endswith("pooled")

    def builder(u: BatchUnit, c: BatchContext) -> tuple[list[Row], int, str | None]:
        rows, contrasts, problem = _standardised_shift_rows(u, c, comps)
        if problem:
            return rows, contrasts, problem
        if pooled:
            return rows, contrasts, None
        post = sum(1 for _, x, _ in rows if x >= 0.5)
        return rows, post if comps != ["dont_tap"] else len(rows), None

    return _slope_indicator(units, ctx, builder, sign=-1.0)


# ---------------------------------------------------------------- discounting (hierarchical log k)


DiscountData = tuple[list[float], list[float], list[float], list[float], list[int]]


def _discount_data(u: BatchUnit, kind: str) -> DiscountData:
    sa: list[float] = []
    sc: list[float] = []
    la: list[float] = []
    lc: list[float] = []
    y: list[int] = []
    for t in u.trials:
        r = t.response
        if r is None or r.value is None or r.input_mode == "timeout":
            continue
        if kind == "delay":
            p = need_params(t, "ss_amount", "ss_delay", "ll_amount", "ll_delay")
            sa.append(float(p["ss_amount"]))
            sc.append(float(p["ss_delay"]))
            la.append(float(p["ll_amount"]))
            lc.append(float(p["ll_delay"]))
            y.append(1 if r.value == "wait" else 0)
        else:
            p = need_params(t, "easy_amount", "easy_effort", "hard_amount", "hard_effort")
            sa.append(float(p["easy_amount"]))
            sc.append(float(p["easy_effort"]))
            la.append(float(p["hard_amount"]))
            lc.append(float(p["hard_effort"]))
            y.append(1 if r.value == "hard" else 0)
    return sa, sc, la, lc, y


def fit_discounting_eb(data: Mapping[str, DiscountData], params: Any) -> dict[str, Any]:
    """Hierarchical hyperbolic discounting: per-person MAP of (log k, log beta) under a population prior on
    log k that is re-estimated (empirical Bayes) until it converges. ``data`` maps person -> (small amount,
    small cost, large amount, large cost, chose large); ``params`` is the scoring parameter document.

    Shared by the engine and by design simulations (stats/simulator, VAL-02)."""
    p = params
    lk_bounds = tuple(float(v) for v in p.get("discounting.log_k_bounds"))
    lb_bounds = tuple(float(v) for v in p.get("discounting.log_beta_bounds"))
    beta_prior = (p.f("discounting.log_beta_prior_mean"), p.f("discounting.log_beta_prior_sd"))
    mu = p.f("discounting.initial_log_k_prior_mean")
    sd = p.f("discounting.initial_log_k_prior_sd")
    # Fit every person with at least two choices; each indicator applies its own minimum afterwards.
    usable = {s: d for s, d in data.items() if len(d[4]) >= 2}
    fits: dict[str, Any] = {}
    iterations = 0
    for _ in range(p.i("discounting.eb_max_iter")):
        iterations += 1
        # First pass: multi-start; later passes warm-start from the previous optimum (same objective
        # family, slightly different prior), which keeps the empirical-Bayes loop cheap.
        fits = {
            s: fit_hyperbolic_map(
                *d,
                log_k_prior=(mu, sd),
                log_beta_prior=beta_prior,
                log_k_bounds=(lk_bounds[0], lk_bounds[1]),
                log_beta_bounds=(lb_bounds[0], lb_bounds[1]),
                start=None if s not in fits else (fits[s].log_k, fits[s].log_beta),
            )
            for s, d in sorted(usable.items())
        }
        if len(fits) < 2:
            break
        est = np.array([f.log_k for f in fits.values()])
        post_var = np.array([f.log_k_sd**2 if np.isfinite(f.log_k_sd) else sd**2 for f in fits.values()])
        mu_new = float(est.mean())
        sd_new = float(math.sqrt(max(float(est.var(ddof=0)) + float(post_var.mean()), 1e-4)))
        if abs(mu_new - mu) < p.f("discounting.eb_tol") and abs(sd_new - sd) < p.f("discounting.eb_tol"):
            mu, sd = mu_new, sd_new
            break
        mu, sd = mu_new, sd_new
    sds = [f.log_k_sd for f in fits.values() if np.isfinite(f.log_k_sd)]
    prior_var = sd**2
    rel = float(max(0.0, 1.0 - float(np.mean(np.square(sds))) / prior_var)) if sds and prior_var > 0 else None
    return {
        "fits": fits,
        "data": usable,
        "prior_mean": mu,
        "prior_sd": sd,
        "iterations": iterations,
        "model_reliability": rel,
    }


def _fit_discounting(units: Sequence[BatchUnit], ctx: BatchContext, kind: str) -> dict[str, Any]:
    key = f"discount:{kind}"
    if key in ctx.cache:
        return dict(ctx.cache[key])
    result = fit_discounting_eb({u.session.session_id: _discount_data(u, kind) for u in units}, ctx.params)
    ctx.cache[key] = result
    return result


def _discount_values(units: Sequence[BatchUnit], ctx: BatchContext, kind: str) -> dict[str, IndicatorValue]:
    res = _fit_discounting(units, ctx, kind)
    fits = res["fits"]
    rel = res["model_reliability"]
    ctx.partition_details.update(
        {
            "method": "hyperbolic_map_empirical_bayes",
            "prior_mean_log_k": res["prior_mean"],
            "prior_sd_log_k": res["prior_sd"],
            "iterations": res["iterations"],
            "model_reliability": rel,
            "n_persons": len(fits),
        }
    )
    out: dict[str, IndicatorValue] = {}
    for u in units:
        sid = u.session.session_id
        n = len(_discount_data(u, kind)[4])
        f = fits.get(sid)
        if f is None or n < ctx.spec.min_valid_count:
            out[sid] = IndicatorValue.empty(n)
            continue
        flags = () if f.converged else ("optimiser_not_converged",)
        out[sid] = IndicatorValue(
            value=f.log_k,
            n_valid=n,
            se=f.log_k_sd if np.isfinite(f.log_k_sd) else None,
            flags=flags,
            details={"log_beta": f.log_beta, "model_reliability": rel},
        )
    return out


@batch_formula("discounting.hierarchical_logk")
def delay_logk(units: Sequence[BatchUnit], ctx: BatchContext) -> dict[str, IndicatorValue]:
    """Log k of hyperbolic delay discounting (empirical-Bayes hierarchical MAP, Laplace posterior SD)."""
    return _discount_values(units, ctx, "delay")


@batch_formula("discounting.effort_k")
def effort_k(units: Sequence[BatchUnit], ctx: BatchContext) -> dict[str, IndicatorValue]:
    """Log k of hyperbolic effort discounting from hold-to-earn choices (same hierarchical machinery)."""
    return _discount_values(units, ctx, "effort")


@batch_formula("discounting.choice_consistency")
def choice_consistency(units: Sequence[BatchUnit], ctx: BatchContext) -> dict[str, IndicatorValue]:
    """Share of delay choices consistent with the person's fitted discounting function (ties count .5)."""
    res = _fit_discounting(units, ctx, "delay")
    fits = res["fits"]
    out: dict[str, IndicatorValue] = {}
    for u in units:
        sid = u.session.session_id
        y = _discount_data(u, "delay")[4]
        f = fits.get(sid)
        if f is None or len(y) < ctx.spec.min_valid_count:
            out[sid] = IndicatorValue.empty(len(y))
            continue
        score = 0.0
        for p_large, chose in zip(f.p_larger, y, strict=True):
            if abs(float(p_large) - 0.5) < 1e-9:
                score += 0.5
            else:
                score += float((float(p_large) > 0.5) == bool(chose))
        out[sid] = IndicatorValue(value=score / len(y), n_valid=len(y))
    ctx.partition_details.update({"method": "consistency_with_fitted_hyperbolic", "n_persons": len(fits)})
    return out


# ---------------------------------------------------------------- location-scale residual SD


@batch_formula("style.location_scale_sigma")
def location_scale_sigma(units: Sequence[BatchUnit], ctx: BatchContext) -> dict[str, IndicatorValue]:
    """Person residual SD of log RT after module-specific means and linear trends (location), with
    empirical-Bayes shrinkage of log SD (sampling variance 1 / (2 df)); value = shrunken SD."""
    records: list[tuple[str, str, float, float]] = []
    for u in units:
        for t in u.trials:
            lat = latency(t)
            if lat is None or lat <= 0:
                continue
            records.append((u.session.session_id, f"{t.module_id}.{t.block}", float(t.trial_index), math.log(lat)))
    out: dict[str, IndicatorValue] = {}
    if not records:
        return {u.session.session_id: IndicatorValue.empty(0) for u in units}
    df = pd.DataFrame(records, columns=["sid", "module", "idx", "y"])
    # Population location: module mean and module-specific linear trend in trial index.
    df["resid"] = 0.0
    for _, g in df.groupby("module"):
        x = g["idx"].to_numpy()
        yv = g["y"].to_numpy()
        coef = np.polyfit(x, yv, 1) if np.ptp(x) > 0 else np.array([0.0, yv.mean()])
        df.loc[g.index, "resid"] = yv - (coef[0] * x + coef[1])
    # Person location per module block removed; residuals are scaled by the block's pooled residual SD so
    # that blocks with different noise levels (and the planned-missingness slot) do not drive the scale.
    df["within"] = df["resid"] - df.groupby(["sid", "module"])["resid"].transform("mean")
    pooled = df.groupby("module")["within"].transform(lambda v: float(np.sqrt(np.mean(np.square(v)))) or 1.0)
    df["within"] = df["within"] / pooled
    stats = df.groupby("sid").agg(
        ss=("within", lambda v: float(np.sum(np.square(v)))), n=("within", "size"), m=("module", "nunique")
    )
    min_n = max(ctx.spec.min_valid_count, ctx.params.i("models.location_scale_min_trials"))
    eligible = stats[(stats["n"] >= min_n) & (stats["n"] - stats["m"] > 1)]
    for u in units:
        sid = u.session.session_id
        if sid not in eligible.index:
            out[sid] = IndicatorValue.empty(int(stats.loc[sid, "n"]) if sid in stats.index else 0)
    if len(eligible) < ctx.params.i("models.min_persons"):
        for sid in eligible.index:
            out[str(sid)] = IndicatorValue.empty(
                int(eligible.loc[sid, "n"]), "too_few_persons_for_model", status="model_failed"
            )
        return out
    dof = (eligible["n"] - eligible["m"]).to_numpy(dtype=float)
    log_sd = 0.5 * np.log(eligible["ss"].to_numpy(dtype=float) / dof)
    var = 1.0 / (2.0 * dof)
    post, psd, mu, tau2 = eb_normal_shrinkage(list(log_sd), list(var))
    rel = float(tau2 / (tau2 + float(np.mean(var))))
    ctx.partition_details.update(
        {
            "method": "location_scale_eb_log_sd",
            "mu_log_sd": mu,
            "tau2_log_sd": tau2,
            "model_reliability": rel,
            "n_persons": len(eligible),
        }
    )
    for i, sid in enumerate(eligible.index):
        out[str(sid)] = IndicatorValue(
            value=float(math.exp(post[i])),
            n_valid=int(eligible.loc[sid, "n"]),
            se=float(psd[i]),
            details={"raw_sd": float(math.exp(log_sd[i])), "posterior_sd_log": float(psd[i]), "model_reliability": rel},
        )
    return out


# ---------------------------------------------------------------- persistence of style (cross-segment r)


def _segment_style(trials: Sequence[Trial], risky: frozenset[str]) -> dict[str, float]:
    lats = [math.log(v) for t in trials if (v := latency(t)) is not None and v > 0]
    answered = [t for t in trials if t.responded and t.response is not None]
    return {
        "speed": float(np.mean(lats)) if lats else math.nan,
        "rt_variability": float(np.std(lats, ddof=1)) if len(lats) >= 2 else math.nan,
        "revision_rate": float(np.mean([len(t.response.revisions) for t in answered if t.response]))
        if answered
        else math.nan,
        "risk": float(np.mean([1.0 if t.response and t.response.value in risky else 0.0 for t in answered]))
        if answered
        else math.nan,
    }


@batch_formula("style.cross_segment_r")
def cross_segment_r(units: Sequence[BatchUnit], ctx: BatchContext) -> dict[str, IndicatorValue]:
    """Mean Fisher-z profile correlation of per-segment style vectors (speed, RT variability as the caution
    proxy, revision rate, risk), each dimension standardised within segment across the partition."""
    dims = list(ctx.params.strs("style.dimensions"))
    risky = frozenset(ctx.params.strs("style.risky_codes"))
    clip = ctx.params.f("style.correlation_clip")
    min_seg = ctx.params.i("style.min_trials_per_segment")
    per: dict[str, dict[tuple[str, str], dict[str, float]]] = {}
    for u in units:
        segs = probe_segments(u.trials, min_seg)
        per[u.session.session_id] = {k: _segment_style(v, risky) for k, v in segs.items()}
    # Standardise each (segment, dimension) across persons.
    stats: dict[tuple[tuple[str, str], str], tuple[float, float]] = {}
    keys = sorted({k for v in per.values() for k in v})
    for k in keys:
        for d in dims:
            vals = np.array([v[k][d] for v in per.values() if k in v and np.isfinite(v[k][d])])
            if vals.size >= 3 and vals.std(ddof=1) > 0:
                stats[(k, d)] = (float(vals.mean()), float(vals.std(ddof=1)))
    out: dict[str, IndicatorValue] = {}
    for sid, person_segs in per.items():
        vectors: dict[tuple[str, str], np.ndarray] = {}
        for k, style in person_segs.items():
            vec = np.array(
                [
                    (style[d] - stats[(k, d)][0]) / stats[(k, d)][1]
                    if (k, d) in stats and np.isfinite(style[d])
                    else np.nan
                    for d in dims
                ]
            )
            vectors[k] = vec
        zs: list[float] = []
        ks = sorted(vectors)
        for i in range(len(ks)):
            for j in range(i + 1, len(ks)):
                a, b = vectors[ks[i]], vectors[ks[j]]
                ok = np.isfinite(a) & np.isfinite(b)
                if ok.sum() < 3 or a[ok].std() == 0 or b[ok].std() == 0:
                    continue
                r = float(np.corrcoef(a[ok], b[ok])[0, 1])
                zs.append(fisher_z(r, clip))
        n_seg = len(vectors)
        if n_seg < ctx.spec.min_valid_count or not zs:
            out[sid] = IndicatorValue.empty(n_seg)
            continue
        out[sid] = IndicatorValue(value=float(math.tanh(float(np.mean(zs)))), n_valid=n_seg, details={"pairs": len(zs)})
    ctx.partition_details.update({"method": "profile_correlation_fisher_z", "segments": [list(k) for k in keys]})
    return out
