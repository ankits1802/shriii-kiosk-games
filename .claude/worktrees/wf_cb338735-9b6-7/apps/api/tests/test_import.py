"""Smoke test: the workspace member is importable from the shared uv environment."""

import shriii_api


def test_package_importable() -> None:
    assert shriii_api.__version__ == "0.1.0"
