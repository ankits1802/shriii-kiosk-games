"""Test configuration: registers the ``slow`` marker; slow tests run only with SHRIII_RUN_SLOW=1 or ``-m slow``."""

from __future__ import annotations

import os

import pytest


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "slow: heavy statistical / recovery test (set SHRIII_RUN_SLOW=1 or use -m slow)")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("SHRIII_RUN_SLOW") == "1" or "slow" in (config.getoption("-m") or ""):
        return
    skip = pytest.mark.skip(reason="slow test: set SHRIII_RUN_SLOW=1 or run with -m slow")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip)
