"""Roles, permissions and the principal model (PRV-08). The permission matrix is tested in CI.

Roles: ``admin``, ``researcher``, ``administrator`` (field administrator), ``analyst``
(de-identified data only) and ``kiosk_device``. Study scope: a principal carries the studies it may
touch (``"*"`` = all); admins are unscoped.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class Role(StrEnum):
    ADMIN = "admin"
    RESEARCHER = "researcher"
    ADMINISTRATOR = "administrator"
    ANALYST = "analyst"
    KIOSK_DEVICE = "kiosk_device"


class Perm(StrEnum):
    SESSIONS_WRITE = "sessions.write"
    SESSIONS_READ = "sessions.read"
    SESSIONS_INVALIDATE = "sessions.invalidate"
    EVENTS_INGEST = "events.ingest"
    EVENTS_READ_RAW = "events.read_raw"
    GAMES_READ = "games.read"
    GAMES_WRITE = "games.write"
    PARTICIPANTS_CREATE = "participants.create"
    PARTICIPANTS_READ = "participants.read"
    PARTICIPANTS_LINK = "participants.link"
    PARTICIPANTS_WITHDRAW = "participants.withdraw"
    CONSENT_WRITE = "consent.write"
    CONSENT_READ = "consent.read"
    CONTACT_WRITE = "contact.write"
    ERASURE_REQUEST = "erasure.request"
    ERASURE_EXECUTE = "erasure.execute"
    INSTRUMENTS_READ = "instruments.read"
    INSTRUMENTS_WRITE = "instruments.write"
    RESPONSES_WRITE = "responses.write"
    RESPONSES_READ = "responses.read"
    SCORES_READ = "scores.read"
    IMPORTS_WRITE = "imports.write"
    FEATURES_READ = "features.read"
    FEATURES_RUN = "features.run"
    DATASETS_READ = "datasets.read"
    DATASETS_WRITE = "datasets.write"
    VALIDATION_READ = "validation.read"
    VALIDATION_RUN = "validation.run"
    MODELS_READ = "models.read"
    MODELS_WRITE = "models.write"
    NORMS_READ = "norms.read"
    NORMS_WRITE = "norms.write"
    REPORTS_GENERATE = "reports.generate"
    REPORTS_READ = "reports.read"
    REPORTS_MANAGE = "reports.manage"
    GATES_READ = "gates.read"
    GATES_WRITE = "gates.write"
    STUDIES_READ = "studies.read"
    STUDIES_WRITE = "studies.write"
    STUDIES_ENROLL = "studies.enroll"
    JOBS_READ = "jobs.read"
    JOBS_WRITE = "jobs.write"
    KIOSK_HEARTBEAT = "kiosk.heartbeat"
    ADMIN_KIOSKS = "admin.kiosks"
    ADMIN_CONTENT = "admin.content"
    ADMIN_SETTINGS = "admin.settings"
    AUDIT_READ = "audit.read"
    RETENTION_RUN = "retention.run"
    DEAD_LETTER_MANAGE = "dead_letter.manage"


_RESEARCH_READ = {
    Perm.SESSIONS_READ,
    Perm.GAMES_READ,
    Perm.INSTRUMENTS_READ,
    Perm.FEATURES_READ,
    Perm.DATASETS_READ,
    Perm.VALIDATION_READ,
    Perm.MODELS_READ,
    Perm.NORMS_READ,
    Perm.GATES_READ,
    Perm.STUDIES_READ,
    Perm.JOBS_READ,
}

ROLE_PERMISSIONS: dict[Role, frozenset[Perm]] = {
    Role.ADMIN: frozenset(Perm),
    Role.RESEARCHER: frozenset(
        _RESEARCH_READ
        | {
            Perm.SESSIONS_WRITE,
            Perm.SESSIONS_INVALIDATE,
            Perm.EVENTS_READ_RAW,
            Perm.PARTICIPANTS_CREATE,
            Perm.PARTICIPANTS_READ,
            Perm.PARTICIPANTS_LINK,
            Perm.PARTICIPANTS_WITHDRAW,
            Perm.CONSENT_WRITE,
            Perm.CONSENT_READ,
            Perm.CONTACT_WRITE,
            Perm.ERASURE_REQUEST,
            Perm.INSTRUMENTS_WRITE,
            Perm.RESPONSES_WRITE,
            Perm.RESPONSES_READ,
            Perm.SCORES_READ,
            Perm.IMPORTS_WRITE,
            Perm.FEATURES_RUN,
            Perm.DATASETS_WRITE,
            Perm.VALIDATION_RUN,
            Perm.MODELS_WRITE,
            Perm.NORMS_WRITE,
            Perm.REPORTS_GENERATE,
            Perm.REPORTS_READ,
            Perm.REPORTS_MANAGE,
            Perm.STUDIES_WRITE,
            Perm.STUDIES_ENROLL,
            Perm.JOBS_WRITE,
        }
    ),
    # Field administrators run sessions and the battery but never read scores (PRV-08 AC).
    Role.ADMINISTRATOR: frozenset(
        {
            Perm.SESSIONS_WRITE,
            Perm.SESSIONS_READ,
            Perm.GAMES_READ,
            Perm.PARTICIPANTS_CREATE,
            Perm.PARTICIPANTS_READ,
            Perm.PARTICIPANTS_LINK,
            Perm.PARTICIPANTS_WITHDRAW,
            Perm.CONSENT_WRITE,
            Perm.CONTACT_WRITE,
            Perm.ERASURE_REQUEST,
            Perm.INSTRUMENTS_READ,
            Perm.RESPONSES_WRITE,
            Perm.REPORTS_GENERATE,
            Perm.STUDIES_READ,
            Perm.STUDIES_ENROLL,
        }
    ),
    # Analysts see de-identified layers only: no linkage, consent, raw events or identity (CRT-01 AC).
    Role.ANALYST: frozenset(_RESEARCH_READ | {Perm.VALIDATION_RUN, Perm.MODELS_WRITE, Perm.JOBS_WRITE}),
    Role.KIOSK_DEVICE: frozenset(
        {
            Perm.EVENTS_INGEST,
            Perm.SESSIONS_WRITE,
            Perm.GAMES_READ,
            Perm.GATES_READ,
            Perm.REPORTS_GENERATE,
            Perm.KIOSK_HEARTBEAT,
            Perm.ERASURE_REQUEST,
            Perm.PARTICIPANTS_LINK,
        }
    ),
}


@dataclass(frozen=True, slots=True)
class Principal:
    """Authenticated caller."""

    sub: str
    roles: frozenset[Role]
    kind: str = "user"
    """user | device"""
    studies: frozenset[str] = field(default_factory=lambda: frozenset({"*"}))
    kiosk_id: str | None = None
    site_id: str | None = None

    @property
    def permissions(self) -> frozenset[Perm]:
        out: set[Perm] = set()
        for role in self.roles:
            out |= ROLE_PERMISSIONS[role]
        return frozenset(out)

    def has(self, perm: Perm) -> bool:
        return perm in self.permissions

    def can_access_study(self, study_id: str | None) -> bool:
        if study_id is None or Role.ADMIN in self.roles or "*" in self.studies:
            return True
        return study_id in self.studies

    @property
    def is_admin(self) -> bool:
        return Role.ADMIN in self.roles


SYSTEM_PRINCIPAL = Principal(sub="system", roles=frozenset({Role.ADMIN}), kind="system")
