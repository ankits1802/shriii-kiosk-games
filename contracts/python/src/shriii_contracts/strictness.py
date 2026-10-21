"""Reader/writer strictness helpers for the tolerant Pydantic contract models.

Models accept unknown fields (``extra="allow"``) so the backend can ingest minor N+1 events.
These helpers find those fields, store them separately (``payload_ext``) and enforce the
writer-side rule that our own outgoing records carry no unknown fields.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from shriii_contracts._base import FORBIDDEN_FIELD_NAMES


class UnknownFieldsError(ValueError):
    """Raised when a record intended for writing carries fields outside the contract."""

    def __init__(self, paths: list[str]) -> None:
        super().__init__(f"unknown fields not allowed for writers: {', '.join(paths)}")
        self.paths = paths


def unknown_fields(model: BaseModel, prefix: str = "") -> dict[str, Any]:
    """Return every tolerated unknown field, keyed by JSON pointer, recursing into nested models."""
    found: dict[str, Any] = {}
    for key, value in (model.model_extra or {}).items():
        found[f"{prefix}/{key}"] = value
    for name, info in type(model).model_fields.items():
        attr = getattr(model, name)
        key = info.alias or name
        found.update(_walk(attr, f"{prefix}/{key}"))
    return found


def _walk(value: Any, path: str) -> dict[str, Any]:
    if isinstance(value, BaseModel):
        return unknown_fields(value, path)
    if isinstance(value, list):
        out: dict[str, Any] = {}
        for i, item in enumerate(value):
            out.update(_walk(item, f"{path}/{i}"))
        return out
    return {}


def assert_no_unknown_fields(model: BaseModel) -> None:
    """Writer-side strictness: raise :class:`UnknownFieldsError` if any unknown field exists."""
    extra = unknown_fields(model)
    if extra:
        raise UnknownFieldsError(sorted(extra))


def payload_ext(model: BaseModel) -> dict[str, Any]:
    """Unknown fields to persist in ``payload_ext``, minus privacy-forbidden names.

    Forbidden names (free text, transcripts, audio, ASR alternatives) are dropped even when a newer
    client sends them, so they can never reach storage.
    """
    return {
        path: value
        for path, value in unknown_fields(model).items()
        if path.rsplit("/", 1)[-1] not in FORBIDDEN_FIELD_NAMES
    }
