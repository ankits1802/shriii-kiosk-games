"""Retention schedule runner (PRV-05). Rules live in ``config/retention.yaml``; legal holds block purges."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from importlib import resources
from typing import Any

import yaml
from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from shriii_api.canonical import sha256_hex
from shriii_api.db.models.identity import ContactRecord
from shriii_api.db.models.kiosk_raw import BatchChunk, ConsentParking
from shriii_api.db.models.ops import RetentionRun
from shriii_api.db.models.participants import SessionKey
from shriii_api.db.session import identity_session_scope, set_mutation_purpose
from shriii_api.services.ingestion import _Ctx, dead_letter
from shriii_api.settings import Settings

log = logging.getLogger(__name__)

_HELD_SESSIONS_SQL = """
    SELECT s.session_id FROM kiosk_raw.sessions s
    JOIN governance.legal_holds h ON h.released_at IS NULL AND (
        (h.scope_kind = 'session' AND h.scope_value = s.session_id::text) OR
        (h.scope_kind = 'study' AND h.scope_value = s.study_id) OR
        (h.scope_kind = 'participant' AND h.scope_value = s.participant_pid))
"""


def load_policy() -> tuple[dict[str, Any], str]:
    raw = resources.files("shriii_api.config").joinpath("retention.yaml").read_bytes()
    return yaml.safe_load(raw.decode("utf-8")), sha256_hex(raw)


def _rowcount(result: Any) -> int:
    return int(getattr(result, "rowcount", 0) or 0)


def run_retention(
    db: Session, settings: Settings, *, dry_run: bool, triggered_by: str, now: datetime | None = None
) -> RetentionRun:
    policy, digest = load_policy()
    now = now or datetime.now(UTC)
    run = RetentionRun(dry_run=dry_run, policy_sha256=digest, status="running", triggered_by=triggered_by)
    db.add(run)
    db.flush()
    report: dict[str, Any] = {"policy_version": policy.get("version"), "rules": {}}
    if not dry_run:
        set_mutation_purpose(db, "retention")
    for rule in policy.get("rules", []):
        if not rule.get("enabled", True):
            report["rules"][rule["id"]] = {"skipped": "disabled"}
            continue
        ttl = rule.get("ttl_days")
        cutoff = now - timedelta(days=int(ttl)) if ttl is not None else now
        handler = _HANDLERS.get(rule["id"])
        if handler is None:
            report["rules"][rule["id"]] = {"skipped": "no_handler"}
            continue
        with db.begin_nested():
            count = handler(db, settings, cutoff, now, dry_run)
        report["rules"][rule["id"]] = {"cutoff": cutoff.isoformat(), "affected": count}
    run.report = report
    run.status = "completed"
    run.finished_at = datetime.now(UTC)
    db.flush()
    log.info("retention run", extra={"dry_run": dry_run, "report": report})
    return run


def _consent_parking(db: Session, settings: Settings, cutoff: datetime, now: datetime, dry_run: bool) -> int:
    rows = list(
        db.execute(
            select(ConsentParking).where(
                ConsentParking.expires_at <= now, text(f"session_id NOT IN ({_HELD_SESSIONS_SQL})")
            )
        ).scalars()
    )
    if dry_run:
        return len(rows)
    for row in rows:
        ctx = _Ctx(
            db=db,
            settings=settings,
            principal=None,  # type: ignore[arg-type]
            batch_id=row.batch_id,
            kiosk_id=row.envelope.get("context", {}).get("kiosk_id", ""),
            received_at=now,
            clock_offset_ms=None,
        )
        envelope = {k: v for k, v in row.envelope.items() if k != "_payload_ext"}
        dead_letter(
            ctx,
            reason="no_consent",
            payload=envelope,
            event_id=str(row.event_id),
            session_id=str(row.session_id),
            seq=row.seq,
        )
        db.execute(text("UPDATE kiosk_raw.event_dedup SET state = 'dead' WHERE event_id = :e"), {"e": row.event_id})
        db.delete(row)
    db.flush()
    return len(rows)


def _play_only(db: Session, settings: Settings, cutoff: datetime, now: datetime, dry_run: bool) -> int:
    """Whole play-only sessions whose last raw event is older than the cutoff.

    Deletes the raw events, the stored raw chunks and the session DEK (crypto-shredding any copy of the
    chunk), so no raw copy of the session survives in another table. Returns the number of raw events.
    """
    sessions_sql = f"""
        SELECT e.session_id FROM kiosk_raw.events e
        WHERE NOT EXISTS (SELECT 1 FROM linkage.participant_links l WHERE l.session_id = e.session_id)
          AND NOT EXISTS (SELECT 1 FROM consent.artefacts a WHERE a.session_id = e.session_id
                          AND a.kind = 'archive' AND a.granted)
          AND e.session_id NOT IN ({_HELD_SESSIONS_SQL})
        GROUP BY e.session_id
        HAVING max(e.server_received_at) < :cutoff
    """
    session_ids = list(db.execute(text(sessions_sql), {"cutoff": cutoff}).scalars())
    if not session_ids:
        return 0
    if dry_run:
        return int(
            db.execute(
                text("SELECT count(*) FROM kiosk_raw.events WHERE session_id = ANY(:s)"), {"s": session_ids}
            ).scalar_one()
        )
    events = _rowcount(db.execute(text("DELETE FROM kiosk_raw.events WHERE session_id = ANY(:s)"), {"s": session_ids}))
    db.execute(delete(BatchChunk).where(BatchChunk.session_id.in_(session_ids)))
    db.execute(delete(SessionKey).where(SessionKey.session_id.in_(session_ids)))
    return events


def _simple(table: str, column: str, extra: str = "") -> Any:
    def handler(db: Session, settings: Settings, cutoff: datetime, now: datetime, dry_run: bool) -> int:
        cond = f"{column} < :cutoff {extra}"
        if dry_run:
            return int(db.execute(text(f"SELECT count(*) FROM {table} WHERE {cond}"), {"cutoff": cutoff}).scalar_one())
        return _rowcount(db.execute(text(f"DELETE FROM {table} WHERE {cond}"), {"cutoff": cutoff}))

    return handler


def _dead_letters(db: Session, settings: Settings, cutoff: datetime, now: datetime, dry_run: bool) -> int:
    cond = f"created_at < :cutoff AND (session_id IS NULL OR session_id NOT IN ({_HELD_SESSIONS_SQL}))"
    if dry_run:
        return int(
            db.execute(
                text(f"SELECT count(*) FROM kiosk_raw.dead_letter WHERE {cond}"), {"cutoff": cutoff}
            ).scalar_one()
        )
    return _rowcount(db.execute(text(f"DELETE FROM kiosk_raw.dead_letter WHERE {cond}"), {"cutoff": cutoff}))


def _vault(db: Session, settings: Settings, cutoff: datetime, now: datetime, dry_run: bool) -> int:
    with identity_session_scope() as vault:
        stmt = select(ContactRecord.id).where(ContactRecord.purge_after.is_not(None), ContactRecord.purge_after <= now)
        ids = list(vault.execute(stmt).scalars())
        if not dry_run and ids:
            vault.execute(delete(ContactRecord).where(ContactRecord.id.in_(ids)))
        return len(ids)


_HANDLERS: dict[str, Any] = {
    "consent_parking_expired": _consent_parking,
    "play_only_raw_events": _play_only,
    "dead_letters": _dead_letters,
    "telemetry": _simple("governance.system_events", "occurred_at"),
    "security_logs": _simple("governance.audit_events", "occurred_at"),
    "expired_reports": _simple("reporting.reports", "expires_at", f"AND session_id NOT IN ({_HELD_SESSIONS_SQL})"),
    "finished_jobs": _simple("ops.jobs", "finished_at", "AND status IN ('succeeded', 'cancelled')"),
    "vault_contacts": _vault,
}
