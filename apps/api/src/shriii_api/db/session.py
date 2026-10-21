"""Engines and session factories for the research DB and the identity vault (separate connection)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from shriii_api.settings import get_settings

_ENGINES: dict[tuple[str, int, bool], Engine] = {}


def _engine(url: str, pool_size: int, echo: bool) -> Engine:
    key = (url, pool_size, echo)
    engine = _ENGINES.get(key)
    if engine is None:
        engine = create_engine(url, pool_size=pool_size, max_overflow=pool_size, pool_pre_ping=True, echo=echo)
        _ENGINES[key] = engine
    return engine


def get_engine() -> Engine:
    s = get_settings()
    return _engine(s.database_url, s.db_pool_size, s.db_echo)


def get_identity_engine() -> Engine:
    s = get_settings()
    return _engine(s.effective_identity_database_url, max(2, s.db_pool_size // 4), s.db_echo)


def session_factory() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False)


def identity_session_factory() -> sessionmaker[Session]:
    return sessionmaker(bind=get_identity_engine(), expire_on_commit=False)


@contextmanager
def session_scope() -> Iterator[Session]:
    """Transactional scope: commit on success, roll back on error."""
    session = session_factory()()
    try:
        yield session
        session.commit()
    except BaseException:
        session.rollback()
        raise
    finally:
        session.close()


@contextmanager
def identity_session_scope() -> Iterator[Session]:
    session = identity_session_factory()()
    try:
        yield session
        session.commit()
    except BaseException:
        session.rollback()
        raise
    finally:
        session.close()


def set_mutation_purpose(session: Session, purpose: str) -> None:
    """Declare the erasure/retention purpose for this transaction (unlocks guarded DELETEs)."""
    if purpose not in ("erasure", "retention"):
        raise ValueError("purpose must be erasure or retention")
    session.execute(text("SELECT set_config('shriii.mutation_purpose', :p, true)"), {"p": purpose})


def dispose_engines() -> None:
    """Dispose every pooled engine (tests and CLI shutdown)."""
    for engine in _ENGINES.values():
        engine.dispose()
    _ENGINES.clear()
