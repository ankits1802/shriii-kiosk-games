"""Cryptographic primitives: pseudonymous ids, HMAC, DEK unsealing/re-wrapping and Ed25519 signing.

* pids and pairing codes are Crockford base32 with a Luhn mod-32 check character (detects every
  single-character error and adjacent transpositions); the check stays inside the ``pid`` pattern.
* Session DEKs arrive sealed to the backend X25519 key (libsodium ``crypto_box_seal``); chunk
  ciphertext is AES-256-GCM with a 12-byte nonce and no associated data. The unsealed DEK is
  re-wrapped under the KMS-style KEK (AES-256-GCM, AAD = session id) and stored in
  ``consent.session_keys``; deleting that row crypto-shreds every stored copy of the chunk.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time
import uuid

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from nacl.exceptions import CryptoError
from nacl.public import PrivateKey, SealedBox

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_INDEX = {c: i for i, c in enumerate(CROCKFORD)}
_NORMALISE = str.maketrans({"I": "1", "L": "1", "O": "0", "-": None, " ": None})
PID_BODY_LEN = 9
PAIRING_BODY_LEN = 5


class CryptoFailureError(Exception):
    """Decryption, unsealing or signature verification failed."""


# ---------------------------------------------------------------- Crockford base32 + Luhn mod 32


def _luhn_check_char(body: str) -> str:
    factor = 2
    total = 0
    for ch in reversed(body):
        addend = factor * _INDEX[ch]
        factor = 1 if factor == 2 else 2
        total += addend // 32 + addend % 32
    return CROCKFORD[(32 - total % 32) % 32]


def normalise_code(code: str) -> str:
    """Upper-case and apply Crockford substitutions (I/L -> 1, O -> 0, drop hyphens/spaces)."""
    return code.strip().upper().translate(_NORMALISE)


def is_valid_code(code: str) -> bool:
    """True when ``code`` (already normalised) is Crockford base32 with a valid check character."""
    if len(code) < 2 or any(c not in _INDEX for c in code):
        return False
    return _luhn_check_char(code[:-1]) == code[-1]


def _random_body(length: int) -> str:
    return "".join(secrets.choice(CROCKFORD) for _ in range(length))


def new_pid() -> str:
    """Random pseudonymous participant id (45 random bits + check character)."""
    body = _random_body(PID_BODY_LEN)
    return body + _luhn_check_char(body)


def derive_pid(pepper: bytes, namespace: str, external_ref: str) -> str:
    """Deterministic pid for reconciling an external identifier (keyed HMAC; the ref is never stored)."""
    digest = hmac.new(pepper, f"{namespace}\x1f{external_ref}".encode(), hashlib.sha256).digest()
    bits = int.from_bytes(digest, "big")
    body = "".join(CROCKFORD[(bits >> (5 * i)) & 31] for i in range(PID_BODY_LEN))
    return body + _luhn_check_char(body)


def new_pairing_code() -> str:
    """6-character Crockford base32 pairing code with check character (CRT-06)."""
    body = _random_body(PAIRING_BODY_LEN)
    return body + _luhn_check_char(body)


def new_uuid7() -> uuid.UUID:
    """RFC 9562 UUIDv7 (millisecond timestamp + 74 random bits) for session and batch ids."""
    unix_ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10), "big")
    value = (unix_ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= ((rand >> 62) & 0xFFF) << 64
    value |= 0b10 << 62
    value |= rand & ((1 << 62) - 1)
    return uuid.UUID(int=value)


def new_opaque_token(nbytes: int = 24) -> str:
    return secrets.token_urlsafe(nbytes)


def new_report_token() -> str:
    """Opaque 128-bit report retrieval token (hex, matches ReportArtefact.token)."""
    return secrets.token_hex(16)


def keyed_hmac(pepper: bytes, value: str) -> str:
    return hmac.new(pepper, value.encode(), hashlib.sha256).hexdigest()


def token_digest(token: str) -> str:
    """Storage digest of a bearer secret (device tokens, QR tokens)."""
    return hashlib.sha256(token.encode()).hexdigest()


# ---------------------------------------------------------------- DEKs and chunk decryption


def unseal_dek(private_key: bytes, sealed_dek_b64: str) -> bytes:
    try:
        dek = SealedBox(PrivateKey(private_key)).decrypt(base64.b64decode(sealed_dek_b64))
    except (CryptoError, ValueError) as exc:
        raise CryptoFailureError("cannot unseal session DEK") from exc
    if len(dek) != 32:
        raise CryptoFailureError("session DEK must be 32 bytes")
    return dek


def decrypt_chunk(dek: bytes, nonce_b64: str, ciphertext_b64: str) -> bytes:
    try:
        return AESGCM(dek).decrypt(base64.b64decode(nonce_b64), base64.b64decode(ciphertext_b64), None)
    except (InvalidTag, ValueError) as exc:
        raise CryptoFailureError("chunk authentication failed") from exc


def seal_dek(public_key: bytes, dek: bytes) -> str:
    """Kiosk-side helper (tests, simulator): seal a DEK to the backend public key."""
    from nacl.public import PublicKey  # noqa: PLC0415

    return base64.b64encode(SealedBox(PublicKey(public_key)).encrypt(dek)).decode()


def encrypt_chunk(dek: bytes, plaintext: bytes) -> tuple[str, str]:
    """Kiosk-side helper (tests, simulator): AES-256-GCM encrypt; returns (nonce_b64, ciphertext_b64)."""
    nonce = os.urandom(12)
    return base64.b64encode(nonce).decode(), base64.b64encode(AESGCM(dek).encrypt(nonce, plaintext, None)).decode()


def x25519_public_key(private_key: bytes) -> bytes:
    return bytes(PrivateKey(private_key).public_key)


def wrap_key(kek: bytes, key: bytes, aad: str) -> tuple[bytes, bytes]:
    nonce = os.urandom(12)
    return nonce, AESGCM(kek).encrypt(nonce, key, aad.encode())


def unwrap_key(kek: bytes, nonce: bytes, wrapped: bytes, aad: str) -> bytes:
    try:
        return AESGCM(kek).decrypt(nonce, wrapped, aad.encode())
    except InvalidTag as exc:
        raise CryptoFailureError("cannot unwrap key") from exc


def encrypt_field(key: bytes, plaintext: str, aad: str) -> bytes:
    """Column envelope encryption (identity vault): nonce || ciphertext."""
    nonce = os.urandom(12)
    return nonce + AESGCM(key).encrypt(nonce, plaintext.encode(), aad.encode())


def decrypt_field(key: bytes, blob: bytes, aad: str) -> str:
    try:
        return AESGCM(key).decrypt(blob[:12], blob[12:], aad.encode()).decode()
    except InvalidTag as exc:
        raise CryptoFailureError("cannot decrypt field") from exc


# ---------------------------------------------------------------- Ed25519


def sign_ed25519(seed: bytes, message: bytes) -> str:
    return base64.b64encode(Ed25519PrivateKey.from_private_bytes(seed).sign(message)).decode()


def ed25519_public_key(seed: bytes) -> bytes:
    from cryptography.hazmat.primitives import serialization  # noqa: PLC0415

    return (
        Ed25519PrivateKey.from_private_bytes(seed)
        .public_key()
        .public_bytes(encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw)
    )


def verify_ed25519(public_key: bytes, message: bytes, signature_b64: str) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(base64.b64decode(signature_b64), message)
    except (InvalidSignature, ValueError):
        return False
    return True
