"""RFC 8785 JSON Canonicalization Scheme (JCS) and hashing helpers.

``UploadBatch.sha256`` is the lower-case hex SHA-256 of the JCS serialisation of ``session_chunks``
(UTF-8). JCS equals ``JSON.stringify`` with recursively sorted keys in JavaScript, so the kiosk can
produce it without a library; this module reproduces it exactly in Python (number formatting follows
ECMAScript ``Number.prototype.toString``; keys are sorted by UTF-16 code units).
"""

from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from typing import Any


def _format_number(value: float) -> str:
    if math.isnan(value) or math.isinf(value):
        raise ValueError("JCS cannot serialise NaN or Infinity")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    dec = Decimal(repr(abs(value)))
    _, digit_tuple, exponent = dec.as_tuple()
    assert isinstance(exponent, int)
    digits = "".join(str(d) for d in digit_tuple).rstrip("0") or "0"
    # value = 0.digits * 10^n  <=>  digits * 10^(n - k)
    trailing_zeros_stripped = len("".join(str(d) for d in digit_tuple)) - len(digits)
    k = len(digits)
    n = exponent + trailing_zeros_stripped + k
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        exp = ("+" if e >= 0 else "-") + str(abs(e))
        out = (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + exp
    return sign + out


def _serialise(value: Any, out: list[str]) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, int):
        out.append(str(value))
    elif isinstance(value, float):
        out.append(_format_number(value))
    elif isinstance(value, str):
        out.append(json.dumps(value, ensure_ascii=False))
    elif isinstance(value, (list, tuple)):
        out.append("[")
        for i, item in enumerate(value):
            if i:
                out.append(",")
            _serialise(item, out)
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
            _serialise(value[key], out)
        out.append("}")
    else:
        raise TypeError(f"cannot canonicalise {type(value).__name__}")


class _NeedsSlowPathError(Exception):
    pass


def _fast_prepare(value: Any) -> Any:
    """Normalise to a structure where ``json.dumps(sort_keys=True)`` equals JCS, or raise.

    Integral floats become ints (JS prints ``60`` for ``60.0``); other floats are kept only when
    Python's ``repr`` already matches ECMAScript (no exponent form); keys beyond the BMP-safe range
    (where code-point order differs from UTF-16 order) force the exact slow path.
    """
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if not isinstance(k, str) or (not k.isascii() and any(ord(c) >= 0xD800 for c in k)):
                raise _NeedsSlowPathError
            out[k] = _fast_prepare(v)
        return out
    if isinstance(value, (list, tuple)):
        return [_fast_prepare(v) for v in value]
    if isinstance(value, float) and not isinstance(value, bool):
        if math.isnan(value) or math.isinf(value):
            raise ValueError("JCS cannot serialise NaN or Infinity")
        if value.is_integer() and abs(value) < 2**53:
            return int(value)
        if value.is_integer() or "e" in repr(value) or "E" in repr(value):
            raise _NeedsSlowPathError
        return value
    return value


def canonical_json(value: Any) -> str:
    """JCS serialisation of a JSON-compatible value."""
    try:
        prepared = _fast_prepare(value)
    except _NeedsSlowPathError:
        out: list[str] = []
        _serialise(value, out)
        return "".join(out)
    return json.dumps(prepared, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def canonical_bytes(value: Any) -> bytes:
    return canonical_json(value).encode("utf-8")


def sha256_hex(data: bytes | str) -> str:
    return hashlib.sha256(data.encode("utf-8") if isinstance(data, str) else data).hexdigest()


def canonical_sha256(value: Any) -> str:
    """Hex SHA-256 of the JCS serialisation (used for batch checksums and job idempotency keys)."""
    return sha256_hex(canonical_bytes(value))
