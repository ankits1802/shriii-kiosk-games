"""Append-only guards, database roles/grants and initial event partitions.

* ``governance.forbid_mutation()`` rejects UPDATE always and DELETE/TRUNCATE unless the transaction
  declared ``shriii.mutation_purpose`` = erasure | retention (``SET LOCAL`` via ``set_config``).
  Applied to raw events, criterion responses, consent artefacts and the audit log (CRT-01, PRV-02,
  PRV-08). This works even for the table owner, unlike grants.
* Roles (NOLOGIN, defence in depth): ``shriii_app`` (no UPDATE/DELETE on append-only tables),
  ``shriii_erasure`` (DELETE on them), ``shriii_analyst`` (read de-identified schemas only; never
  ``linkage``/``consent``/identity). Created only when the migrating user may create roles.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-21
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from alembic import op

revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

GUARDED_TABLES = (
    "kiosk_raw.events",
    "criterion.responses",
    "consent.artefacts",
    "governance.audit_events",
)
APPEND_ONLY_DELETE_ALLOWED = ("kiosk_raw.events", "criterion.responses", "consent.artefacts", "governance.audit_events")
ANALYST_SCHEMAS = ("scored", "validation", "games", "study")
ALL_SCHEMAS = (
    "kiosk_raw",
    "scored",
    "criterion",
    "linkage",
    "consent",
    "study",
    "games",
    "validation",
    "reporting",
    "governance",
    "ops",
)


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION governance.forbid_mutation() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE
            purpose text := coalesce(current_setting('shriii.mutation_purpose', true), '');
        BEGIN
            IF TG_OP = 'UPDATE' THEN
                RAISE EXCEPTION 'append-only table %.%: UPDATE is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            IF purpose NOT IN ('erasure', 'retention') THEN
                RAISE EXCEPTION 'append-only table %.%: % requires the erasure or retention path',
                    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            IF TG_OP = 'DELETE' THEN
                RETURN OLD;
            END IF;
            RETURN NULL;
        END;
        $$;
        """
    )
    for table in GUARDED_TABLES:
        name = table.split(".")[1]
        op.execute(
            f"CREATE TRIGGER trg_{name}_append_only BEFORE UPDATE OR DELETE ON {table} "
            "FOR EACH ROW EXECUTE FUNCTION governance.forbid_mutation()"
        )
        op.execute(
            f"CREATE TRIGGER trg_{name}_no_truncate BEFORE TRUNCATE ON {table} "
            "FOR EACH STATEMENT EXECUTE FUNCTION governance.forbid_mutation()"
        )

    schemas = ", ".join(ALL_SCHEMAS)
    analyst = ", ".join(ANALYST_SCHEMAS)
    guarded = ", ".join(APPEND_ONLY_DELETE_ALLOWED)
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shriii_app') THEN
                CREATE ROLE shriii_app NOLOGIN;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shriii_erasure') THEN
                CREATE ROLE shriii_erasure NOLOGIN;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shriii_analyst') THEN
                CREATE ROLE shriii_analyst NOLOGIN;
            END IF;
            GRANT USAGE ON SCHEMA {schemas} TO shriii_app;
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {schemas} TO shriii_app;
            GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA {schemas} TO shriii_app;
            REVOKE UPDATE, DELETE, TRUNCATE ON {guarded} FROM shriii_app;
            GRANT USAGE ON SCHEMA {schemas} TO shriii_erasure;
            GRANT SELECT, DELETE ON {guarded} TO shriii_erasure;
            GRANT USAGE ON SCHEMA {analyst} TO shriii_analyst;
            GRANT SELECT ON ALL TABLES IN SCHEMA {analyst} TO shriii_analyst;
            REVOKE ALL ON ALL TABLES IN SCHEMA linkage, consent, kiosk_raw FROM shriii_analyst;
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'skipping role creation/grants: migrating user lacks CREATEROLE';
        END;
        $$;
        """
    )

    today = datetime.now(UTC).date()
    for offset in range(-1, 8):
        day = today + timedelta(days=offset)
        op.execute(
            f"CREATE TABLE IF NOT EXISTS kiosk_raw.events_p{day:%Y%m%d} PARTITION OF kiosk_raw.events "
            f"FOR VALUES FROM ('{day.isoformat()}') TO ('{(day + timedelta(days=1)).isoformat()}')"
        )


def downgrade() -> None:
    for table in GUARDED_TABLES:
        name = table.split(".")[1]
        op.execute(f"DROP TRIGGER IF EXISTS trg_{name}_append_only ON {table}")
        op.execute(f"DROP TRIGGER IF EXISTS trg_{name}_no_truncate ON {table}")
    op.execute("DROP FUNCTION IF EXISTS governance.forbid_mutation()")
    # Partitions are dropped with the parent table in 0001's downgrade; roles are cluster-wide and
    # may be shared by other databases, so they are left in place.
