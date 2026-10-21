"""Locate the tool's schemas and default thresholds, load and validate inputs."""

from __future__ import annotations

import csv
import hashlib
import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator

TOOL_ROOT = Path(__file__).resolve().parents[2]
SCHEMAS_DIR = TOOL_ROOT / "schemas"
DEFAULT_THRESHOLDS = TOOL_ROOT / "config" / "thresholds.yaml"

CAPTURE_FORMAT = "shriii.timing-capture/1"
PROFILE_SCHEMA = "shriii.timing-profile/1"


@cache
def _validator(name: str) -> Draft202012Validator:
    schema = json.loads((SCHEMAS_DIR / name).read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


def schema_errors(name: str, doc: Any) -> list[str]:
    """Human-readable validation errors of ``doc`` against a tool schema (empty when valid)."""
    errors = sorted(_validator(name).iter_errors(doc), key=lambda e: list(e.absolute_path))
    return [f"{'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}" for e in errors]


class InputError(ValueError):
    """An input file is missing, malformed or fails its schema."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_json(doc: Any) -> str:
    """SHA-256 of the sorted-key compact JSON serialisation (used for content addressing)."""
    return sha256_bytes(json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def load_capture(path: Path) -> tuple[dict[str, Any], str]:
    """Load and schema-check a page capture; returns the document and the file's SHA-256."""
    raw = path.read_bytes()
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise InputError(f"{path}: not JSON ({exc})") from exc
    errs = schema_errors("capture.v1.schema.json", doc)
    if errs:
        raise InputError(f"{path}: capture fails capture.v1 schema:\n  " + "\n  ".join(errs[:20]))
    return doc, sha256_bytes(raw)


@dataclass(frozen=True, slots=True)
class Thresholds:
    """Acceptance thresholds (``config/thresholds.yaml``) with their content hash."""

    data: dict[str, Any]
    sha256: str

    def get(self, dotted: str) -> Any:
        node: Any = self.data
        for part in dotted.split("."):
            if not isinstance(node, dict) or part not in node:
                raise KeyError(f"thresholds: missing key {dotted!r}")
            node = node[part]
        return node

    def f(self, dotted: str) -> float:
        return float(self.get(dotted))

    def i(self, dotted: str) -> int:
        return int(self.get(dotted))


def load_thresholds(path: Path | None = None) -> Thresholds:
    p = path or DEFAULT_THRESHOLDS
    raw = p.read_bytes()
    data = yaml.safe_load(raw)
    if not isinstance(data, dict):
        raise InputError(f"{p}: thresholds must be a mapping")
    return Thresholds(data=data, sha256=sha256_bytes(raw))


def read_csv_columns(path: Path, required: tuple[str, ...]) -> tuple[dict[str, list[float]], str]:
    """Read numeric columns from a CSV with a header row. Blank cells become NaN.

    Lines starting with ``#`` are comments (rig firmware often writes a preamble)."""
    raw = path.read_bytes()
    text = raw.decode("utf-8-sig")
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    reader = csv.DictReader(lines)
    if reader.fieldnames is None:
        raise InputError(f"{path}: empty CSV")
    names = [n.strip() for n in reader.fieldnames]
    missing = [c for c in required if c not in names]
    if missing:
        raise InputError(f"{path}: missing column(s) {missing}; found {names}")
    out: dict[str, list[float]] = {n: [] for n in names}
    for lineno, row in enumerate(reader, start=2):
        for key, value in row.items():
            if key is None:
                raise InputError(f"{path}:{lineno}: more cells than header columns")
            cell = (value or "").strip()
            try:
                out[key.strip()].append(float(cell) if cell else float("nan"))
            except ValueError as exc:
                raise InputError(f"{path}:{lineno}: column {key!r} is not numeric: {cell!r}") from exc
    return out, sha256_bytes(raw)
