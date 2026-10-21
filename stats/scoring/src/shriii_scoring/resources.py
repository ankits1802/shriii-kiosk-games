"""Locate and load versioned YAML resources with content hashes.

Hashes are SHA-256 over the file bytes with line endings normalised to LF, so the same committed file
hashes identically on Windows and Linux checkouts (the repository enforces ``eol=lf``).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from functools import cache
from importlib import resources as importlib_resources
from pathlib import Path
from typing import Any

import yaml
from shriii_contracts.paths import content_dir, scoring_dir

__all__ = [
    "LoadedYaml",
    "content_dir",
    "load_package_yaml",
    "load_yaml",
    "scoring_dir",
    "sha256_bytes",
    "sha256_file",
]


def sha256_bytes(data: bytes) -> str:
    """Lower-case hex SHA-256 of ``data`` with CRLF normalised to LF."""
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()


def sha256_file(path: Path) -> str:
    """Line-ending-normalised SHA-256 of a file."""
    return sha256_bytes(path.read_bytes())


@dataclass(frozen=True, slots=True)
class LoadedYaml:
    """A parsed YAML document plus its provenance."""

    path: str
    sha256: str
    data: Any


@cache
def load_yaml(path: Path) -> LoadedYaml:
    """Parse a YAML file (cached by path) and record its hash."""
    raw = path.read_bytes()
    return LoadedYaml(path=str(path), sha256=sha256_bytes(raw), data=yaml.safe_load(raw.decode("utf-8")))


@cache
def load_package_yaml(package: str, name: str) -> LoadedYaml:
    """Load a YAML resource shipped inside a Python package (e.g. engine parameter files)."""
    ref = importlib_resources.files(package).joinpath(name)
    raw = ref.read_bytes()
    return LoadedYaml(path=f"{package}:{name}", sha256=sha256_bytes(raw), data=yaml.safe_load(raw.decode("utf-8")))
