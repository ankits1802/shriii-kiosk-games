"""UploadBatch ingestion (ING-02, ING-04, ING-08, PRV-02).

Steps per batch:

1. Parse the shell (batch fields + chunk headers) without validating events, so one bad event never
   rejects the batch. Verify ``sha256`` = SHA-256 of the JCS serialisation of ``session_chunks``.
2. Serialise replays of the same ``batch_id`` (advisory lock). A batch already stored as final
   returns its stored result with ``duplicate_batch=true`` (parked statuses refreshed).
3. Per chunk: unseal the DEK (encrypted chunks) and re-wrap it under the KEK
   (``consent.session_keys``); keep the raw chunk; lock the session (``pg_try_advisory_xact_lock``;
   busy sessions get ``retryable`` so ordering is preserved).
4. Per event, in seq order: Pydantic validation (tolerant reader; unknown minor fields go to
   ``payload_ext`` minus privacy-forbidden names) + contract invariants -> ``rejected_terminal`` and
   the DLQ on failure; tombstoned sessions are refused; ``event_dedup`` insert ``ON CONFLICT DO
   NOTHING`` decides ``duplicate`` vs new (a different event with the same ``(session_id, seq)`` is a
   ``seq_conflict``); scorable events without core consent are ``parked`` (consent-first) and
   unparked when ``consent.granted(core)`` arrives; everything else is ``accepted`` into the
   partitioned ``kiosk_raw.events`` with ``server_received_at`` set by the server.
5. Seq-gap detection per touched session (``session_quality_flags``), clock-offset estimate, and
   session lifecycle side effects (end -> pipeline jobs; erasure/tombstone events -> erasure jobs).
"""

from __future__ import annotations

import base64
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from shriii_contracts import EVENT_ADAPTER, check_event_invariants, payload_ext, unknown_fields
from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from shriii_api.auth.rbac import Principal
from shriii_api.canonical import canonical_bytes, canonical_sha256
from shriii_api.db.models.kiosk_raw import (
    Batch,
    BatchChunk,
    ConsentParking,
    DeadLetter,
    Event,
    EventDedup,
    GameSession,
)
from shriii_api.db.models.ops import SystemEvent
from shriii_api.db.models.participants import ErasureRequest, SessionKey, Tombstone
from shriii_api.db.partitions import ensure_event_partition
from shriii_api.errors import DomainError
from shriii_api.observability import tracer
from shriii_api.security import CryptoFailureError, decrypt_chunk, new_uuid7, unseal_dek, unwrap_key, wrap_key
from shriii_api.services import consent as consent_svc
from shriii_api.services import sessions as session_svc
from shriii_api.settings import Settings
from shriii_api.worker.queue import enqueue

log = logging.getLogger(__name__)

Status = Literal["accepted", "duplicate", "parked", "rejected_terminal", "retryable"]
STATUSES: tuple[Status, ...] = ("accepted", "duplicate", "parked", "rejected_terminal", "retryable")
SCHEMA_VERSION = "1.0"


class IngestError(DomainError):
    """Whole-batch rejection (mapped to an HTTP error by the router)."""


class _ChunkShell(BaseModel):
    model_config = ConfigDict(extra="allow")

    encryption: Literal["x25519_sealed_aes256gcm", "none_dev"]
    session_id: str = Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    first_seq: int = Field(ge=0)
    last_seq: int = Field(ge=0)
    event_count: int = Field(ge=1)
    events: list[Any] | None = None
    sealed_dek: str | None = None
    nonce: str | None = None
    ciphertext: str | None = None


class _BatchShell(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: str = Field(pattern=r"^1\.(0|[1-9]\d*)$")
    batch_id: str = Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    kiosk_id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,63}$")
    kiosk_t_wall: datetime
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    event_count: int = Field(ge=1, le=500)
    session_chunks: list[_ChunkShell] = Field(min_length=1)


@dataclass(slots=True)
class _Result:
    event_id: str
    session_id: str
    seq: int
    status: Status
    reason_code: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "session_id": self.session_id,
            "seq": self.seq,
            "status": self.status,
            "reason_code": self.reason_code,
        }


@dataclass(slots=True)
class _Ctx:
    db: Session
    settings: Settings
    principal: Principal
    batch_id: uuid.UUID
    kiosk_id: str
    received_at: datetime
    clock_offset_ms: float | None
    results: list[_Result] = field(default_factory=list)
    unidentifiable: int = 0
    touched: dict[uuid.UUID, GameSession] = field(default_factory=dict)
    partitions: set[date] = field(default_factory=set)


NO_PAYLOAD_REASONS = frozenset({"consent_declined", "session_tombstoned"})
"""Dead letters with these reasons keep metadata only: the participant declined consent or the session
was erased, so the event content must not be retained (ONB-02, PRV-06). ``no_consent`` (parking
expired) keeps its encrypted payload for ING-04 triage and replay under the DLQ retention rule."""

DISCARD_SESSION_REASONS = frozenset({"consent_declined", "under_age"})
"""``session.abandoned`` reasons after which nothing of the session is kept (ONB-02, ONB-04)."""


def _encrypt_dlq_payload(settings: Settings, payload: Any) -> tuple[bytes, bytes]:
    data = json.dumps(payload, default=str).encode()
    nonce, ct = wrap_key(settings.key_bytes("session_key_kek"), data, "dead_letter")
    return nonce, ct


def decrypt_dead_letter(settings: Settings, row: DeadLetter) -> Any:
    if row.payload_nonce is None or row.payload_ciphertext is None:
        return None
    raw = unwrap_key(settings.key_bytes("session_key_kek"), row.payload_nonce, row.payload_ciphertext, "dead_letter")
    return json.loads(raw)


def dead_letter(
    ctx: _Ctx,
    *,
    reason: str,
    payload: Any,
    event_id: str | None = None,
    session_id: str | None = None,
    seq: int | None = None,
    schema_path: str | None = None,
    message: str | None = None,
) -> None:
    nonce: bytes | None = None
    ct: bytes | None = None
    if reason not in NO_PAYLOAD_REASONS:
        nonce, ct = _encrypt_dlq_payload(ctx.settings, payload)
    app_version = None
    if isinstance(payload, dict):
        app_version = (payload.get("versions") or {}).get("app_version")
    ctx.db.add(
        DeadLetter(
            event_id=_uuid_or_none(event_id),
            session_id=_uuid_or_none(session_id),
            seq=seq,
            batch_id=ctx.batch_id,
            kiosk_id=ctx.kiosk_id,
            app_version=app_version,
            reason_code=reason,
            schema_path=schema_path,
            message=(message or "")[:2000] or None,
            payload_nonce=nonce,
            payload_ciphertext=ct,
            status="open",
        )
    )


def _uuid_or_none(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value is not None else None
    except ValueError:
        return None


def _identity(raw: Any) -> tuple[str, str, int] | None:
    """(event_id, session_id, seq) when the raw event carries well-formed identifiers."""
    if not isinstance(raw, dict):
        return None
    eid, sid, seq = raw.get("event_id"), raw.get("session_id"), raw.get("seq")
    if not isinstance(eid, str) or not isinstance(sid, str) or not isinstance(seq, int) or isinstance(seq, bool):
        return None
    if _uuid_or_none(eid) is None or _uuid_or_none(sid) is None or seq < 0:
        return None
    return eid, sid, seq


def _strip(doc: dict[str, Any], pointers: list[str]) -> None:
    for pointer in pointers:
        parts = [p for p in pointer.split("/") if p]
        node: Any = doc
        for part in parts[:-1]:
            node = node[int(part)] if isinstance(node, list) else node.get(part)
            if node is None:
                break
        else:
            if isinstance(node, dict):
                node.pop(parts[-1], None)


def _session_tombstoned(db: Session, session_id: uuid.UUID) -> bool:
    return db.execute(select(Tombstone.id).where(Tombstone.session_id == session_id)).first() is not None


def _session_consent(db: Session, session_id: uuid.UUID) -> bool | None:
    """True = core consent granted, False = declined, None = not yet decided."""
    state = consent_svc.consent_state(db, session_id=session_id)
    return state.get("core")


def _clock_offset(received_at: datetime, kiosk_t_wall: datetime) -> float:
    return (received_at - kiosk_t_wall).total_seconds() * 1000.0


def _decrypt_events(ctx: _Ctx, chunk: _ChunkShell) -> list[Any]:
    if chunk.sealed_dek is None or chunk.nonce is None or chunk.ciphertext is None:
        raise IngestError(
            422, "malformed_chunk", "encrypted chunk lacks sealed_dek/nonce/ciphertext", session_id=chunk.session_id
        )
    try:
        dek = unseal_dek(ctx.settings.key_bytes("backend_x25519_private_key"), chunk.sealed_dek)
        plaintext = decrypt_chunk(dek, chunk.nonce, chunk.ciphertext)
    except CryptoFailureError as exc:
        raise IngestError(422, "chunk_decrypt_failed", str(exc), session_id=chunk.session_id) from exc
    session_id = uuid.UUID(chunk.session_id)
    if ctx.db.get(SessionKey, session_id) is None:
        nonce, wrapped = wrap_key(ctx.settings.key_bytes("session_key_kek"), dek, str(session_id))
        ctx.db.add(SessionKey(session_id=session_id, nonce=nonce, wrapped_dek=wrapped, kek_version=1))
        ctx.db.flush()
    events: list[Any] = []
    for line in plaintext.decode("utf-8").splitlines():
        if line.strip():
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                events.append({"_undecodable": True})
    return events


def _store_chunk(ctx: _Ctx, chunk: _ChunkShell) -> None:
    if chunk.encryption == "none_dev":
        body: dict[str, Any] = {"events": chunk.events}
    else:
        body = {"sealed_dek": chunk.sealed_dek, "nonce": chunk.nonce, "ciphertext": chunk.ciphertext}
    ctx.db.execute(
        insert(BatchChunk)
        .values(
            batch_id=ctx.batch_id,
            session_id=uuid.UUID(chunk.session_id),
            encryption=chunk.encryption,
            first_seq=chunk.first_seq,
            last_seq=chunk.last_seq,
            event_count=chunk.event_count,
            body=body,
        )
        .on_conflict_do_nothing(index_elements=[BatchChunk.batch_id, BatchChunk.session_id])
    )


CONSENT_EVENT_TYPES = frozenset({"consent.granted", "consent.declined", "optin.archive", "optin.contact"})


def _event_row(
    envelope: dict[str, Any],
    ext: dict[str, Any],
    received_at: datetime,
    clock_offset: float | None,
    batch_id: uuid.UUID,
) -> dict[str, Any]:
    """Column values for one ``kiosk_raw.events`` row (bulk-inserted)."""
    task = envelope.get("task") or {}
    cond = envelope.get("condition") or {}
    ctx_ = envelope["context"]
    timing = envelope["timing"]
    return {
        "event_id": uuid.UUID(envelope["event_id"]),
        "server_received_date": received_at.date(),
        "server_received_at": received_at,
        "session_id": uuid.UUID(envelope["session_id"]),
        "seq": envelope["seq"],
        "event_type": envelope["event_type"],
        "schema_version": envelope["schema_version"],
        "participant_pid": ctx_.get("participant_pid"),
        "kiosk_id": ctx_["kiosk_id"],
        "site_mode": ctx_.get("site_mode"),
        "mode": ctx_.get("mode"),
        "language": ctx_.get("language"),
        "episode_id": task.get("episode_id"),
        "module_id": task.get("module_id"),
        "block_id": task.get("block_id"),
        "trial_id": task.get("trial_id"),
        "trial_index": task.get("trial_index"),
        "phase": cond.get("phase"),
        "scorable": bool(timing["scorable"]),
        "timing_flag": timing["timing_flag"],
        "t_mono_ms": float(timing["t_mono_ms"]),
        "kiosk_t_wall": datetime.fromisoformat(timing["kiosk_t_wall"].replace("Z", "+00:00")),
        "batch_id": batch_id,
        "clock_offset_estimate_ms": clock_offset,
        "synthetic": bool(ctx_.get("synthetic")),
        "payload": envelope.get("payload") or {},
        "payload_ext": ext or None,
        "envelope": envelope,
    }


def _insert_events(ctx: _Ctx, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    for day in {r["server_received_date"] for r in rows}:
        if day not in ctx.partitions:
            ensure_event_partition(ctx.db, day)
            ctx.partitions.add(day)
    ctx.db.execute(insert(Event), rows)  # executemany (pipelined by psycopg)


def _set_dedup_state(ctx: _Ctx, event_ids: list[uuid.UUID], state: str) -> None:
    if event_ids:
        ctx.db.execute(
            text("UPDATE kiosk_raw.event_dedup SET state = :st WHERE event_id = ANY(:ids)"),
            {"st": state, "ids": event_ids},
        )


def _unpark(ctx: _Ctx, session_id: uuid.UUID) -> int:
    parked = list(
        ctx.db.execute(
            select(ConsentParking).where(ConsentParking.session_id == session_id).order_by(ConsentParking.seq)
        ).scalars()
    )
    if not parked:
        return 0
    rows: list[dict[str, Any]] = []
    envelopes: list[dict[str, Any]] = []
    for row in parked:
        envelope = dict(row.envelope)
        ext = envelope.pop("_payload_ext", {}) or {}
        rows.append(_event_row(envelope, ext, row.server_received_at, row.clock_offset_estimate_ms, row.batch_id))
        envelopes.append(envelope)
    _insert_events(ctx, rows)
    _set_dedup_state(ctx, [row.event_id for row in parked], "accepted")
    ctx.db.execute(delete(ConsentParking).where(ConsentParking.session_id == session_id))
    session_row = ctx.touched.get(session_id)
    if session_row is not None:
        for envelope in envelopes:
            _apply_side_effects(ctx, envelope, session_row, count=False)
    return len(parked)


def _purge_parked(ctx: _Ctx, session_id: uuid.UUID, reason: str) -> int:
    parked = list(ctx.db.execute(select(ConsentParking).where(ConsentParking.session_id == session_id)).scalars())
    for row in parked:
        dead_letter(
            ctx,
            reason=reason,
            payload=row.envelope,
            event_id=str(row.event_id),
            session_id=str(session_id),
            seq=row.seq,
        )
    _set_dedup_state(ctx, [row.event_id for row in parked], "dead")
    ctx.db.execute(delete(ConsentParking).where(ConsentParking.session_id == session_id))
    return len(parked)


def _apply_side_effects(ctx: _Ctx, envelope: dict[str, Any], session_row: GameSession, *, count: bool = True) -> None:
    et = envelope["event_type"]
    payload = envelope.get("payload") or {}
    pid = envelope["context"].get("participant_pid")
    if pid and session_row.participant_pid is None:
        session_row.participant_pid = pid
    if envelope["context"].get("language") and session_row.language is None:
        session_row.language = envelope["context"]["language"]
    if count:
        session_row.event_count += 1
    if et == "session_end":
        session_svc.on_session_end(
            ctx.db, session_row, payload.get("reason", "completed"), ctx.settings, ctx.principal.sub
        )
    elif et == "session.abandoned" and payload.get("reason") in DISCARD_SESSION_REASONS:
        request_session_discard(ctx, session_row.session_id, str(payload["reason"]))
    elif et == "session.abandoned" and session_row.status == "active":
        session_svc.on_session_end(ctx.db, session_row, "abandoned", ctx.settings, ctx.principal.sub)
    elif et in ("erasure_requested", "session_tombstone"):
        scope = payload.get("scope", "session") if et == "erasure_requested" else "session"
        channel = payload.get("channel", "kiosk_hand_icon") if et == "erasure_requested" else "kiosk_tombstone"
        req = ErasureRequest(
            scope="participant" if scope == "participant" and pid else "session",
            pid=pid if scope == "participant" else None,
            session_id=session_row.session_id,
            channel=channel,
            reason=et,
            requested_by=ctx.principal.sub,
            status="requested",
        )
        ctx.db.add(req)
        ctx.db.flush()
        job = enqueue(
            ctx.db,
            "erasure",
            {"request_id": str(req.request_id)},
            created_by=ctx.principal.sub,
            settings=ctx.settings,
            priority=10,
        )
        req.job_id = job.job_id


def request_session_discard(ctx: _Ctx, session_id: uuid.UUID, reason: str) -> ErasureRequest | None:
    """Queue a session-scope erasure after a consent decline or an under-18 exit (ONB-02/ONB-04).

    "Declining keeps only an anonymous counter": the erasure deletes the session row, raw events, raw
    chunks (crypto-shredded), consent artefacts and dead letters and leaves a tombstone so re-uploads
    are refused. The counter is a ``governance.system_events`` row carrying only the kiosk and reason.
    """
    existing = ctx.db.execute(
        select(ErasureRequest.request_id).where(
            ErasureRequest.session_id == session_id,
            ErasureRequest.scope == "session",
            ErasureRequest.status.in_(("requested", "running", "completed")),
        )
    ).first()
    if existing is not None:
        return None
    req = ErasureRequest(
        scope="session",
        pid=None,
        session_id=session_id,
        channel=reason,
        reason=f"session discarded: {reason}",
        requested_by=ctx.principal.sub,
        status="requested",
    )
    ctx.db.add(req)
    ctx.db.add(SystemEvent(kind=f"session_discarded.{reason}", severity="info", kiosk_id=ctx.kiosk_id, details={}))
    ctx.db.flush()
    job = enqueue(
        ctx.db,
        "erasure",
        {"request_id": str(req.request_id)},
        created_by=ctx.principal.sub,
        settings=ctx.settings,
        priority=10,
    )
    req.job_id = job.job_id
    return req


@dataclass(slots=True)
class _Prepared:
    raw: dict[str, Any]
    event_id: str
    session_id: str
    seq: int
    event_type: str
    scorable: bool
    envelope: dict[str, Any]
    ext: dict[str, Any]
    consent_kind: str | None


def _reject(
    ctx: _Ctx,
    raw: Any,
    ident: tuple[str, str, int],
    code: str,
    *,
    path: str | None = None,
    message: str | None = None,
) -> None:
    event_id, session_id, seq = ident
    dead_letter(
        ctx,
        reason=code,
        payload=raw,
        event_id=event_id,
        session_id=session_id,
        seq=seq,
        schema_path=path,
        message=message,
    )
    ctx.results.append(_Result(event_id, session_id, seq, "rejected_terminal", code))


def _prepare(ctx: _Ctx, raw: Any, chunk_session: uuid.UUID, tombstoned: bool) -> _Prepared | None:
    """Validate one event (pure Python apart from queued DLQ rows); None when it was rejected."""
    ident = _identity(raw)
    if ident is None:
        ctx.unidentifiable += 1
        dead_letter(ctx, reason="unidentifiable_event", payload=raw, session_id=str(chunk_session))
        return None
    event_id, session_id_str, seq = ident
    try:
        event = EVENT_ADAPTER.validate_python(raw)
    except ValidationError as exc:
        errors = exc.errors()
        loc = errors[0]["loc"] if errors else ()
        msg = errors[0]["msg"] if errors else "invalid event"
        _reject(
            ctx,
            raw,
            (event_id, session_id_str, seq),
            "schema_violation",
            path="/" + "/".join(str(p) for p in loc),
            message=str(msg),
        )
        return None
    violations = check_event_invariants(event, origin="kiosk")
    reason: tuple[str, str | None, str] | None = None
    if violations:
        reason = (violations[0].code, violations[0].path, violations[0].message)
    elif uuid.UUID(session_id_str) != chunk_session:
        reason = ("session_mismatch", None, "event session_id differs from its chunk")
    elif event.context.kiosk_id != ctx.kiosk_id:
        reason = ("kiosk_mismatch", None, "event kiosk_id differs from the batch kiosk_id")
    elif event.context.synthetic and not ctx.settings.is_dev:
        reason = ("synthetic_not_allowed", None, "simulator events are refused outside dev/test")
    elif tombstoned:
        reason = ("session_tombstoned", None, "session was erased or withdrawn")
    elif event.event_type in CONSENT_EVENT_TYPES and event.context.language is None:
        reason = ("consent_without_language", None, "consent requires a selected language")
    if reason is not None:
        _reject(ctx, raw, (event_id, session_id_str, seq), reason[0], path=reason[1], message=reason[2])
        return None
    ext = payload_ext(event)
    envelope = event.model_dump(mode="json", by_alias=True)
    _strip(envelope, sorted(unknown_fields(event), key=len, reverse=True))
    envelope["server"] = {
        "server_received_at": ctx.received_at.isoformat(),
        "clock_offset_estimate_ms": ctx.clock_offset_ms,
        "batch_id": str(ctx.batch_id),
    }
    payload = envelope.get("payload") or {}
    return _Prepared(
        raw=raw,
        event_id=event_id,
        session_id=session_id_str,
        seq=seq,
        event_type=event.event_type,
        scorable=bool(event.timing.scorable),
        envelope=envelope,
        ext=ext,
        consent_kind=payload.get("consent_kind") if event.event_type in CONSENT_EVENT_TYPES else None,
    )


def _process_chunk(ctx: _Ctx, raws: list[Any], chunk_session: uuid.UUID, state: dict[str, Any]) -> None:
    """Validate, dedup and store one session chunk with a handful of bulk statements."""
    prepared = [p for raw in raws if (p := _prepare(ctx, raw, chunk_session, bool(state.get("tombstoned"))))]
    if not prepared:
        return
    db = ctx.db
    seen_ids: set[str] = set()
    seen_seqs: set[int] = set()
    unique: list[_Prepared] = []
    for p in prepared:
        if p.event_id in seen_ids:
            ctx.results.append(_Result(p.event_id, p.session_id, p.seq, "duplicate", None))
        elif p.seq in seen_seqs:
            _reject(
                ctx,
                p.raw,
                (p.event_id, p.session_id, p.seq),
                "seq_conflict",
                message=f"seq {p.seq} appears twice in the batch",
            )
        else:
            seen_ids.add(p.event_id)
            seen_seqs.add(p.seq)
            unique.append(p)
    existing_ids = set(
        db.execute(
            select(EventDedup.event_id).where(EventDedup.event_id.in_([uuid.UUID(p.event_id) for p in unique]))
        ).scalars()
    )
    taken_seqs = set(
        db.execute(
            select(EventDedup.seq).where(
                EventDedup.session_id == chunk_session, EventDedup.seq.in_([p.seq for p in unique])
            )
        ).scalars()
    )
    fresh: list[_Prepared] = []
    conflicts: list[_Prepared] = []
    for p in unique:
        if uuid.UUID(p.event_id) in existing_ids:
            ctx.results.append(_Result(p.event_id, p.session_id, p.seq, "duplicate", None))
        elif p.seq in taken_seqs:
            conflicts.append(p)
        else:
            fresh.append(p)
    if not fresh and not conflicts:
        return
    session_row = ctx.touched.get(chunk_session) or session_svc.get_or_create_session(
        db, (fresh or conflicts)[0].raw, ctx.principal.sub
    )
    ctx.touched[chunk_session] = session_row
    for p in conflicts:
        _reject(
            ctx,
            p.raw,
            (p.event_id, p.session_id, p.seq),
            "seq_conflict",
            message=f"seq {p.seq} already holds a different event",
        )
        session_svc.raise_flag(db, chunk_session, "seq_conflict", "blocking", {"seq": p.seq, "event_id": p.event_id})
    if not fresh:
        return

    # Decide statuses in seq order (consent may change mid-chunk).
    consent = state.get("consent")
    decided: list[tuple[_Prepared, Status, str | None]] = []
    core_change: bool | None = None
    for p in fresh:
        if p.consent_kind == "core" and p.event_type in ("consent.granted", "consent.declined"):
            consent = p.event_type == "consent.granted"
            core_change = consent
        if p.scorable and consent is not True:
            decided.append((p, "rejected_terminal", "consent_declined") if consent is False else (p, "parked", None))
        else:
            decided.append((p, "accepted", None))
    state["consent"] = consent

    dedup_state = {"accepted": "accepted", "parked": "parked", "rejected_terminal": "dead"}
    inserted = set(
        db.execute(
            insert(EventDedup)
            .values(
                [
                    {
                        "event_id": uuid.UUID(p.event_id),
                        "session_id": chunk_session,
                        "seq": p.seq,
                        "batch_id": ctx.batch_id,
                        "state": dedup_state[status],
                        "server_received_at": ctx.received_at,
                    }
                    for p, status, _ in decided
                ]
            )
            .on_conflict_do_nothing()
            .returning(EventDedup.event_id)
        ).scalars()
    )
    event_rows: list[dict[str, Any]] = []
    parking_rows: list[dict[str, Any]] = []
    accepted_envelopes: list[dict[str, Any]] = []
    expires = ctx.received_at + timedelta(hours=ctx.settings.consent_parking_ttl_hours)
    for p, status, code in decided:
        if uuid.UUID(p.event_id) not in inserted:  # lost a race with a concurrent upload of the same event
            ctx.results.append(_Result(p.event_id, p.session_id, p.seq, "duplicate", None))
            continue
        if p.event_type in CONSENT_EVENT_TYPES:
            consent_svc.artefact_from_event(db, p.envelope, ctx.principal.sub)
        if status == "accepted":
            event_rows.append(_event_row(p.envelope, p.ext, ctx.received_at, ctx.clock_offset_ms, ctx.batch_id))
            accepted_envelopes.append(p.envelope)
        elif status == "parked":
            parking_rows.append(
                {
                    "event_id": uuid.UUID(p.event_id),
                    "session_id": chunk_session,
                    "seq": p.seq,
                    "batch_id": ctx.batch_id,
                    "server_received_at": ctx.received_at,
                    "clock_offset_estimate_ms": ctx.clock_offset_ms,
                    "envelope": {**p.envelope, "_payload_ext": p.ext},
                    "expires_at": expires,
                }
            )
        else:
            dead_letter(
                ctx, reason=code or "rejected", payload=p.raw, event_id=p.event_id, session_id=p.session_id, seq=p.seq
            )
        ctx.results.append(_Result(p.event_id, p.session_id, p.seq, status, code))
    _insert_events(ctx, event_rows)
    if parking_rows:
        db.execute(insert(ConsentParking), parking_rows)
    session_row.event_count += len(event_rows) + len(parking_rows)
    for envelope in accepted_envelopes:
        _apply_side_effects(ctx, envelope, session_row, count=False)
    if core_change is True:
        _unpark(ctx, chunk_session)
    elif core_change is False:
        _purge_parked(ctx, chunk_session, "consent_declined")
        request_session_discard(ctx, chunk_session, "consent_declined")


def _summary(results: list[_Result], unidentifiable: int) -> dict[str, int]:
    summary: dict[str, int] = dict.fromkeys(STATUSES, 0)
    for r in results:
        summary[r.status] += 1
    summary["rejected_terminal"] += unidentifiable
    return summary


def _replay_result(db: Session, stored: Batch) -> dict[str, Any]:
    result = dict(stored.result)
    refreshed: list[dict[str, Any]] = []
    for original in result.get("results", []):
        r = dict(original)
        if r["status"] == "parked":
            state = db.execute(
                select(EventDedup.state).where(EventDedup.event_id == uuid.UUID(r["event_id"]))
            ).scalar_one_or_none()
            if state == "accepted":
                r["status"] = "accepted"
            elif state == "dead":
                reason = db.execute(
                    select(DeadLetter.reason_code)
                    .where(DeadLetter.event_id == uuid.UUID(r["event_id"]))
                    .order_by(DeadLetter.id.desc())
                    .limit(1)
                ).scalar_one_or_none()
                r["status"], r["reason_code"] = "rejected_terminal", reason or "no_consent"
        refreshed.append(r)
    result["results"] = refreshed
    result["summary"] = _summary([_Result(**r) for r in refreshed], 0)
    result["duplicate_batch"] = True
    return result


def ingest_batch(db: Session, body: bytes, principal: Principal, settings: Settings) -> dict[str, Any]:
    """Process one UploadBatch body; returns an ``UploadBatchResult`` document."""
    if len(body) > settings.max_batch_bytes:
        raise IngestError(413, "batch_too_large", f"batch exceeds {settings.max_batch_bytes} bytes")
    try:
        doc = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise IngestError(400, "malformed_json", "request body is not valid JSON") from exc
    if not isinstance(doc, dict):
        raise IngestError(400, "malformed_batch", "batch must be a JSON object")
    try:
        shell = _BatchShell.model_validate(doc)
    except ValidationError as exc:
        raise IngestError(
            422,
            "invalid_batch",
            "batch envelope does not match UploadBatch",
            errors=json.loads(exc.json(include_url=False))[:20],
        ) from exc
    if canonical_sha256(doc["session_chunks"]) != shell.sha256:
        raise IngestError(400, "sha256_mismatch", "sha256 does not match the JCS serialisation of session_chunks")
    if principal.kind == "device" and principal.kiosk_id != shell.kiosk_id:
        raise IngestError(403, "kiosk_mismatch", "device token does not belong to this kiosk")
    if any(c.encryption == "none_dev" for c in shell.session_chunks) and not settings.accept_plaintext_chunks:
        raise IngestError(422, "plaintext_not_allowed", "none_dev chunks are rejected by this environment")

    batch_id = uuid.UUID(shell.batch_id)
    with tracer.start_as_current_span("ingest_batch") as span:
        span.set_attribute("shriii.batch_id", shell.batch_id)
        span.set_attribute("shriii.kiosk_id", shell.kiosk_id)
        db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"batch:{batch_id}"})
        stored = db.get(Batch, batch_id)
        if stored is not None:
            if stored.sha256 != shell.sha256:
                raise IngestError(409, "batch_id_conflict", "batch_id was already used for different content")
            if stored.final:
                return _replay_result(db, stored)

        received_at = datetime.now(UTC)
        offset = _clock_offset(received_at, shell.kiosk_t_wall)
        ctx = _Ctx(
            db=db,
            settings=settings,
            principal=principal,
            batch_id=batch_id,
            kiosk_id=shell.kiosk_id,
            received_at=received_at,
            clock_offset_ms=offset,
        )
        if stored is None:
            stored = Batch(
                batch_id=batch_id,
                kiosk_id=shell.kiosk_id,
                sha256=shell.sha256,
                event_count=shell.event_count,
                kiosk_t_wall=shell.kiosk_t_wall,
                clock_offset_estimate_ms=offset,
                result={},
                final=False,
            )
            db.add(stored)
            db.flush()

        for chunk in shell.session_chunks:
            session_id = uuid.UUID(chunk.session_id)
            events = (chunk.events or []) if chunk.encryption == "none_dev" else _decrypt_events(ctx, chunk)
            _store_chunk(ctx, chunk)
            got_lock = db.execute(
                text("SELECT pg_try_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"session:{session_id}"}
            ).scalar_one()
            ordered = sorted(events, key=lambda e: e.get("seq", -1) if isinstance(e, dict) else -1)
            if not got_lock:
                for raw in ordered:
                    ident = _identity(raw)
                    if ident:
                        ctx.results.append(_Result(*ident, status="retryable", reason_code="session_busy"))
                continue
            state: dict[str, Any] = {
                "tombstoned": _session_tombstoned(db, session_id),
                "consent": _session_consent(db, session_id),
            }
            _process_chunk(ctx, ordered, session_id, state)
            if chunk.event_count != len(events) or (
                events
                and isinstance(ordered[0], dict)
                and isinstance(ordered[-1], dict)
                and (ordered[0].get("seq"), ordered[-1].get("seq")) != (chunk.first_seq, chunk.last_seq)
            ):
                session_svc.raise_flag(
                    db,
                    session_id,
                    "chunk_header_mismatch",
                    "info",
                    {"batch_id": str(batch_id), "declared": [chunk.first_seq, chunk.last_seq, chunk.event_count]},
                )

        for row in ctx.touched.values():
            session_svc.refresh_integrity(db, row)
            if abs(offset) > settings.clock_offset_anomaly_ms:
                session_svc.raise_flag(
                    db,
                    row.session_id,
                    "clock_offset_anomaly",
                    "info",
                    {"clock_offset_estimate_ms": offset, "batch_id": str(batch_id)},
                )
            session_svc.update_validity(db, row)

        summary = _summary(ctx.results, ctx.unidentifiable)
        result = {
            "schema_version": SCHEMA_VERSION,
            "batch_id": str(batch_id),
            "server_received_at": received_at.isoformat(),
            "clock_offset_estimate_ms": offset,
            "duplicate_batch": False,
            "results": [r.as_dict() for r in ctx.results],
            "summary": summary,
        }
        stored.result = result
        stored.final = summary["retryable"] == 0
        stored.clock_offset_estimate_ms = offset
        db.flush()
        span.set_attribute("shriii.accepted", summary["accepted"])
        log.info("batch ingested", extra={"batch_id": str(batch_id), "kiosk_id": shell.kiosk_id, **summary})
        return result


def raw_chunk_events(db: Session, settings: Settings, chunk: BatchChunk) -> list[Any]:
    """Re-read a stored chunk (decrypting with the re-wrapped DEK); fails after crypto-shredding."""
    if chunk.encryption == "none_dev":
        return list(chunk.body.get("events") or [])
    key = db.get(SessionKey, chunk.session_id)
    if key is None:
        raise CryptoFailureError("session key was shredded")
    dek = unwrap_key(settings.key_bytes("session_key_kek"), key.nonce, key.wrapped_dek, str(chunk.session_id))
    plaintext = decrypt_chunk(dek, chunk.body["nonce"], chunk.body["ciphertext"])
    return [json.loads(line) for line in plaintext.decode().splitlines() if line.strip()]


def replay_dead_letter(db: Session, settings: Settings, row: DeadLetter, principal: Principal) -> dict[str, Any]:
    """Re-run ingestion for one dead letter, keeping its original event_id and seq (ING-04)."""
    payload = decrypt_dead_letter(settings, row)
    if not isinstance(payload, dict) or row.session_id is None:
        raise IngestError(422, "not_replayable", "dead letter has no replayable event payload")
    if isinstance(payload.get("server"), dict):
        # Stored envelopes carry the original server fields; replay re-ingests the kiosk event as sent.
        payload["server"] = {"server_received_at": None, "clock_offset_estimate_ms": None, "batch_id": None}
    if row.event_id is not None:
        db.execute(delete(EventDedup).where(EventDedup.event_id == row.event_id, EventDedup.state == "dead"))
    batch_id = new_uuid7()
    ctx = _Ctx(
        db=db,
        settings=settings,
        principal=principal,
        batch_id=batch_id,
        kiosk_id=row.kiosk_id or "",
        received_at=datetime.now(UTC),
        clock_offset_ms=None,
    )
    db.add(
        Batch(
            batch_id=batch_id,
            kiosk_id=row.kiosk_id or "replay",
            sha256=canonical_sha256(payload),
            event_count=1,
            kiosk_t_wall=ctx.received_at,
            clock_offset_estimate_ms=None,
            result={},
            final=True,
        )
    )
    db.flush()
    state: dict[str, Any] = {
        "tombstoned": _session_tombstoned(db, row.session_id),
        "consent": _session_consent(db, row.session_id),
    }
    _process_chunk(ctx, [payload], row.session_id, state)
    for session_row in ctx.touched.values():
        session_svc.refresh_integrity(db, session_row)
        session_svc.update_validity(db, session_row)
    outcome = ctx.results[0].as_dict() if ctx.results else {"status": "rejected_terminal"}
    if outcome["status"] in ("accepted", "parked", "duplicate"):
        row.status = "replayed"
        row.replayed_at = datetime.now(UTC)
    batch = db.get(Batch, batch_id)
    assert batch is not None
    batch.result = {"replay_of_dead_letter": row.id, "result": outcome}
    return outcome


def canonical_chunks_sha256(chunks: list[dict[str, Any]]) -> str:
    """Helper for clients/tests: the checksum the server expects."""
    return canonical_sha256(chunks)


def encode_ndjson(events: list[dict[str, Any]]) -> bytes:
    return b"\n".join(canonical_bytes(e) for e in events)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()
