"""JSON Schema validation for the harness's own schemas (schemas/*.schema.json)."""

from __future__ import annotations

import json
from functools import cache
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from shriii_asr_bakeoff.config import SCHEMA_DIR


class SchemaError(ValueError):
    pass


@cache
def _validator(name: str) -> Draft202012Validator:
    schema = json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def validate(data: Any, name: str) -> None:
    errors = sorted(_validator(name).iter_errors(data), key=lambda e: list(e.absolute_path))
    if errors:
        lines = [f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}" for e in errors[:15]]
        raise SchemaError(f"{name}: {len(errors)} violation(s)\n" + "\n".join(lines))
