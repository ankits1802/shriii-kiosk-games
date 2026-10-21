"""Game definitions and approved versions (schema ``games``; spec section 13 games domain)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from shriii_api.db.base import Base, CreatedAtMixin

SCHEMA = "games"


class Game(Base, CreatedAtMixin):
    __tablename__ = "games"
    __table_args__ = {"schema": SCHEMA}

    game_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))
    pathways: Mapped[list[str]] = mapped_column(default=list)
    constructs: Mapped[list[str]] = mapped_column(default=list)
    slot: Mapped[bool] = mapped_column(Boolean, default=False)


class GameVersion(Base, CreatedAtMixin):
    __tablename__ = "game_versions"
    __table_args__ = (UniqueConstraint("game_id", "version"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    game_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.games.game_id"))
    version: Mapped[str] = mapped_column(String(64))
    config_id: Mapped[str] = mapped_column(String(128))
    config: Mapped[dict[str, Any]] = mapped_column()
    sha256: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="draft")
    """draft | approved | retired"""
    approved_by: Mapped[list[str]] = mapped_column(default=list)
    approved_at: Mapped[datetime | None] = mapped_column()
    source_path: Mapped[str | None] = mapped_column(String(512))


class Episode(Base):
    __tablename__ = "episodes"
    __table_args__ = (UniqueConstraint("game_version_id", "episode_id"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    game_version_id: Mapped[int] = mapped_column(ForeignKey(f"{SCHEMA}.game_versions.id", ondelete="CASCADE"))
    episode_id: Mapped[str] = mapped_column(String(128))
    sequence: Mapped[int] = mapped_column(Integer)
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)


class TrialDefinition(Base):
    """Block-level trial specification (counts, phase, condition) from the game config."""

    __tablename__ = "trial_definitions"
    __table_args__ = (UniqueConstraint("game_version_id", "block_id"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    game_version_id: Mapped[int] = mapped_column(ForeignKey(f"{SCHEMA}.game_versions.id", ondelete="CASCADE"))
    block_id: Mapped[str] = mapped_column(String(128))
    sequence: Mapped[int] = mapped_column(Integer)
    phase: Mapped[str] = mapped_column(String(32))
    condition_id: Mapped[str | None] = mapped_column(String(128))
    planned_trials: Mapped[int] = mapped_column(Integer)
    min_trials: Mapped[int] = mapped_column(Integer)
    scorable: Mapped[bool] = mapped_column(Boolean)
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)


class Stimulus(Base):
    __tablename__ = "stimuli"
    __table_args__ = (UniqueConstraint("game_version_id", "stimulus_id"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    game_version_id: Mapped[int] = mapped_column(ForeignKey(f"{SCHEMA}.game_versions.id", ondelete="CASCADE"))
    stimulus_id: Mapped[str] = mapped_column(String(128))
    stimulus_version: Mapped[str | None] = mapped_column(String(64))
    attributes: Mapped[dict[str, Any]] = mapped_column(default=dict)


class Condition(Base):
    __tablename__ = "conditions"
    __table_args__ = (UniqueConstraint("game_version_id", "condition_id"), {"schema": SCHEMA})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    game_version_id: Mapped[int] = mapped_column(ForeignKey(f"{SCHEMA}.game_versions.id", ondelete="CASCADE"))
    condition_id: Mapped[str] = mapped_column(String(128))
    phase: Mapped[str | None] = mapped_column(String(32))
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)
