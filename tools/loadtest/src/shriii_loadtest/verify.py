"""Server-side correctness checks and database statistics for a finished run.

``verify_plan`` reads the database directly (read-only queries) and proves the ING-02 acceptance
criteria for the sessions in the plan: every event stored exactly once, nothing left parked, nothing
dead-lettered, and no duplicate rows, however many retries, storms or re-orderings were sent.
``pg_stat_statements`` helpers attribute server time to SQL statements for the bottleneck report.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any

import psycopg

__all__ = ["libpq_url", "pgstats_reset", "pgstats_top", "table_sizes", "verify_plan"]


def libpq_url(url: str) -> str:
    """Turn a SQLAlchemy URL (``postgresql+psycopg://``) into a libpq one."""
    for prefix in ("postgresql+psycopg://", "postgresql+psycopg2://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql://" + url[len(prefix) :]
    return url


def verify_plan(db_url: str, expected_sessions: Mapping[str, int]) -> dict[str, Any]:
    ids = [uuid.UUID(s) for s in expected_sessions]
    with psycopg.connect(libpq_url(db_url)) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT session_id, count(*), count(DISTINCT event_id), count(DISTINCT seq)
            FROM kiosk_raw.events WHERE session_id = ANY(%s) GROUP BY session_id
            """,
            (ids,),
        )
        stored = {str(r[0]): (int(r[1]), int(r[2]), int(r[3])) for r in cur.fetchall()}
        cur.execute(
            "SELECT state, count(*) FROM kiosk_raw.event_dedup WHERE session_id = ANY(%s) GROUP BY state", (ids,)
        )
        dedup_states = {str(r[0]): int(r[1]) for r in cur.fetchall()}
        cur.execute("SELECT count(*) FROM kiosk_raw.consent_parking WHERE session_id = ANY(%s)", (ids,))
        still_parked = int(cur.fetchone()[0])  # type: ignore[index]
        cur.execute(
            "SELECT reason_code, count(*) FROM kiosk_raw.dead_letter WHERE session_id = ANY(%s) GROUP BY reason_code",
            (ids,),
        )
        dead = {str(r[0]): int(r[1]) for r in cur.fetchall()}
    missing: dict[str, int] = {}
    duplicated: dict[str, int] = {}
    for sid, expected in expected_sessions.items():
        rows, distinct, _ = stored.get(sid, (0, 0, 0))
        if rows != distinct:
            duplicated[sid] = rows - distinct
        if distinct != expected:
            missing[sid] = expected - distinct
    expected_total = sum(expected_sessions.values())
    stored_total = sum(v[0] for v in stored.values())
    return {
        "sessions": len(expected_sessions),
        "expected_events": expected_total,
        "stored_rows": stored_total,
        "stored_distinct": sum(v[1] for v in stored.values()),
        "duplicate_rows": sum(duplicated.values()),
        "sessions_with_missing_events": len(missing),
        "missing_events": sum(v for v in missing.values() if v > 0),
        "still_parked": still_parked,
        "dead_letters": dead,
        "dedup_states": dedup_states,
        "passed": not duplicated and not missing and still_parked == 0 and not dead,
        "examples": {"missing": dict(list(missing.items())[:5]), "duplicated": dict(list(duplicated.items())[:5])},
    }


def pgstats_reset(db_url: str) -> bool:
    try:
        with psycopg.connect(libpq_url(db_url), autocommit=True) as conn:
            conn.execute("CREATE EXTENSION IF NOT EXISTS pg_stat_statements")
            conn.execute("SELECT pg_stat_statements_reset()")
        return True
    except psycopg.Error:
        return False


def pgstats_top(db_url: str, limit: int = 15) -> list[dict[str, Any]]:
    try:
        with psycopg.connect(libpq_url(db_url)) as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 160), calls,
                       round(total_exec_time::numeric, 1), round(mean_exec_time::numeric, 3), rows
                FROM pg_stat_statements
                WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                ORDER BY total_exec_time DESC LIMIT %s
                """,
                (limit,),
            )
            return [
                {"query": r[0], "calls": int(r[1]), "total_ms": float(r[2]), "mean_ms": float(r[3]), "rows": int(r[4])}
                for r in cur.fetchall()
            ]
    except psycopg.Error:
        return []


def table_sizes(db_url: str) -> list[dict[str, Any]]:
    with psycopg.connect(libpq_url(db_url)) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT n.nspname || '.' || c.relname, pg_total_relation_size(c.oid)
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('kiosk_raw', 'governance', 'consent', 'scored', 'ops') AND c.relkind IN ('r', 'p')
            ORDER BY 2 DESC LIMIT 12
            """
        )
        return [{"table": r[0], "bytes": int(r[1])} for r in cur.fetchall()]
