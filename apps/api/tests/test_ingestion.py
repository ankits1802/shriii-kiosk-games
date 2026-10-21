"""Ingestion: idempotency & dedup, seq gaps, consent parking, DLQ, encryption, append-only guards."""

from __future__ import annotations

import os
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from shriii_api.canonical import canonical_sha256
from shriii_api.db.session import get_engine
from shriii_api.testing import encrypted_chunk, make_batch, session_events, uuid7

URL = "/api/v1/events/batch"


def _post(client: TestClient, kiosk: dict[str, Any], batch: dict[str, Any]) -> Any:
    return client.post(URL, json=batch, headers=kiosk["headers"])


def _scalar(sql: str, **params: Any) -> Any:
    with get_engine().connect() as conn:
        return conn.execute(text(sql), params).scalar()


def test_accepts_batch_and_sets_server_time(client: TestClient, kiosk: dict[str, Any]) -> None:
    events = session_events()
    r = _post(client, kiosk, make_batch(events))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["summary"] == {"accepted": 10, "duplicate": 0, "parked": 0, "rejected_terminal": 0, "retryable": 0}
    assert body["duplicate_batch"] is False
    assert [x["status"] for x in body["results"]] == ["accepted"] * 10
    sid = events[0]["session_id"]
    assert _scalar("SELECT count(*) FROM kiosk_raw.events WHERE session_id = :s", s=sid) == 10
    received = _scalar(
        "SELECT envelope->'server'->>'server_received_at' FROM kiosk_raw.events WHERE session_id = :s AND seq = 0",
        s=sid,
    )
    assert received is not None
    assert (
        _scalar("SELECT batch_id::text FROM kiosk_raw.events WHERE session_id = :s AND seq = 0", s=sid)
        == body["batch_id"]
    )
    partition = _scalar("SELECT tableoid::regclass::text FROM kiosk_raw.events WHERE session_id = :s LIMIT 1", s=sid)
    assert partition.startswith("kiosk_raw.events_p")
    session = client.get(f"/api/v1/sessions/{sid}", headers=client.headers)
    assert session.status_code == 401  # raw session read needs a staff token


def test_replay_is_idempotent(client: TestClient, kiosk: dict[str, Any]) -> None:
    events = session_events()
    batch = make_batch(events)
    first = _post(client, kiosk, batch).json()
    replay = _post(client, kiosk, batch)
    assert replay.status_code == 200
    assert replay.json()["duplicate_batch"] is True
    assert replay.json()["results"] == first["results"]
    # The same events re-sent under a new batch id are duplicates, never re-inserted.
    again = _post(client, kiosk, make_batch(events)).json()
    assert again["summary"]["duplicate"] == 10 and again["summary"]["accepted"] == 0
    sid = events[0]["session_id"]
    assert _scalar("SELECT count(*) FROM kiosk_raw.events WHERE session_id = :s", s=sid) == 10
    assert _scalar("SELECT count(*) FROM kiosk_raw.event_dedup WHERE session_id = :s", s=sid) == 10


def test_batch_id_reuse_with_other_content_conflicts(client: TestClient, kiosk: dict[str, Any]) -> None:
    batch = make_batch(session_events())
    assert _post(client, kiosk, batch).status_code == 200
    other = make_batch(session_events(), batch_id=batch["batch_id"])
    r = _post(client, kiosk, other)
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "batch_id_conflict"


def test_sha256_mismatch_rejected(client: TestClient, kiosk: dict[str, Any]) -> None:
    batch = make_batch(session_events())
    batch["sha256"] = "0" * 64
    r = _post(client, kiosk, batch)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "sha256_mismatch"


def test_kiosk_cannot_upload_for_another_kiosk(client: TestClient, kiosk: dict[str, Any]) -> None:
    events = session_events(kiosk_id="kiosk-002")
    r = _post(client, kiosk, make_batch(events, kiosk_id="kiosk-002"))
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "kiosk_mismatch"


def test_invalid_event_dead_lettered_others_accepted(
    client: TestClient, kiosk: dict[str, Any], admin: dict[str, str]
) -> None:
    events = session_events()
    events[7]["payload"]["latency_ms"] = None  # response not a timeout: latency must be present
    events[2]["payload"] = {"unexpected": True}  # schema violation
    body = _post(client, kiosk, make_batch(events)).json()
    statuses = {x["seq"]: (x["status"], x["reason_code"]) for x in body["results"]}
    assert statuses[2][0] == "rejected_terminal"
    assert statuses[7] == ("rejected_terminal", "latency_null_iff_timeout")
    assert body["summary"]["accepted"] == 8
    dlq = client.get("/api/v1/admin/dead-letters", headers=admin).json()
    assert {d["reason_code"] for d in dlq["items"]} == {"schema_violation", "latency_null_iff_timeout"}
    assert all(d["batch_id"] == body["batch_id"] for d in dlq["items"])


def test_seq_gap_detection_and_resolution(
    client: TestClient, kiosk: dict[str, Any], researcher: dict[str, str]
) -> None:
    events = session_events()
    sid = events[0]["session_id"]
    assert _post(client, kiosk, make_batch(events[:4])).status_code == 200
    assert _post(client, kiosk, make_batch(events[6:])).status_code == 200
    detail = client.get(f"/api/v1/sessions/{sid}", headers=researcher).json()
    assert detail["missing_ranges"] == [[4, 5]]
    assert [f["flag_code"] for f in detail["open_flags"]] == ["seq_gap"]
    assert detail["open_flags"][0]["details"]["missing_count"] == 2
    assert detail["session"]["valid_for_report"] is False
    resume = client.post(f"/api/v1/sessions/{sid}/resume", headers=kiosk["headers"]).json()
    assert resume["missing_ranges"] == [[4, 5]] and resume["max_contiguous_seq"] == 3
    # The late upload fills the gap: flag resolved, session valid.
    assert _post(client, kiosk, make_batch(events[4:6])).status_code == 200
    detail = client.get(f"/api/v1/sessions/{sid}", headers=researcher).json()
    assert detail["missing_ranges"] == []
    assert detail["open_flags"] == []
    assert detail["session"]["valid_for_report"] is True
    flags = client.get(f"/api/v1/sessions/{sid}/quality-flags", headers=researcher).json()
    assert flags[0]["flag_code"] == "seq_gap" and flags[0]["resolved_at"] is not None


def test_seq_conflict_is_terminal_and_blocking(
    client: TestClient, kiosk: dict[str, Any], researcher: dict[str, str]
) -> None:
    events = session_events()
    _post(client, kiosk, make_batch(events))
    clash = dict(events[5], event_id=uuid7())
    body = _post(client, kiosk, make_batch([clash])).json()
    assert body["results"][0]["status"] == "rejected_terminal"
    assert body["results"][0]["reason_code"] == "seq_conflict"
    detail = client.get(f"/api/v1/sessions/{events[0]['session_id']}", headers=researcher).json()
    assert "seq_conflict" in {f["flag_code"] for f in detail["open_flags"]}
    assert detail["session"]["valid_for_report"] is False


def test_consent_first_parking_then_unpark(client: TestClient, kiosk: dict[str, Any]) -> None:
    events = session_events()
    sid = events[0]["session_id"]
    consent = events[3]
    without_consent = [e for e in events if e["seq"] != 3]
    first = _post(client, kiosk, make_batch(without_consent)).json()
    statuses = {x["seq"]: x["status"] for x in first["results"]}
    assert {statuses[s] for s in (4, 5, 6, 7, 8)} == {"parked"}
    assert statuses[0] == "accepted" and statuses[9] == "accepted"  # non-scorable onboarding/session events
    assert _scalar("SELECT count(*) FROM kiosk_raw.consent_parking WHERE session_id = :s", s=sid) == 5
    # Consent arrives in a later batch: parked events move to the raw store.
    second = _post(client, kiosk, make_batch([consent])).json()
    assert second["results"][0]["status"] == "accepted"
    assert _scalar("SELECT count(*) FROM kiosk_raw.consent_parking WHERE session_id = :s", s=sid) == 0
    assert _scalar("SELECT count(*) FROM kiosk_raw.events WHERE session_id = :s", s=sid) == 10
    assert (
        _scalar("SELECT count(*) FROM consent.artefacts WHERE session_id = :s AND kind = 'core' AND granted", s=sid)
        == 1
    )
    # Replaying the first batch reports the refreshed statuses.
    replay = _post(client, kiosk, make_batch(without_consent, batch_id=first["batch_id"])).json()
    assert replay["duplicate_batch"] is True
    assert {x["status"] for x in replay["results"]} == {"accepted"}


def test_consent_declined_rejects_scorable_events(client: TestClient, kiosk: dict[str, Any]) -> None:
    events = session_events()
    decline = events[3]
    decline["event_type"] = "consent.declined"
    decline["payload"] = {
        "consent_kind": "core",
        "tap_confirmed": True,
        "consent_script_id": "consent.core.v1",
        "replay_counts": [0],
    }
    body = _post(client, kiosk, make_batch(events)).json()
    statuses = {x["seq"]: (x["status"], x["reason_code"]) for x in body["results"]}
    assert statuses[3] == ("accepted", None)
    assert {statuses[s] for s in (4, 5, 6, 7, 8)} == {("rejected_terminal", "consent_declined")}


def test_encrypted_chunk_round_trip_and_crypto_shred(client: TestClient, kiosk: dict[str, Any], settings: Any) -> None:
    from shriii_api.db.models.kiosk_raw import BatchChunk  # noqa: PLC0415
    from shriii_api.db.session import session_scope  # noqa: PLC0415
    from shriii_api.security import CryptoFailureError  # noqa: PLC0415
    from shriii_api.services.ingestion import raw_chunk_events  # noqa: PLC0415

    events = session_events()
    chunk = encrypted_chunk(events, kiosk["public_key"], os.urandom(32))
    body = _post(client, kiosk, make_batch(events, chunks=[chunk])).json()
    assert body["summary"]["accepted"] == 10
    sid = uuid.UUID(events[0]["session_id"])
    with session_scope() as db:
        stored = db.query(BatchChunk).filter(BatchChunk.session_id == sid).one()
        assert "ciphertext" in stored.body and "events" not in stored.body
        assert [e["event_id"] for e in raw_chunk_events(db, settings, stored)] == [e["event_id"] for e in events]
        db.execute(text("DELETE FROM consent.session_keys WHERE session_id = :s"), {"s": sid})
        with pytest.raises(CryptoFailureError):
            raw_chunk_events(db, settings, stored)


def test_tampered_ciphertext_rejected(client: TestClient, kiosk: dict[str, Any]) -> None:
    events = session_events()
    chunk = encrypted_chunk(events, kiosk["public_key"], os.urandom(32))
    chunk["ciphertext"] = chunk["ciphertext"][:-8] + "AAAAAAA="
    r = _post(client, kiosk, make_batch(events, chunks=[chunk]))
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "chunk_decrypt_failed"


def test_raw_events_are_append_only(client: TestClient, kiosk: dict[str, Any]) -> None:
    events = session_events()
    _post(client, kiosk, make_batch(events))
    with pytest.raises(DBAPIError, match="append-only"), get_engine().begin() as conn:
        conn.execute(text("UPDATE kiosk_raw.events SET seq = seq + 100"))
    with pytest.raises(DBAPIError, match="append-only"), get_engine().begin() as conn:
        conn.execute(text("DELETE FROM kiosk_raw.events"))
    with get_engine().begin() as conn:  # the erasure path is the only exception
        conn.execute(text("SELECT set_config('shriii.mutation_purpose', 'erasure', true)"))
        deleted = conn.execute(text("DELETE FROM kiosk_raw.events WHERE seq = 9")).rowcount
    assert deleted == 1


def test_session_end_enqueues_pipeline(client: TestClient, kiosk: dict[str, Any], admin: dict[str, str]) -> None:
    events = session_events()
    _post(client, kiosk, make_batch(events))
    jobs = client.get("/api/v1/admin/jobs", headers=admin).json()["items"]
    assert [j["job_type"] for j in jobs] == ["trial_eligibility"]
    assert jobs[0]["inputs"]["session_id"] == events[0]["session_id"]
    assert (
        canonical_sha256({"job_type": "trial_eligibility", "inputs": jobs[0]["inputs"]}) == jobs[0]["idempotency_key"]
    )


def test_upload_is_audited(client: TestClient, kiosk: dict[str, Any], admin: dict[str, str]) -> None:
    batch = make_batch(session_events())
    _post(client, kiosk, batch)
    audit = client.get("/api/v1/admin/audit", headers=admin, params={"action": "events.batch"}).json()
    assert audit["total"] == 1
    entry = audit["items"][0]
    assert entry["actor_kind"] == "device" and entry["resource_id"] == batch["batch_id"]
