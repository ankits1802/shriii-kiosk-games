"""Content configs (``content/games/**/*.json``) and instruments (``content/instruments/*.yaml``)."""

from __future__ import annotations

import json
from collections.abc import Mapping
from functools import cache
from pathlib import Path
from typing import Any

from shriii_scoring.resources import content_dir as _content_dir
from shriii_scoring.resources import load_yaml

__all__ = ["block_phases", "load_game_configs", "load_instruments"]


@cache
def _game_configs(base: Path) -> Mapping[str, Mapping[str, Any]]:
    out: dict[str, Mapping[str, Any]] = {}
    for f in sorted((base / "games").glob("*/*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        if "module_id" in data:
            out[str(data["module_id"])] = data
    return out


def load_game_configs(directory: Path | None = None) -> Mapping[str, Mapping[str, Any]]:
    """module_id -> parsed game config."""
    return _game_configs(directory if directory is not None else _content_dir())


def block_phases(configs: Mapping[str, Mapping[str, Any]]) -> dict[tuple[str, str], str]:
    """(module_id, block_id) -> phase, from the content configs."""
    return {(m, str(b["block_id"])): str(b["phase"]) for m, c in configs.items() for b in c.get("blocks", [])}


def load_instruments(directory: Path | None = None) -> dict[str, tuple[Mapping[str, Any], str]]:
    """instrument_id -> (parsed instrument YAML, file SHA-256)."""
    base = (directory if directory is not None else _content_dir()) / "instruments"
    out: dict[str, tuple[Mapping[str, Any], str]] = {}
    for f in sorted(base.glob("*.yaml")):
        doc = load_yaml(f)
        out[str(doc.data["instrument_id"])] = (doc.data, doc.sha256)
    return out
