"""Audit logging: every write and every research-data read is recorded (PRV-08).

The HTTP middleware writes one ``governance.audit_events`` row per audited request in its own
transaction (so denials and failures are recorded even when the request transaction rolls back).
Services can also write audit rows directly (worker, CLI, erasure).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Request, Response
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from shriii_api.auth.rbac import Principal
from shriii_api.db.models.ops import AuditEvent
from shriii_api.db.session import session_scope
from shriii_api.observability import request_id_var

log = logging.getLogger(__name__)

# GETs on these prefixes are not research data (public catalogues, health) and are not audited.
_UNAUDITED_GET_PREFIXES = (
    "/api/v1/games",
    "/api/v1/instruments",
    "/api/v1/auth",
    "/api/v1/admin/gates/release-pack/public-key",
)
_UNAUDITED_PATHS = ("/healthz", "/readyz", "/livez", "/openapi.json", "/docs", "/redoc")


def record_audit(
    session: Session,
    *,
    action: str,
    actor: Principal | None,
    outcome: str = "success",
    resource_type: str | None = None,
    resource_id: str | None = None,
    study_id: str | None = None,
    details: dict[str, Any] | None = None,
    method: str | None = None,
    path: str | None = None,
    status_code: int | None = None,
    ip: str | None = None,
) -> None:
    session.add(
        AuditEvent(
            actor_sub=actor.sub if actor else None,
            actor_roles=sorted(r.value for r in actor.roles) if actor else [],
            actor_kind=actor.kind if actor else "anonymous",
            action=action,
            method=method,
            path=path,
            status_code=status_code,
            outcome=outcome,
            resource_type=resource_type,
            resource_id=resource_id,
            study_id=study_id,
            request_id=request_id_var.get(),
            ip=ip,
            details=details or {},
        )
    )


def _should_audit(request: Request) -> bool:
    path = request.url.path
    if not path.startswith("/api/") or path in _UNAUDITED_PATHS:
        return False
    if request.method in ("OPTIONS", "HEAD"):
        return False
    return not (request.method == "GET" and path.startswith(_UNAUDITED_GET_PREFIXES))


def _write(request: Request, response_status: int) -> None:
    audit: dict[str, Any] = getattr(request.state, "audit", None) or {}
    principal: Principal | None = getattr(request.state, "principal", None)
    outcome = getattr(request.state, "audit_outcome", None)
    if outcome is None:
        if response_status in (401, 403):
            outcome = "denied"
        elif response_status >= 400:
            outcome = "error"
        else:
            outcome = "success"
    route = request.scope.get("route")
    template = getattr(route, "path", None) or request.url.path
    details = dict(audit.get("details", {}))
    failure = getattr(request.state, "auth_failure", None)
    if failure:
        details["auth_failure"] = failure
    with session_scope() as session:
        record_audit(
            session,
            action=audit.get("action") or f"{request.method} {template}",
            actor=principal,
            outcome=outcome,
            resource_type=audit.get("resource_type"),
            resource_id=audit.get("resource_id"),
            study_id=audit.get("study_id"),
            details=details,
            method=request.method,
            path=request.url.path,
            status_code=response_status,
            ip=request.client.host if request.client else None,
        )


async def audit_middleware(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    """Assign a request id, run the request, then write the audit row (failures are logged, never hidden)."""
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex
    token = request_id_var.set(rid)
    try:
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
        finally:
            if _should_audit(request):
                try:
                    await run_in_threadpool(_write, request, status_code)
                except Exception:
                    log.exception("audit write failed", extra={"path": request.url.path})
                    raise
        response.headers["x-request-id"] = rid
        return response
    finally:
        request_id_var.reset(token)
