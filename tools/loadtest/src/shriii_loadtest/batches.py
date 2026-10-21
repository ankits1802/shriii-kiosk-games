"""Kiosk outbox model and ``UploadBatch`` construction (contracts upload-batch.v1).

A kiosk drains its outbox in (session, seq) order and packs at most ``max_events`` events per batch;
one batch may carry chunks from several sessions (one chunk per session). Each chunk is either
``none_dev`` plaintext (accepted by the API only when ENV is dev or test) or
``x25519_sealed_aes256gcm``: a per-session 32-byte DEK sealed to the backend X25519 key with libsodium
``crypto_box_seal`` and AES-256-GCM over NDJSON (12-byte nonce, no AAD), as in backend/api/README.md.
``sha256`` is the JCS hash of ``session_chunks``.
"""

from __future__ import annotations

import base64
import json
import os
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from nacl.public import PublicKey, SealedBox

from shriii_loadtest.ids import uuid7
from shriii_loadtest.jcs import canonical_sha256

__all__ = [
    "Encryption",
    "KioskIdentity",
    "OutboxSession",
    "PreparedBatch",
    "build_batch",
    "pack_outbox",
]

Encryption = Literal["none_dev", "sealed"]
MAX_EVENTS_PER_BATCH = 500
"""Contract ceiling (``UploadBatch.event_count`` maximum) and the ING-02 latency target size."""


@dataclass(frozen=True, slots=True)
class KioskIdentity:
    kiosk_id: str
    site_id: str
    token: str


@dataclass(slots=True)
class OutboxSession:
    """One session waiting in a kiosk outbox."""

    session_id: str
    events: list[dict[str, Any]]
    dek: bytes = field(default_factory=lambda: os.urandom(32))

    def __post_init__(self) -> None:
        seqs = [e["seq"] for e in self.events]
        if seqs != sorted(seqs):
            raise ValueError("outbox events must be in seq order")


@dataclass(slots=True)
class PreparedBatch:
    """A ready-to-send request body plus what the harness needs to check the response."""

    batch_id: str
    kiosk_id: str
    body: bytes
    event_count: int
    event_ids: tuple[str, ...]
    session_ids: tuple[str, ...]
    kind: str = "fresh"
    contains_consent: bool = False

    @property
    def size_bytes(self) -> int:
        return len(self.body)


Slice = tuple[OutboxSession, list[dict[str, Any]]]


def pack_outbox(sessions: Iterable[OutboxSession], max_events: int = MAX_EVENTS_PER_BATCH) -> list[list[Slice]]:
    """Split an outbox into batches of at most ``max_events`` events, keeping (session, seq) order."""
    if not 1 <= max_events <= MAX_EVENTS_PER_BATCH:
        raise ValueError(f"max_events must be within 1..{MAX_EVENTS_PER_BATCH}")
    batches: list[list[Slice]] = []
    current: list[Slice] = []
    room = max_events
    for session in sessions:
        start = 0
        while start < len(session.events):
            take = min(room, len(session.events) - start)
            current.append((session, session.events[start : start + take]))
            start += take
            room -= take
            if room == 0:
                batches.append(current)
                current, room = [], max_events
    if current:
        batches.append(current)
    return batches


def _seal(public_key: bytes, dek: bytes) -> str:
    return base64.b64encode(SealedBox(PublicKey(public_key)).encrypt(dek)).decode()


def _chunk(
    session: OutboxSession, events: Sequence[dict[str, Any]], encryption: Encryption, public_key: bytes | None
) -> dict[str, Any]:
    chunk: dict[str, Any] = {
        "session_id": session.session_id,
        "first_seq": events[0]["seq"],
        "last_seq": events[-1]["seq"],
        "event_count": len(events),
    }
    if encryption == "none_dev":
        chunk["encryption"] = "none_dev"
        chunk["events"] = list(events)
        return chunk
    if public_key is None:
        raise ValueError("sealed chunks need the backend X25519 public key")
    plaintext = b"\n".join(json.dumps(e, separators=(",", ":"), ensure_ascii=False).encode() for e in events)
    nonce = os.urandom(12)
    chunk["encryption"] = "x25519_sealed_aes256gcm"
    chunk["sealed_dek"] = _seal(public_key, session.dek)
    chunk["nonce"] = base64.b64encode(nonce).decode()
    chunk["ciphertext"] = base64.b64encode(AESGCM(session.dek).encrypt(nonce, plaintext, None)).decode()
    return chunk


def build_batch(
    kiosk: KioskIdentity,
    slices: Sequence[Slice],
    *,
    kiosk_t_wall: datetime,
    encryption: Encryption = "none_dev",
    public_key: bytes | None = None,
    batch_id: str | None = None,
    kind: str = "fresh",
) -> PreparedBatch:
    if not slices:
        raise ValueError("a batch needs at least one chunk")
    chunks = [_chunk(session, events, encryption, public_key) for session, events in slices]
    event_count = sum(len(events) for _, events in slices)
    doc = {
        "schema_version": "1.0",
        "batch_id": batch_id or uuid7(),
        "kiosk_id": kiosk.kiosk_id,
        "kiosk_t_wall": kiosk_t_wall.isoformat(timespec="milliseconds"),
        "sha256": canonical_sha256(chunks),
        "event_count": event_count,
        "session_chunks": chunks,
    }
    return PreparedBatch(
        batch_id=doc["batch_id"],
        kiosk_id=kiosk.kiosk_id,
        body=json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode(),
        event_count=event_count,
        event_ids=tuple(e["event_id"] for _, events in slices for e in events),
        session_ids=tuple(dict.fromkeys(s.session_id for s, _ in slices)),
        kind=kind,
        contains_consent=any(e["event_type"] == "consent.granted" for _, events in slices for e in events),
    )
