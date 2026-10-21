"""RFC 9180 HPKE base mode for DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-GCM.

Mirror of ``frontend/packages/session-crypto/src/hpke.ts``. Built on ``cryptography`` primitives (X25519,
HMAC-SHA256, AES-GCM) and verified against the RFC 9180 known-answer vectors.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

KEM_X25519_HKDF_SHA256 = 0x0020
KDF_HKDF_SHA256 = 0x0001
AEAD_AES_128_GCM = 0x0001
AEAD_AES_256_GCM = 0x0002

N_SECRET = 32
N_PK = 32
N_SK = 32
N_H = 32
N_N = 12
N_T = 16
_MODE_BASE = 0
_HPKE_V1 = b"HPKE-v1"
_KEM_SUITE_ID = b"KEM" + KEM_X25519_HKDF_SHA256.to_bytes(2, "big")


class DecryptionError(Exception):
    """Authentication or format failure. Never carries key material."""


def _aead_key_length(aead: int) -> int:
    if aead == AEAD_AES_128_GCM:
        return 16
    if aead == AEAD_AES_256_GCM:
        return 32
    raise ValueError(f"unsupported AEAD {aead}")


def _hpke_suite_id(aead: int) -> bytes:
    return (
        b"HPKE"
        + KEM_X25519_HKDF_SHA256.to_bytes(2, "big")
        + KDF_HKDF_SHA256.to_bytes(2, "big")
        + aead.to_bytes(2, "big")
    )


def hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    return hmac.new(salt, ikm, hashlib.sha256).digest()


def hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    if length > 255 * N_H:
        raise ValueError("hkdf_expand: length too large")
    out = b""
    block = b""
    counter = 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
        counter += 1
    return out[:length]


def _labeled_extract(suite_id: bytes, salt: bytes, label: str, ikm: bytes) -> bytes:
    return hkdf_extract(salt, _HPKE_V1 + suite_id + label.encode() + ikm)


def _labeled_expand(suite_id: bytes, prk: bytes, label: str, info: bytes, length: int) -> bytes:
    labeled_info = length.to_bytes(2, "big") + _HPKE_V1 + suite_id + label.encode() + info
    return hkdf_expand(prk, labeled_info, length)


def public_from_private(sk: bytes) -> bytes:
    return X25519PrivateKey.from_private_bytes(sk).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def derive_key_pair(ikm: bytes) -> tuple[bytes, bytes]:
    """RFC 9180 section 7.1.3 DeriveKeyPair for X25519; returns (sk, pk)."""
    if len(ikm) < N_SK:
        raise ValueError("ikm must be >= 32 bytes")
    dkp_prk = _labeled_extract(_KEM_SUITE_ID, b"", "dkp_prk", ikm)
    sk = _labeled_expand(_KEM_SUITE_ID, dkp_prk, "sk", b"", N_SK)
    return sk, public_from_private(sk)


def _dh(sk: bytes, pk: bytes) -> bytes:
    try:
        shared = X25519PrivateKey.from_private_bytes(sk).exchange(X25519PublicKey.from_public_bytes(pk))
    except ValueError as exc:  # cryptography rejects the all-zero shared secret
        raise DecryptionError("X25519: low-order public key") from exc
    if shared == bytes(len(shared)):
        raise DecryptionError("X25519: low-order public key")
    return shared


def _extract_and_expand(dh: bytes, kem_context: bytes) -> bytes:
    eae_prk = _labeled_extract(_KEM_SUITE_ID, b"", "eae_prk", dh)
    return _labeled_expand(_KEM_SUITE_ID, eae_prk, "shared_secret", kem_context, N_SECRET)


def encap(pk_r: bytes, ikm_e: bytes) -> tuple[bytes, bytes]:
    """Deterministic Encap (tests only); returns (shared_secret, enc)."""
    sk_e, pk_e = derive_key_pair(ikm_e)
    return _extract_and_expand(_dh(sk_e, pk_r), pk_e + pk_r), pk_e


def decap(enc: bytes, sk_r: bytes) -> bytes:
    if len(enc) != N_PK:
        raise DecryptionError("enc must be 32 bytes")
    return _extract_and_expand(_dh(sk_r, enc), enc + public_from_private(sk_r))


@dataclass(frozen=True)
class KeySchedule:
    key: bytes
    base_nonce: bytes
    exporter_secret: bytes
    key_schedule_context: bytes
    secret: bytes


def key_schedule(aead: int, shared_secret: bytes, info: bytes) -> KeySchedule:
    suite_id = _hpke_suite_id(aead)
    psk_id_hash = _labeled_extract(suite_id, b"", "psk_id_hash", b"")
    info_hash = _labeled_extract(suite_id, b"", "info_hash", info)
    ksc = bytes([_MODE_BASE]) + psk_id_hash + info_hash
    secret = _labeled_extract(suite_id, shared_secret, "secret", b"")
    return KeySchedule(
        key=_labeled_expand(suite_id, secret, "key", ksc, _aead_key_length(aead)),
        base_nonce=_labeled_expand(suite_id, secret, "base_nonce", ksc, N_N),
        exporter_secret=_labeled_expand(suite_id, secret, "exp", ksc, N_H),
        key_schedule_context=ksc,
        secret=secret,
    )


class HpkeContext:
    """RFC 9180 section 5.2 encryption context with sequence-number nonces."""

    def __init__(self, aead: int, schedule: KeySchedule) -> None:
        self.aead = aead
        self.schedule = schedule
        self._seq = 0
        self._cipher = AESGCM(schedule.key)

    def _nonce(self) -> bytes:
        seq = self._seq.to_bytes(N_N, "big")
        return bytes(a ^ b for a, b in zip(self.schedule.base_nonce, seq, strict=True))

    def seal(self, aad: bytes, plaintext: bytes) -> bytes:
        out = self._cipher.encrypt(self._nonce(), plaintext, aad)
        self._seq += 1
        return out

    def open(self, aad: bytes, ciphertext: bytes) -> bytes:
        try:
            out = self._cipher.decrypt(self._nonce(), ciphertext, aad)
        except InvalidTag as exc:
            raise DecryptionError("authentication failed") from exc
        self._seq += 1
        return out


def setup_base_s(aead: int, pk_r: bytes, info: bytes, ikm_e: bytes) -> tuple[bytes, HpkeContext]:
    shared_secret, enc = encap(pk_r, ikm_e)
    return enc, HpkeContext(aead, key_schedule(aead, shared_secret, info))


def setup_base_r(aead: int, enc: bytes, sk_r: bytes, info: bytes) -> HpkeContext:
    return HpkeContext(aead, key_schedule(aead, decap(enc, sk_r), info))


def open_base(aead: int, enc: bytes, sk_r: bytes, *, info: bytes, aad: bytes, ciphertext: bytes) -> bytes:
    return setup_base_r(aead, enc, sk_r, info).open(aad, ciphertext)
