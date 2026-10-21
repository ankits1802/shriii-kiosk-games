"""Thin client for the SHRIII API endpoints provisioning needs.

Endpoints (backend/api, ``/api/v1``):
  GET  /healthz                         liveness (outside /api/v1)
  POST /api/v1/admin/kiosks             register; returns the device token once (admin bearer)
  GET  /api/v1/admin/kiosks             fleet list (admin bearer)
  POST /api/v1/admin/kiosks/{id}/rotate-token
  POST /api/v1/admin/deployments        site + site_mode assignment (admin bearer)
  POST /api/v1/admin/kiosks/heartbeat   device heartbeat (device token)

Secrets (admin bearer, device token) are never included in exception messages or logs.
"""

from __future__ import annotations

import ssl
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from shriii_provision import ProvisionError

SiteMode = Literal["supervised", "open_public"]
SITE_MODES: tuple[SiteMode, ...] = ("supervised", "open_public")
DEFAULT_TIMEOUT = httpx.Timeout(15.0, connect=5.0)


@dataclass(frozen=True)
class Registration:
    kiosk: dict[str, Any]
    device_token: str
    backend_x25519_public_key: str


def _error_detail(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:200]
    if isinstance(body, dict):
        detail = body.get("detail", body.get("error", body))
        if isinstance(detail, dict):
            code = detail.get("code", "")
            message = detail.get("message", "")
            return f"{code}: {message}".strip(": ")
        return str(detail)[:200]
    return str(body)[:200]


class ApiClient:
    """Synchronous API client. ``transport`` is injectable for tests (``httpx.MockTransport``)."""

    def __init__(
        self,
        api_origin: str,
        *,
        admin_token: str | None = None,
        transport: httpx.BaseTransport | None = None,
        verify: ssl.SSLContext | str | bool = True,
        cert: tuple[str, str] | None = None,
        timeout: httpx.Timeout = DEFAULT_TIMEOUT,
    ) -> None:
        self.api_origin = api_origin.rstrip("/")
        self._admin_token = admin_token
        kwargs: dict[str, Any] = {"base_url": self.api_origin, "timeout": timeout}
        if transport is not None:
            kwargs["transport"] = transport
        else:
            if cert is not None:
                ctx = verify if isinstance(verify, ssl.SSLContext) else _context(verify)
                ctx.load_cert_chain(*cert)
                verify = ctx
            kwargs["verify"] = verify
        self._http = httpx.Client(**kwargs)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> ApiClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------ helpers

    def _admin_headers(self) -> dict[str, str]:
        if not self._admin_token:
            raise ProvisionError("an admin token is required (--admin-token-file or SHRIII_ADMIN_TOKEN)")
        return {"authorization": f"Bearer {self._admin_token}"}

    def _request(self, method: str, path: str, *, expect: tuple[int, ...], **kwargs: Any) -> Any:
        try:
            resp = self._http.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise ProvisionError(f"{method} {path}: {type(exc).__name__}: {exc}") from exc
        if resp.status_code not in expect:
            raise ProvisionError(f"{method} {path}: HTTP {resp.status_code} {_error_detail(resp)}")
        if not resp.content:
            return None
        try:
            return resp.json()
        except ValueError as exc:
            raise ProvisionError(f"{method} {path}: response is not JSON") from exc

    # ------------------------------------------------------------------ endpoints

    def healthz(self) -> dict[str, Any]:
        body = self._request("GET", "/healthz", expect=(200,))
        if not isinstance(body, dict) or body.get("status") != "ok":
            raise ProvisionError(f"GET /healthz: unexpected body {body!r}")
        return body

    def register_kiosk(
        self, *, kiosk_id: str, site_id: str, label: str | None, hardware_sku: str | None
    ) -> Registration:
        body = self._request(
            "POST",
            "/api/v1/admin/kiosks",
            expect=(201,),
            headers=self._admin_headers(),
            json={"kiosk_id": kiosk_id, "site_id": site_id, "label": label, "hardware_sku": hardware_sku},
        )
        return _registration(body)

    def rotate_token(self, kiosk_id: str) -> Registration:
        body = self._request(
            "POST", f"/api/v1/admin/kiosks/{kiosk_id}/rotate-token", expect=(200,), headers=self._admin_headers()
        )
        return _registration(body)

    def list_kiosks(self) -> list[dict[str, Any]]:
        body = self._request("GET", "/api/v1/admin/kiosks", expect=(200,), headers=self._admin_headers())
        if not isinstance(body, list):
            raise ProvisionError("GET /api/v1/admin/kiosks: expected a list")
        return body

    def create_deployment(
        self,
        *,
        kiosk_id: str,
        site_id: str,
        site_mode: SiteMode,
        policy_version: str,
        app_version: str,
        study_id: str | None = None,
        ring: str = "pilot",
    ) -> dict[str, Any]:
        if site_mode not in SITE_MODES:
            raise ProvisionError(f"site_mode must be one of {', '.join(SITE_MODES)}")
        body = self._request(
            "POST",
            "/api/v1/admin/deployments",
            expect=(201,),
            headers=self._admin_headers(),
            json={
                "kiosk_id": kiosk_id,
                "site_id": site_id,
                "site_mode": site_mode,
                "study_id": study_id,
                "policy_version": policy_version,
                "app_version": app_version,
                "ring": ring,
            },
        )
        if not isinstance(body, dict):
            raise ProvisionError("POST /api/v1/admin/deployments: expected an object")
        return body

    def heartbeat(self, device_token: str, *, app_version: str | None, payload: dict[str, Any]) -> dict[str, Any]:
        body = self._request(
            "POST",
            "/api/v1/admin/kiosks/heartbeat",
            expect=(200,),
            headers={"authorization": f"Bearer {device_token}"},
            json={"app_version": app_version, "payload": payload},
        )
        if not isinstance(body, dict):
            raise ProvisionError("POST /api/v1/admin/kiosks/heartbeat: expected an object")
        return body


def _registration(body: Any) -> Registration:
    try:
        return Registration(
            kiosk=dict(body["kiosk"]),
            device_token=str(body["device_token"]),
            backend_x25519_public_key=str(body["backend_x25519_public_key"]),
        )
    except (KeyError, TypeError) as exc:
        raise ProvisionError("kiosk registration response is missing fields") from exc


def _context(verify: str | bool) -> ssl.SSLContext:
    if isinstance(verify, str):
        ctx = ssl.create_default_context(cafile=verify)
    else:
        ctx = ssl.create_default_context()
        if not verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx
