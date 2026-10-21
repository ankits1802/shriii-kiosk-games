"""initial identity vault

Revision ID: i0001
Revises:
Create Date: 2026-10-21 17:07:56.021335
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "i0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS identity_vault")
    op.create_table(
        "contacts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("pid_hmac", sa.String(length=64), nullable=False),
        sa.Column("pepper_version", sa.Integer(), nullable=False),
        sa.Column("channel", sa.String(length=16), nullable=False),
        sa.Column("contact_hmac", sa.String(length=64), nullable=False),
        sa.Column("contact_ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=True),
        sa.Column("purge_after", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_contacts")),
        schema="identity_vault",
    )
    op.create_index(
        op.f("ix_identity_vault_contacts_contact_hmac"),
        "contacts",
        ["contact_hmac"],
        unique=False,
        schema="identity_vault",
    )
    op.create_index(
        op.f("ix_identity_vault_contacts_pid_hmac"), "contacts", ["pid_hmac"], unique=False, schema="identity_vault"
    )
    op.create_table(
        "relink_audit",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("pid_hmac", sa.String(length=64), nullable=False),
        sa.Column("actor", sa.String(length=256), nullable=False),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("justification", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_relink_audit")),
        schema="identity_vault",
    )
    op.create_index(
        op.f("ix_identity_vault_relink_audit_pid_hmac"),
        "relink_audit",
        ["pid_hmac"],
        unique=False,
        schema="identity_vault",
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_identity_vault_relink_audit_pid_hmac"), table_name="relink_audit", schema="identity_vault")
    op.drop_table("relink_audit", schema="identity_vault")
    op.drop_index(op.f("ix_identity_vault_contacts_pid_hmac"), table_name="contacts", schema="identity_vault")
    op.drop_index(op.f("ix_identity_vault_contacts_contact_hmac"), table_name="contacts", schema="identity_vault")
    op.drop_table("contacts", schema="identity_vault")
    op.execute("DROP SCHEMA IF EXISTS identity_vault CASCADE")
