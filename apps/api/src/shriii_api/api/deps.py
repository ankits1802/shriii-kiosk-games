"""Request-scoped dependencies: DB session, principal resolution, permission checks and audit context."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Annotated, Any, NoReturn

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from shriii_api.auth.rbac import Perm, Principal, Role
from shriii_api.auth.tokens import DEVICE_TOKEN_PREFIX, AuthError, verify_jwt
from shriii_api.db.models.ops import Kiosk
from shriii_api.db.session import session_factory
from shriii_api.security import token_digest
from shriii_api.settings import Settings, get_settings


def api_error(status_code: int, code: str, message: str, **extra: Any) -> HTTPException:
    """HTTPException with a stable machine-readable ``code`` (body: ``{"detail": {"code", "message"}}``)."""
    return HTTPException(status_code=status_code, detail={"code": code, "message": message, **extra})


def raise_error(status_code: int, code: str, message: str, **extra: Any) -> NoReturn:
    raise api_error(status_code, code, message, **extra)


def get_db() -> Iterator[Session]:
    """One transaction per request: commit on success, roll back on any exception."""
    session = session_factory()()
    try:
        yield session
        session.commit()
    except BaseException:
        session.rollback()
        raise
    finally:
        session.close()


DbSession = Annotated[Session, Depends(get_db, scope="function")]
"""Committed before the response is sent, so a commit failure is reported to the client."""
SettingsDep = Annotated[Settings, Depends(get_settings)]


def set_audit(
    request: Request,
    *,
    action: str | None = None,
    resource_type: str | None = None,
    resource_id: str | None = None,
    study_id: str | None = None,
    **details: Any,
) -> None:
    """Attach audit context for the middleware (written in its own transaction after the response)."""
    audit: dict[str, Any] = getattr(request.state, "audit", None) or {}
    if action is not None:
        audit["action"] = action
    if resource_type is not None:
        audit["resource_type"] = resource_type
    if resource_id is not None:
        audit["resource_id"] = resource_id
    if study_id is not None:
        audit["study_id"] = study_id
    if details:
        audit.setdefault("details", {}).update(details)
    request.state.audit = audit


def _resolve_device(token: str) -> Principal:
    with session_factory()() as session:
        kiosk = session.execute(select(Kiosk).where(Kiosk.token_digest == token_digest(token))).scalar_one_or_none()
        if kiosk is None or kiosk.status != "active":
            raise AuthError("unknown or revoked device token")
        return Principal(
            sub=f"kiosk:{kiosk.kiosk_id}",
            roles=frozenset({Role.KIOSK_DEVICE}),
            kind="device",
            kiosk_id=kiosk.kiosk_id,
            site_id=kiosk.site_id,
        )


def resolve_principal(request: Request, settings: Settings) -> Principal | None:
    header = request.headers.get("authorization", "")
    token: str | None = None
    if header.lower().startswith("bearer "):
        token = header[7:].strip()
    elif request.headers.get("x-device-token"):
        token = request.headers["x-device-token"].strip()
    if not token:
        return None
    if token.startswith(DEVICE_TOKEN_PREFIX):
        return _resolve_device(token)
    return verify_jwt(settings, token)


def get_principal(request: Request, settings: SettingsDep) -> Principal:
    try:
        principal = resolve_principal(request, settings)
    except AuthError as exc:
        request.state.auth_failure = str(exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthenticated", "message": str(exc)},
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    if principal is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthenticated", "message": "missing bearer token"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    request.state.principal = principal
    return principal


def get_optional_principal(request: Request, settings: SettingsDep) -> Principal | None:
    try:
        principal = resolve_principal(request, settings)
    except AuthError:
        return None
    if principal is not None:
        request.state.principal = principal
    return principal


CurrentPrincipal = Annotated[Principal, Depends(get_principal)]


def require(*perms: Perm) -> Callable[..., Principal]:
    """Dependency factory: the caller must hold every listed permission (else 403, audited as denied)."""

    def dependency(request: Request, principal: CurrentPrincipal) -> Principal:
        missing = [p.value for p in perms if not principal.has(p)]
        if missing:
            request.state.audit_outcome = "denied"
            raise api_error(status.HTTP_403_FORBIDDEN, "forbidden", "missing permission", missing=missing)
        return principal

    return dependency


def ensure_study_access(request: Request, principal: Principal, study_id: str | None) -> None:
    """Study-scoped permission check (403 when the principal is not scoped to ``study_id``)."""
    if not principal.can_access_study(study_id):
        request.state.audit_outcome = "denied"
        raise api_error(status.HTTP_403_FORBIDDEN, "study_forbidden", f"no access to study {study_id}")


def redact_pid(principal: Principal, pid: str | None) -> str | None:
    """Analysts never see pids (de-identified access only)."""
    return pid if principal.has(Perm.PARTICIPANTS_READ) else None
