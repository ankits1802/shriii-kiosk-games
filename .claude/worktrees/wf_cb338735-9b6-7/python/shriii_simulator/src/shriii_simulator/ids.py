"""Deterministic identifiers for synthetic data (UUIDv7, pseudonymous ids, hashes)."""

from __future__ import annotations

import hashlib

import numpy as np

__all__ = ["CROCKFORD", "fake_sha256", "pid", "uuid7"]

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def uuid7(rng: np.random.Generator, unix_ms: int) -> str:
    """RFC 9562 UUIDv7 with the given millisecond timestamp and random bits from ``rng``."""
    rand_a = int(rng.integers(0, 1 << 12))
    rand_b = int(rng.integers(0, 1 << 62))
    value = (unix_ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= rand_a << 64
    value |= 0b10 << 62
    value |= rand_b
    h = f"{value:032x}"
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def pid(rng: np.random.Generator, length: int = 10) -> str:
    """Pseudonymous participant id in Crockford base32 (synthetic; contains no identity data)."""
    return "".join(CROCKFORD[int(i)] for i in rng.integers(0, 32, length))


def fake_sha256(label: str) -> str:
    """A stable SHA-256 for synthetic version tuples (hash of a label)."""
    return hashlib.sha256(label.encode()).hexdigest()
