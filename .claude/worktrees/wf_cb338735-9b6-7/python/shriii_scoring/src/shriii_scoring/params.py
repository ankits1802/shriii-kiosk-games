"""Engine parameters (``data/scoring_params.yaml``) with provenance.

The engine reads every threshold from YAML: the dictionary, ``gates.yaml`` and this parameter file.
Callers may pass an alternative parameter file (e.g. a frozen copy referenced by a scoring run).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from shriii_scoring.resources import LoadedYaml, load_package_yaml, load_yaml

__all__ = ["ScoringParams", "load_params"]


@dataclass(frozen=True, slots=True)
class ScoringParams:
    """Parsed parameter document; ``get`` walks dotted paths and fails loudly on missing keys."""

    version: str
    sha256: str
    path: str
    data: Mapping[str, Any]

    def get(self, dotted: str) -> Any:
        node: Any = self.data
        for part in dotted.split("."):
            if not isinstance(node, Mapping) or part not in node:
                raise KeyError(f"scoring parameter {dotted!r} is missing from {self.path}")
            node = node[part]
        return node

    def f(self, dotted: str) -> float:
        return float(self.get(dotted))

    def i(self, dotted: str) -> int:
        return int(self.get(dotted))

    def strs(self, dotted: str) -> tuple[str, ...]:
        return tuple(str(v) for v in cast(list[Any], self.get(dotted)))


def _wrap(doc: LoadedYaml) -> ScoringParams:
    data = cast(Mapping[str, Any], doc.data)
    if data.get("schema") != "shriii-scoring-params":
        raise ValueError(f"{doc.path} is not a shriii-scoring-params document")
    return ScoringParams(version=str(data["version"]), sha256=doc.sha256, path=doc.path, data=data)


def load_params(path: Path | None = None) -> ScoringParams:
    """Load the packaged parameter file, or ``path`` when given."""
    if path is not None:
        return _wrap(load_yaml(path))
    return _wrap(load_package_yaml("shriii_scoring.data", "scoring_params.yaml"))
