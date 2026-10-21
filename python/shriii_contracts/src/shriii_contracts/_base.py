"""Base model and format validators shared by the generated contract models."""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict

FORBIDDEN_FIELD_NAMES: frozenset[str] = frozenset({"text", "free_text", "transcript", "audio", "asr_alternatives"})
"""Field names that must never be stored, even as tolerated unknown fields (PLT-02, PRV-03)."""

StrictFloatOrInt = float
"""JSON ``number``: in strict mode Pydantic accepts int and float but never strings or bools."""

_RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$",
)


def _check_date_time(value: str) -> str:
    """RFC 3339 date-time with a mandatory offset (mirrors ajv-formats ``date-time``)."""
    if not _RFC3339.match(value):
        raise ValueError("must be an RFC 3339 date-time with offset")
    normalised = value.replace("Z", "+00:00").replace("z", "+00:00")
    try:
        datetime.fromisoformat(normalised)
    except ValueError as exc:  # pragma: no cover - regex catches nearly all cases
        raise ValueError("invalid date-time") from exc
    return value


def _check_date(value: str) -> str:
    """Full-date (YYYY-MM-DD)."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("must be YYYY-MM-DD")
    date.fromisoformat(value)
    return value


def _check_uuid(value: str) -> str:
    """RFC 9562 UUID string."""
    uuid.UUID(value)
    return value


def _unique(values: list[Any]) -> list[Any]:
    """``uniqueItems``: reject duplicates (compared by their JSON-ish representation)."""
    seen: list[Any] = []
    for v in values:
        key = v.model_dump(mode="json") if isinstance(v, BaseModel) else v
        if key in seen:
            raise ValueError("items must be unique")
        seen.append(key)
    return values


class ContractModel(BaseModel):
    """Base for every generated contract model.

    * ``strict=True`` mirrors JSON Schema types (no string-to-number coercion).
    * ``extra="allow"`` makes models *tolerant readers*: unknown fields from a newer minor version
      are retained in ``model_extra`` (stored by the backend in ``payload_ext``), never rejected.
      Use :func:`shriii_contracts.strictness.assert_no_unknown_fields` for writer-side strictness.
    """

    model_config = ConfigDict(
        strict=True,
        extra="allow",
        validate_default=False,
        protected_namespaces=(),
        validate_by_name=True,
        validate_by_alias=True,
        serialize_by_alias=True,
        ser_json_inf_nan="strings",
    )
