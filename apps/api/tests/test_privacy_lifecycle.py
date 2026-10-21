"""Decline / under-18 discard (ONB-02, ONB-04) and retention of every raw copy (PRV-05)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import text

from shriii_api.db.session import get_engine, session_scope
from shriii_api.testing import drain, make_batch, session_events

URL = "/api/v1/events/batch"


def _count(sql: str, **params: Any) -> int:
    with get_engine().connect() as conn:
        return int(conn.execute(text(sql), params).scalar_one())


def _assert_discarded(sid: str, reason: str) -> None:
    s = uuid.UUID(sid)
    for sql in (
        "SELECT count(*) FROM kiosk_raw.events WHERE session_id = :s",
        "SELECT count(*) FROM kiosk_raw.sessions WHERE session_id = :s",
        "SELECT count(*) FROM kiosk_raw.batch_chunks WHERE session_id = :s",
        "SELECT count(*) FROM kiosk_raw.consent_parking WHERE session_id = :s",
        "SELECT count(*) FROM kiosk_raw.dead_letter WHERE session_id = :s",
        "SELECT count(*) FROM consent.artefacts WHERE session_id = :s",
    ):
        assert _count(sql, s=s) == 0, sql
    assert _count("SELECT count(*) FROM consent.tombstones WHERE session_id = :s AND reason = :r", s=s, r=reason) == 1
    # The anonymous counter: kiosk + reason only, no session or participant identifiers.
    with get_engine().connect() as conn:
        rows = conn.execute(
            text("SELECT kiosk_id, details FROM governance.system_events WHERE kind = :k"),
            {"k": f"session_discarded.{reason}"},
        ).all()
    assert [(r.kiosk_id, r.details) for r in rows] == [("kiosk-001", {})]


def _payload_rows(sid: str) -> int:
    return _count(
        "SELECT count(*) FROM kiosk_raw.dead_letter WHERE session_id = :s AND payload_ciphertext IS NOT NULL",
        s=uuid.UUID(sid),
    )


def test_consent_decline_keeps_only_an_anonymous_counter(client: TestClient, kiosk: dict[str, Any]) -> None:
    events = session_events()
    sid = events[0]["session_id"]
    decline = events[3]
    decline["event_type"] = "consent.declined"
    decline["payload"] = {
        "consent_kind": "core",
        "tap_confirmed": True,
        "consent_script_id": "consent.core.v1",
        "replay_counts": [0],
    }
    body = client.post(URL, json=make_batch(events), headers=kiosk["headers"]).json()
    assert {x["reason_code"] for x in body["results"] if x["seq"] in (4, 5, 6, 7, 8)} == {"consent_declined"}
    assert _payload_rows(sid) == 0  # declined events are dead-lettered without their content
    drain()
    _assert_discarded(sid, "consent_declined")
    # Late uploads of the same session are refused, and their content is not kept either.
    late = session_events(session_id=sid)
    again = client.post(URL, json=make_batch(late[4:7]), headers=kiosk["headers"]).json()
    assert {x["reason_code"] for x in again["results"]} == {"session_tombstoned"}
    assert _payload_rows(sid) == 0
    assert _count("SELECT count(*) FROM kiosk_raw.events WHERE session_id = :s", s=uuid.UUID(sid)) == 0


def test_under_age_exit_keeps_nothing(client: TestClient, kiosk: dict[str, Any]) -> None:
    events = session_events(pid=None)
    sid = events[0]["session_id"]
    abandoned = {
        **events[9],
        "seq": 3,
        "event_type": "session.abandoned",
        "payload": {
            "last_state": "bands",
            "module_id": None,
            "trial_id": None,
            "elapsed_ms": 41000,
            "reason": "under_age",
        },
    }
    body = client.post(URL, json=make_batch([*events[:3], abandoned]), headers=kiosk["headers"]).json()
    assert body["summary"]["accepted"] == 4, body
    drain()
    _assert_discarded(sid, "under_age")


def test_play_only_retention_removes_every_raw_copy(
    client: TestClient, kiosk: dict[str, Any], admin: dict[str, str], settings: Any
) -> None:
    from shriii_api.services.retention import run_retention  # noqa: PLC0415

    events = session_events(pid=None)
    sid = uuid.UUID(events[0]["session_id"])
    client.post(URL, json=make_batch(events), headers=kiosk["headers"])
    held = session_events(pid=None)
    held_sid = uuid.UUID(held[0]["session_id"])
    client.post(URL, json=make_batch(held), headers=kiosk["headers"])
    hold = client.post(
        "/api/v1/admin/legal-holds",
        headers=admin,
        json={"scope_kind": "session", "scope_value": str(held_sid), "reason": "inquiry"},
    )
    assert hold.status_code == 201, hold.text
    assert _count("SELECT count(*) FROM kiosk_raw.batch_chunks WHERE session_id = :s", s=sid) == 1
    with session_scope() as db:
        run = run_retention(
            db, settings, dry_run=False, triggered_by="test", now=datetime.now(UTC) + timedelta(days=400)
        )
        assert run.report["rules"]["play_only_raw_events"]["affected"] == 10
    assert _count("SELECT count(*) FROM kiosk_raw.events WHERE session_id = :s", s=sid) == 0
    assert _count("SELECT count(*) FROM kiosk_raw.batch_chunks WHERE session_id = :s", s=sid) == 0
    # The legal hold protects the other session's raw events and chunks.
    assert _count("SELECT count(*) FROM kiosk_raw.events WHERE session_id = :s", s=held_sid) == 10
    assert _count("SELECT count(*) FROM kiosk_raw.batch_chunks WHERE session_id = :s", s=held_sid) == 1


def test_dead_letter_retention_respects_legal_holds(
    client: TestClient, kiosk: dict[str, Any], admin: dict[str, str], settings: Any
) -> None:
    from shriii_api.services.retention import run_retention  # noqa: PLC0415

    held = session_events(pid=None)
    held_sid = held[0]["session_id"]
    broken = dict(held[4])
    broken["payload"] = {"not": "a module_start payload"}
    client.post(URL, json=make_batch([*held[:4], broken]), headers=kiosk["headers"])
    assert _count("SELECT count(*) FROM kiosk_raw.dead_letter WHERE session_id = :s", s=uuid.UUID(held_sid)) == 1
    client.post(
        "/api/v1/admin/legal-holds",
        headers=admin,
        json={"scope_kind": "session", "scope_value": held_sid, "reason": "inquiry"},
    )
    with session_scope() as db:
        run_retention(db, settings, dry_run=False, triggered_by="test", now=datetime.now(UTC) + timedelta(days=400))
    assert _count("SELECT count(*) FROM kiosk_raw.dead_letter WHERE session_id = :s", s=uuid.UUID(held_sid)) == 1
