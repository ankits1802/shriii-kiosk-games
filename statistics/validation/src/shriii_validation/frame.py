"""Snapshot-frame conventions shared by the analysis entry points.

A snapshot frame (``apps/api`` ``services/snapshots.py``) has one row per participant x occasion with
de-identified design columns (``research_id``, ``occasion_id``, ``language``, ``cohort_id``, ``holdout``,
coarse demographic bands, ...), layer-2 indicator columns ``ind__<indicator_id>`` and layer-3 criterion
columns ``crit__<instrument_id>.<scale_id>``.

This module resolves the analysis context (scoring dictionary, ``gates.yaml``, ``hypotheses.yaml``) from
what the caller supplies, falling back to the versioned files in the repository, and applies the frame-level
exclusions every analysis shares, recording each one by reason and language:

* group-level-only indicators (private reports) are dropped before any individual analysis
  (BUILD_DECISIONS non-negotiable 6);
* rows of untouched holdout cohorts are kept out of every analysis except the final holdout evaluation;
* criterion values of rows flagged ``criterion_careless`` are blanked (attention-check failures);
* cross-sectional analyses use one occasion (the baseline unless ``params.occasion`` says otherwise).
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, cast

import numpy as np
import pandas as pd
from numpy.typing import NDArray
from shriii_scoring.resources import load_yaml, scoring_dir

from shriii_validation.params import load_gates, load_hypotheses

__all__ = [
    "CRITERION_PREFIX",
    "INDICATOR_PREFIX",
    "AnalysisContext",
    "IndicatorInfo",
    "PreparedFrame",
    "composite",
    "prepare_frame",
    "resolve_context",
]

INDICATOR_PREFIX = "ind__"
CRITERION_PREFIX = "crit__"
FloatArray = NDArray[np.float64]


@dataclass(frozen=True, slots=True)
class IndicatorInfo:
    """What the analyses need to know about one dictionary indicator."""

    id: str
    construct: str
    sign: int
    gate_eligible: bool
    group_only: bool
    tier: int | None
    role: str | None
    convergent_criteria: tuple[str, ...]

    @property
    def column(self) -> str:
        return INDICATOR_PREFIX + self.id


@dataclass(frozen=True, slots=True)
class AnalysisContext:
    """Dictionary, gates and hypotheses for one analysis, plus caller provenance."""

    indicators: Mapping[str, IndicatorInfo]
    constructs: Mapping[str, Mapping[str, Any]]
    gates: Mapping[str, Any]
    hypotheses: Mapping[str, Any]
    confirmatory_ids: frozenset[str]
    pathway: str | None
    shared_params: Mapping[str, Any]
    snapshot_exclusions: Mapping[str, Any]
    provenance: Mapping[str, Any]
    sources: Mapping[str, str] = field(default_factory=dict)

    def construct_indicators(
        self, construct: str, columns: Sequence[str], *, gate_eligible_only: bool = True
    ) -> list[IndicatorInfo]:
        """Individual (never group-only) indicators of ``construct`` present in ``columns``."""
        present = set(columns)
        return [
            i
            for i in self.indicators.values()
            if i.construct == construct
            and not i.group_only
            and (i.gate_eligible or not gate_eligible_only)
            and i.column in present
        ]

    def convergent_criteria(self, construct: str) -> list[str]:
        """Criterion ids (``instrument.scale``) listed as convergent for ``construct`` in ``shared.yaml``."""
        rel = (self.constructs.get(construct) or {}).get("criterion_relations") or {}
        return [str(r["criterion"]) for r in rel.get("convergent", []) if r.get("criterion")]

    def expected_sign(self, construct: str, criterion: str) -> int:
        rel = (self.constructs.get(construct) or {}).get("criterion_relations") or {}
        for r in rel.get("convergent", []):
            if r.get("criterion") == criterion:
                return {"positive": 1, "negative": -1}.get(str(r.get("expected_sign")), 0)
        return 0


def _sign(direction: Any) -> int:
    return -1 if str(direction or "").endswith("less") else 1


def _indicator(raw: Mapping[str, Any]) -> IndicatorInfo:
    tier = raw.get("tier")
    return IndicatorInfo(
        id=str(raw["id"]),
        construct=str(raw.get("construct") or str(raw["id"]).split(".", 1)[0]),
        sign=_sign(raw.get("direction")),
        gate_eligible=bool(raw.get("gate_eligible", True)),
        group_only=bool(raw.get("group_only", False)),
        tier=int(tier) if tier is not None else None,
        role=str(raw["role"]) if raw.get("role") is not None else None,
        convergent_criteria=tuple(str(c) for c in (raw.get("convergent_criteria") or [])),
    )


def _repo_dictionary() -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], dict[str, Any], dict[str, str]]:
    shared = load_yaml(scoring_dir() / "dictionary" / "shared.yaml")
    indicators: list[dict[str, Any]] = []
    seen: set[str] = set()
    sources = {"shared": shared.sha256}
    for pathway in ("A", "B"):
        doc = load_yaml(scoring_dir() / "dictionary" / f"dictionary.{pathway}.yaml")
        sources[pathway] = doc.sha256
        for ind in cast(Mapping[str, Any], doc.data).get("indicators", []):
            if ind["id"] not in seen:
                seen.add(ind["id"])
                indicators.append(dict(ind))
    data = cast(Mapping[str, Any], shared.data)
    constructs = {str(c["id"]): dict(c) for c in data.get("constructs", [])}
    params = {k: data[k] for k in ("private_report",) if k in data}
    return indicators, constructs, params, sources


def resolve_context(context: Mapping[str, Any] | None) -> AnalysisContext:
    """Build an :class:`AnalysisContext` from the caller's context, filling gaps from the repository files.

    Recognised keys: ``indicators`` (dictionary indicator entries), ``constructs`` (``shared.yaml``
    constructs by id), ``gates``, ``hypotheses``, ``hypothesis_ids`` (the confirmatory ones), ``pathway``,
    ``shared_params``, ``snapshot_exclusions`` and ``provenance`` (passed through to every result).
    """
    ctx = dict(context or {})
    sources: dict[str, str] = {}
    raw_inds = ctx.get("indicators")
    constructs = ctx.get("constructs")
    shared_params = ctx.get("shared_params")
    if raw_inds is None or constructs is None or shared_params is None:
        repo_inds, repo_constructs, repo_params, dict_sources = _repo_dictionary()
        raw_inds = repo_inds if raw_inds is None else raw_inds
        constructs = repo_constructs if constructs is None else constructs
        shared_params = repo_params if shared_params is None else shared_params
        sources.update({f"dictionary.{k}": v for k, v in dict_sources.items()})
    gates = ctx.get("gates")
    if gates is None:
        gates, sha = load_gates()
        sources["gates"] = sha
    hypotheses = ctx.get("hypotheses")
    if hypotheses is None:
        hypotheses, sha = load_hypotheses()
        sources["hypotheses"] = sha
    indicators = {str(i["id"]): _indicator(i) for i in raw_inds}
    group_only = set(cast(Sequence[str], gates.get("group_only_indicators", [])))
    for gid in group_only:
        if gid in indicators and not indicators[gid].group_only:
            # gates.yaml is authoritative for group-level-only indicators (defence in depth).
            i = indicators[gid]
            indicators[gid] = IndicatorInfo(
                i.id, i.construct, i.sign, i.gate_eligible, True, i.tier, i.role, i.convergent_criteria
            )
    pathway = ctx.get("pathway")
    return AnalysisContext(
        indicators=indicators,
        constructs={str(k): dict(v) for k, v in cast(Mapping[str, Any], constructs).items()},
        gates=cast(Mapping[str, Any], gates),
        hypotheses=cast(Mapping[str, Any], hypotheses),
        confirmatory_ids=frozenset(str(h) for h in ctx.get("hypothesis_ids") or []),
        pathway=str(pathway) if pathway in ("A", "B") else None,
        shared_params=cast(Mapping[str, Any], shared_params),
        snapshot_exclusions=cast(Mapping[str, Any], ctx.get("snapshot_exclusions") or {}),
        provenance=dict(cast(Mapping[str, Any], ctx.get("provenance") or {})),
        sources=sources,
    )


@dataclass(slots=True)
class PreparedFrame:
    """The frame after the shared exclusions, with the exclusion report."""

    all_rows: pd.DataFrame
    """Every non-holdout row (all occasions)."""
    baseline: pd.DataFrame
    """One occasion (``occasion``) of :attr:`all_rows`."""
    holdout: pd.DataFrame
    """Rows of untouched holdout cohorts (only the final holdout evaluation may use them)."""
    occasion: str | None
    occasions: list[str]
    indicator_columns: list[str]
    criterion_columns: list[str]
    exclusions: dict[str, Any]

    @property
    def measure_columns(self) -> list[str]:
        return [*self.indicator_columns, *self.criterion_columns]


def _by_language(frame: pd.DataFrame, mask: pd.Series) -> dict[str, int]:
    if "language" not in frame.columns:
        return {"unknown": int(mask.sum())}
    counts = Counter(str(v) for v in frame.loc[mask, "language"].tolist())
    return dict(sorted(counts.items()))


def _truthy(series: pd.Series) -> pd.Series:
    return series.fillna(False).astype(bool)


def prepare_frame(frame: pd.DataFrame, ctx: AnalysisContext, params: Mapping[str, Any]) -> PreparedFrame:
    """Apply the shared exclusions and split the frame (see the module docstring)."""
    df = frame.copy()
    if "research_id" not in df.columns:
        if len(df):
            raise KeyError("snapshot frame has no research_id column")
        df["research_id"] = pd.Series(dtype=str)
    if "occasion_id" not in df.columns:
        df["occasion_id"] = "T1"
    df["occasion_id"] = df["occasion_id"].fillna("unassigned").astype(str)
    exclusions: dict[str, Any] = {"rows_in": len(df), "by_reason": {}, "by_reason_language": {}, "columns_dropped": {}}

    def note(reason: str, mask: pd.Series) -> None:
        k = int(mask.sum())
        if k:
            exclusions["by_reason"][reason] = exclusions["by_reason"].get(reason, 0) + k
            exclusions["by_reason_language"][reason] = _by_language(df, mask)

    group_only_cols = [c for c in df.columns if c.startswith(INDICATOR_PREFIX) and _is_group_only(c, ctx)]
    if group_only_cols:
        exclusions["columns_dropped"]["group_level_only"] = sorted(c[len(INDICATOR_PREFIX) :] for c in group_only_cols)
        df = df.drop(columns=group_only_cols)
    # Pathway filter (one battery arm per analysis unless the caller pools on purpose).
    pathway = params.get("pathway") or ctx.pathway
    if pathway and "pathway" in df.columns:
        other = df["pathway"].astype(str) != str(pathway)
        note("other_pathway", other)
        df = df[~other]
    hold_mask = pd.Series(False, index=df.index)
    if "holdout" in df.columns:
        hold_mask = _truthy(df["holdout"])
    holdout_cohorts = [str(c) for c in params.get("holdout_cohorts") or []]
    if holdout_cohorts and "cohort_id" in df.columns:
        hold_mask = hold_mask | df["cohort_id"].astype(str).isin(holdout_cohorts)
    holdout = df[hold_mask].copy()
    if params.get("include_holdout"):
        hold_mask = pd.Series(False, index=df.index)
    else:
        note("holdout_cohort", hold_mask)
    df = df[~hold_mask].copy()
    crit_cols = sorted(c for c in df.columns if c.startswith(CRITERION_PREFIX))
    ind_cols = sorted(c for c in df.columns if c.startswith(INDICATOR_PREFIX))
    for c in [*crit_cols, *ind_cols]:
        df[c] = pd.to_numeric(df[c], errors="coerce").astype(float)
        if c in holdout.columns:
            holdout[c] = pd.to_numeric(holdout[c], errors="coerce").astype(float)
    if params.get("exclude_careless", True) and "criterion_careless" in df.columns and crit_cols:
        careless = _truthy(df["criterion_careless"])
        note("criterion_careless_values_blanked", careless)
        df.loc[careless, crit_cols] = np.nan
    occasions = sorted(str(o) for o in df["occasion_id"].dropna().unique())
    occasion = str(params["occasion"]) if params.get("occasion") else (occasions[0] if occasions else None)
    baseline_mask = df["occasion_id"] == occasion if occasion is not None else pd.Series(False, index=df.index)
    if len(occasions) > 1:
        exclusions["non_baseline_rows_in_cross_sectional_analyses"] = int((~baseline_mask).sum())
    baseline = df[baseline_mask].copy()
    dup = baseline["research_id"].duplicated(keep="last")
    note("duplicate_participant_occasion", dup)
    baseline = baseline[~dup]
    exclusions["rows_used"] = len(df)
    exclusions["baseline_rows"] = len(baseline)
    exclusions["holdout_rows"] = len(holdout)
    exclusions["occasion"] = occasion
    return PreparedFrame(
        all_rows=df,
        baseline=baseline,
        holdout=holdout,
        occasion=occasion,
        occasions=occasions,
        indicator_columns=ind_cols,
        criterion_columns=crit_cols,
        exclusions=exclusions,
    )


def _is_group_only(column: str, ctx: AnalysisContext) -> bool:
    info = ctx.indicators.get(column[len(INDICATOR_PREFIX) :])
    return info is not None and info.group_only


def composite(
    frame: pd.DataFrame,
    indicators: Sequence[IndicatorInfo],
    *,
    reference: pd.DataFrame | None = None,
    min_present: int = 1,
) -> tuple[pd.Series, dict[str, dict[str, float]]]:
    """Unit-weighted, construct-keyed z composite (mean of available z scores per row).

    Standardisation parameters come from ``reference`` (default: ``frame``) so that, e.g., a retest occasion
    is scored on the baseline metric. Rows with fewer than ``min_present`` indicators are NaN. Returns the
    composite and the per-indicator ``{mean, sd, sign}`` used.
    """
    ref = frame if reference is None else reference
    zs: dict[str, pd.Series] = {}
    standardisation: dict[str, dict[str, float]] = {}
    for ind in indicators:
        col = ind.column
        if col not in frame.columns or col not in ref.columns:
            continue
        r = pd.to_numeric(ref[col], errors="coerce")
        mean, sd = float(r.mean()), float(r.std(ddof=1))
        if not math.isfinite(sd) or sd <= 0:
            continue
        standardisation[ind.id] = {"mean": mean, "sd": sd, "sign": float(ind.sign)}
        zs[ind.id] = ind.sign * (pd.to_numeric(frame[col], errors="coerce") - mean) / sd
    if not zs:
        return pd.Series(np.nan, index=frame.index, dtype=float), standardisation
    z = pd.DataFrame(zs, index=frame.index)
    comp = z.mean(axis=1, skipna=True)
    comp[z.notna().sum(axis=1) < min_present] = np.nan
    return comp.astype(float), standardisation


def values(series: pd.Series) -> FloatArray:
    """A float numpy array (NaN for missing)."""
    return np.asarray(pd.to_numeric(series, errors="coerce"), dtype=float)


def coverage(frame: pd.DataFrame, column: str) -> float:
    """Share of rows with a finite value."""
    if column not in frame.columns or not len(frame):
        return 0.0
    return float(pd.to_numeric(frame[column], errors="coerce").notna().mean())
