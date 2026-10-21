"""Read-only loaders for the versioned content and scoring files in the repository.

Scientific thresholds (gates, hypotheses, dictionary) are always read from these YAML files; the API
never hard-codes them. Every loader returns the parsed document plus its SHA-256 for lineage.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from shriii_contracts.paths import content_dir, repo_root, scoring_dir

from shriii_api.canonical import sha256_hex


@dataclass(frozen=True, slots=True)
class Document:
    path: Path
    data: dict[str, Any]
    sha256: str

    @property
    def relpath(self) -> str:
        try:
            return self.path.relative_to(repo_root()).as_posix()
        except ValueError:
            return self.path.as_posix()


def _load(path: Path) -> Document:
    raw = path.read_bytes()
    text = raw.decode("utf-8")
    data = json.loads(text) if path.suffix == ".json" else yaml.safe_load(text)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a mapping")
    return Document(path=path, data=data, sha256=sha256_hex(raw))


def load_document(path: Path) -> Document:
    return _load(path)


@lru_cache(maxsize=1)
def gates() -> Document:
    return _load(scoring_dir() / "gates.yaml")


@lru_cache(maxsize=1)
def hypotheses() -> Document:
    return _load(scoring_dir() / "hypotheses.yaml")


@lru_cache(maxsize=1)
def dictionary_shared() -> Document:
    return _load(scoring_dir() / "dictionary" / "shared.yaml")


@lru_cache(maxsize=2)
def dictionary_pathway(pathway: str) -> Document:
    if pathway not in ("A", "B"):
        raise ValueError("pathway must be A or B")
    return _load(scoring_dir() / "dictionary" / f"dictionary.{pathway}.yaml")


def instrument_documents() -> list[Document]:
    return [_load(p) for p in sorted((content_dir() / "instruments").glob("*.yaml"))]


def game_documents() -> list[Document]:
    root = content_dir() / "games"
    return [_load(p) for p in sorted(root.glob("*/*.json"))]


def session_plan() -> Document:
    return _load(content_dir() / "games" / "session-plan.json")


def clear_caches() -> None:
    gates.cache_clear()
    hypotheses.cache_clear()
    dictionary_shared.cache_clear()
    dictionary_pathway.cache_clear()
