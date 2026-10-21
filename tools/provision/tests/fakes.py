"""In-memory fakes: the SHRIII API (admin + device endpoints) and step-ca (sign / renew / revoke)."""

from __future__ import annotations

import base64
import json
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

ADMIN_TOKEN = "admin-test-token"
BACKEND_PUB = base64.b64encode(b"\x07" * 32).decode()


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass
class FakeApi:
    kiosks: dict[str, dict[str, Any]] = field(default_factory=dict)
    tokens: dict[str, str] = field(default_factory=dict)  # token -> kiosk id
    deployments: list[dict[str, Any]] = field(default_factory=list)
    heartbeats: list[dict[str, Any]] = field(default_factory=list)
    calls: list[tuple[str, str]] = field(default_factory=list)
    healthy: bool = True

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def _kiosk_out(self, kiosk_id: str) -> dict[str, Any]:
        return self.kiosks[kiosk_id]

    def _issue(self, kiosk_id: str) -> dict[str, Any]:
        token = "kdt_" + secrets.token_urlsafe(24)
        self.tokens = {t: k for t, k in self.tokens.items() if k != kiosk_id}
        self.tokens[token] = kiosk_id
        return {"kiosk": self._kiosk_out(kiosk_id), "device_token": token, "backend_x25519_public_key": BACKEND_PUB}

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append((request.method, path))
        if path == "/healthz":
            if not self.healthy:
                return httpx.Response(503, json={"status": "down"})
            return httpx.Response(200, json={"status": "ok", "version": "test"})
        auth = request.headers.get("authorization", "")
        bearer = auth[7:] if auth.lower().startswith("bearer ") else ""
        if path == "/api/v1/admin/kiosks/heartbeat" and request.method == "POST":
            kiosk_id = self.tokens.get(bearer)
            if kiosk_id is None or self.kiosks[kiosk_id]["status"] != "active":
                return httpx.Response(401, json={"detail": {"code": "unauthenticated", "message": "bad token"}})
            body = json.loads(request.content)
            self.heartbeats.append({"kiosk_id": kiosk_id, **body})
            self.kiosks[kiosk_id]["health_status"] = "healthy"
            return httpx.Response(200, json=self._kiosk_out(kiosk_id))
        if bearer != ADMIN_TOKEN:
            return httpx.Response(401, json={"detail": {"code": "unauthenticated", "message": "admin only"}})
        if path == "/api/v1/admin/kiosks" and request.method == "POST":
            body = json.loads(request.content)
            if body["kiosk_id"] in self.kiosks:
                return httpx.Response(409, json={"detail": {"code": "kiosk_exists", "message": "already registered"}})
            self.kiosks[body["kiosk_id"]] = {
                "kiosk_id": body["kiosk_id"],
                "site_id": body["site_id"],
                "label": body.get("label"),
                "status": "active",
                "hardware_sku": body.get("hardware_sku"),
                "app_version": None,
                "last_heartbeat_at": None,
                "last_heartbeat": {},
                "health_status": "unknown",
                "created_at": _now().isoformat(),
                "revoked_at": None,
            }
            return httpx.Response(201, json=self._issue(body["kiosk_id"]))
        if path == "/api/v1/admin/kiosks" and request.method == "GET":
            return httpx.Response(200, json=list(self.kiosks.values()))
        if path.startswith("/api/v1/admin/kiosks/") and path.endswith("/rotate-token"):
            kiosk_id = path.split("/")[5]
            if kiosk_id not in self.kiosks:
                return httpx.Response(404, json={"detail": {"code": "unknown_kiosk", "message": "kiosk not found"}})
            self.kiosks[kiosk_id]["status"] = "active"
            return httpx.Response(200, json=self._issue(kiosk_id))
        if path == "/api/v1/admin/deployments" and request.method == "POST":
            body = json.loads(request.content)
            if body["kiosk_id"] not in self.kiosks:
                return httpx.Response(404, json={"detail": {"code": "unknown_kiosk", "message": "kiosk not found"}})
            row = {"id": str(uuid.uuid4()), "status": "active", "created_by": "admin", **body}
            self.deployments.append(row)
            return httpx.Response(201, json=row)
        return httpx.Response(404, json={"detail": {"code": "not_found", "message": path}})


def _name(cn: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])


@dataclass
class FakeCa:
    """A two-tier CA plus a JWK provisioner, enforcing the same token rules step-ca does."""

    url: str = "https://ca.test:9000"
    provisioner_name: str = "kiosk-enrolment"
    leaf_lifetime: timedelta = timedelta(hours=24)
    used_jti: set[str] = field(default_factory=set)
    revoked: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        now = _now()
        self.root_key = ec.generate_private_key(ec.SECP256R1())
        self.root = (
            x509.CertificateBuilder()
            .subject_name(_name("SHRIII Test Root CA"))
            .issuer_name(_name("SHRIII Test Root CA"))
            .public_key(self.root_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=1), critical=True)
            .sign(self.root_key, hashes.SHA256())
        )
        self.int_key = ec.generate_private_key(ec.SECP256R1())
        self.intermediate = (
            x509.CertificateBuilder()
            .subject_name(_name("SHRIII Test Kiosk Intermediate CA"))
            .issuer_name(self.root.subject)
            .public_key(self.int_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=365))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .sign(self.root_key, hashes.SHA256())
        )
        self.prov_key = ec.generate_private_key(ec.SECP256R1())

    @property
    def root_pem(self) -> bytes:
        return self.root.public_bytes(serialization.Encoding.PEM)

    def provisioner_pem(self) -> bytes:
        return self.prov_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def _verify_token(self, token: str, audience_path: str) -> dict[str, Any]:
        claims: dict[str, Any] = jwt.decode(
            token,
            self.prov_key.public_key(),
            algorithms=["ES256"],
            audience=self.url + audience_path,
            issuer=self.provisioner_name,
            options={"require": ["exp", "nbf", "iat", "jti", "sub"]},
        )
        if claims["jti"] in self.used_jti:
            raise jwt.InvalidTokenError("token already used")
        self.used_jti.add(claims["jti"])
        return claims

    def _leaf(self, subject: x509.Name, public_key: Any, sans: x509.SubjectAlternativeName) -> x509.Certificate:
        now = _now()
        return (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(self.intermediate.subject)
            .public_key(public_key)
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + self.leaf_lifetime)
            .add_extension(sans, critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
            .sign(self.int_key, hashes.SHA256())
        )

    def _response(self, leaf: x509.Certificate) -> httpx.Response:
        crt = leaf.public_bytes(serialization.Encoding.PEM).decode()
        ca = self.intermediate.public_bytes(serialization.Encoding.PEM).decode()
        return httpx.Response(201, json={"crt": crt, "ca": ca, "certChain": [crt, ca]})

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/1.0/sign":
            body = json.loads(request.content)
            try:
                claims = self._verify_token(body["ott"], "/1.0/sign")
            except jwt.PyJWTError as exc:
                return httpx.Response(401, json={"message": f"invalid token: {exc}"})
            csr = x509.load_pem_x509_csr(body["csr"].encode())
            if not csr.is_signature_valid:
                return httpx.Response(400, json={"message": "bad csr signature"})
            cn = csr.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value
            if cn != claims["sub"]:
                return httpx.Response(403, json={"message": "common name does not match token subject"})
            san = csr.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            got = sorted(
                san.get_values_for_type(x509.DNSName) + san.get_values_for_type(x509.UniformResourceIdentifier)
            )
            if got != sorted(claims["sans"]):
                return httpx.Response(403, json={"message": "certificate request does not contain the valid SANs"})
            return self._response(self._leaf(csr.subject, csr.public_key(), san))
        if request.url.path == "/1.0/renew":
            # The mock transport has no TLS; tests pass the current cert in a header to emulate mTLS.
            pem = request.headers.get("x-test-client-cert")
            if pem is None:
                return httpx.Response(401, json={"message": "missing client certificate"})
            current = x509.load_pem_x509_certificate(pem.encode())
            if str(current.serial_number) in self.revoked or current.not_valid_after_utc <= _now():
                return httpx.Response(401, json={"message": "certificate is revoked or expired"})
            san = current.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            return self._response(self._leaf(current.subject, current.public_key(), san))
        if request.url.path == "/1.0/revoke":
            body = json.loads(request.content)
            try:
                claims = self._verify_token(body["ott"], "/1.0/revoke")
            except jwt.PyJWTError as exc:
                return httpx.Response(401, json={"message": f"invalid token: {exc}"})
            if claims["sub"] != body["serial"]:
                return httpx.Response(403, json={"message": "token subject does not match serial"})
            self.revoked.add(body["serial"])
            return httpx.Response(200, json={"status": "ok"})
        return httpx.Response(404, json={"message": "not found"})
