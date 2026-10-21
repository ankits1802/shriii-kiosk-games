"""Verify a generated document (Markdown, HTML or JSON) against the current inputs.

The embedded manifest lists each input's repository-relative path and SHA-256. Verification re-hashes the
files under the repository root and reports any input that changed, is missing, or was added/removed.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from shriii_scoring.resources import sha256_bytes

__all__ = ["VerificationResult", "extract_manifest", "verify_document"]

_COMMENT = re.compile(r"<!--\s*shriii-prereg-inputs:\s*(\{.*?\})\s*-->", re.DOTALL)


@dataclass(frozen=True, slots=True)
class VerificationResult:
    ok: bool
    checked: list[dict[str, Any]] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)


def extract_manifest(path: Path) -> dict[str, Any]:
    """The embedded input manifest from a generated ``.md``/``.html`` (comment) or ``.json`` document."""
    raw = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        doc = json.loads(raw)
        if doc.get("schema") != "shriii-prereg-document":
            raise ValueError(f"{path} is not a shriii-prereg-document")
        return {"inputs": doc["inputs"], "generated_at": doc["meta"]["generated_at"]}
    m = _COMMENT.search(raw)
    if not m:
        raise ValueError(f"{path} has no embedded shriii-prereg-inputs manifest")
    manifest: dict[str, Any] = json.loads(m.group(1))
    return manifest


def verify_document(path: Path, repo_root: Path) -> VerificationResult:
    """Compare the document's embedded hashes with the files currently under ``repo_root``."""
    manifest = extract_manifest(path)
    checked: list[dict[str, Any]] = []
    problems: list[str] = []
    for entry in manifest.get("inputs", []):
        rel = str(entry["path"])
        target = Path(rel) if Path(rel).is_absolute() else repo_root / rel
        expected = str(entry["sha256"])
        if not target.is_file():
            problems.append(f"{rel}: missing")
            checked.append({"path": rel, "expected": expected, "actual": None, "match": False})
            continue
        actual = sha256_bytes(target.read_bytes())
        match = actual == expected
        if not match:
            problems.append(f"{rel}: sha256 changed ({expected[:12]}... -> {actual[:12]}...)")
        checked.append({"path": rel, "expected": expected, "actual": actual, "match": match})
    recorded = {str(e["path"]) for e in manifest.get("inputs", []) if str(e.get("role", "")).startswith("dictionary")}
    dict_dir = repo_root / "scoring" / "dictionary"
    if recorded and dict_dir.is_dir():
        current = {f"scoring/dictionary/{p.name}" for p in dict_dir.glob("*.yaml")}
        for extra in sorted(current - recorded):
            problems.append(f"{extra}: dictionary file not covered by the registered document")
    if not checked:
        problems.append("manifest lists no inputs")
    return VerificationResult(ok=not problems, checked=checked, problems=problems)
