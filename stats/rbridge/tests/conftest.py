"""Registers the ``r`` marker. ``@pytest.mark.r`` tests run against the shriiipsy Docker image (or a local
Rscript with shriiipsy) and skip cleanly when neither is available.

Environment: ``SHRIII_R_IMAGE`` (default ``shriii/r-psychometrics:0.1.0``), ``SHRIII_R_RUNNER``
(``docker`` | ``local`` | ``auto``).
"""

from __future__ import annotations

import os
from functools import cache

import pytest
from shriii_rbridge import DEFAULT_IMAGE, DockerRunner, LocalRscriptRunner, RscriptBackend
from shriii_rbridge.runner import docker_available, docker_image_present, local_shriiipsy_available


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "r: needs the shriiipsy R backend (Docker image or local Rscript); skipped when unavailable"
    )


@cache
def _backend_or_reason() -> tuple[RscriptBackend | None, str]:
    mode = os.environ.get("SHRIII_R_RUNNER", "auto").lower()
    image = os.environ.get("SHRIII_R_IMAGE", DEFAULT_IMAGE)
    if mode in ("local", "auto") and local_shriiipsy_available():
        return RscriptBackend(LocalRscriptRunner()), ""
    if mode == "local":
        return None, "SHRIII_R_RUNNER=local but Rscript with shriiipsy is not installed"
    if not docker_available():
        return None, "docker is not available"
    if not docker_image_present(image):
        return None, f"docker image {image} is not built (see infra/docker/r-psychometrics.Dockerfile)"
    return RscriptBackend(DockerRunner(image=image)), ""


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    r_items = [i for i in items if "r" in i.keywords]
    if not r_items:
        return
    backend, reason = _backend_or_reason()
    if backend is None:
        skip = pytest.mark.skip(reason=f"R backend unavailable: {reason}")
        for item in r_items:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def r_backend() -> RscriptBackend:
    backend, reason = _backend_or_reason()
    if backend is None:
        pytest.skip(f"R backend unavailable: {reason}")
    return backend
