"""Device configuration written at enrolment.

Layout under the device root (``$SNAP_COMMON`` of the ``shriii-kiosk`` snap on Ubuntu Core; it survives
snap refreshes and reverts, unlike ``$SNAP_DATA``)::

    kiosk-config.json        read by the Electron runtime (SHRIII_KIOSK_CONFIG; frontend/apps/kiosk-electron
                             src/main/config.ts): kioskId, apiOrigin, recipientKeysPath, printer, update
    recipient-keys.json      backend X25519 recipient keys for per-session DEK sealing (KSK-07)
    device.json              provisioning record: site, site_mode, deployment, CA, versions (no secrets)
    secrets/device-token     API device token (kdt_...), 0600
    tls/device.key           device private key (EC P-256, generated on the device), 0600
    tls/device.crt           short-lived step-ca client certificate
    tls/chain.crt            certificate chain (leaf + intermediate)
    tls/root_ca.crt          pinned root (fingerprint checked against the enrolment bundle)

All files are written atomically (temp file + rename) and secrets with mode 0600.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from shriii_provision import ProvisionError

# The API's kiosk id pattern (backend/api admin.KioskCreate); stricter than the runtime's.
KIOSK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
SITE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
RINGS = ("lab", "canary", "ring10", "stable")

CONFIG_FILE = "kiosk-config.json"
RECIPIENT_KEYS_FILE = "recipient-keys.json"
DEVICE_RECORD_FILE = "device.json"
TOKEN_FILE = "secrets/device-token"
KEY_FILE = "tls/device.key"
CERT_FILE = "tls/device.crt"
CHAIN_FILE = "tls/chain.crt"
ROOT_FILE = "tls/root_ca.crt"


def validate_kiosk_id(kiosk_id: str) -> str:
    if not KIOSK_ID_RE.fullmatch(kiosk_id):
        raise ProvisionError(f"invalid kiosk id {kiosk_id!r}: lowercase letters, digits and '-', 2-64 chars")
    return kiosk_id


def validate_site_id(site_id: str) -> str:
    if not SITE_ID_RE.fullmatch(site_id):
        raise ProvisionError(f"invalid site id {site_id!r}")
    return site_id


def validate_origin(value: str, field_name: str, *, allow_http: bool = False) -> str:
    """Mirror of the runtime's ``parseOrigin``: https (or http when allowed), no credentials, no path."""
    parts = urlsplit(value)
    if parts.scheme not in ("https", "http") or not parts.hostname:
        raise ProvisionError(f"{field_name} is not an http(s) URL")
    if parts.scheme == "http" and not allow_http:
        raise ProvisionError(f"{field_name} must use https")
    if parts.username or parts.password:
        raise ProvisionError(f"{field_name} must not contain credentials")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ProvisionError(f"{field_name} must be an origin without a path")
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme}://{parts.hostname}{port}"


def recipient_key_entry(public_key_b64: str, *, not_before: datetime | None = None) -> dict[str, Any]:
    raw = base64.b64decode(public_key_b64, validate=True)
    if len(raw) != 32:
        raise ProvisionError("backend X25519 public key must be 32 bytes")
    kid = "backend-x25519-" + hashlib.sha256(raw).hexdigest()[:16]
    nb = (not_before or datetime(2026, 1, 1, tzinfo=UTC)).isoformat().replace("+00:00", "Z")
    return {"kid": kid, "public_key": public_key_b64, "not_before": nb, "not_after": None}


PrinterKind = Literal["none", "virtual", "network", "device"]


@dataclass(frozen=True)
class PrinterSpec:
    kind: PrinterKind = "device"
    path: str = "/dev/usb/lp0"
    host: str | None = None
    port: int = 9100

    @classmethod
    def parse(cls, value: str) -> PrinterSpec:
        """``none`` | ``virtual`` | ``device:/dev/usb/lp0`` | ``tcp://host[:port]``."""
        if value == "none":
            return cls(kind="none")
        if value == "virtual":
            return cls(kind="virtual")
        if value.startswith("device:"):
            path = value.removeprefix("device:")
            if not path.startswith("/dev/"):
                raise ProvisionError("printer device path must be under /dev")
            return cls(kind="device", path=path)
        if value.startswith("tcp://"):
            parts = urlsplit(value)
            if not parts.hostname:
                raise ProvisionError("printer tcp:// needs a host")
            return cls(kind="network", host=parts.hostname, port=parts.port or 9100)
        raise ProvisionError(f"printer not understood: {value!r}")

    def to_json(self) -> dict[str, Any]:
        if self.kind == "device":
            return {"kind": "device", "path": self.path}
        if self.kind == "network":
            return {"kind": "network", "host": self.host, "port": self.port}
        if self.kind == "virtual":
            return {"kind": "virtual"}
        return {"kind": "none"}


@dataclass(frozen=True)
class UpdateSpec:
    feed_url: str | None = None
    ring: str | None = None
    manifest_public_key: str | None = None
    frozen_version: str | None = None

    def to_json(self) -> dict[str, Any]:
        if self.ring is not None and self.ring not in RINGS:
            raise ProvisionError(f"update ring must be one of {', '.join(RINGS)}")
        out: dict[str, Any] = {}
        if self.feed_url:
            if urlsplit(self.feed_url).scheme != "https":
                raise ProvisionError("update feed must use https")
            out["feedUrl"] = self.feed_url.rstrip("/")
        if self.ring:
            out["ring"] = self.ring
        if self.manifest_public_key:
            out["manifestPublicKey"] = self.manifest_public_key
        if self.frozen_version:
            out["frozenVersion"] = self.frozen_version
        return out


@dataclass(frozen=True)
class DeviceConfig:
    kiosk_id: str
    api_origin: str
    printer: PrinterSpec = field(default_factory=PrinterSpec)
    update: UpdateSpec = field(default_factory=UpdateSpec)

    def kiosk_config_json(self, root: Path) -> dict[str, Any]:
        """The Electron runtime config. Paths are absolute on the device."""
        validate_kiosk_id(self.kiosk_id)
        return {
            "kioskId": self.kiosk_id,
            "apiOrigin": validate_origin(self.api_origin, "apiOrigin"),
            "recipientKeysPath": str(root / RECIPIENT_KEYS_FILE).replace("\\", "/"),
            "printer": self.printer.to_json(),
            "update": self.update.to_json(),
        }


def write_atomic(path: Path, data: bytes, *, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def write_json(path: Path, obj: Any, *, mode: int = 0o644) -> None:
    write_atomic(path, (json.dumps(obj, indent=2, sort_keys=True) + "\n").encode(), mode=mode)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ProvisionError(f"missing {path}") from exc
    except json.JSONDecodeError as exc:
        raise ProvisionError(f"{path} is not valid JSON: {exc}") from exc
