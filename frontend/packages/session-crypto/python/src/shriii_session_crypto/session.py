"""Server-side decryption of kiosk upload chunks (mirror of dek.ts / chunk.ts).

Typical API use::

    keys = {"backend-2026-10": private_key_bytes}
    events = decrypt_session_chunk(chunk_dict, keys.get)

``chunk_dict`` is one ``UploadBatch.session_chunks[]`` item with
``encryption == "x25519_sealed_aes256gcm"``.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import zlib
from collections.abc import Callable, Mapping
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .hpke import (
    AEAD_AES_256_GCM,
    KDF_HKDF_SHA256,
    KEM_X25519_HKDF_SHA256,
    N_PK,
    N_T,
    DecryptionError,
    open_base,
)

CHUNK_ENCRYPTION = "x25519_sealed_aes256gcm"
SEALED_DEK_VERSION = 1
DEK_BYTES = 32
DEK_INFO = b"shriii/session-dek/v1"
MAX_CHUNK_PLAINTEXT_BYTES = 16 * 1024 * 1024
KID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

PrivateKeyLookup = Callable[[str], bytes | None]


def _b64(text: str, field: str) -> bytes:
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise DecryptionError(f"{field} is not base64") from exc


def parse_sealed_dek(sealed: str) -> tuple[bytes, str, bytes, bytes]:
    """Return (header, kid, enc, ciphertext) of a base64 sealed DEK without decrypting it."""
    raw = _b64(sealed, "sealed_dek")
    if len(raw) < 8:
        raise DecryptionError("sealed DEK too short")
    if raw[0] != SEALED_DEK_VERSION:
        raise DecryptionError(f"unsupported version {raw[0]}")
    if int.from_bytes(raw[1:3], "big") != KEM_X25519_HKDF_SHA256 or int.from_bytes(raw[3:5], "big") != KDF_HKDF_SHA256:
        raise DecryptionError("unsupported KEM/KDF")
    if int.from_bytes(raw[5:7], "big") != AEAD_AES_256_GCM:
        raise DecryptionError("unsupported AEAD")
    header_end = 8 + raw[7]
    if len(raw) != header_end + N_PK + DEK_BYTES + N_T:
        raise DecryptionError("sealed DEK has the wrong length")
    try:
        kid = raw[8:header_end].decode("ascii")
    except UnicodeDecodeError as exc:
        raise DecryptionError("sealed DEK has an invalid kid") from exc
    if not KID_PATTERN.match(kid):
        raise DecryptionError("sealed DEK has an invalid kid")
    return raw[:header_end], kid, raw[header_end : header_end + N_PK], raw[header_end + N_PK :]


def sealed_dek_kid(sealed: str) -> str:
    """The backend key id a sealed DEK was sealed to (for key lookup / rotation metrics)."""
    return parse_sealed_dek(sealed)[1]


def open_dek(sealed: str, session_id: str, private_keys: PrivateKeyLookup) -> bytes:
    header, kid, enc, ciphertext = parse_sealed_dek(sealed)
    sk = private_keys(kid)
    if sk is None:
        raise DecryptionError(f"no private key for kid {kid}")
    dek = open_base(AEAD_AES_256_GCM, enc, sk, info=DEK_INFO, aad=header + session_id.encode(), ciphertext=ciphertext)
    if len(dek) != DEK_BYTES:
        raise DecryptionError("DEK has the wrong length")
    return dek


def chunk_aad(session_id: str, first_seq: int, last_seq: int, event_count: int) -> bytes:
    return f"shriii/chunk/v1|{session_id}|{first_seq}|{last_seq}|{event_count}".encode()


def _gunzip_bounded(data: bytes, limit: int) -> bytes:
    d = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
    try:
        out = d.decompress(data, limit + 1)
    except zlib.error as exc:
        raise DecryptionError("chunk payload is not valid gzip") from exc
    if len(out) > limit or d.unconsumed_tail:
        raise DecryptionError("chunk payload too large")
    if not d.eof:
        raise DecryptionError("chunk payload is truncated gzip")
    return out


def decrypt_chunk_with_dek(dek: bytes, chunk: Mapping[str, Any], *, verify_events: bool = True) -> list[dict[str, Any]]:
    session_id = str(chunk["session_id"])
    first_seq = int(chunk["first_seq"])
    last_seq = int(chunk["last_seq"])
    event_count = int(chunk["event_count"])
    nonce = _b64(str(chunk["nonce"]), "nonce")
    if len(nonce) != 12:
        raise DecryptionError("nonce must be 12 bytes")
    ciphertext = _b64(str(chunk["ciphertext"]), "ciphertext")
    try:
        compressed = AESGCM(dek).decrypt(nonce, ciphertext, chunk_aad(session_id, first_seq, last_seq, event_count))
    except InvalidTag as exc:
        raise DecryptionError("authentication failed") from exc
    text = _gunzip_bounded(compressed, MAX_CHUNK_PLAINTEXT_BYTES)
    try:
        decoded = text.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise DecryptionError("chunk payload is not UTF-8") from exc
    if decoded and not decoded.endswith("\n"):
        raise DecryptionError("NDJSON not terminated")
    try:
        events = [json.loads(line) for line in decoded.split("\n")[:-1]]
    except json.JSONDecodeError as exc:
        raise DecryptionError("chunk payload is not valid NDJSON") from exc
    if verify_events:
        if len(events) != event_count:
            raise DecryptionError("event_count mismatch")
        for i, ev in enumerate(events):
            if not isinstance(ev, dict):
                raise DecryptionError("event is not an object")
            if ev.get("session_id") != session_id:
                raise DecryptionError("event session_id mismatch")
            if ev.get("seq") != first_seq + i:
                raise DecryptionError("event seq is not contiguous")
    return events


def decrypt_session_chunk(chunk: Mapping[str, Any], private_keys: PrivateKeyLookup) -> list[dict[str, Any]]:
    """Open the sealed DEK and decrypt one encrypted session chunk to its event envelopes."""
    if chunk.get("encryption") != CHUNK_ENCRYPTION:
        raise DecryptionError(f"unsupported chunk encryption {chunk.get('encryption')!r}")
    dek = open_dek(str(chunk["sealed_dek"]), str(chunk["session_id"]), private_keys)
    return decrypt_chunk_with_dek(dek, chunk)
