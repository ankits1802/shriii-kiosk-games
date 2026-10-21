"""Register a load-test kiosk fleet through the admin API and cache device tokens locally.

Uses ``POST /api/v1/auth/dev-login`` (ENV=dev/test only) for an admin token, then
``POST /api/v1/admin/kiosks`` for new kiosks or ``POST /api/v1/admin/kiosks/{id}/rotate-token`` for
existing ones (tokens are shown once). The fleet file holds bearer secrets: it lives under the
git-ignored ``.cache`` directory and is never committed.
"""

from __future__ import annotations

import base64
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import httpx

from shriii_loadtest.batches import KioskIdentity

__all__ = ["Fleet", "dev_token", "load_fleet", "provision_fleet"]


@dataclass(slots=True)
class Fleet:
    base_url: str
    backend_x25519_public_key: str
    kiosks: list[KioskIdentity]

    @property
    def public_key_bytes(self) -> bytes:
        return base64.b64decode(self.backend_x25519_public_key)

    def to_json(self) -> dict[str, Any]:
        return {
            "base_url": self.base_url,
            "backend_x25519_public_key": self.backend_x25519_public_key,
            "kiosks": [asdict(k) for k in self.kiosks],
        }


def dev_token(client: httpx.Client, roles: list[str], sub: str = "loadtest") -> str:
    resp = client.post("/api/v1/auth/dev-login", json={"sub": sub, "roles": roles, "ttl_minutes": 1440})
    resp.raise_for_status()
    return str(resp.json()["access_token"])


def provision_fleet(
    base_url: str,
    count: int,
    *,
    prefix: str = "lt",
    site_id: str = "site-load-01",
    client: httpx.Client | None = None,
) -> Fleet:
    """Register ``count`` kiosks (``client`` may be an in-process test client)."""
    if client is None:
        with httpx.Client(base_url=base_url, timeout=30) as own:
            return provision_fleet(base_url, count, prefix=prefix, site_id=site_id, client=own)
    kiosks: list[KioskIdentity] = []
    public_key = ""
    admin = {"Authorization": f"Bearer {dev_token(client, ['admin'], 'loadtest-admin')}"}
    for i in range(1, count + 1):
        kiosk_id = f"{prefix}-{i:04d}"
        resp = client.post(
            "/api/v1/admin/kiosks",
            json={"kiosk_id": kiosk_id, "site_id": site_id, "label": "load test"},
            headers=admin,
        )
        if resp.status_code == 409:
            resp = client.post(f"/api/v1/admin/kiosks/{kiosk_id}/rotate-token", headers=admin)
        resp.raise_for_status()
        doc = resp.json()
        public_key = doc["backend_x25519_public_key"]
        kiosks.append(KioskIdentity(kiosk_id=kiosk_id, site_id=site_id, token=doc["device_token"]))
    return Fleet(base_url=base_url, backend_x25519_public_key=public_key, kiosks=kiosks)


def save_fleet(fleet: Fleet, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fleet.to_json(), indent=2), encoding="utf-8")


def load_fleet(path: Path) -> Fleet:
    doc = json.loads(path.read_text(encoding="utf-8"))
    return Fleet(
        base_url=doc["base_url"],
        backend_x25519_public_key=doc["backend_x25519_public_key"],
        kiosks=[KioskIdentity(**k) for k in doc["kiosks"]],
    )
