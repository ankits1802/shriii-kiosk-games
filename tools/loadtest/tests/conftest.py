"""Fixtures for the load-test harness tests.

Unit tests need no services. ``api_app`` runs the real API in-process (ASGI) against PostgreSQL, using
its own ``shriii_loadtest_it`` databases on the first reachable server: ``LOADTEST_TEST_DATABASE_URL``,
the load-test compose DB (localhost:55442), then the developer DB ports 5432/55432. Without a server
those tests are skipped, unless ``SHRIII_REQUIRE_DB=1``.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest
from shriii_loadtest.batches import KioskIdentity
from shriii_loadtest.corpus import Corpus, load_or_build_corpus

IT_DB = "shriii_loadtest_it"
IT_IDENTITY_DB = "shriii_loadtest_it_identity"


@pytest.fixture(scope="session")
def corpus(tmp_path_factory: pytest.TempPathFactory) -> Corpus:
    return load_or_build_corpus(sessions_b=2, sessions_a=1, seed=99, cache_dir=tmp_path_factory.mktemp("corpus"))


@pytest.fixture(scope="session")
def corpus_events(corpus: Corpus) -> list[dict[str, Any]]:
    return corpus.sessions[0].events


@pytest.fixture
def kiosks() -> list[KioskIdentity]:
    return [KioskIdentity(kiosk_id=f"lt-{i:04d}", site_id="site-load-01", token=f"kdt_test_{i}") for i in range(1, 61)]


def _candidates() -> list[str]:
    urls = [os.environ["LOADTEST_TEST_DATABASE_URL"]] if os.environ.get("LOADTEST_TEST_DATABASE_URL") else []
    return [
        *urls,
        "postgresql://load:load@localhost:55442/postgres",
        "postgresql://dev:dev@localhost:5432/postgres",
        "postgresql://dev:dev@localhost:55432/postgres",
    ]


def _server() -> str | None:
    for url in _candidates():
        try:
            with psycopg.connect(url, connect_timeout=3):
                return url
        except psycopg.Error:
            continue
    return None


def _recreate(admin_url: str, name: str) -> str:
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{name}"')
    base = admin_url.rsplit("/", 1)[0]
    return f"{base.replace('postgresql://', 'postgresql+psycopg://', 1)}/{name}"


@pytest.fixture(scope="module")
def api_app(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Any]:
    admin_url = _server()
    if admin_url is None:
        msg = "PostgreSQL not reachable for the load-harness integration test (tried " + ", ".join(_candidates()) + ")"
        if os.environ.get("SHRIII_REQUIRE_DB") == "1":
            pytest.fail(msg)
        pytest.skip(msg)
    research = _recreate(admin_url, IT_DB)
    identity = _recreate(admin_url, IT_IDENTITY_DB)
    env = {
        "ENV": "test",
        "DATABASE_URL": research,
        "IDENTITY_DATABASE_URL": identity,
        "AUTH_MODE": "dev",
        "DEV_JWT_SECRET": "loadtest-integration-secret-0123456789abcdef",
        "DATA_DIR": str(Path(tmp_path_factory.mktemp("data"))),
        "LOG_JSON": "false",
        "LOG_LEVEL": "WARNING",
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    from shriii_api.cli import migrate  # noqa: PLC0415
    from shriii_api.db.session import dispose_engines  # noqa: PLC0415
    from shriii_api.main import create_app  # noqa: PLC0415
    from shriii_api.settings import get_settings  # noqa: PLC0415

    get_settings.cache_clear()
    dispose_engines()
    migrate(get_settings())
    try:
        yield create_app(), research
    finally:
        dispose_engines()
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        get_settings.cache_clear()
