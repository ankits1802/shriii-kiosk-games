"""RFC 8785 JSON Canonicalization Scheme, used to verify ``UploadBatch.sha256``.

``UploadBatch.sha256`` is the SHA-256 of the JCS serialisation of ``session_chunks`` (contracts
upload-batch.v1). JCS equals ``JSON.stringify`` with recursively sorted keys (UTF-16 code-unit order);
numbers follow ECMAScript ``Number.prototype.toString``.
"""

from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from typing import Any


def _number(value: float) -> str:
    if math.isnan(value) or math.isinf(value):
        raise ValueError("JCS cannot serialise NaN or Infinity")
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    sign = "-" if value < 0 else ""
    _, digit_tuple, exponent = Decimal(repr(abs(value))).as_tuple()
    assert isinstance(exponent, int)
    raw = "".join(str(d) for d in digit_tuple)
    digits = raw.rstrip("0") or "0"
    k = len(digits)
    n = exponent + (len(raw) - k) + k
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


def _utf16_key(s: str) -> bytes:
    return s.encode("utf-16-be")


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
        out.append(_number(value))
    elif isinstance(value, str):
        out.append(json.dumps(value, ensure_ascii=False))
    elif isinstance(value, list | tuple):
        out.append("[")
        for i, item in enumerate(value):
            if i:
                out.append(",")
            _write(item, out)
        out.append("]")
    elif isinstance(value, dict):
        out.append("{")
        for i, key in enumerate(sorted(value, key=_utf16_key)):
            if i:
                out.append(",")
            out.append(json.dumps(key, ensure_ascii=False))
            out.append(":")
            _write(value[key], out)
        out.append("}")
    else:
        raise TypeError(f"JCS cannot serialise {type(value).__name__}")


def canonical(value: Any) -> str:
    out: list[str] = []
    _write(value, out)
    return "".join(out)


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()
