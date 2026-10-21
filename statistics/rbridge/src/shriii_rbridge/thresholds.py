"""Science thresholds sent to R: the single source of truth stays in YAML on the Python side.

``scoring/gates.yaml`` (frozen gate rules) and ``shriii_validation/data/validation_params.yaml`` (analysis
conventions) are mapped onto the shriiipsy ``thresholds`` schema and sent with every request, so R never
uses a threshold that disagrees with the gate evaluator. Keys absent here fall back to the R package's own
``inst/config/thresholds.yaml`` defaults (which mirror the same files).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from shriii_validation.params import ValidationParams, load_gates, load_validation_params

__all__ = ["ThresholdSet", "project_thresholds"]


@dataclass(frozen=True, slots=True)
class ThresholdSet:
    """Threshold overrides for shriiipsy plus the hashes of the documents they came from."""

    overrides: Mapping[str, Any]
    sources: Mapping[str, str] = field(default_factory=dict)


def _get(doc: Mapping[str, Any], dotted: str) -> Any:
    node: Any = doc
    for part in dotted.split("."):
        if not isinstance(node, Mapping) or part not in node:
            return None
        node = node[part]
    return node


def _put(out: dict[str, dict[str, Any]], section: str, key: str, value: Any) -> None:
    if value is not None:
        out.setdefault(section, {})[key] = value


def project_thresholds(
    params: ValidationParams | None = None, gates: Mapping[str, Any] | None = None, gates_sha256: str | None = None
) -> ThresholdSet:
    """Map validation_params.yaml + gates.yaml onto shriiipsy threshold overrides."""
    prm = params or load_validation_params()
    sources: dict[str, str] = {"validation_params_sha256": prm.sha256}
    if gates is None:
        try:
            gates, gates_sha256 = load_gates()
        except (FileNotFoundError, OSError):
            gates = {}
    if gates_sha256:
        sources["gates_sha256"] = gates_sha256
    p = prm.data
    out: dict[str, dict[str, Any]] = {}
    for key in ("delta_cfi_max_drop", "delta_rmsea_max_increase", "delta_srmr_metric_max", "delta_srmr_scalar_max"):
        _put(out, "invariance", key, _get(p, f"invariance.{key}"))
    _put(out, "invariance", "max_freed_parameter_share", _get(gates, "trait_gate.invariance.max_freed_parameter_share"))
    _put(out, "invariance", "small_group_n", _get(gates, "trait_gate.invariance.small_group_n"))
    _put(out, "dif", "fdr_alpha", _get(p, "dif.fdr_alpha"))
    _put(out, "dif", "purification_max_iter", _get(p, "dif.purification_max_iter"))
    for key in ("weight_trim_ratio", "provisional_effective_n", "percentiles"):
        _put(out, "norming", key, _get(p, f"norming.{key}"))
    _put(out, "slopes", "reliability_min", _get(gates, "trait_gate.reliability.point_min"))
    _put(out, "slopes", "ci_level", _get(gates, "trait_gate.reliability.ci_level"))
    _put(out, "icc", "ci_level", _get(gates, "trait_gate.retest.ci_level"))
    return ThresholdSet(out, sources)
