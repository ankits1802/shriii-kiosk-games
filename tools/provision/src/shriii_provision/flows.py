"""Provisioning flows: register (workstation), enrol (device), verify and renew (device).

workstation                         API                    step-ca              kiosk (Ubuntu Core)
───────────                         ───                    ───────              ───────────────────
register ── POST admin/kiosks ────▶ device token (once)
         ── POST admin/deployments ▶ site + site_mode
         ── mint one-time token (kiosk-enrolment JWK provisioner, bound to kiosk SANs, 15 min)
         ── write enrolment bundle (0600) ───────────────────────────────────────▶ snap set / push
                                                                                 enrol: keygen on device,
                                                       ◀── CSR + OTT /1.0/sign ── CSR, write config
                                                                                 verify: healthz, mTLS,
                                     ◀──────────────────── heartbeat (device token)
"""

from __future__ import annotations

import os
import ssl
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.x509.oid import NameOID

from shriii_provision import ProvisionError, __version__, stepca
from shriii_provision import device_config as dc
from shriii_provision.api import ApiClient, SiteMode

BUNDLE_SCHEMA = "shriii.enrolment-bundle/v1"


# ---------------------------------------------------------------------------------------------- register


@dataclass(frozen=True)
class RegisterRequest:
    kiosk_id: str
    site_id: str
    site_mode: SiteMode
    policy_version: str
    app_version: str
    ca_url: str
    root_ca_pem: bytes
    provisioner: stepca.ProvisionerKey
    label: str | None = None
    hardware_sku: str | None = None
    study_id: str | None = None
    ring: str = "pilot"
    domain: str = stepca.DEFAULT_DOMAIN
    token_ttl_s: int = 900
    rotate_existing: bool = False
    printer: dc.PrinterSpec = field(default_factory=dc.PrinterSpec)
    update: dc.UpdateSpec = field(default_factory=dc.UpdateSpec)


def register(api: ApiClient, req: RegisterRequest, *, now: datetime | None = None) -> dict[str, Any]:
    """Register the kiosk, assign its site and site mode, and return the enrolment bundle (contains secrets)."""
    dc.validate_kiosk_id(req.kiosk_id)
    dc.validate_site_id(req.site_id)
    # open_public kiosks ARE bound to the study: they run thank-you mode for the unattended-mode substudy
    # (VAL-18) and site_mode is an invariance grouping. The PRV-01 rejected combinations (criterion capture or
    # live dyads at open_public) are enforced by the signed deployment policy, not by refusing the study link.
    created = now or datetime.now(UTC)
    api.healthz()
    if req.rotate_existing:
        reg = api.rotate_token(req.kiosk_id)
    else:
        reg = api.register_kiosk(
            kiosk_id=req.kiosk_id, site_id=req.site_id, label=req.label, hardware_sku=req.hardware_sku
        )
    deployment = api.create_deployment(
        kiosk_id=req.kiosk_id,
        site_id=req.site_id,
        site_mode=req.site_mode,
        policy_version=req.policy_version,
        app_version=req.app_version,
        study_id=req.study_id,
        ring=req.ring,
    )
    identity = stepca.DeviceIdentity(req.kiosk_id, req.domain)
    fingerprint = stepca.root_fingerprint(req.root_ca_pem)
    ott = stepca.mint_ott(
        req.provisioner,
        ca_url=req.ca_url,
        subject=req.kiosk_id,
        sans=identity.sans,
        root_sha256=fingerprint,
        ttl_s=req.token_ttl_s,
        now=created.timestamp(),
    )
    return {
        "schema": BUNDLE_SCHEMA,
        "created_at": _iso(created),
        "expires_at": _iso(created + timedelta(seconds=req.token_ttl_s)),
        "created_by_tool": f"shriii-provision/{__version__}",
        "kiosk_id": req.kiosk_id,
        "site_id": req.site_id,
        "site_mode": req.site_mode,
        "study_id": req.study_id,
        "deployment_id": str(deployment.get("id", "")),
        "policy_version": req.policy_version,
        "app_version": req.app_version,
        "ring": req.ring,
        "api_origin": api.api_origin,
        "device_token": reg.device_token,
        "recipient_keys": [dc.recipient_key_entry(reg.backend_x25519_public_key)],
        "ca": {
            "url": req.ca_url.rstrip("/"),
            "root_fingerprint": fingerprint,
            "root_pem": req.root_ca_pem.decode(),
            "provisioner": req.provisioner.name,
            "domain": req.domain,
            "ott": ott,
        },
        "config": {"printer": req.printer.to_json(), "update": req.update.to_json()},
        "lockdown": {"disable_ssh": True, "blacklist_usb_storage": True, "remove_system_users": True},
    }


def write_bundle(path: Path, bundle: dict[str, Any]) -> None:
    dc.write_json(path, bundle, mode=0o600)


def load_bundle(path: Path, *, now: datetime | None = None) -> dict[str, Any]:
    bundle = dc.read_json(path)
    if not isinstance(bundle, dict) or bundle.get("schema") != BUNDLE_SCHEMA:
        raise ProvisionError(f"{path} is not a {BUNDLE_SCHEMA} enrolment bundle")
    for key in ("kiosk_id", "site_id", "site_mode", "api_origin", "device_token", "recipient_keys", "ca", "config"):
        if key not in bundle:
            raise ProvisionError(f"enrolment bundle is missing {key!r}")
    expires = datetime.fromisoformat(str(bundle["expires_at"]).replace("Z", "+00:00"))
    if (now or datetime.now(UTC)) >= expires:
        raise ProvisionError("enrolment bundle has expired; run register again (with --rotate-existing)")
    return bundle


# ---------------------------------------------------------------------------------------------- enrol


@dataclass(frozen=True)
class EnrolResult:
    kiosk_id: str
    certificate_serial: str
    certificate_not_after: datetime
    root: Path


def _printer_from(raw: dict[str, Any]) -> dc.PrinterSpec:
    kind = raw.get("kind", "device")
    if kind == "device":
        return dc.PrinterSpec(kind="device", path=str(raw.get("path", "/dev/usb/lp0")))
    if kind == "network":
        return dc.PrinterSpec(kind="network", host=str(raw["host"]), port=int(raw.get("port", 9100)))
    if kind in ("virtual", "none"):
        return dc.PrinterSpec(kind=kind)
    raise ProvisionError(f"bundle printer kind {kind!r} not understood")


def _update_from(raw: dict[str, Any]) -> dc.UpdateSpec:
    return dc.UpdateSpec(
        feed_url=raw.get("feedUrl"),
        ring=raw.get("ring"),
        manifest_public_key=raw.get("manifestPublicKey"),
        frozen_version=raw.get("frozenVersion"),
    )


def enrol(
    bundle: dict[str, Any],
    root: Path,
    *,
    pinned_root_fingerprint: str | None = None,
    ca_transport: httpx.BaseTransport | None = None,
) -> EnrolResult:
    """Device side: generate the key on the device, get the certificate, write the device config."""
    kiosk_id = dc.validate_kiosk_id(str(bundle["kiosk_id"]))
    ca = bundle["ca"]
    root_pem = str(ca["root_pem"]).encode()
    fingerprint = stepca.root_fingerprint(root_pem)
    if fingerprint != ca["root_fingerprint"]:
        raise ProvisionError("bundle root CA does not match its fingerprint")
    if pinned_root_fingerprint and fingerprint != pinned_root_fingerprint.lower().replace(":", ""):
        raise ProvisionError("bundle root CA does not match the root pinned in the image")
    cfg = dc.DeviceConfig(
        kiosk_id=kiosk_id,
        api_origin=str(bundle["api_origin"]),
        printer=_printer_from(bundle["config"].get("printer", {})),
        update=_update_from(bundle["config"].get("update", {})),
    )
    kiosk_json = cfg.kiosk_config_json(root)  # validate before any side effect

    identity = stepca.DeviceIdentity(kiosk_id, str(ca.get("domain", stepca.DEFAULT_DOMAIN)))
    key = stepca.generate_device_key()
    csr = stepca.build_csr(key, identity)
    dc.write_atomic(root / dc.ROOT_FILE, root_pem)
    issued = stepca.sign(
        str(ca["url"]), csr_pem=csr, ott=str(ca["ott"]), root_pem_path=root / dc.ROOT_FILE, transport=ca_transport
    )
    cert = x509.load_pem_x509_certificate(issued.certificate_pem)
    _check_issued(cert, key.public_key(), identity)

    dc.write_atomic(root / dc.KEY_FILE, stepca.private_key_pem(key), mode=0o600)
    dc.write_atomic(root / dc.CERT_FILE, issued.certificate_pem)
    dc.write_atomic(root / dc.CHAIN_FILE, issued.chain_pem)
    dc.write_atomic(root / dc.TOKEN_FILE, (str(bundle["device_token"]) + "\n").encode(), mode=0o600)
    os.chmod(root / "secrets", 0o700)
    dc.write_json(root / dc.RECIPIENT_KEYS_FILE, bundle["recipient_keys"])
    dc.write_json(
        root / dc.DEVICE_RECORD_FILE,
        {
            "kiosk_id": kiosk_id,
            "site_id": bundle["site_id"],
            "site_mode": bundle["site_mode"],
            "study_id": bundle.get("study_id"),
            "deployment_id": bundle.get("deployment_id"),
            "policy_version": bundle.get("policy_version"),
            "app_version": bundle.get("app_version"),
            "ring": bundle.get("ring"),
            "api_origin": kiosk_json["apiOrigin"],
            "ca_url": ca["url"],
            "ca_root_fingerprint": fingerprint,
            "certificate_serial": str(cert.serial_number),
            "certificate_not_after": _iso(cert.not_valid_after_utc),
            "provisioned_at": _iso(datetime.now(UTC)),
            "provisioned_by_tool": f"shriii-provision/{__version__}",
        },
    )
    # Written last: its presence is what the snap's launcher waits for.
    dc.write_json(root / dc.CONFIG_FILE, kiosk_json)
    return EnrolResult(kiosk_id, str(cert.serial_number), cert.not_valid_after_utc, root)


def _check_issued(cert: x509.Certificate, public_key: Any, identity: stepca.DeviceIdentity) -> None:
    pub = serialization.PublicFormat.SubjectPublicKeyInfo
    enc = serialization.Encoding.DER
    if cert.public_key().public_bytes(enc, pub) != public_key.public_bytes(enc, pub):
        raise ProvisionError("issued certificate does not carry the device key")
    cns = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
    if not cns or cns[0].value != identity.kiosk_id:
        raise ProvisionError("issued certificate has the wrong common name")


# ---------------------------------------------------------------------------------------------- verify


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str


def verify(
    root: Path,
    *,
    api_transport: httpx.BaseTransport | None = None,
    mtls_transport: httpx.BaseTransport | None = None,
    check_mtls: bool = True,
    min_cert_validity: timedelta = timedelta(minutes=10),
    now: datetime | None = None,
) -> list[Check]:
    """Post-enrolment health: config files, certificate, API liveness, mTLS, device-token heartbeat."""
    checks: list[Check] = []
    moment = now or datetime.now(UTC)

    def record(name: str, ok: bool, detail: str) -> bool:
        checks.append(Check(name, ok, detail))
        return ok

    try:
        kiosk_json = dc.read_json(root / dc.CONFIG_FILE)
        record_json = dc.read_json(root / dc.DEVICE_RECORD_FILE)
        dc.read_json(root / dc.RECIPIENT_KEYS_FILE)
        token = (root / dc.TOKEN_FILE).read_text(encoding="utf-8").strip()
        if not token.startswith("kdt_"):
            raise ProvisionError("device token has the wrong format")
        record("config", True, f"kiosk {kiosk_json['kioskId']} at site {record_json['site_id']}")
    except (ProvisionError, OSError, KeyError) as exc:
        record("config", False, str(exc))
        return checks

    try:
        cert = x509.load_pem_x509_certificate((root / dc.CERT_FILE).read_bytes())
        key = serialization.load_pem_private_key((root / dc.KEY_FILE).read_bytes(), password=None)
        _check_issued(cert, key.public_key(), stepca.DeviceIdentity(str(kiosk_json["kioskId"])))
        remaining = cert.not_valid_after_utc - moment
        record(
            "certificate",
            remaining >= min_cert_validity,
            f"serial {cert.serial_number}, expires {_iso(cert.not_valid_after_utc)} "
            f"({int(remaining.total_seconds())} s)",
        )
    except (ProvisionError, OSError, ValueError) as exc:
        record("certificate", False, str(exc))

    api_origin = str(kiosk_json["apiOrigin"])
    with ApiClient(api_origin, transport=api_transport) as api:
        try:
            api.healthz()
            record("api_health", True, f"{api_origin}/healthz ok")
        except ProvisionError as exc:
            record("api_health", False, str(exc))
        try:
            out = api.heartbeat(token, app_version=None, payload={"provisioning_check": True})
            same = out.get("kiosk_id") == kiosk_json["kioskId"] and out.get("status") == "active"
            record("heartbeat", same, f"kiosk {out.get('kiosk_id')} status {out.get('status')}")
        except ProvisionError as exc:
            record("heartbeat", False, str(exc))

    if check_mtls:
        try:
            ctx = ssl.create_default_context()
            client = ApiClient(
                api_origin,
                transport=mtls_transport,
                verify=ctx,
                cert=None if mtls_transport else (str(root / dc.CHAIN_FILE), str(root / dc.KEY_FILE)),
            )
            with client:
                client.healthz()
            record("mtls", True, "API accepted the device certificate")
        except (ProvisionError, OSError, ssl.SSLError) as exc:
            record("mtls", False, str(exc))
    return checks


# ---------------------------------------------------------------------------------------------- renew


def renew_device_cert(root: Path, *, transport: httpx.BaseTransport | None = None) -> stepca.IssuedCert:
    record = dc.read_json(root / dc.DEVICE_RECORD_FILE)
    issued = stepca.renew(
        str(record["ca_url"]),
        cert_path=root / dc.CHAIN_FILE,
        key_path=root / dc.KEY_FILE,
        root_pem_path=root / dc.ROOT_FILE,
        transport=transport,
    )
    dc.write_atomic(root / dc.CERT_FILE, issued.certificate_pem)
    dc.write_atomic(root / dc.CHAIN_FILE, issued.chain_pem)
    record["certificate_serial"] = issued.serial
    record["certificate_not_after"] = _iso(issued.not_after)
    dc.write_json(root / dc.DEVICE_RECORD_FILE, record)
    return issued


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")
