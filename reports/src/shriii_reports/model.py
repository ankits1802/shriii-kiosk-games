"""Report input model: a *report bundle* of ValidationResult entries plus sample, exclusion and provenance data.

Each result entry wraps one ``EvidenceResult`` exactly as ``shriii_validation.results.EvidenceResult.to_dict()``
serialises it (analysis, estimate, ci_low, ci_high, ci_level, n, method, status, assumptions, warnings,
details, provenance), plus the ``ValidationResult`` contract fields from plan section 6.2 / the
``validation.statistical_results`` table (subject, metric, subgroup, threshold, passed, hypothesis_id, ...).

A flat row (estimate/ci_low/... at the top level, as stored in ``statistical_results``) is accepted and
lifted into ``evidence`` automatically.
"""

from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

__all__ = [
    "REPORT_KINDS",
    "AssumptionCheck",
    "BatteryGateEntry",
    "EvidenceResult",
    "ExclusionEntry",
    "IndicatorDecisionEntry",
    "NormCellEntry",
    "NormTableEntry",
    "Provenance",
    "ReportBundle",
    "ReportMeta",
    "ResultEntry",
    "SampleCell",
    "SampleSummary",
    "TargetEntry",
    "TraitGateEntry",
]

ReportKind = Literal["stage2_pilot", "stage3_retest", "stage4_fairness", "stage5_norming", "technical_manual"]
REPORT_KINDS: tuple[str, ...] = (
    "stage2_pilot",
    "stage3_retest",
    "stage4_fairness",
    "stage5_norming",
    "technical_manual",
)
Status = Literal["ok", "insufficient", "not_available", "failed"]

_EVIDENCE_FIELDS = (
    "analysis",
    "estimate",
    "ci_low",
    "ci_high",
    "ci_level",
    "n",
    "method",
    "status",
    "assumptions",
    "warnings",
    "details",
    "provenance",
)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class AssumptionCheck(_Model):
    name: str
    passed: bool
    statistic: float | None = None
    detail: str = ""


class Provenance(_Model):
    """``shriii_validation.results.Provenance``."""

    analysis: str
    algorithm_version: str
    computed_at: str
    inputs_sha256: str
    seed: int | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    library_versions: dict[str, str | None] = Field(default_factory=dict)


class EvidenceResult(_Model):
    """``shriii_validation.results.EvidenceResult`` (serialised form)."""

    analysis: str
    estimate: float | None
    ci_low: float | None
    ci_high: float | None
    ci_level: float | None
    n: int
    method: str
    status: Status = "ok"
    assumptions: tuple[AssumptionCheck, ...] = ()
    warnings: tuple[str, ...] = ()
    details: dict[str, Any] = Field(default_factory=dict)
    provenance: Provenance | None = None

    @field_validator("estimate", "ci_low", "ci_high", "ci_level", mode="before")
    @classmethod
    def _finite_or_none(cls, v: Any) -> Any:
        # NaN/inf serialise as strings or floats; neither may be shown as evidence.
        if isinstance(v, str) and v.lower() in {"nan", "inf", "-inf", "infinity", "-infinity"}:
            return None
        if isinstance(v, float) and not math.isfinite(v):
            return None
        return v

    @property
    def ok(self) -> bool:
        return self.status == "ok" and self.estimate is not None


class ResultEntry(_Model):
    """One ``ValidationResult``: subject x metric x subgroup with its evidence and decision fields."""

    result_id: str | None = None
    section: str
    """Report section key (e.g. ``reliability``, ``convergent``, ``retest``, ``invariance``, ``dif``)."""
    subject: str
    subject_kind: Literal[
        "indicator", "trait", "construct", "criterion", "battery", "module", "item", "model", "norm"
    ] = "indicator"
    metric: str
    hypothesis_id: str | None = None
    family: str | None = None
    confirmatory: bool = False
    pathway: str | None = None
    language: str | None = None
    subgroup: dict[str, Any] = Field(default_factory=dict)
    threshold: float | None = None
    threshold_rule: str | None = None
    """Human-readable rule, e.g. ``ci_low > 0.10`` or ``point >= 0.60 and ci_low >= 0.40``."""
    passed: bool | None = None
    run_id: str | None = None
    evidence: EvidenceResult

    @model_validator(mode="before")
    @classmethod
    def _lift_flat(cls, data: Any) -> Any:
        if isinstance(data, dict) and "evidence" not in data and "estimate" in data:
            data = dict(data)
            ev = {k: data.pop(k) for k in list(data) if k in _EVIDENCE_FIELDS}
            ev.setdefault("analysis", str(data.get("metric", "unknown")))
            ev.setdefault("method", "unspecified")
            ev.setdefault("n", 0)
            ev.setdefault("ci_low", None)
            ev.setdefault("ci_high", None)
            ev.setdefault("ci_level", None)
            if "exploratory" in data:
                data["confirmatory"] = not bool(data.pop("exploratory"))
            data["evidence"] = ev
        return data


class ReportMeta(_Model):
    kind: ReportKind
    title: str
    study_id: str
    stage: str
    wave: str | None = None
    languages: tuple[str, ...] = ()
    pathways: tuple[str, ...] = ()
    site_mode: str | None = None
    data_cutoff: str | None = None
    status: Literal["draft", "internal", "final"] = "draft"
    authors: tuple[str, ...] = ()
    summary: str | None = None


class ProvenanceBlock(_Model):
    """Report-level provenance (footer): every coefficient traces to run -> snapshot manifest -> partitions."""

    analysis_run_id: str
    snapshot_id: str
    snapshot_sha256: str
    generated_at: str | None = None
    git_sha: str | None = None
    image_digest: str | None = None
    prereg_id: str | None = None
    protocol_version: str | None = None
    hypotheses_sha256: str | None = None
    gates_sha256: str | None = None
    dictionary_sha256: dict[str, str] = Field(default_factory=dict)
    validation_algorithm_version: str | None = None
    scoring_run_id: str | None = None
    erasures_applied: int = 0
    seeds: dict[str, int] = Field(default_factory=dict)


class SampleCell(_Model):
    group: dict[str, str]
    n: int
    target: int | None = None


class SampleSummary(_Model):
    enrolled: int
    consented: int
    analysed: int
    withdrawn: int = 0
    cells: tuple[SampleCell, ...] = ()

    @model_validator(mode="after")
    def _monotone(self) -> SampleSummary:
        if not (self.enrolled >= self.consented >= self.analysed >= 0):
            raise ValueError("sample counts must satisfy enrolled >= consented >= analysed >= 0")
        return self


class ExclusionEntry(_Model):
    rule_id: str
    description: str
    n_sessions: int
    n_participants: int | None = None
    by_group: dict[str, dict[str, float]] = Field(default_factory=dict)
    """grouping -> {group value -> exclusion rate (proportion)} for the differential-exclusion table"""


class TargetEntry(_Model):
    metric: Literal["completion", "play_again"]
    group: dict[str, str]
    observed: float | None
    target: float
    n: int


class TraitGateEntry(_Model):
    """``TraitGateDecision`` / ``TraitGateStatus``."""

    trait: str
    language: str
    pathway: str
    status: str
    evaluated_status: str | None = None
    rules: dict[str, str] = Field(default_factory=dict)
    reasons: tuple[str, ...] = ()
    capped: bool = False
    evaluate_only: bool = True


class BatteryGateEntry(_Model):
    language: str
    pathway: str
    site_mode: str
    status: Literal["closed", "open"]
    rules: dict[str, str] = Field(default_factory=dict)
    reasons: tuple[str, ...] = ()
    qualifying_languages: tuple[str, ...] = ()


class IndicatorDecisionEntry(_Model):
    indicator_id: str
    pathway: str
    decision: str
    provisional_flags: tuple[str, ...] = ()
    rationale: str = ""
    evidence_ids: tuple[str, ...] = ()
    signers: tuple[str, ...] = ()


class NormCellEntry(_Model):
    label: str
    n: int
    effective_n: float
    provisional: bool
    percentiles: dict[str, float] = Field(default_factory=dict)


class NormTableEntry(_Model):
    version: str
    trait: str
    language_group: str
    method: str
    weights_scheme: str
    provisional: bool
    cells: tuple[NormCellEntry, ...] = ()


class ReportBundle(_Model):
    schema_: Literal["shriii-report-bundle"] = Field(alias="schema")
    schema_version: Literal["1.0"]
    report: ReportMeta
    provenance: ProvenanceBlock
    sample: SampleSummary
    exclusions: tuple[ExclusionEntry, ...] = ()
    targets: tuple[TargetEntry, ...] = ()
    results: tuple[ResultEntry, ...] = ()
    trait_gates: tuple[TraitGateEntry, ...] = ()
    battery_gates: tuple[BatteryGateEntry, ...] = ()
    indicator_decisions: tuple[IndicatorDecisionEntry, ...] = ()
    norm_tables: tuple[NormTableEntry, ...] = ()
    notes: tuple[str, ...] = ()

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
