"""Locate repository resources (canonical schemas, fixtures, scoring and content files).

The canonical JSON Schemas live in ``contracts/schemas``. In the monorepo they are found by
walking up from this file; deployments can point ``SHRIII_REPO_ROOT`` (repository root) or
``SHRIII_SCHEMAS_DIR`` (schema directory) at a copy.
"""

from __future__ import annotations

import os
from functools import cache
from pathlib import Path


@cache
def repo_root() -> Path:
    """Repository root (directory containing ``contracts/schemas``)."""
    env = os.environ.get("SHRIII_REPO_ROOT")
    if env:
        return Path(env).resolve()
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "contracts" / "schemas").is_dir():
            return parent
    raise FileNotFoundError("cannot locate the SHRIII repository root; set SHRIII_REPO_ROOT")


def schemas_dir() -> Path:
    """Directory holding the canonical ``*.v1.schema.json`` files."""
    env = os.environ.get("SHRIII_SCHEMAS_DIR")
    if env:
        return Path(env).resolve()
    return repo_root() / "contracts" / "schemas"


def fixtures_dir() -> Path:
    """Shared contract fixtures (used by both TypeScript and Python tests)."""
    return repo_root() / "contracts" / "fixtures"


def scoring_dir() -> Path:
    """``stats/measurement-model/`` (dictionary, hypotheses, gates)."""
    return repo_root() / "stats" / "measurement-model"


def content_dir() -> Path:
    """``content/`` (instruments, i18n line catalogue, game configs)."""
    return repo_root() / "content"
