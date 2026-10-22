"""Contract validation (jsonschema + Pydantic models + semantic invariants) and sequence integrity.

Everything here reads ``shriii_contracts`` only; nothing is modified.
"""

from __future__ import annotations

import copy
from collections import Counter
from collections.abc import Sequence
from functools import cache
from typing import Any, Literal
from urllib.parse import urljoin

from jsonschema import Draft202012Validator
from pydantic import ValidationError as PydanticValidationError
from shriii_contracts import check_event_invariants, parse_event
from shriii_contracts.schema_validation import (
    BASE,
    CONTRACT_FILES,
    READER_BASE,
    Mode,
    _registry,
    _to_reader,
    format_checker,
    iter_errors,
    load_schemas,
)

from shriii_replay.jcs import canonical_sha256
from shriii_replay.load import Issue

MAX_ERRORS_PER_EVENT = 3


def _where(ev: dict[str, Any], index: int) -> str:
    seq = ev.get("seq")
    et = ev.get("event_type", "?")
    return f"seq {seq} ({et})" if isinstance(seq, int) else f"event[{index}] ({et})"


def _path(err: Any) -> str:
    return "/" + "/".join(str(p) for p in err.absolute_path)


@cache
def _docs(mode: Mode) -> dict[str, dict[str, Any]]:
    """Canonical schema documents keyed by ``$id`` (reader-relaxed copies in reader mode)."""
    out: dict[str, dict[str, Any]] = {}
    for schema in load_schemas().values():
        doc = _to_reader(copy.deepcopy(schema)) if mode == "reader" else copy.deepcopy(schema)
        out[doc["$id"]] = doc
    return out


def _inline(node: Any, base: str, mode: Mode, stack: tuple[str, ...]) -> Any:
    """Replace every ``$ref`` with the referenced subschema (siblings kept under ``allOf``).

    The contract schemas are acyclic; a cycle would keep its ``$ref`` (resolved by the registry)."""
    if isinstance(node, list):
        return [_inline(n, base, mode, stack) for n in node]
    if not isinstance(node, dict):
        return node
    ref = node.get("$ref")
    out = {k: _inline(v, base, mode, stack) for k, v in node.items() if k not in ("$ref", "$id", "$schema")}
    if not isinstance(ref, str):
        return out
    uri = urljoin(base, ref)
    if uri in stack:
        return {**out, "$ref": uri}
    doc_uri, _, fragment = uri.partition("#")
    target: Any = _docs(mode)[doc_uri]
    for part in [p for p in fragment.split("/") if p]:
        target = target[part.replace("~1", "/").replace("~0", "~")]
    resolved = _inline(target, doc_uri, mode, (*stack, uri))
    return {"allOf": [resolved], **out} if out else resolved


@cache
def _event_validator(event_type: str, mode: Mode) -> Draft202012Validator | None:
    """Validator for one event type: the envelope with its ``oneOf`` narrowed to the matching branch and
    every ``$ref`` inlined.

    Equivalent to the full envelope schema for an event of that type (every other branch fails on the
    ``event_type`` const), but far faster than evaluating all branches through the reference registry."""
    file = CONTRACT_FILES["event-envelope"]
    doc_id = load_schemas()[file]["$id"]
    if mode == "reader":
        doc_id = doc_id.replace(BASE, READER_BASE)
    schema = copy.deepcopy(_docs(mode)[doc_id])
    branches = [
        b
        for b in schema.get("oneOf", [])
        if (b.get("properties", {}).get("event_type") or {}).get("const") == event_type
    ]
    if len(branches) != 1:
        return None
    schema["oneOf"] = branches
    inlined = _inline(schema, doc_id, mode, ())
    inlined.pop("$defs", None)
    return Draft202012Validator(inlined, registry=_registry(), format_checker=format_checker)


def _event_errors(ev: dict[str, Any], mode: Mode) -> list[Any]:
    et = ev.get("event_type")
    v = _event_validator(et, mode) if isinstance(et, str) else None
    return list(v.iter_errors(ev)) if v is not None else list(iter_errors("event-envelope", ev, mode))


def validate_batches(batches: Sequence[dict[str, Any]], mode: Mode) -> list[Issue]:
    """UploadBatch schema, JCS sha256 and chunk bookkeeping (first/last seq, event counts)."""
    issues: list[Issue] = []
    for b_i, batch in enumerate(batches):
        where = f"batch[{b_i}] {batch.get('batch_id', '?')}"
        for err in list(iter_errors("upload-batch", batch, mode))[:5]:
            # Event-level problems are reported per event below; keep batch-shell errors here.
            if "events" in [str(p) for p in err.absolute_path]:
                continue
            issues.append(Issue("error", "batch_schema", where, f"{_path(err)}: {err.message[:300]}"))
        chunks = batch.get("session_chunks") or []
        try:
            if isinstance(batch.get("sha256"), str) and canonical_sha256(chunks) != batch["sha256"]:
                issues.append(
                    Issue("error", "batch_sha256_mismatch", where, "sha256 does not match JCS(session_chunks)")
                )
        except (TypeError, ValueError) as exc:
            issues.append(Issue("error", "batch_sha256_uncomputable", where, str(exc)))
        total = 0
        for c_i, chunk in enumerate(chunks):
            if not isinstance(chunk, dict) or chunk.get("encryption") != "none_dev":
                continue
            evs = [e for e in chunk.get("events") or [] if isinstance(e, dict)]
            total += len(evs)
            cw = f"{where} chunk[{c_i}]"
            seqs = [int(e["seq"]) for e in evs if isinstance(e.get("seq"), int)]
            if chunk.get("event_count") != len(evs):
                issues.append(
                    Issue("error", "chunk_event_count", cw, f"event_count {chunk.get('event_count')} != {len(evs)}")
                )
            if seqs and (chunk.get("first_seq") != min(seqs) or chunk.get("last_seq") != max(seqs)):
                issues.append(
                    Issue(
                        "error",
                        "chunk_seq_range",
                        cw,
                        f"first/last_seq {chunk.get('first_seq')}..{chunk.get('last_seq')} != {min(seqs)}..{max(seqs)}",
                    )
                )
            if any(e.get("session_id") != chunk.get("session_id") for e in evs):
                issues.append(Issue("error", "chunk_session_mismatch", cw, "event session_id differs from chunk"))
        if isinstance(batch.get("event_count"), int) and total and batch["event_count"] != total:
            issues.append(Issue("error", "batch_event_count", where, f"event_count {batch['event_count']} != {total}"))
    return issues


def validate_events(events: Sequence[dict[str, Any]], mode: Mode) -> tuple[list[Issue], int]:
    """Per-event jsonschema validation, Pydantic parse and invariant checks.

    Returns the issues and the number of events that passed every check."""
    issues: list[Issue] = []
    clean = 0
    for i, ev in enumerate(events):
        where = _where(ev, i)
        errs = _event_errors(ev, mode)
        for err in errs[:MAX_ERRORS_PER_EVENT]:
            issues.append(Issue("error", "event_schema", where, f"{_path(err)}: {err.message[:300]}"))
        if len(errs) > MAX_ERRORS_PER_EVENT:
            issues.append(Issue("error", "event_schema", where, f"... {len(errs) - MAX_ERRORS_PER_EVENT} more"))
        ok = not errs
        try:
            model = parse_event(ev, strict=(mode == "strict"))
        except (PydanticValidationError, ValueError) as exc:
            ok = False
            if not errs:
                issues.append(Issue("error", "event_model", where, str(exc).splitlines()[0][:300]))
        else:
            server = ev.get("server") or {}
            origin: Literal["kiosk", "server"] = "server" if any(v is not None for v in server.values()) else "kiosk"
            for v in check_event_invariants(model, origin):
                ok = False
                issues.append(Issue("error", f"invariant.{v.code}", where, f"{v.path}: {v.message}"))
        clean += int(ok)
    return issues, clean


def check_sequence(events: Sequence[dict[str, Any]]) -> tuple[list[Issue], list[dict[str, Any]]]:
    """Gapless ``seq`` from 0, one session, unique ids, monotonic clock, start/end bookends.

    Mirrors ``shriii_contracts.check_session_sequence`` (same codes) on plain dicts so it also works when
    some events fail to parse. Exact re-sends (same ``event_id`` and content) are deduplicated as the
    ingestion API does (``duplicate``), and the deduplicated, seq-ordered stream is returned."""
    issues: list[Issue] = []
    by_id: dict[str, dict[str, Any]] = {}
    unique: list[dict[str, Any]] = []
    for i, ev in enumerate(events):
        eid = ev.get("event_id")
        if isinstance(eid, str) and eid in by_id:
            if by_id[eid] == ev:
                issues.append(Issue("info", "duplicate_event", _where(ev, i), "exact re-send dropped (idempotent)"))
            else:
                issues.append(
                    Issue("error", "duplicate_event_id", _where(ev, i), "event_id reused with different content")
                )
            continue
        if isinstance(eid, str):
            by_id[eid] = ev
        unique.append(ev)
    sessions = Counter(e.get("session_id") for e in unique)
    if len(sessions) > 1:
        issues.append(Issue("error", "mixed_sessions", "input", f"events from {len(sessions)} sessions"))
    ordered = sorted(unique, key=_seq_key)
    seqs = [e.get("seq") for e in ordered]
    counts = Counter(s for s in seqs if isinstance(s, int))
    for s, c in sorted(counts.items()):
        if c > 1:
            issues.append(Issue("error", "seq_conflict", f"seq {s}", f"{c} different events share seq {s}"))
    present = sorted(counts)
    if present:
        expected = set(range(present[-1] + 1))
        missing = sorted(expected - set(present))
        for start, end in _ranges(missing):
            label = f"seq {start}" if start == end else f"seq {start}..{end}"
            issues.append(Issue("error", "seq_gap", label, f"missing {end - start + 1} event(s)"))
    last = float("-inf")
    for e in ordered:
        t = (e.get("timing") or {}).get("t_mono_ms")
        if isinstance(t, int | float):
            if t < last:
                issues.append(Issue("error", "mono_decreasing", _where(e, 0), f"t_mono_ms {t} < {last}"))
            last = max(last, float(t))
    if ordered and ordered[0].get("event_type") != "session_start":
        issues.append(Issue("error", "missing_session_start", "seq 0", "first event must be session_start"))
    if ordered and ordered[-1].get("event_type") not in ("session_end", "session_tombstone"):
        issues.append(
            Issue("warning", "missing_session_end", "last event", "session has no session_end (still open or lost)")
        )
    return issues, ordered


def _seq_key(ev: dict[str, Any]) -> int:
    seq = ev.get("seq")
    return seq if isinstance(seq, int) else 10**12


def _ranges(values: list[int]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for v in values:
        if out and v == out[-1][1] + 1:
            out[-1] = (out[-1][0], v)
        else:
            out.append((v, v))
    return out
