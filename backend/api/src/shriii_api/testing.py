"""Helpers for building kiosk event batches in tests and tools (no test framework dependency)."""

from __future__ import annotations

import base64
import copy
import json
from datetime import UTC, datetime
from typing import Any

from shriii_contracts.paths import fixtures_dir

from shriii_api.canonical import canonical_bytes, canonical_sha256
from shriii_api.security import encrypt_chunk, new_uuid7, seal_dek


def uuid7() -> str:
    return str(new_uuid7())


def session_events(
    *,
    pid: str | None = "7K3M9QX",
    session_id: str | None = None,
    kiosk_id: str = "kiosk-001",
    synthetic: bool = False,
    language: str = "hi-IN",
) -> list[dict[str, Any]]:
    """The shared minimal session (10 events) with fresh identifiers."""
    template = json.loads((fixtures_dir() / "sessions" / "minimal-session.json").read_text(encoding="utf-8"))
    sid = session_id or uuid7()
    out = []
    for e in copy.deepcopy(template):
        e["event_id"] = uuid7()
        e["session_id"] = sid
        e["context"]["kiosk_id"] = kiosk_id
        e["context"]["synthetic"] = synthetic
        e["context"]["language"] = language
        if e["context"]["participant_pid"] is not None:
            e["context"]["participant_pid"] = pid
        out.append(e)
    return out


def make_batch(
    events: list[dict[str, Any]],
    *,
    kiosk_id: str = "kiosk-001",
    batch_id: str | None = None,
    chunks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if chunks is None:
        by_session: dict[str, list[dict[str, Any]]] = {}
        for e in events:
            by_session.setdefault(e["session_id"], []).append(e)
        chunks = [
            {
                "encryption": "none_dev",
                "session_id": sid,
                "first_seq": min(e["seq"] for e in evs),
                "last_seq": max(e["seq"] for e in evs),
                "event_count": len(evs),
                "events": evs,
            }
            for sid, evs in by_session.items()
        ]
    count = sum(c["event_count"] for c in chunks)
    return {
        "schema_version": "1.0",
        "batch_id": batch_id or uuid7(),
        "kiosk_id": kiosk_id,
        "kiosk_t_wall": datetime.now(UTC).isoformat(),
        "sha256": canonical_sha256(chunks),
        "event_count": count,
        "session_chunks": chunks,
    }


def encrypted_chunk(events: list[dict[str, Any]], public_key_b64: str, dek: bytes) -> dict[str, Any]:
    """An ``x25519_sealed_aes256gcm`` chunk exactly as a kiosk would build it."""
    ndjson = b"\n".join(canonical_bytes(e) for e in events)
    nonce, ciphertext = encrypt_chunk(dek, ndjson)
    return {
        "encryption": "x25519_sealed_aes256gcm",
        "session_id": events[0]["session_id"],
        "sealed_dek": seal_dek(base64.b64decode(public_key_b64), dek),
        "nonce": nonce,
        "ciphertext": ciphertext,
        "first_seq": events[0]["seq"],
        "last_seq": events[-1]["seq"],
        "event_count": len(events),
    }


__all__ = ["drain", "encrypted_chunk", "make_batch", "session_events", "uuid7"]


def drain() -> int:
    """Run every queued job synchronously (the worker loop without sleeping)."""
    from shriii_api.worker.runner import drain as _drain  # noqa: PLC0415

    return _drain()
