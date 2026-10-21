"""Read raw event input: NDJSON events, a JSON array of events, or development UploadBatch documents."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

InputKind = Literal["ndjson_events", "json_events", "upload_batches"]


@dataclass(slots=True)
class Issue:
    """One finding. ``severity``: ``error`` breaks replay validity, ``warning`` needs QA attention,
    ``info`` is recorded only. ``code`` is stable (machine-readable)."""

    severity: Literal["error", "warning", "info"]
    code: str
    where: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {"severity": self.severity, "code": self.code, "where": self.where, "message": self.message}


@dataclass(slots=True)
class LoadedInput:
    path: str
    kind: InputKind
    events: list[dict[str, Any]]
    batches: list[dict[str, Any]] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)


def _is_batch(doc: Any) -> bool:
    return isinstance(doc, dict) and "session_chunks" in doc


def _events_from_batches(batches: list[dict[str, Any]], issues: list[Issue]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for b_i, batch in enumerate(batches):
        for c_i, chunk in enumerate(batch.get("session_chunks") or []):
            where = f"batch[{b_i}].session_chunks[{c_i}]"
            if not isinstance(chunk, dict):
                issues.append(Issue("error", "chunk_not_object", where, "session chunk is not an object"))
                continue
            if chunk.get("encryption") != "none_dev":
                issues.append(
                    Issue(
                        "error",
                        "encrypted_chunk",
                        where,
                        "encrypted chunk: decrypt with the session DEK first (replay reads plaintext events only)",
                    )
                )
                continue
            for ev in chunk.get("events") or []:
                if isinstance(ev, dict):
                    events.append(ev)
                else:
                    issues.append(Issue("error", "event_not_object", where, "event is not an object"))
    return events


def load_input(path: Path) -> LoadedInput:
    """Detect the input format and return the events (in file order) plus parse issues."""
    text = path.read_text(encoding="utf-8-sig")
    issues: list[Issue] = []
    stripped = text.lstrip()
    docs: list[Any] = []
    whole: Any = None
    if stripped.startswith(("[", "{")):
        try:
            whole = json.loads(text)
        except json.JSONDecodeError:
            whole = None
    if whole is not None:
        if isinstance(whole, list):
            if whole and all(_is_batch(d) for d in whole):
                batches = [d for d in whole if isinstance(d, dict)]
                return LoadedInput(str(path), "upload_batches", _events_from_batches(batches, issues), batches, issues)
            events = [d for d in whole if isinstance(d, dict)]
            if len(events) != len(whole):
                issues.append(Issue("error", "event_not_object", str(path), "array contains non-object entries"))
            return LoadedInput(str(path), "json_events", events, [], issues)
        if _is_batch(whole):
            return LoadedInput(str(path), "upload_batches", _events_from_batches([whole], issues), [whole], issues)
        if isinstance(whole, dict) and isinstance(whole.get("events"), list):
            return LoadedInput(
                str(path), "json_events", [e for e in whole["events"] if isinstance(e, dict)], [], issues
            )
        if isinstance(whole, dict) and "event_type" in whole:
            return LoadedInput(str(path), "ndjson_events", [whole], [], issues)
    for lineno, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            docs.append(json.loads(line))
        except json.JSONDecodeError as exc:
            issues.append(Issue("error", "json_parse", f"line {lineno}", f"invalid JSON: {exc.msg}"))
    if docs and all(_is_batch(d) for d in docs):
        return LoadedInput(str(path), "upload_batches", _events_from_batches(docs, issues), docs, issues)
    events = []
    for i, d in enumerate(docs):
        if isinstance(d, dict) and not _is_batch(d):
            events.append(d)
        else:
            issues.append(Issue("error", "event_not_object", f"record {i}", "NDJSON record is not an event object"))
    return LoadedInput(str(path), "ndjson_events", events, [], issues)


def load_json_or_ndjson(path: Path) -> list[dict[str, Any]]:
    """Rows from a JSON array, an object holding a ``rows``/``indicators`` array, or NDJSON."""
    text = path.read_text(encoding="utf-8-sig")
    try:
        doc = json.loads(text)
    except json.JSONDecodeError:
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    if isinstance(doc, list):
        return [d for d in doc if isinstance(d, dict)]
    if isinstance(doc, dict):
        for key in ("rows", "indicators"):
            if isinstance(doc.get(key), list):
                return [d for d in doc[key] if isinstance(d, dict)]
        return [doc]
    raise ValueError(f"{path}: expected JSON rows")


def load_trial_params(path: Path, session_id: str) -> dict[str, dict[str, dict[str, Any]]]:
    """``GameTrialSpec.params`` keyed ``session_id -> trial_id -> params``.

    Accepts that nested form or a flat ``trial_id -> params`` mapping for one session."""
    doc = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(doc, dict):
        raise ValueError(f"{path}: trial params must be a JSON object")
    if session_id in doc and isinstance(doc[session_id], dict):
        return {session_id: doc[session_id]}
    values = list(doc.values())
    nested = values and all(isinstance(v, dict) and all(isinstance(x, dict) for x in v.values()) for v in values)
    looks_like_sessions = all(isinstance(k, str) and len(k) == 36 and k.count("-") == 4 for k in doc)
    if nested and looks_like_sessions:
        return {}  # params for other sessions only
    return {session_id: doc}
