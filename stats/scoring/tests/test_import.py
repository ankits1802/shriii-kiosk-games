"""Smoke test: the workspace member is importable from the shared uv environment."""

import shriii_scoring


def test_package_importable() -> None:
    assert shriii_scoring.__version__ == "0.1.0"
