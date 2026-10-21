"""API test fixtures: a real PostgreSQL 18 (docker compose), migrated once per session.

Connection candidates (first reachable wins): ``SHRIII_TEST_DATABASE_URL``, ``DATABASE_URL`` with the
database swapped, then localhost:5432 and localhost:55432 (dev/dev). Tests create their own databases
``shriii_api_test`` and ``shriii_api_test_identity`` (the identity vault uses its own connection). If
no server is reachable the API tests are skipped with an explicit reason, unless
``SHRIII_REQUIRE_DB=1`` makes that a failure. SQLite is never used.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Iterator
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.engine import make_url

TEST_DB = "shriii_api_test"
TEST_IDENTITY_DB = "shriii_api_test_identity"


def _candidates() -> list[str]:
    urls: list[str] = []
    if os.environ.get("SHRIII_TEST_DATABASE_URL"):
        urls.append(os.environ["SHRIII_TEST_DATABASE_URL"])
    if os.environ.get("DATABASE_URL"):
        urls.append(os.environ["DATABASE_URL"])
    urls += [
        "postgresql+psycopg://dev:dev@localhost:5432/shriii",
        "postgresql+psycopg://dev:dev@localhost:55432/shriii",
    ]
    return urls


def _admin_dsn(url: str) -> str:
    u = make_url(url)
    return f"host={u.host} port={u.port or 5432} user={u.username} password={u.password} dbname=postgres"


def _find_server() -> str | None:
    for url in _candidates():
        try:
            with psycopg.connect(_admin_dsn(url), connect_timeout=3):
                return url
        except psycopg.Error:
            continue
    return None


def _recreate(url: str, name: str) -> str:
    with psycopg.connect(_admin_dsn(url), autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{name}"')
    return make_url(url).set(database=name).render_as_string(hide_password=False)


@pytest.fixture(scope="session")
def database_urls(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[str, str]]:
    base = _find_server()
    if base is None:
        msg = "PostgreSQL not reachable (tried " + ", ".join(_candidates()) + "); run `docker compose up -d postgres`"
        if os.environ.get("SHRIII_REQUIRE_DB") == "1":
            pytest.fail(msg)
        pytest.skip(msg)
    research = _recreate(base, TEST_DB)
    identity = _recreate(base, TEST_IDENTITY_DB)
    data_dir = tmp_path_factory.mktemp("data")
    env = {
        "ENV": "test",
        "DATABASE_URL": research,
        "IDENTITY_DATABASE_URL": identity,
        "AUTH_MODE": "dev",
        "DEV_JWT_SECRET": "test-secret-for-api-tests-0123456789abcdef",
        "DATA_DIR": str(data_dir),
        "LOG_JSON": "false",
        "LOG_LEVEL": "WARNING",
        "JOB_BACKOFF_BASE_S": "0.01",
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    from shriii_api.cli import migrate  # noqa: PLC0415
    from shriii_api.db.session import dispose_engines  # noqa: PLC0415
    from shriii_api.settings import get_settings  # noqa: PLC0415

    get_settings.cache_clear()
    dispose_engines()
    migrate(get_settings())
    yield research, identity
    dispose_engines()
    for k, v in old.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    get_settings.cache_clear()


def _truncate_all() -> None:
    from shriii_api.db.session import get_engine, get_identity_engine  # noqa: PLC0415

    with get_engine().begin() as conn:
        conn.execute(text("SELECT set_config('shriii.mutation_purpose', 'retention', true)"))
        tables = (
            conn.execute(
                text(
                    "SELECT format('%I.%I', schemaname, tablename) FROM pg_tables "
                    "WHERE schemaname IN ('kiosk_raw','scored','criterion','linkage','consent','study','games',"
                    "'validation','reporting','governance','ops') AND tablename NOT LIKE 'events_p%'"
                )
            )
            .scalars()
            .all()
        )
        conn.execute(text(f"TRUNCATE {', '.join(tables)} RESTART IDENTITY CASCADE"))
    with get_identity_engine().begin() as conn:
        conn.execute(text("TRUNCATE identity_vault.contacts, identity_vault.relink_audit RESTART IDENTITY"))


@pytest.fixture
def db_ready(database_urls: tuple[str, str]) -> None:
    _truncate_all()
    from shriii_api.content import clear_caches  # noqa: PLC0415

    clear_caches()


@pytest.fixture
def settings(db_ready: None) -> Any:
    from shriii_api.settings import get_settings  # noqa: PLC0415

    return get_settings()


@pytest.fixture
def client(db_ready: None) -> Iterator[TestClient]:
    from shriii_api.main import create_app  # noqa: PLC0415

    with TestClient(create_app()) as c:
        yield c


AuthFactory = Callable[..., dict[str, str]]


@pytest.fixture
def auth(client: TestClient) -> AuthFactory:
    def make(*roles: str, sub: str | None = None, studies: list[str] | None = None) -> dict[str, str]:
        body: dict[str, Any] = {"sub": sub or f"user-{'-'.join(roles)}", "roles": list(roles)}
        if studies is not None:
            body["studies"] = studies
        r = client.post("/api/v1/auth/dev-login", json=body)
        assert r.status_code == 200, r.text
        return {"Authorization": f"Bearer {r.json()['access_token']}"}

    return make


@pytest.fixture
def admin(auth: AuthFactory) -> dict[str, str]:
    return auth("admin", sub="admin-1")


@pytest.fixture
def researcher(auth: AuthFactory) -> dict[str, str]:
    return auth("researcher", sub="researcher-1")


@pytest.fixture
def kiosk(client: TestClient, admin: dict[str, str]) -> dict[str, Any]:
    r = client.post("/api/v1/admin/kiosks", json={"kiosk_id": "kiosk-001", "site_id": "site-pune-01"}, headers=admin)
    assert r.status_code == 201, r.text
    body = r.json()
    return {
        "headers": {"Authorization": f"Bearer {body['device_token']}"},
        "kiosk_id": "kiosk-001",
        "public_key": body["backend_x25519_public_key"],
    }


def drain_jobs() -> int:
    from shriii_api.worker.runner import drain  # noqa: PLC0415

    return drain()


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """``slow`` tests (registered in the root pyproject) run only with SHRIII_RUN_SLOW=1 or ``-m slow``."""
    if os.environ.get("SHRIII_RUN_SLOW") == "1" or "slow" in (config.getoption("-m") or ""):
        return
    skip = pytest.mark.skip(reason="slow test: set SHRIII_RUN_SLOW=1 or run with -m slow")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip)
