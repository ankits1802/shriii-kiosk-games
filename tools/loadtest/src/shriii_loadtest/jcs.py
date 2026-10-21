"""RFC 8785 JSON Canonicalization Scheme, client side.

``UploadBatch.sha256`` is the lower-case hex SHA-256 of the JCS serialisation of ``session_chunks``.
This is an independent client implementation (as a kiosk would have), so the load harness does not
import server internals. ``tests/test_jcs.py`` checks it against the API's own implementation.
"""

from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from typing import Any

__all__ = ["canonical_bytes", "canonical_json", "canonical_sha256", "format_number"]


def format_number(value: float) -> str:
    """ECMAScript ``Number.prototype.toString`` for a finite double (shortest round-trip digits)."""
    if math.isnan(value) or math.isinf(value):
        raise ValueError("JCS cannot serialise NaN or Infinity")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    _, digit_tuple, exponent = Decimal(repr(abs(value))).as_tuple()
    assert isinstance(exponent, int)
    all_digits = "".join(str(d) for d in digit_tuple)
    digits = all_digits.rstrip("0") or "0"
    k = len(digits)
    n = exponent + (len(all_digits) - k) + k
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        out = (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + out


def _write(value: Any, out: list[str]) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, int):
        out.append(str(value))
    elif isinstance(value, float):
        out.append(format_number(value))
    elif isinstance(value, str):
        out.append(json.dumps(value, ensure_ascii=False))
    elif isinstance(value, (list, tuple)):
        out.append("[")
        for i, item in enumerate(value):
            if i:
                out.append(",")
            _write(item, out)
        out.append("]")
    elif isinstance(value, dict):
        out.append("{")
        for i, key in enumerate(sorted(value, key=lambda s: str(s).encode("utf-16-be"))):
            if not isinstance(key, str):
                raise TypeError("JCS object keys must be strings")
            if i:
                out.append(",")
            out.append(json.dumps(key, ensure_ascii=False))
            out.append(":")
            _write(value[key], out)
        out.append("}")
    else:
        raise TypeError(f"cannot canonicalise {type(value).__name__}")


class _SlowPath(Exception):
    pass


def _prepare(value: Any) -> Any:
    """Normalise so that ``json.dumps(sort_keys=True)`` equals JCS, or raise ``_SlowPath``."""
    if isinstance(value, dict):
        prepared: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str) or any(ord(c) >= 0xD800 for c in key):
                raise _SlowPath
            prepared[key] = _prepare(item)
        return prepared
    if isinstance(value, (list, tuple)):
        return [_prepare(v) for v in value]
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise ValueError("JCS cannot serialise NaN or Infinity")
        if value.is_integer() and abs(value) < 2**53:
            return int(value)
        text = repr(value)
        if value.is_integer() or "e" in text or "E" in text:
            raise _SlowPath
    return value


def canonical_json(value: Any) -> str:
    try:
        prepared = _prepare(value)
    except _SlowPath:
        out: list[str] = []
        _write(value, out)
        return "".join(out)
    return json.dumps(prepared, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def canonical_bytes(value: Any) -> bytes:
    return canonical_json(value).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()
