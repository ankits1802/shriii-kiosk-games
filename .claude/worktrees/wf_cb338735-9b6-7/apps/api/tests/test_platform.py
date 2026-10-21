"""Platform checks: OpenAPI drift, migrations up/down/up, health/readiness, retention, CORS, admin smoke."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text

from shriii_api.db.session import get_engine
from shriii_api.testing import make_batch, session_events

API_ROOT = Path(__file__).resolve().parents[1]


def test_openapi_is_committed_and_current() -> None:
    from shriii_api.main import create_app  # noqa: PLC0415

    generated = create_app().openapi()
    committed = json.loads((API_ROOT / "openapi.json").read_text(encoding="utf-8"))
    assert committed == json.loads(json.dumps(generated)), "run `uv run shriii-api export-openapi`"
    assert generated["openapi"].startswith("3.1")
    paths = generated["paths"]
    for group in (
        "/api/v1/sessions",
        "/api/v1/events/batch",
        "/api/v1/games",
        "/api/v1/participants",
        "/api/v1/instruments",
        "/api/v1/assessment-responses",
        "/api/v1/features",
        "/api/v1/validation/datasets",
        "/api/v1/validation/runs",
        "/api/v1/models",
        "/api/v1/norms/tables",
        "/api/v1/reports",
        "/api/v1/admin/kiosks",
        "/api/v1/studies",
    ):
        assert group in paths, group
    body = paths["/api/v1/events/batch"]["post"]["requestBody"]["content"]["application/json"]["schema"]
    assert body == {"$ref": "#/components/schemas/UploadBatch"}
    assert "UploadBatch" in generated["components"]["schemas"]


def test_migrations_downgrade_and_upgrade(database_urls: tuple[str, str]) -> None:
    from sqlalchemy.engine import make_url  # noqa: PLC0415

    from shriii_api.cli import alembic_config  # noqa: PLC0415

    base = make_url(database_urls[0])
    scratch = base.set(database="shriii_api_migration_check").render_as_string(hide_password=False)
    admin_dsn = f"host={base.host} port={base.port} user={base.username} password={base.password} dbname=postgres"
    with psycopg.connect(admin_dsn, autocommit=True) as conn:
        conn.execute('DROP DATABASE IF EXISTS "shriii_api_migration_check" WITH (FORCE)')
        conn.execute('CREATE DATABASE "shriii_api_migration_check"')
    cfg = alembic_config(scratch)
    command.upgrade(cfg, "head")
    engine = create_engine(scratch)
    try:
        insp = inspect(engine)
        for schema in (
            "kiosk_raw",
            "scored",
            "criterion",
            "linkage",
            "consent",
            "study",
            "games",
            "validation",
            "reporting",
            "governance",
            "ops",
        ):
            assert insp.get_table_names(schema=schema), schema
        with engine.connect() as conn:
            kind = conn.execute(text("SELECT relkind FROM pg_class WHERE oid = 'kiosk_raw.events'::regclass")).scalar()
            assert kind == "p"  # partitioned
            triggers = set(conn.execute(text("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal")).scalars())
            assert {
                "trg_events_append_only",
                "trg_responses_append_only",
                "trg_artefacts_append_only",
                "trg_audit_events_append_only",
            } <= triggers
        command.downgrade(cfg, "base")
        with engine.connect() as conn:
            assert conn.execute(text("SELECT to_regclass('kiosk_raw.events')")).scalar() is None
        command.upgrade(cfg, "head")
    finally:
        engine.dispose()
        with psycopg.connect(admin_dsn, autocommit=True) as conn:
            conn.execute('DROP DATABASE IF EXISTS "shriii_api_migration_check" WITH (FORCE)')


def test_health_and_readiness(client: TestClient) -> None:
    assert client.get("/healthz").json()["status"] == "ok"
    ready = client.get("/readyz")
    assert ready.status_code == 200, ready.text
    assert ready.json()["checks"]["database"] == "ok" and ready.json()["checks"]["identity_database"] == "ok"
    assert ready.json()["checks"]["migration"] == "0003"


def test_cors_allows_web_and_kiosk_origins(client: TestClient) -> None:
    for origin in ("http://localhost:3000", "http://localhost:5173"):
        r = client.options("/api/v1/games", headers={"Origin": origin, "Access-Control-Request-Method": "GET"})
        assert r.headers.get("access-control-allow-origin") == origin
    r = client.options(
        "/api/v1/games", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"}
    )
    assert "access-control-allow-origin" not in r.headers


def test_retention_purges_expired_parking_and_respects_holds(
    client: TestClient, kiosk: dict[str, Any], admin: dict[str, str]
) -> None:
    events = session_events()
    without_consent = [e for e in events if e["seq"] != 3]
    client.post("/api/v1/events/batch", json=make_batch(without_consent), headers=kiosk["headers"])
    with get_engine().begin() as conn:
        conn.execute(text("UPDATE kiosk_raw.consent_parking SET expires_at = now() - interval '1 hour'"))
    dry = client.post("/api/v1/admin/retention/run", headers=admin, json={"dry_run": True}).json()
    assert dry["report"]["rules"]["consent_parking_expired"]["affected"] == 5
    applied = client.post("/api/v1/admin/retention/run", headers=admin, json={"dry_run": False}).json()
    assert applied["report"]["rules"]["consent_parking_expired"]["affected"] == 5
    dlq = client.get("/api/v1/admin/dead-letters", headers=admin, params={"reason_code": "no_consent"}).json()
    assert dlq["total"] == 5
    # Play-only raw events past their TTL are purged unless a legal hold covers the session.
    sid = events[0]["session_id"]
    client.post(
        "/api/v1/admin/legal-holds", headers=admin, json={"scope_kind": "session", "scope_value": sid, "reason": "hold"}
    )
    from shriii_api.db.session import session_scope  # noqa: PLC0415
    from shriii_api.services.retention import run_retention  # noqa: PLC0415
    from shriii_api.settings import get_settings  # noqa: PLC0415

    with session_scope() as db:
        run = run_retention(
            db, get_settings(), dry_run=False, triggered_by="test", now=datetime.now(UTC) + timedelta(days=120)
        )
    assert run.report["rules"]["play_only_raw_events"]["affected"] == 0
    with get_engine().connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM kiosk_raw.events")).scalar() == 4  # held, not purged


def test_dead_letter_replay_keeps_identity(client: TestClient, kiosk: dict[str, Any], admin: dict[str, str]) -> None:
    events = session_events()
    without_consent = [e for e in events if e["seq"] != 3]
    client.post("/api/v1/events/batch", json=make_batch(without_consent), headers=kiosk["headers"])
    with get_engine().begin() as conn:
        conn.execute(text("UPDATE kiosk_raw.consent_parking SET expires_at = now() - interval '1 hour'"))
    client.post("/api/v1/admin/retention/run", headers=admin, json={"dry_run": False})
    client.post("/api/v1/events/batch", json=make_batch([events[3]]), headers=kiosk["headers"])  # consent arrives late
    dl = client.get("/api/v1/admin/dead-letters", headers=admin, params={"reason_code": "no_consent"}).json()["items"][
        0
    ]
    out = client.post(f"/api/v1/admin/dead-letters/{dl['id']}/replay", headers=admin).json()
    assert out["status"] == "accepted" and out["event_id"] == dl["event_id"] and out["seq"] == dl["seq"]


def test_admin_content_games_and_deployments(client: TestClient, admin: dict[str, str], kiosk: dict[str, Any]) -> None:
    assert client.post("/api/v1/games/sync", headers=admin).json()["versions_added"] >= 14
    games = client.get("/api/v1/games", headers=kiosk["headers"]).json()
    dont_tap = next(g for g in games if g["game_id"] == "dont_tap")
    version = dont_tap["latest_version"]["version"]
    detail = client.get(f"/api/v1/games/dont_tap/versions/{version}", headers=admin).json()
    assert detail["trial_definitions"] and detail["config"]["module_id"] == "dont_tap"
    approved = client.post(
        f"/api/v1/games/dont_tap/versions/{version}/approve", headers=admin, json={"approvers": ["a", "b"]}
    )
    assert approved.json()["status"] == "approved"
    assert [g["game_id"] for g in client.get("/api/v1/games/approved", headers=kiosk["headers"]).json()] == ["dont_tap"]
    content = client.post("/api/v1/admin/content-versions/sync", headers=admin).json()
    assert {c["kind"] for c in content} >= {"games", "instruments", "gates", "hypotheses", "dictionary_A"}
    dep = client.post(
        "/api/v1/admin/deployments",
        headers=admin,
        json={
            "kiosk_id": "kiosk-001",
            "site_id": "site-pune-01",
            "site_mode": "supervised",
            "policy_version": "1.0.0",
            "app_version": "0.1.0",
            "content_version_id": content[0]["id"],
        },
    )
    assert dep.status_code == 201
    hb = client.post(
        "/api/v1/admin/kiosks/heartbeat",
        headers=kiosk["headers"],
        json={"app_version": "0.1.0", "payload": {"outbox_depth": 0}},
    )
    assert hb.json()["health_status"] == "healthy"
    setting = client.put(
        "/api/v1/admin/settings/report_mode_default", headers=admin, json={"value": {"mode": "thank_you"}}
    )
    assert setting.status_code == 200
    audit = client.get("/api/v1/admin/audit", headers=admin, params={"action": "settings.put"}).json()
    assert audit["items"][0]["details"]["new"] == {"mode": "thank_you"}
    assert os.environ["ENV"] == "test"
