"""Simulator parameter document (``data/simulator.yaml``) with dotted-path access and overrides."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from shriii_scoring.resources import load_package_yaml, load_yaml

__all__ = ["SimParams", "load_sim_params"]


@dataclass(frozen=True, slots=True)
class SimParams:
    """Generative-model parameters; ``overrides`` (dotted path -> value) take precedence."""

    sha256: str
    data: Mapping[str, Any]
    overrides: Mapping[str, Any] = field(default_factory=dict)

    def get(self, dotted: str) -> Any:
        if dotted in self.overrides:
            return self.overrides[dotted]
        node: Any = self.data
        for part in dotted.split("."):
            if not isinstance(node, Mapping) or part not in node:
                raise KeyError(f"simulator parameter {dotted!r} is missing")
            node = node[part]
        return node

    def f(self, dotted: str) -> float:
        return float(self.get(dotted))

    def with_overrides(self, overrides: Mapping[str, Any]) -> SimParams:
        merged = dict(self.overrides)
        merged.update(overrides)
        return SimParams(self.sha256, self.data, merged)


def load_sim_params(path: Path | None = None) -> SimParams:
    """Load the packaged simulator parameters (or ``path``)."""
    doc = load_yaml(path) if path is not None else load_package_yaml("shriii_simulator.data", "simulator.yaml")
    data = cast(Mapping[str, Any], doc.data)
    if data.get("schema") != "shriii-simulator-params":
        raise ValueError(f"{doc.path} is not a shriii-simulator-params document")
    return SimParams(sha256=doc.sha256, data=data)
