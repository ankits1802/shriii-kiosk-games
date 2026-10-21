"""Locate repository resources relative to this tool (monorepo layout)."""

from __future__ import annotations

from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parents[2]
"""``tools/audio-pipeline``."""


def repo_root() -> Path:
    """The monorepo root (the directory that holds ``packages/contracts``)."""
    for candidate in [TOOL_ROOT, *TOOL_ROOT.parents]:
        if (candidate / "packages" / "contracts" / "schemas").is_dir():
            return candidate
    raise FileNotFoundError("could not locate the monorepo root (packages/contracts/schemas)")


def default_catalogue() -> Path:
    return repo_root() / "content" / "i18n" / "lines.yaml"


def schemas_dir() -> Path:
    return repo_root() / "packages" / "contracts" / "schemas"


def default_qc_config() -> Path:
    return TOOL_ROOT / "config" / "qc.yaml"


def default_direction_config() -> Path:
    return TOOL_ROOT / "config" / "direction.yaml"


def default_out_dir() -> Path:
    return TOOL_ROOT / "out"
