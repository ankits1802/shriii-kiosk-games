"""Test configuration: registers the ``slow`` marker; slow tests run only with SHRIII_RUN_SLOW=1 or ``-m slow``."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

# Hypothesis keeps its example database in the repo-wide, gitignored .cache/ instead of a root .hypothesis/.
# Hypothesis reads this lazily on first use, so setting it before any test runs is enough; an explicit env var wins.
os.environ.setdefault(
    "HYPOTHESIS_STORAGE_DIRECTORY", str(Path(__file__).resolve().parents[3] / ".cache" / "hypothesis")
)


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "slow: heavy statistical / recovery test (set SHRIII_RUN_SLOW=1 or use -m slow)")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("SHRIII_RUN_SLOW") == "1" or "slow" in (config.getoption("-m") or ""):
        return
    skip = pytest.mark.skip(reason="slow test: set SHRIII_RUN_SLOW=1 or run with -m slow")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip)
