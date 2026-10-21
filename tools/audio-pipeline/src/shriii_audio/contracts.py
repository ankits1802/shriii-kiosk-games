"""Validate data against the canonical JSON Schemas in ``packages/contracts/schemas`` (read-only)."""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from shriii_audio.paths import schemas_dir

BASE = "https://shriii.local/contracts/"


class ContractError(ValueError):
    """Data does not satisfy a canonical contract schema."""


@cache
def _registry(directory: str) -> Registry:
    resources = []
    for path in sorted(Path(directory).glob("*.schema.json")):
        schema = json.loads(path.read_text(encoding="utf-8"))
        resources.append((BASE + path.name, Resource.from_contents(schema)))
    return Registry().with_resources(resources)


def validate(data: Any, schema_file: str, directory: Path | None = None) -> None:
    """Raise :class:`ContractError` listing every violation of ``schema_file``.

    ``schema_file`` is a canonical schema file name, e.g. ``content-manifest.v1.schema.json``.
    """
    directory = directory or schemas_dir()
    registry = _registry(str(directory))
    schema = registry.contents(BASE + schema_file)
    validator = Draft202012Validator(schema, registry=registry)
    errors = sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
    if errors:
        lines = [f"{'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}" for e in errors[:20]]
        raise ContractError(f"{schema_file}: {len(errors)} violation(s)\n" + "\n".join(lines))
