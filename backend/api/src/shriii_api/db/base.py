"""Declarative bases, naming conventions and shared column mixins.

Two metadata trees exist on purpose (PRV-04): :class:`Base` for the research database and
:class:`IdentityBase` for the identity vault, which has its own connection setting and its own
Alembic environment so it can live in a separate database with separate keys.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Date, DateTime, MetaData, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NAMING_CONVENTION: dict[str, str] = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

RESEARCH_SCHEMAS: tuple[str, ...] = (
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
"""Plan section 6.4 schemas plus ``games`` (spec section 13 games domain), ``reporting`` (layer 5)
and ``ops`` (job queue). ``identity_vault`` lives in the identity database."""

IDENTITY_SCHEMA = "identity_vault"

_TYPE_MAP: dict[Any, Any] = {
    dict[str, Any]: JSONB,
    list[Any]: JSONB,
    list[str]: JSONB,
    datetime: DateTime(timezone=True),
    date: Date,
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
    type_annotation_map = _TYPE_MAP


class IdentityBase(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
    type_annotation_map = _TYPE_MAP


class CreatedAtMixin:
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class DerivedMixin:
    """Lineage carried by every derived row (layers 2-5); everything is reproducible from raw data."""

    algorithm_version: Mapped[str] = mapped_column(String(64))
    dictionary_version: Mapped[str | None] = mapped_column(String(64))
    source_refs: Mapped[dict[str, Any]] = mapped_column(default=dict)
    """e.g. ``{"event_ids": [...], "session_ids": [...], "response_ids": [...]}``"""
    data_snapshot_id: Mapped[uuid.UUID | None] = mapped_column()
    job_id: Mapped[uuid.UUID | None] = mapped_column()
    computed_at: Mapped[datetime] = mapped_column(server_default=func.now())
