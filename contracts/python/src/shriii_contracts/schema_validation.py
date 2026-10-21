"""Validate plain JSON data against the canonical JSON Schemas with ``jsonschema``.

``mode="strict"`` validates with the schemas exactly as written (writers: unknown properties are
rejected). ``mode="reader"`` relaxes every ``additionalProperties: false`` (tolerant readers),
exactly like the generated TypeScript ``readX`` validators.
"""

from __future__ import annotations

import copy
import json
import re
import uuid
from collections.abc import Iterator
from datetime import date, datetime
from functools import cache
from typing import Any, Literal

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource

from shriii_contracts.paths import schemas_dir

Mode = Literal["strict", "reader"]
BASE = "https://shriii.local/contracts/"
READER_BASE = "https://shriii.local/contracts/reader/"

CONTRACT_FILES: dict[str, str] = {
    "event-envelope": "event-envelope.v1.schema.json",
    "upload-batch": "upload-batch.v1.schema.json",
    "upload-batch-result": "upload-batch-result.v1.schema.json",
    "session-context": "session-context.v1.schema.json",
    "content-manifest": "content-manifest.v1.schema.json",
    "game-trial-spec": "game-trial-spec.v1.schema.json",
    "criterion-response": "criterion-response.v1.schema.json",
    "criterion-scale-score": "criterion-scale-score.v1.schema.json",
    "consent-artefact": "consent-artefact.v1.schema.json",
    "report-artefact": "report-artefact.v1.schema.json",
    "release-pack": "release-pack.v1.schema.json",
    "scoring-dictionary-shared": "scoring-dictionary-shared.v1.schema.json",
    "scoring-dictionary-pathway": "scoring-dictionary-pathway.v1.schema.json",
    "hypotheses": "hypotheses.v1.schema.json",
    "gates": "gates.v1.schema.json",
    "instrument": "instrument.v1.schema.json",
    "game-config": "game-config.v1.schema.json",
    "voice-line-catalogue": "voice-line-catalogue.v1.schema.json",
    "session-plan": "session-plan.v1.schema.json",
}
"""Contract name (kebab-case, as used for fixture folders) -> schema file."""

_RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$")

format_checker = FormatChecker(formats=())


@format_checker.checks("date-time", raises=ValueError)
def _date_time(value: object) -> bool:
    if not isinstance(value, str):
        return True
    if not _RFC3339.match(value):
        return False
    datetime.fromisoformat(value.replace("Z", "+00:00").replace("z", "+00:00"))
    return True


@format_checker.checks("date", raises=ValueError)
def _date(value: object) -> bool:
    if not isinstance(value, str):
        return True
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    date.fromisoformat(value)
    return True


@format_checker.checks("uuid", raises=ValueError)
def _uuid(value: object) -> bool:
    if not isinstance(value, str):
        return True
    uuid.UUID(value)
    return True


def _to_reader(node: Any) -> Any:
    if isinstance(node, list):
        return [_to_reader(n) for n in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key == "additionalProperties" and value is False:
            continue
        if key == "$id" and isinstance(value, str):
            out[key] = value.replace(BASE, READER_BASE)
            continue
        if key == "properties" and isinstance(value, dict):
            out[key] = {pk: _to_reader(pv) for pk, pv in value.items()}
            continue
        out[key] = _to_reader(value)
    return out


@cache
def load_schemas() -> dict[str, dict[str, Any]]:
    """All canonical schemas keyed by file name."""
    return {p.name: json.loads(p.read_text(encoding="utf-8")) for p in sorted(schemas_dir().glob("*.schema.json"))}


@cache
def _registry() -> Registry[Any]:
    registry: Registry[Any] = Registry()
    for schema in load_schemas().values():
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
        reader = _to_reader(copy.deepcopy(schema))
        registry = registry.with_resource(reader["$id"], Resource.from_contents(reader))
    return registry


@cache
def validator_for(contract: str, mode: Mode = "strict") -> Draft202012Validator:
    """A cached ``Draft202012Validator`` for a contract (kebab-case name or schema file name)."""
    file = CONTRACT_FILES.get(contract, contract)
    schema = load_schemas()[file]
    if mode == "reader":
        schema = _to_reader(copy.deepcopy(schema))
    return Draft202012Validator(schema, registry=_registry(), format_checker=format_checker)


def iter_errors(contract: str, data: Any, mode: Mode = "strict") -> Iterator[ValidationError]:
    """Yield every validation error (best match first is not guaranteed)."""
    yield from validator_for(contract, mode).iter_errors(data)


def is_valid(contract: str, data: Any, mode: Mode = "strict") -> bool:
    """True when ``data`` validates against the contract."""
    return validator_for(contract, mode).is_valid(data)


def validate(contract: str, data: Any, mode: Mode = "strict") -> None:
    """Raise :class:`jsonschema.exceptions.ValidationError` on the first error."""
    validator_for(contract, mode).validate(data)
