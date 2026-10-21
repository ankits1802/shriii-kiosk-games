"""Validation parameters.

Sources: ``data/validation_params.yaml``, ``stats/measurement-model/gates.yaml`` and ``hypotheses.yaml``.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from shriii_scoring.resources import load_package_yaml, load_yaml, scoring_dir

__all__ = ["ValidationParams", "load_gates", "load_hypotheses", "load_validation_params"]


@dataclass(frozen=True, slots=True)
class ValidationParams:
    """Parsed validation parameter document with dotted access."""

    sha256: str
    data: Mapping[str, Any]

    def get(self, dotted: str) -> Any:
        node: Any = self.data
        for part in dotted.split("."):
            if not isinstance(node, Mapping) or part not in node:
                raise KeyError(f"validation parameter {dotted!r} is missing")
            node = node[part]
        return node

    def f(self, dotted: str) -> float:
        return float(self.get(dotted))

    def i(self, dotted: str) -> int:
        return int(self.get(dotted))


def load_validation_params(path: Path | None = None) -> ValidationParams:
    doc = load_yaml(path) if path is not None else load_package_yaml("shriii_validation.data", "validation_params.yaml")
    data = cast(Mapping[str, Any], doc.data)
    if data.get("schema") != "shriii-validation-params":
        raise ValueError(f"{doc.path} is not a shriii-validation-params document")
    return ValidationParams(doc.sha256, data)


def load_gates(path: Path | None = None) -> tuple[Mapping[str, Any], str]:
    """``stats/measurement-model/gates.yaml`` (parsed) and its SHA-256."""
    doc = load_yaml(path or scoring_dir() / "gates.yaml")
    return cast(Mapping[str, Any], doc.data), doc.sha256


def load_hypotheses(path: Path | None = None) -> tuple[Mapping[str, Any], str]:
    """``stats/measurement-model/hypotheses.yaml`` (parsed) and its SHA-256."""
    doc = load_yaml(path or scoring_dir() / "hypotheses.yaml")
    return cast(Mapping[str, Any], doc.data), doc.sha256
