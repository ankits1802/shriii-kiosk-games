"""Erasure cascade (PRV-06a/06): raw + derived + criterion + linkage + vault + snapshots, signed receipt."""

from __future__ import annotations

import base64
import os
import uuid
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import text

from shriii_api.canonical import canonical_bytes
from shriii_api.db.session import get_engine, get_identity_engine
from shriii_api.security import verify_ed25519
from shriii_api.testing import drain, encrypted_chunk, make_batch, session_events

STUDY = "s-erase"


def _count(sql: str, engine: Any = None, **params: Any) -> int:
    with (engine or get_engine()).connect() as conn:
        return int(conn.execute(text(sql), params).scalar_one())


def _setup_participant(
    client: TestClient, admin: dict[str, str], researcher: dict[str, str], kiosk: dict[str, Any]
) -> dict[str, Any]:
    client.post(
        "/api/v1/studies", headers=researcher, json={"study_id": STUDY, "code": "S1", "name": "erase", "stage": "pilot"}
    )
    pid = client.post("/api/v1/participants", headers=researcher, json={"study_id": STUDY}).json()["pid"]
    events = session_events(pid=pid)
    sid = events[0]["session_id"]
    chunk = encrypted_chunk(events, kiosk["public_key"], os.urandom(32))
    batch = make_batch(events, chunks=[chunk])
    assert client.post("/api/v1/events/batch", json=batch, headers=kiosk["headers"]).json()["summary"]["accepted"] == 10
    pairing = client.post(
        f"/api/v1/participants/{pid}/pairing-codes", headers=researcher, json={"study_id": STUDY, "occasion_id": "T1"}
    ).json()
    link = client.post(
        "/api/v1/participants/link", headers=kiosk["headers"], json={"session_id": sid, "qr_token": pairing["qr_token"]}
    )
    assert link.status_code == 201, link.text
    # criterion data
    assert client.post("/api/v1/instruments/sync", headers=admin).status_code == 200
    client.post(
        "/api/v1/instruments/bscs/versions/1.0.0/languages/hi-IN",
        headers=admin,
        json={"itc_state": "approved", "approvers": ["a", "b"]},
    )
    client.post(
        "/api/v1/instruments/bscs/licensing",
        headers=admin,
        json={
            "holder": "h",
            "licence": "l",
            "permission_status": "granted",
            "permission_document": "D",
            "allowed_use": "research",
        },
    )
    for kind in ("criterion", "contact"):
        client.post(
            f"/api/v1/participants/{pid}/consents",
            headers=researcher,
            json={
                "kind": kind,
                "granted": True,
                "consent_script_id": f"{kind}.v1",
                "script_audio_sha256": "b" * 64,
                "language": "hi-IN",
                "policy_version": "1.0.0",
                "presented_at": "2026-10-21T10:00:00Z",
                "decided_at": "2026-10-21T10:00:05Z",
            },
        )
    responses = [{"item_id": f"bscs.i{i:02d}", "raw_response": 3.0} for i in range(1, 14)]
    r = client.post(
        "/api/v1/assessment-responses",
        headers=researcher,
        json={
            "pid": pid,
            "study_id": STUDY,
            "occasion_id": "T1",
            "instrument_id": "bscs",
            "language": "hi-IN",
            "block": "X",
            "administration_mode": "self",
            "device_id": "tab-1",
            "responses": responses,
        },
    )
    assert r.status_code == 201, r.text
    contact = client.post(
        f"/api/v1/participants/{pid}/contact", headers=researcher, json={"channel": "ivr", "contact": "+91-9000000000"}
    )
    assert contact.status_code == 201, contact.text
    return {"pid": pid, "session_id": sid, "batch": batch}


def test_participant_erasure_cascade(
    client: TestClient, admin: dict[str, str], researcher: dict[str, str], kiosk: dict[str, Any], settings: Any
) -> None:
    ctx = _setup_participant(client, admin, researcher, kiosk)
    pid, sid = ctx["pid"], ctx["session_id"]
    drain()  # trial eligibility etc.
    # A snapshot that contains the participant.
    snap = client.post(
        "/api/v1/validation/datasets",
        headers=researcher,
        json={"study_id": STUDY, "name": "pre-erasure", "spec": {"require_game": True, "require_criterion": True}},
    )
    assert snap.status_code == 202, snap.text
    drain()
    snapshot = client.get(f"/api/v1/validation/datasets/{snap.json()['snapshot_id']}", headers=researcher).json()
    assert snapshot["status"] == "ready" and snapshot["row_count"] == 1, snapshot
    parquet = Path(settings.data_dir) / "snapshots" / STUDY / f"{snapshot['snapshot_id']}.parquet"
    assert parquet.exists()
    assert _count("SELECT count(*) FROM kiosk_raw.events WHERE session_id = :s", s=sid) == 10
    assert _count("SELECT count(*) FROM identity_vault.contacts", engine=get_identity_engine()) == 1

    req = client.post(
        "/api/v1/participants/erasure-requests",
        headers=researcher,
        json={"scope": "participant", "pid": pid, "reason": "participant request"},
    )
    assert req.status_code == 202, req.text
    request_id = req.json()["request_id"]
    drain()
    done = client.get(f"/api/v1/participants/erasure-requests/{request_id}", headers=researcher).json()
    assert done["status"] == "completed", done
    receipt = done["receipt"]
    key = client.get("/api/v1/admin/gates/release-pack/public-key").json()
    assert verify_ed25519(base64.b64decode(key["public_key"]), canonical_bytes(receipt["body"]), receipt["signature"])
    counts = receipt["body"]["counts"]
    assert counts["raw_events"] == 10 and counts["session_keys_shredded"] == 1 and counts["criterion_responses"] == 13
    assert counts["vault_contacts"] == 1
    assert receipt["body"]["snapshots_tombstoned"] == [snapshot["snapshot_id"]]

    # Sweep: nothing references the pid or its session in primary stores.
    for sql in (
        "SELECT count(*) FROM kiosk_raw.events WHERE session_id = :s",
        "SELECT count(*) FROM kiosk_raw.batch_chunks WHERE session_id = :s",
        "SELECT count(*) FROM consent.session_keys WHERE session_id = :s",
        "SELECT count(*) FROM scored.trials_canonical WHERE session_id = :s",
        "SELECT count(*) FROM consent.artefacts WHERE session_id = :s",
        "SELECT count(*) FROM kiosk_raw.sessions WHERE session_id = :s",
    ):
        assert _count(sql, s=uuid.UUID(sid)) == 0, sql
    for sql in (
        "SELECT count(*) FROM linkage.participants WHERE pid = :p",
        "SELECT count(*) FROM criterion.responses WHERE subject_pid = :p OR pid = :p",
        "SELECT count(*) FROM criterion.scale_scores WHERE pid = :p",
        "SELECT count(*) FROM validation.snapshot_members WHERE pid = :p",
        "SELECT count(*) FROM consent.artefacts WHERE participant_pid = :p",
        "SELECT count(*) FROM consent.erasure_requests WHERE pid = :p",
    ):
        assert _count(sql, p=pid) == 0, sql
    assert _count("SELECT count(*) FROM identity_vault.contacts", engine=get_identity_engine()) == 0
    # Snapshot tombstoned, file removed, rebuild queued as an explicit pipeline step.
    snap_after = client.get(f"/api/v1/validation/datasets/{snapshot['snapshot_id']}", headers=researcher).json()
    assert snap_after["status"] == "tombstoned" and not parquet.exists()
    rebuilt = client.get("/api/v1/validation/datasets", headers=researcher, params={"study_id": STUDY}).json()
    assert any(s["supersedes_id"] == snapshot["snapshot_id"] and s["row_count"] == 0 for s in rebuilt)
    # Replay guard: re-uploading the erased session never resurrects it.
    again = client.post("/api/v1/events/batch", json=ctx["batch"], headers=kiosk["headers"]).json()
    assert again["duplicate_batch"] is True
    fresh = make_batch(session_events(pid=pid, session_id=sid))
    resent = client.post("/api/v1/events/batch", json=fresh, headers=kiosk["headers"]).json()
    assert {r["reason_code"] for r in resent["results"]} == {"session_tombstoned"}
    assert _count("SELECT count(*) FROM kiosk_raw.events WHERE session_id = :s", s=uuid.UUID(sid)) == 0


def test_session_erasure_from_report_token(client: TestClient, kiosk: dict[str, Any]) -> None:
    events = session_events()
    client.post("/api/v1/events/batch", json=make_batch(events), headers=kiosk["headers"])
    report = client.post(
        "/api/v1/reports",
        headers=kiosk["headers"],
        json={"session_id": events[0]["session_id"], "report_mode": "thank_you"},
    ).json()
    token = report["artefact"]["token"]
    r = client.post(f"/api/v1/reports/by-token/{token}/erase")
    assert r.status_code == 202, r.text
    drain()
    assert (
        _count("SELECT count(*) FROM kiosk_raw.events WHERE session_id = :s", s=uuid.UUID(events[0]["session_id"])) == 0
    )
    assert client.get(f"/api/v1/reports/by-token/{token}").status_code == 404


def test_legal_hold_blocks_erasure(
    client: TestClient, admin: dict[str, str], researcher: dict[str, str], kiosk: dict[str, Any]
) -> None:
    events = session_events()
    sid = events[0]["session_id"]
    client.post("/api/v1/events/batch", json=make_batch(events), headers=kiosk["headers"])
    hold = client.post(
        "/api/v1/admin/legal-holds",
        headers=admin,
        json={"scope_kind": "session", "scope_value": sid, "reason": "regulator inquiry"},
    )
    assert hold.status_code == 201
    req = client.post(
        "/api/v1/participants/erasure-requests", headers=researcher, json={"scope": "session", "session_id": sid}
    ).json()
    drain()
    status = client.get(f"/api/v1/participants/erasure-requests/{req['request_id']}", headers=researcher).json()
    assert status["status"] == "blocked_legal_hold"
    assert _count("SELECT count(*) FROM kiosk_raw.events WHERE session_id = :s", s=uuid.UUID(sid)) == 10


MATCHED_FOR_SESSION = (
    "SELECT count(*) FROM validation.matched_records WHERE session_ids @> jsonb_build_array(CAST(:s AS text))"
)


def test_session_erasure_tombstones_snapshots_built_from_it(
    client: TestClient, admin: dict[str, str], researcher: dict[str, str], kiosk: dict[str, Any], settings: Any
) -> None:
    """Erasing one linked session (hand icon / report token) also retires the snapshots built from it."""
    ctx = _setup_participant(client, admin, researcher, kiosk)
    pid, sid = ctx["pid"], ctx["session_id"]
    drain()
    snap = client.post(
        "/api/v1/validation/datasets",
        headers=researcher,
        json={"study_id": STUDY, "name": "pre-session-erasure", "spec": {"require_game": True}},
    ).json()
    drain()
    snapshot = client.get(f"/api/v1/validation/datasets/{snap['snapshot_id']}", headers=researcher).json()
    assert snapshot["status"] == "ready" and snapshot["row_count"] == 1, snapshot
    parquet = Path(settings.data_dir) / "snapshots" / STUDY / f"{snapshot['snapshot_id']}.parquet"
    assert parquet.exists()
    from shriii_api.db.session import session_scope  # noqa: PLC0415
    from shriii_api.services.snapshots import refresh_matched_records  # noqa: PLC0415

    with session_scope() as db:
        refresh_matched_records(db, STUDY, None)
    assert _count(MATCHED_FOR_SESSION, s=sid) == 1

    req = client.post(
        "/api/v1/participants/erasure-requests", headers=researcher, json={"scope": "session", "session_id": sid}
    ).json()
    drain()
    done = client.get(f"/api/v1/participants/erasure-requests/{req['request_id']}", headers=researcher).json()
    assert done["status"] == "completed", done
    assert done["receipt"]["body"]["snapshots_tombstoned"] == [snapshot["snapshot_id"]]
    assert _count(MATCHED_FOR_SESSION, s=sid) == 0
    after = client.get(f"/api/v1/validation/datasets/{snapshot['snapshot_id']}", headers=researcher).json()
    assert after["status"] == "tombstoned" and not parquet.exists()
    # A session-scope erasure leaves the participant and their criterion data in place.
    assert _count("SELECT count(*) FROM linkage.participants WHERE pid = :p", p=pid) == 1
    assert _count("SELECT count(*) FROM criterion.responses WHERE subject_pid = :p", p=pid) == 13
