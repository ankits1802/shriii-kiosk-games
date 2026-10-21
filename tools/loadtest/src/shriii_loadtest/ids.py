"""Identifiers as the kiosk mints them: UUIDv7 (RFC 9562) and pseudonymous pids."""

from __future__ import annotations

import os
import random
import time
import uuid

__all__ = ["CROCKFORD", "luhn32_check", "pseudonymous_pid", "uuid7", "uuid7_from"]

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_INDEX = {c: i for i, c in enumerate(CROCKFORD)}


def uuid7(unix_ms: int | None = None) -> str:
    ms = time.time_ns() // 1_000_000 if unix_ms is None else unix_ms
    return _compose(ms, int.from_bytes(os.urandom(10), "big"))


def uuid7_from(rng: random.Random, unix_ms: int) -> str:
    """Deterministic UUIDv7 for reproducible plans (same seed -> same ids)."""
    return _compose(unix_ms, rng.getrandbits(80))


def _compose(unix_ms: int, rand: int) -> str:
    value = (unix_ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= ((rand >> 62) & 0xFFF) << 64
    value |= 0b10 << 62
    value |= rand & ((1 << 62) - 1)
    return str(uuid.UUID(int=value))


def luhn32_check(body: str) -> str:
    """Luhn mod-32 check character over a Crockford base32 body (the API's pid scheme)."""
    factor, total = 2, 0
    for ch in reversed(body):
        addend = factor * _INDEX[ch]
        factor = 1 if factor == 2 else 2
        total += addend // 32 + addend % 32
    return CROCKFORD[(32 - total % 32) % 32]


def pseudonymous_pid(rng: random.Random, body_len: int = 9) -> str:
    """Random pid (Crockford base32 + Luhn mod-32 check character). It carries no identity data."""
    body = "".join(rng.choice(CROCKFORD) for _ in range(body_len))
    return body + luhn32_check(body)
