"""JWT verification (OIDC-ready) and dev token issuance.

* ``AUTH_MODE=oidc``: RS256/ES256 tokens verified against the provider JWKS (issuer + audience),
  roles/studies read from configurable claims.
* ``AUTH_MODE=dev`` (only when ``ENV`` is dev/test): HS256 tokens signed with ``DEV_JWT_SECRET``,
  issued by ``POST /api/v1/auth/dev-login``.
* Kiosk devices authenticate with an opaque device token (``kdt_...``) looked up by digest.
"""

from __future__ import annotations

import time
from functools import lru_cache
from typing import Any

import jwt

from shriii_api.auth.rbac import Principal, Role
from shriii_api.settings import Settings

DEVICE_TOKEN_PREFIX = "kdt_"


class AuthError(Exception):
    """Authentication failed (401)."""


@lru_cache(maxsize=4)
def _jwks_client(url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(url, cache_keys=True, lifespan=300)


def issue_dev_token(
    settings: Settings, sub: str, roles: list[str], studies: list[str] | None = None, ttl_minutes: int | None = None
) -> tuple[str, int]:
    """Sign a dev JWT. Refuses outside dev/test."""
    if not settings.is_dev or settings.auth_mode != "dev":
        raise AuthError("dev login is disabled")
    now = int(time.time())
    exp = now + 60 * (ttl_minutes or settings.dev_jwt_ttl_minutes)
    claims = {
        "sub": sub,
        "roles": roles,
        "studies": studies if studies is not None else ["*"],
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "iat": now,
        "nbf": now,
        "exp": exp,
    }
    token = jwt.encode(claims, settings.dev_jwt_secret.get_secret_value(), algorithm="HS256")
    return token, exp


def _roles_from(claims: dict[str, Any], claim: str) -> frozenset[Role]:
    raw = claims.get(claim, [])
    if isinstance(raw, str):
        raw = [raw]
    roles: set[Role] = set()
    for value in raw if isinstance(raw, list) else []:
        try:
            role = Role(str(value).lower())
        except ValueError:
            continue
        if role is not Role.KIOSK_DEVICE:  # devices never authenticate with user JWTs
            roles.add(role)
    return frozenset(roles)


def verify_jwt(settings: Settings, token: str) -> Principal:
    try:
        if settings.auth_mode == "dev":
            claims = jwt.decode(
                token,
                settings.dev_jwt_secret.get_secret_value(),
                algorithms=["HS256"],
                audience=settings.jwt_audience,
                issuer=settings.jwt_issuer,
                options={"require": ["exp", "sub", "iss", "aud"]},
            )
            roles_claim, studies_claim = "roles", "studies"
        else:
            assert settings.oidc_jwks_url is not None
            signing_key = _jwks_client(settings.oidc_jwks_url).get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=settings.oidc_algorithms,
                audience=settings.jwt_audience,
                issuer=settings.jwt_issuer,
                options={"require": ["exp", "sub", "iss", "aud"]},
            )
            roles_claim, studies_claim = settings.oidc_roles_claim, settings.oidc_studies_claim
    except jwt.PyJWTError as exc:
        raise AuthError(f"invalid token: {exc}") from exc
    roles = _roles_from(claims, roles_claim)
    if not roles:
        raise AuthError("token carries no recognised role")
    studies_raw = claims.get(studies_claim, [])
    studies = frozenset(str(s) for s in studies_raw) if isinstance(studies_raw, list) else frozenset()
    return Principal(sub=str(claims["sub"]), roles=roles, kind="user", studies=studies)
