"""Identity vault (separate DB/connection; PRV-04). Only link to research data: HMAC(pepper, pid)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from shriii_api.db.base import IDENTITY_SCHEMA, CreatedAtMixin, IdentityBase


class ContactRecord(IdentityBase, CreatedAtMixin):
    """Contact details for retest reminders (CRT-10); envelope-encrypted, purged at study end."""

    __tablename__ = "contacts"
    __table_args__ = {"schema": IDENTITY_SCHEMA}

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    pid_hmac: Mapped[str] = mapped_column(String(64), index=True)
    pepper_version: Mapped[int] = mapped_column(Integer)
    channel: Mapped[str] = mapped_column(String(16))
    """phone | sms | ivr | email"""
    contact_hmac: Mapped[str] = mapped_column(String(64), index=True)
    contact_ciphertext: Mapped[bytes] = mapped_column(LargeBinary)
    study_id: Mapped[str | None] = mapped_column(String(128))
    purge_after: Mapped[datetime | None] = mapped_column()


class RelinkAudit(IdentityBase, CreatedAtMixin):
    """Every vault read/relink with justification (IdentitySteward)."""

    __tablename__ = "relink_audit"
    __table_args__ = {"schema": IDENTITY_SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    pid_hmac: Mapped[str] = mapped_column(String(64), index=True)
    actor: Mapped[str] = mapped_column(String(256))
    action: Mapped[str] = mapped_column(String(32))
    justification: Mapped[str] = mapped_column(Text)
