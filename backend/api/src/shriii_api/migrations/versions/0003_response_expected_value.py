"""Store the administration-file key value on criterion responses.

``criterion.responses.expected_response`` keeps, per response, the value from the licensed
administration file that scoring needs: the instructed answer for attention-check items and the
minimum number of moves for Tower-of-London ``<problem>.moves`` measures. Storing it makes every
rescore (corrections, key updates) reproducible instead of freezing a pass/fail computed at entry.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-21
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("responses", sa.Column("expected_response", sa.Float(), nullable=True), schema="criterion")


def downgrade() -> None:
    op.drop_column("responses", "expected_response", schema="criterion")
