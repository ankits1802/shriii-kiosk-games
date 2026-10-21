"""Planned-missing items, result exclusions/provenance and group-level indicators.

* ``criterion.responses.planned_missing_items`` (JSONB list, default ``[]``): the items an administration
  skipped by design (rotating blocks). Rescoring reads them back so a planned-missing scale is never
  scored as non-response after a correction or key update.
* ``validation.statistical_results.exclusions`` / ``provenance`` (JSONB, default ``{}``): rows available,
  used and excluded per estimate, and snapshot id/sha256, dictionary sha256, algorithm version and git sha.
* ``scored.group_indicators``: group-level private-report estimates from batch scoring. The table has no
  session or participant column by design (BUILD_DECISIONS non-negotiable 6).

Adding columns with a constant default does not rewrite rows or fire the append-only guard triggers.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-21
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "group_indicators",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("pathway", sa.String(length=1), nullable=False),
        sa.Column("partition", postgresql.JSONB(), nullable=False),
        sa.Column("indicator_id", sa.String(length=128), nullable=False),
        sa.Column("construct_id", sa.String(length=64), nullable=True),
        sa.Column("estimate", sa.Float(), nullable=True),
        sa.Column("ci_low", sa.Float(), nullable=True),
        sa.Column("ci_high", sa.Float(), nullable=True),
        sa.Column("n_participants", sa.Integer(), nullable=False),
        sa.Column("n_reports", sa.Integer(), nullable=False),
        sa.Column("suppressed", sa.Boolean(), nullable=False),
        sa.Column("details", postgresql.JSONB(), nullable=False),
        sa.Column("scoring_run_id", sa.Uuid(), nullable=True),
        sa.Column("is_current", sa.Boolean(), nullable=False),
        sa.Column("algorithm_version", sa.String(length=64), nullable=False),
        sa.Column("dictionary_version", sa.String(length=64), nullable=True),
        sa.Column("source_refs", postgresql.JSONB(), nullable=False),
        sa.Column("data_snapshot_id", sa.Uuid(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("computed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["scoring_run_id"],
            ["scored.scoring_runs.run_id"],
            name=op.f("fk_group_indicators_scoring_run_id_scoring_runs"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_group_indicators")),
        schema="scored",
    )
    op.create_index(
        "ix_group_indicators_study_current",
        "group_indicators",
        ["study_id", "indicator_id"],
        unique=False,
        schema="scored",
        postgresql_where=sa.text("is_current"),
    )
    op.add_column(
        "responses",
        sa.Column("planned_missing_items", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        schema="criterion",
    )
    for column in ("exclusions", "provenance"):
        op.add_column(
            "statistical_results",
            sa.Column(column, postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
            schema="validation",
        )


def downgrade() -> None:
    op.drop_index("ix_group_indicators_study_current", table_name="group_indicators", schema="scored")
    op.drop_table("group_indicators", schema="scored")
    for column in ("provenance", "exclusions"):
        op.drop_column("statistical_results", column, schema="validation")
    op.drop_column("responses", "planned_missing_items", schema="criterion")
