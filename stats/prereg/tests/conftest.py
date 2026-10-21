"""Fixtures: a temporary repository copy of the (read-only) scoring inputs and the generator config."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from shriii_prereg.inputs import find_repo_root


@pytest.fixture(scope="session")
def real_root() -> Path:
    return find_repo_root(Path(__file__))


@pytest.fixture
def repo_copy(tmp_path: Path, real_root: Path) -> Path:
    """A writable copy of stats/measurement-model/ and stats/prereg/prereg.config.yaml.

    The real files are never modified.
    """
    root = tmp_path / "repo"
    shutil.copytree(
        real_root / "stats" / "measurement-model",
        root / "stats" / "measurement-model",
        ignore=shutil.ignore_patterns("tests", "__pycache__"),
    )
    (root / "stats" / "prereg").mkdir(parents=True)
    shutil.copy2(
        real_root / "stats" / "prereg" / "prereg.config.yaml",
        root / "stats" / "prereg" / "prereg.config.yaml",
    )
    return root
