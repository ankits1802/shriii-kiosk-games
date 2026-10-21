"""On-demand daily partitions for ``kiosk_raw.events`` (declarative RANGE partitioning).

Partitions are named ``events_pYYYYMMDD`` and created inside the ingesting transaction under a
transaction-scoped advisory lock, so concurrent batches never race on ``CREATE TABLE ... PARTITION OF``.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

_PARTITION_LOCK_KEY = 0x5348_5249_4949  # "SHRIII"


def partition_name(day: date) -> str:
    return f"events_p{day:%Y%m%d}"


def ensure_event_partition(session: Session, day: date) -> None:
    """Create the partition for ``day`` if it does not exist yet (idempotent, concurrency-safe)."""
    name = partition_name(day)
    exists = session.execute(
        text("SELECT to_regclass(:qualified) IS NOT NULL"), {"qualified": f"kiosk_raw.{name}"}
    ).scalar_one()
    if not exists:
        session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _PARTITION_LOCK_KEY})
        session.execute(
            text(
                f"CREATE TABLE IF NOT EXISTS kiosk_raw.{name} PARTITION OF kiosk_raw.events "
                f"FOR VALUES FROM ('{day.isoformat()}') TO ('{(day + timedelta(days=1)).isoformat()}')"
            )
        )


def list_partitions(session: Session) -> list[str]:
    rows = session.execute(
        text(
            "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid "
            "JOIN pg_class p ON p.oid = i.inhparent JOIN pg_namespace n ON n.oid = p.relnamespace "
            "WHERE n.nspname = 'kiosk_raw' AND p.relname = 'events' ORDER BY c.relname"
        )
    ).scalars()
    return list(rows)


def ensure_upcoming_partitions(session: Session, start: date, days: int = 7) -> None:
    """Pre-create partitions so the ingest path rarely needs DDL (called by the worker and ``migrate``)."""
    for offset in range(days):
        ensure_event_partition(session, start + timedelta(days=offset))
