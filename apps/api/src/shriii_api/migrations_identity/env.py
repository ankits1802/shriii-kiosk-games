"""Alembic environment for the identity vault database (schema identity_vault only)."""

from __future__ import annotations

from alembic import context
from sqlalchemy import create_engine, pool

import shriii_api.db.models  # noqa: F401  (registers every table)
from shriii_api.db.base import IDENTITY_SCHEMA, IdentityBase
from shriii_api.settings import get_settings

config = context.config
target_metadata = IdentityBase.metadata


def _url() -> str:
    return config.get_main_option("sqlalchemy.url") or get_settings().effective_identity_database_url


def include_object(obj: object, name: str | None, type_: str, reflected: bool, compare_to: object) -> bool:
    return not (type_ == "table" and reflected and getattr(obj, "schema", None) != IDENTITY_SCHEMA)


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        include_schemas=True,
        include_object=include_object,
        version_table="alembic_version_identity",
        version_table_schema="public",
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = config.attributes.get("connection")
    if connectable is not None:
        _run(connectable)
        return
    engine = create_engine(_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        _run(connection)


def _run(connection: object) -> None:
    context.configure(
        connection=connection,  # type: ignore[arg-type]
        target_metadata=target_metadata,
        include_schemas=True,
        include_object=include_object,
        version_table="alembic_version_identity",
        version_table_schema="public",
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
