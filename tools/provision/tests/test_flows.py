from __future__ import annotations

import base64
import json
import os
import stat
import sys
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import jwt
import pytest
from cryptography import x509
from fakes import BACKEND_PUB, FakeApi, FakeCa

from shriii_provision import ProvisionError, stepca
from shriii_provision import device_config as dc
from shriii_provision.api import ApiClient
from shriii_provision.flows import (
    BUNDLE_SCHEMA,
    RegisterRequest,
    enrol,
    load_bundle,
    register,
    renew_device_cert,
    write_bundle,
)
from shriii_provision.flows import verify as verify_device

POSIX = sys.platform != "win32"


def _enrolled(api: ApiClient, fake_ca: FakeCa, req: RegisterRequest, tmp_path: Path) -> tuple[dict[str, object], Path]:
    bundle = register(api, req)
    root = tmp_path / "device"
    enrol(bundle, root, ca_transport=fake_ca.transport())
    return bundle, root


def test_register_creates_kiosk_deployment_and_bundle(
    api: ApiClient, fake_api: FakeApi, fake_ca: FakeCa, register_request: RegisterRequest
) -> None:
    bundle = register(api, register_request)

    assert bundle["schema"] == BUNDLE_SCHEMA
    assert bundle["kiosk_id"] == "kiosk-pune-001"
    assert bundle["site_mode"] == "supervised"
    assert str(bundle["device_token"]).startswith("kdt_")
    assert fake_api.kiosks["kiosk-pune-001"]["site_id"] == "site-pune-library"
    [deployment] = fake_api.deployments
    assert deployment["site_mode"] == "supervised"
    assert deployment["policy_version"] == "2026.10.1"
    assert bundle["deployment_id"] == deployment["id"]
    assert bundle["recipient_keys"] == [dc.recipient_key_entry(BACKEND_PUB)]
    assert fake_api.calls[0] == ("GET", "/healthz")


def test_register_token_is_bound_to_kiosk_sans_and_audience(
    api: ApiClient, fake_ca: FakeCa, register_request: RegisterRequest
) -> None:
    bundle = register(api, register_request)
    token = bundle["ca"]["ott"]
    claims = jwt.decode(token, fake_ca.prov_key.public_key(), algorithms=["ES256"], audience=f"{fake_ca.url}/1.0/sign")
    assert claims["sub"] == "kiosk-pune-001"
    assert claims["iss"] == "kiosk-enrolment"
    assert claims["sans"] == [
        "kiosk-pune-001.kiosk.shriii.internal",
        "spiffe://shriii.internal/kiosk/kiosk-pune-001",
    ]
    assert claims["sha"] == stepca.root_fingerprint(fake_ca.root_pem)
    assert claims["exp"] - claims["iat"] == 900
    header = jwt.get_unverified_header(token)
    assert header["kid"] == stepca.jwk_thumbprint(fake_ca.prov_key.public_key())


def test_register_rejects_open_public_with_study(api: ApiClient, register_request: RegisterRequest) -> None:
    req = replace(register_request, site_mode="open_public", study_id="study-1")
    with pytest.raises(ProvisionError, match="open_public"):
        register(api, req)


def test_register_duplicate_kiosk_fails_and_rotate_reissues(
    api: ApiClient, fake_api: FakeApi, register_request: RegisterRequest
) -> None:
    first = register(api, register_request)
    with pytest.raises(ProvisionError, match="409 kiosk_exists"):
        register(api, register_request)
    again = register(api, replace(register_request, rotate_existing=True))
    assert again["device_token"] != first["device_token"]
    assert first["device_token"] not in fake_api.tokens


def test_register_requires_admin_token(fake_api: FakeApi, register_request: RegisterRequest) -> None:
    with (
        ApiClient("https://api.test", transport=fake_api.transport()) as anonymous,
        pytest.raises(ProvisionError, match="admin token is required"),
    ):
        register(anonymous, register_request)


def test_register_stops_when_api_unhealthy(
    api: ApiClient, fake_api: FakeApi, register_request: RegisterRequest
) -> None:
    fake_api.healthy = False
    with pytest.raises(ProvisionError, match="healthz"):
        register(api, register_request)
    assert fake_api.kiosks == {}


def test_bundle_expiry_and_schema(tmp_path: Path, api: ApiClient, register_request: RegisterRequest) -> None:
    bundle = register(api, register_request)
    path = tmp_path / "bundle.json"
    write_bundle(path, bundle)
    if POSIX:
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert load_bundle(path)["kiosk_id"] == "kiosk-pune-001"
    with pytest.raises(ProvisionError, match="expired"):
        load_bundle(path, now=datetime.now(UTC) + timedelta(hours=1))
    path.write_text(json.dumps({"schema": "other"}))
    with pytest.raises(ProvisionError, match=r"not a shriii\.enrolment-bundle/v1"):
        load_bundle(path)


def test_enrol_writes_runtime_config_and_certificate(
    api: ApiClient, fake_ca: FakeCa, register_request: RegisterRequest, tmp_path: Path
) -> None:
    bundle, root = _enrolled(api, fake_ca, register_request, tmp_path)

    config = json.loads((root / dc.CONFIG_FILE).read_text())
    assert config == {
        "kioskId": "kiosk-pune-001",
        "apiOrigin": "https://api.test",
        "recipientKeysPath": str(root / dc.RECIPIENT_KEYS_FILE).replace("\\", "/"),
        "printer": {"kind": "device", "path": "/dev/usb/lp0"},
        "update": {},
    }
    keys = json.loads((root / dc.RECIPIENT_KEYS_FILE).read_text())
    assert keys[0]["public_key"] == BACKEND_PUB
    assert keys[0]["kid"].startswith("backend-x25519-")
    record = json.loads((root / dc.DEVICE_RECORD_FILE).read_text())
    assert record["site_mode"] == "supervised"
    assert "device_token" not in json.dumps(record)
    assert (root / dc.TOKEN_FILE).read_text().strip() == bundle["device_token"]

    cert = x509.load_pem_x509_certificate((root / dc.CERT_FILE).read_bytes())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert san.get_values_for_type(x509.UniformResourceIdentifier) == ["spiffe://shriii.internal/kiosk/kiosk-pune-001"]
    assert cert.issuer == fake_ca.intermediate.subject
    assert record["certificate_serial"] == str(cert.serial_number)
    chain = (root / dc.CHAIN_FILE).read_bytes()
    assert chain.count(b"BEGIN CERTIFICATE") == 2
    if POSIX:
        for secret in (dc.KEY_FILE, dc.TOKEN_FILE):
            assert stat.S_IMODE((root / secret).stat().st_mode) == 0o600
        assert stat.S_IMODE((root / "secrets").stat().st_mode) == 0o700


def test_enrol_token_is_single_use(
    api: ApiClient, fake_ca: FakeCa, register_request: RegisterRequest, tmp_path: Path
) -> None:
    bundle, _ = _enrolled(api, fake_ca, register_request, tmp_path)
    with pytest.raises(ProvisionError, match="already used"):
        enrol(bundle, tmp_path / "second", ca_transport=fake_ca.transport())


def test_enrol_rejects_tampered_root_and_pin_mismatch(
    api: ApiClient, fake_ca: FakeCa, register_request: RegisterRequest, tmp_path: Path
) -> None:
    bundle = register(api, register_request)
    other = FakeCa()
    tampered = json.loads(json.dumps(bundle))
    tampered["ca"]["root_pem"] = other.root_pem.decode()
    with pytest.raises(ProvisionError, match="does not match its fingerprint"):
        enrol(tampered, tmp_path / "a", ca_transport=fake_ca.transport())
    with pytest.raises(ProvisionError, match="pinned in the image"):
        enrol(
            bundle,
            tmp_path / "b",
            pinned_root_fingerprint=stepca.root_fingerprint(other.root_pem),
            ca_transport=fake_ca.transport(),
        )
    assert not (tmp_path / "a" / dc.CONFIG_FILE).exists()


def test_enrol_fails_on_san_mismatch_without_writing_config(
    api: ApiClient, fake_ca: FakeCa, register_request: RegisterRequest, tmp_path: Path
) -> None:
    bundle = register(api, register_request)
    bundle["ca"]["domain"] = "evil.example"
    with pytest.raises(ProvisionError, match="valid SANs"):
        enrol(bundle, tmp_path / "dev", ca_transport=fake_ca.transport())
    assert not (tmp_path / "dev" / dc.CONFIG_FILE).exists()
    assert not (tmp_path / "dev" / dc.KEY_FILE).exists()


def test_enrol_rejects_http_api_origin(
    api: ApiClient, fake_ca: FakeCa, register_request: RegisterRequest, tmp_path: Path
) -> None:
    bundle = register(api, register_request)
    bundle["api_origin"] = "http://api.test"
    with pytest.raises(ProvisionError, match="https"):
        enrol(bundle, tmp_path / "dev", ca_transport=fake_ca.transport())


def _mtls_ok() -> httpx.MockTransport:
    return httpx.MockTransport(lambda r: httpx.Response(200, json={"status": "ok"}))


def test_verify_all_green(
    api: ApiClient, fake_api: FakeApi, fake_ca: FakeCa, register_request: RegisterRequest, tmp_path: Path
) -> None:
    _, root = _enrolled(api, fake_ca, register_request, tmp_path)
    checks = verify_device(root, api_transport=fake_api.transport(), mtls_transport=_mtls_ok())
    assert [c.name for c in checks] == ["config", "certificate", "api_health", "heartbeat", "mtls"]
    assert all(c.ok for c in checks), checks
    assert fake_api.heartbeats[-1]["payload"] == {"provisioning_check": True}
    assert fake_api.kiosks["kiosk-pune-001"]["health_status"] == "healthy"


def test_verify_reports_revoked_token_and_expiring_cert(
    api: ApiClient, fake_api: FakeApi, register_request: RegisterRequest, tmp_path: Path
) -> None:
    ca = FakeCa(leaf_lifetime=timedelta(minutes=5))
    req = replace(register_request, ca_url=ca.url, root_ca_pem=ca.root_pem)
    prov_path = tmp_path / "prov.pem"
    prov_path.write_bytes(ca.provisioner_pem())
    req = replace(req, provisioner=stepca.load_provisioner_key(prov_path))
    _, root = _enrolled(api, ca, req, tmp_path)
    fake_api.kiosks["kiosk-pune-001"]["status"] = "revoked"
    checks = {c.name: c for c in verify_device(root, api_transport=fake_api.transport(), check_mtls=False)}
    assert checks["config"].ok
    assert not checks["certificate"].ok  # 5 min left < 10 min minimum
    assert checks["api_health"].ok
    assert not checks["heartbeat"].ok
    assert "401" in checks["heartbeat"].detail
    assert "kdt_" not in checks["heartbeat"].detail


def test_verify_unprovisioned_device(tmp_path: Path) -> None:
    checks = verify_device(tmp_path, check_mtls=False)
    assert len(checks) == 1
    assert not checks[0].ok
    assert "missing" in checks[0].detail


def test_renew_replaces_certificate(
    api: ApiClient, fake_ca: FakeCa, register_request: RegisterRequest, tmp_path: Path
) -> None:
    _, root = _enrolled(api, fake_ca, register_request, tmp_path)
    before = (root / dc.CERT_FILE).read_bytes()

    def with_client_cert(request: httpx.Request) -> httpx.Response:
        request.headers["x-test-client-cert"] = before.decode()
        return fake_ca.handle(request)

    issued = renew_device_cert(root, transport=httpx.MockTransport(with_client_cert))
    after = (root / dc.CERT_FILE).read_bytes()
    assert after != before
    assert json.loads((root / dc.DEVICE_RECORD_FILE).read_text())["certificate_serial"] == issued.serial

    fake_ca.revoked.add(str(x509.load_pem_x509_certificate(before).serial_number))
    with pytest.raises(ProvisionError, match="revoked or expired"):
        renew_device_cert(root, transport=httpx.MockTransport(with_client_cert))


def test_revoke_with_provisioner_token(fake_ca: FakeCa, provisioner: stepca.ProvisionerKey, tmp_path: Path) -> None:
    root = tmp_path / "root.crt"
    root.write_bytes(fake_ca.root_pem)
    token = stepca.mint_ott(provisioner, ca_url=fake_ca.url, subject="1234", sans=[], audience_path="/1.0/revoke")
    stepca.revoke(
        fake_ca.url, serial="1234", ott=token, reason="test", root_pem_path=root, transport=fake_ca.transport()
    )
    assert "1234" in fake_ca.revoked
    assert "sans" not in jwt.decode(token, options={"verify_signature": False})


def test_jwk_provisioner_key_roundtrip(fake_ca: FakeCa, tmp_path: Path) -> None:
    nums = fake_ca.prov_key.private_numbers()

    def b64(n: int) -> str:
        return base64.urlsafe_b64encode(n.to_bytes(32, "big")).rstrip(b"=").decode()

    jwk = {
        "kty": "EC",
        "crv": "P-256",
        "x": b64(nums.public_numbers.x),
        "y": b64(nums.public_numbers.y),
        "d": b64(nums.private_value),
        "kid": "explicit-kid",
    }
    path = tmp_path / "prov.json"
    path.write_text(json.dumps(jwk))
    key = stepca.load_provisioner_key(path)
    assert key.kid == "explicit-kid"
    del jwk["kid"]
    path.write_text(json.dumps(jwk))
    assert stepca.load_provisioner_key(path).kid == stepca.jwk_thumbprint(fake_ca.prov_key.public_key())
    path.write_text(json.dumps({"kty": "EC", "crv": "P-256", "x": "a", "y": "b"}))
    with pytest.raises(ProvisionError, match="decrypted"):
        stepca.load_provisioner_key(path)


def test_token_ttl_bounds(provisioner: stepca.ProvisionerKey) -> None:
    with pytest.raises(ProvisionError, match="ttl"):
        stepca.mint_ott(provisioner, ca_url="https://ca", subject="k", sans=[], ttl_s=7200)


@pytest.mark.skipif(not POSIX, reason="POSIX permissions")
def test_atomic_write_never_leaves_partial_secret(tmp_path: Path) -> None:
    path = tmp_path / "secrets" / "x"
    dc.write_atomic(path, b"one", mode=0o600)
    dc.write_atomic(path, b"two", mode=0o600)
    assert path.read_bytes() == b"two"
    assert os.listdir(path.parent) == ["x"]
