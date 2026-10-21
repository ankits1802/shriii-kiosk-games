"""Tests for the contract compatibility checker (.github/scripts/schema_compat.py)."""

from __future__ import annotations

import copy
import json
import shutil
from pathlib import Path
from typing import Any

import pytest
import schema_compat as sc

REPO = Path(__file__).resolve().parents[3]
SCHEMAS = REPO / "packages" / "contracts" / "schemas"

OBJ: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://shriii.local/contracts/thing.v1.schema.json",
    "title": "Thing",
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "kind": {"type": "string", "enum": ["a", "b"]},
        "n": {"type": "integer", "minimum": 0, "maximum": 10},
        "code": {"type": "string", "pattern": "^[a-z]+$"},
        "tags": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
    },
    "required": ["kind"],
    "$defs": {"id": {"type": "string", "minLength": 1}},
}


def diff(old: Any, new: Any) -> list[tuple[str, str, str]]:
    c = sc.Comparer("thing.v1.schema.json")
    c.compare(old, new)
    return sorted((ch.severity, ch.pointer, ch.message) for ch in c.changes)


def severities(old: Any, new: Any) -> list[str]:
    return sorted({s for s, _, _ in diff(old, new)})


def mutate(fn: Any) -> dict[str, Any]:
    new = copy.deepcopy(OBJ)
    fn(new)
    return new


def test_identical_and_annotation_only_changes_are_clean() -> None:
    assert diff(OBJ, copy.deepcopy(OBJ)) == []
    new = mutate(lambda s: s.update(title="Renamed", description="docs", examples=[{}]))
    new["properties"]["n"]["description"] = "count"
    new["properties"]["n"]["x-ui"] = "slider"
    assert diff(OBJ, new) == []


def test_new_required_field_is_breaking() -> None:
    def add(s: dict[str, Any]) -> None:
        s["properties"]["extra"] = {"type": "string"}
        s["required"].append("extra")

    assert diff(OBJ, mutate(add)) == [("breaking", "#/required", "property 'extra' became required")]


def test_optional_field_is_minor() -> None:
    new = mutate(lambda s: s["properties"].update(extra={"type": "string"}))
    assert severities(OBJ, new) == ["minor"]


def test_removed_property_on_closed_object_is_breaking() -> None:
    new = mutate(lambda s: s["properties"].pop("code"))
    assert severities(OBJ, new) == ["breaking"]
    open_old = mutate(lambda s: s.pop("additionalProperties"))
    open_new = copy.deepcopy(open_old)
    open_new["properties"].pop("code")
    assert severities(open_old, open_new) == ["minor"]


@pytest.mark.parametrize(
    ("path", "value", "expected"),
    [
        (("properties", "kind", "enum"), ["a"], "breaking"),
        (("properties", "kind", "enum"), ["a", "b", "c"], "forward"),
        (("properties", "n", "type"), "number", "forward"),
        (("properties", "n", "type"), "string", "breaking+forward"),
        (("properties", "n", "minimum"), 1, "breaking"),
        (("properties", "n", "maximum"), 20, "forward"),
        (("properties", "tags", "maxItems"), 3, "breaking"),
        (("properties", "code", "pattern"), "^[a-z0-9]+$", "breaking"),
        (("additionalProperties",), True, "minor"),
        (("$defs", "id", "minLength"), 0, "forward"),
        (("properties", "tags", "items", "type"), ["string", "null"], "forward"),
    ],
)
def test_keyword_classification(path: tuple[str, ...], value: Any, expected: str) -> None:
    def set_path(s: dict[str, Any]) -> None:
        node = s
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = value

    assert severities(OBJ, mutate(set_path)) == expected.split("+")


def test_number_to_integer_is_narrowing() -> None:
    old = {"type": "number"}
    assert severities(old, {"type": "integer"}) == ["breaking"]
    assert severities({"type": "integer"}, old) == ["forward"]


def test_closing_additional_properties_and_removing_defs_are_breaking() -> None:
    old = mutate(lambda s: s.pop("additionalProperties"))
    assert severities(old, OBJ) == ["breaking"]
    assert severities(OBJ, mutate(lambda s: s["$defs"].pop("id"))) == ["breaking"]
    assert severities(OBJ, mutate(lambda s: s["$defs"].update(more={"type": "string"}))) == ["minor"]


def test_ref_change_is_breaking() -> None:
    old = {"properties": {"x": {"$ref": "common.v1.schema.json#/$defs/uuid"}}}
    new = {"properties": {"x": {"$ref": "common.v1.schema.json#/$defs/uuidv7"}}}
    assert severities(old, new) == ["breaking"]


def _union(*types: str, payload_required: bool = True) -> dict[str, Any]:
    return {
        "discriminator": {"propertyName": "event_type"},
        "oneOf": [
            {
                "type": "object",
                "properties": {"event_type": {"const": t}, "payload": {"type": "object"}},
                "required": ["event_type", "payload"] if payload_required else ["event_type"],
            }
            for t in types
        ],
    }


def test_discriminated_union_branches_match_by_const() -> None:
    assert diff(_union("a", "b"), _union("b", "a")) == []  # reordering is not a change
    assert diff(_union("a", "b"), _union("a", "b", "c")) == [("forward", "#/oneOf[event_type=c]", "union branch added")]
    assert diff(_union("a", "b"), _union("a")) == [("breaking", "#/oneOf[event_type=b]", "union branch removed")]
    assert severities(_union("a", payload_required=False), _union("a")) == ["breaking"]


def test_composition_direction() -> None:
    assert severities({"allOf": [{"type": "object"}]}, {"allOf": [{"type": "object"}, {"required": ["x"]}]}) == [
        "breaking"
    ]
    assert severities({"anyOf": [{"type": "string"}]}, {"anyOf": [{"type": "string"}, {"type": "null"}]}) == ["forward"]


def test_boolean_schemas() -> None:
    assert severities({"items": True}, {"items": False}) == ["breaking"]
    assert severities({"items": False}, {"items": {"type": "string"}}) == ["forward"]
    assert severities({"items": True}, {"items": {"type": "string"}}) == ["breaking"]
    assert severities({"items": {"type": "string"}}, {"items": True}) == ["forward"]
    assert diff({"items": True}, {"items": {}}) == []


def test_unknown_keyword_change_needs_review() -> None:
    assert severities({"if": {"type": "string"}}, {"if": {"type": "number"}}) == ["breaking"]


# ----------------------------------------------------------------------------- directories and policy


def write(dir_: Path, name: str, schema: dict[str, Any]) -> None:
    dir_.mkdir(parents=True, exist_ok=True)
    (dir_ / name).write_text(json.dumps(schema), encoding="utf-8")


def test_real_contracts_are_compatible_with_themselves() -> None:
    assert sc.compare_dirs(SCHEMAS, SCHEMAS, SCHEMAS.parent / "migrations") == []


def test_real_event_envelope_mutations(tmp_path: Path) -> None:
    head = tmp_path / "head"
    shutil.copytree(SCHEMAS, head)
    env_path = head / "event-envelope.v1.schema.json"
    env = json.loads(env_path.read_text(encoding="utf-8"))
    removed = env["oneOf"].pop()
    env_path.write_text(json.dumps(env), encoding="utf-8")
    changes = sc.compare_dirs(SCHEMAS, head, tmp_path / "migrations")
    branch = removed["properties"]["event_type"]["const"]
    assert [(c.severity, c.pointer) for c in changes] == [("breaking", f"#/oneOf[event_type={branch}]")]


def test_new_major_requires_migration_notes(tmp_path: Path) -> None:
    base, head, notes = tmp_path / "base", tmp_path / "head", tmp_path / "migrations"
    write(base, "thing.v1.schema.json", OBJ)
    write(head, "thing.v1.schema.json", OBJ)
    write(head, "thing.v2.schema.json", mutate(lambda s: s["required"].append("n")))
    changes = sc.compare_dirs(base, head, notes)
    assert [(c.severity, c.schema) for c in changes] == [("breaking", "thing.v2.schema.json")]
    notes.mkdir()
    (notes / "thing.v2.md").write_text("# thing v2\n\n`n` is now required; upcaster fills 0.\n", encoding="utf-8")
    changes = sc.compare_dirs(base, head, notes)
    assert [c.severity for c in changes] == ["minor"]


def test_removing_a_schema_file(tmp_path: Path) -> None:
    base, head, notes = tmp_path / "base", tmp_path / "head", tmp_path / "migrations"
    write(base, "thing.v1.schema.json", OBJ)
    write(head, "other.v1.schema.json", OBJ)
    changes = {c.schema: c.severity for c in sc.compare_dirs(base, head, notes)}
    assert changes == {"thing.v1.schema.json": "breaking", "other.v1.schema.json": "minor"}

    write(head, "thing.v2.schema.json", OBJ)
    notes.mkdir()
    (notes / "thing.v2.md").write_text("notes", encoding="utf-8")
    changes = {c.schema: c.severity for c in sc.compare_dirs(base, head, notes)}
    assert changes["thing.v1.schema.json"] == "minor"


def test_badly_named_new_file_is_rejected(tmp_path: Path) -> None:
    write(tmp_path / "head", "thing.schema.json", OBJ)
    (tmp_path / "base").mkdir()
    changes = sc.compare_dirs(tmp_path / "base", tmp_path / "head", tmp_path / "m")
    assert [c.severity for c in changes] == ["breaking"]


def test_cli(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    base, head = tmp_path / "base", tmp_path / "head"
    write(base, "thing.v1.schema.json", OBJ)
    write(head, "thing.v1.schema.json", mutate(lambda s: s["properties"]["kind"]["enum"].append("c")))
    out = tmp_path / "report.md"
    assert sc.main(["--base", str(base), "--head", str(head), "--out", str(out)]) == 0
    text = capsys.readouterr().out
    assert "**PASS**" in text and "enum values added" in text and out.read_text(encoding="utf-8") == text
    # The kiosk deploy-order gate fails on forward changes.
    assert sc.main(["--base", str(base), "--head", str(head), "--fail-on", "forward", "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False and payload["changes"][0]["severity"] == "forward"
    assert sc.main(["--base", str(base), "--head", str(tmp_path / "nope")]) == 2
    # A missing base directory (first PR introducing contracts) means everything is new.
    assert sc.main(["--base", str(tmp_path / "none"), "--head", str(head)]) == 0
