"""Typed, hashed view of the scoring dictionary (SCR-01): ``shared.yaml`` plus ``dictionary.{A,B}.yaml``.

The YAML files are the single source of truth. This module only *reads* them; it never changes a
threshold. Each :class:`Dictionary` records the SHA-256 of every file it was built from, so every
indicator row can cite the exact dictionary bytes it was computed under.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from shriii_scoring.resources import LoadedYaml, load_yaml, scoring_dir

Pathway = Literal["A", "B"]
IndicatorKind = Literal[
    "raw", "difference_slope", "model_parameter", "group_only", "single_event_unscorable", "composite"
]

__all__ = [
    "Dictionary",
    "ExclusionCondition",
    "ExclusionRule",
    "IndicatorKind",
    "IndicatorSpec",
    "ModuleSpec",
    "Pathway",
    "load_dictionary",
]


@dataclass(frozen=True, slots=True)
class ExclusionCondition:
    """One ``when`` clause of an exclusion rule (``field op value``)."""

    field: str
    op: str
    value: Any


@dataclass(frozen=True, slots=True)
class ExclusionRule:
    """A shared exclusion rule; ``applies_to`` is event, trial, session or indicator."""

    id: str
    applies_to: str
    description: str
    when: tuple[ExclusionCondition, ...]


@dataclass(frozen=True, slots=True)
class ModuleSpec:
    """A module/episode entry of a pathway dictionary."""

    id: str
    kind: str
    config: str | None
    slot: bool
    order: int


@dataclass(frozen=True, slots=True)
class IndicatorSpec:
    """One indicator definition (all fields read verbatim from the pathway dictionary)."""

    id: str
    construct: str
    role: str
    tier: int
    status: str
    kind: str
    module_id: str
    episode_id: str | None
    task: str
    phases: tuple[str, ...]
    slot: bool
    event_inputs: tuple[str, ...]
    formula_ref: str
    formula_description: str
    unit: str
    direction: str
    transformation: str
    aggregation: str
    reliability_method: str
    level_rule: str
    min_valid_count: int
    min_valid_unit: str
    min_valid_basis: str
    exclusions: tuple[str, ...]
    missing_data: str
    group_only: bool
    gate_eligible: bool
    timing_sensitive: bool
    sensitivity: str
    expected_r_lower_bound: float | None
    convergent_criteria: tuple[str, ...]
    notes: str | None

    @property
    def sign(self) -> int:
        """+1 when higher values mean more of the construct, -1 otherwise."""
        return 1 if self.direction == "higher_more" else -1


@dataclass(frozen=True, slots=True)
class Dictionary:
    """Shared competency model plus one pathway's indicators, with provenance."""

    pathway: Pathway
    version: str
    shared_version: str
    status: str
    frozen: bool
    sha256: str
    shared_sha256: str
    path: str
    shared_path: str
    constructs: Mapping[str, Mapping[str, Any]]
    exclusion_rules: Mapping[str, ExclusionRule]
    missing_data_policies: Mapping[str, Mapping[str, Any]]
    transformations: frozenset[str]
    modules: Mapping[str, ModuleSpec]
    indicators: Mapping[str, IndicatorSpec]
    raw_pathway: Mapping[str, Any] = field(repr=False)

    def indicators_for_construct(self, construct: str) -> list[IndicatorSpec]:
        """Indicators of one construct in this pathway, in dictionary order."""
        return [i for i in self.indicators.values() if i.construct == construct]

    def construct_status(self, construct: str) -> str:
        """Pathway status of a construct (scored, withheld, group_only, ...)."""
        return str(self.constructs[construct]["pathways"][self.pathway]["status"])

    @property
    def exploratory(self) -> bool:
        """Scoring under an unfrozen dictionary is exploratory and labelled as such (SCR-01)."""
        return not self.frozen


def _tuple(values: Sequence[Any] | None) -> tuple[Any, ...]:
    return tuple(values) if values else ()


def _parse_indicator(raw: Mapping[str, Any]) -> IndicatorSpec:
    src = raw["source"]
    mvt = raw["min_valid_trials"]
    return IndicatorSpec(
        id=str(raw["id"]),
        construct=str(raw["construct"]),
        role=str(raw["role"]),
        tier=int(raw["tier"]),
        status=str(raw["status"]),
        kind=str(raw["kind"]),
        module_id=str(src["module_id"]),
        episode_id=src.get("episode_id"),
        task=str(src["task"]),
        phases=_tuple(src.get("phases")),
        slot=bool(src.get("slot", False)),
        event_inputs=_tuple(raw.get("event_inputs")),
        formula_ref=str(raw["formula"]["ref"]),
        formula_description=str(raw["formula"].get("description") or ""),
        unit=str(raw["unit"]),
        direction=str(raw["direction"]),
        transformation=str(raw["transformation"]),
        aggregation=str(raw["aggregation"]),
        reliability_method=str(raw["reliability_method"]),
        level_rule=str(raw["level_rule"]),
        min_valid_count=int(mvt["count"]),
        min_valid_unit=str(mvt["unit"]),
        min_valid_basis=str(mvt.get("basis", "")),
        exclusions=_tuple(raw.get("exclusions")),
        missing_data=str(raw["missing_data"]),
        group_only=bool(raw["group_only"]),
        gate_eligible=bool(raw["gate_eligible"]),
        timing_sensitive=bool(raw["timing_sensitive"]),
        sensitivity=str(raw["sensitivity"]),
        expected_r_lower_bound=raw.get("expected_r_lower_bound"),
        convergent_criteria=_tuple(raw.get("convergent_criteria")),
        notes=raw.get("notes"),
    )


def _build(pathway: Pathway, shared: LoadedYaml, pw: LoadedYaml) -> Dictionary:
    s = shared.data
    p = pw.data
    if p.get("pathway") != pathway:
        raise ValueError(f"{pw.path} declares pathway {p.get('pathway')!r}, expected {pathway!r}")
    if p.get("shared_version") != s.get("version"):
        raise ValueError(
            f"{pw.path} was written against shared version {p.get('shared_version')!r}, "
            f"shared.yaml is {s.get('version')!r}"
        )
    rules = {
        r["id"]: ExclusionRule(
            id=r["id"],
            applies_to=r["applies_to"],
            description=r.get("description", ""),
            when=tuple(ExclusionCondition(c["field"], c["op"], c.get("value")) for c in r["when"]),
        )
        for r in s["exclusion_rules"]
    }
    indicators: dict[str, IndicatorSpec] = {}
    for raw in p["indicators"]:
        spec = _parse_indicator(raw)
        if spec.id in indicators:
            raise ValueError(f"duplicate indicator id {spec.id} in {pw.path}")
        unknown = [e for e in spec.exclusions if e not in rules]
        if unknown:
            raise ValueError(f"{spec.id}: unknown exclusion rule(s) {unknown}")
        indicators[spec.id] = spec
    modules = {
        m["id"]: ModuleSpec(
            id=m["id"], kind=m["kind"], config=m.get("config"), slot=bool(m.get("slot")), order=int(m["order"])
        )
        for m in p["modules"]
    }
    frozen = p.get("frozen_at") is not None and p.get("sha256") is not None and s.get("frozen_at") is not None
    return Dictionary(
        pathway=pathway,
        version=str(p["version"]),
        shared_version=str(s["version"]),
        status=str(p["status"]),
        frozen=bool(frozen),
        sha256=pw.sha256,
        shared_sha256=shared.sha256,
        path=pw.path,
        shared_path=shared.path,
        constructs={c["id"]: c for c in s["constructs"]},
        exclusion_rules=rules,
        missing_data_policies={m["id"]: m for m in s["missing_data_policies"]},
        transformations=frozenset(t["id"] for t in s["transformations"]),
        modules=modules,
        indicators=indicators,
        raw_pathway=p,
    )


def load_dictionary(pathway: Pathway, directory: Path | None = None) -> Dictionary:
    """Load ``shared.yaml`` and ``dictionary.<pathway>.yaml`` from ``directory``.

    The default directory is ``stats/measurement-model/dictionary``.
    """
    base = directory if directory is not None else scoring_dir() / "dictionary"
    return _build(pathway, load_yaml(base / "shared.yaml"), load_yaml(base / f"dictionary.{pathway}.yaml"))
