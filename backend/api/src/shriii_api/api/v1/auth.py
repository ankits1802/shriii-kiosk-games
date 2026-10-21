"""Dev login (ENV=dev/test only) and principal introspection."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from shriii_api.api.deps import CurrentPrincipal, SettingsDep, raise_error
from shriii_api.auth.tokens import AuthError, issue_dev_token

router = APIRouter(prefix="/auth", tags=["auth"])

UserRole = Literal["admin", "researcher", "administrator", "analyst"]


class DevLoginRequest(BaseModel):
    sub: str = Field(min_length=1, max_length=256, examples=["dev-researcher"])
    roles: list[UserRole] = Field(min_length=1)
    studies: list[str] | None = Field(default=None, description="Study scope; omit or ['*'] for all studies")
    ttl_minutes: int | None = Field(default=None, ge=1, le=1440)


class TokenResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_at: int


class MeResponse(BaseModel):
    sub: str
    kind: str
    roles: list[str]
    studies: list[str]
    permissions: list[str]
    kiosk_id: str | None


@router.post("/dev-login", response_model=TokenResponse, summary="Issue a signed dev JWT (dev/test only)")
def dev_login(body: DevLoginRequest, settings: SettingsDep) -> TokenResponse:
    try:
        token, exp = issue_dev_token(settings, body.sub, list(body.roles), body.studies, body.ttl_minutes)
    except AuthError as exc:
        raise_error(404, "dev_login_disabled", str(exc))
    return TokenResponse(access_token=token, expires_at=exp)


@router.get("/me", response_model=MeResponse, summary="Current principal")
def me(principal: CurrentPrincipal) -> MeResponse:
    return MeResponse(
        sub=principal.sub,
        kind=principal.kind,
        roles=sorted(r.value for r in principal.roles),
        studies=sorted(principal.studies),
        permissions=sorted(p.value for p in principal.permissions),
        kiosk_id=principal.kiosk_id,
    )
