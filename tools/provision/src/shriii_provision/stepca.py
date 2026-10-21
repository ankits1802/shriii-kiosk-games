"""step-ca client pieces for device certificates (PRV-07, KSK-10).

- ``mint_ott``: a one-time JWK-provisioner token (ES256 JWT) for one kiosk, minted on the provisioning
  workstation with the ``kiosk-enrolment`` provisioner key. It is bound to the kiosk's subject and SANs, the
  CA's ``/1.0/sign`` audience, a random ``jti`` (step-ca rejects replays) and a short lifetime.
- ``generate_device_key`` / ``build_csr``: an EC P-256 key generated **on the device** and a CSR whose SANs
  exactly match the token (step-ca enforces equality).
- ``sign`` / ``renew`` / ``revoke``: the step-ca HTTP API (``/1.0/sign``, ``/1.0/renew`` over mTLS,
  ``/1.0/revoke`` with a provisioner token).

The device identity encoded in every certificate (see infra/pki/templates/device-leaf.tpl):
  CN  = <kiosk_id>
  DNS = <kiosk_id>.kiosk.<domain>
  URI = spiffe://<domain>/kiosk/<kiosk_id>
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import ssl
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from shriii_provision import ProvisionError

DEFAULT_DOMAIN = "shriii.internal"
DEFAULT_PROVISIONER = "kiosk-enrolment"
MAX_TOKEN_TTL_S = 3600


@dataclass(frozen=True)
class DeviceIdentity:
    kiosk_id: str
    domain: str = DEFAULT_DOMAIN

    @property
    def dns_name(self) -> str:
        return f"{self.kiosk_id}.kiosk.{self.domain}"

    @property
    def uri(self) -> str:
        return f"spiffe://{self.domain}/kiosk/{self.kiosk_id}"

    @property
    def sans(self) -> list[str]:
        return [self.dns_name, self.uri]


@dataclass(frozen=True)
class ProvisionerKey:
    name: str
    kid: str
    key: ec.EllipticCurvePrivateKey


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def jwk_thumbprint(public_key: ec.EllipticCurvePublicKey) -> str:
    """RFC 7638 thumbprint of a P-256 public key (step uses it as the JWK ``kid``)."""
    numbers = public_key.public_numbers()
    size = (public_key.curve.key_size + 7) // 8
    canonical = json.dumps(
        {
            "crv": "P-256",
            "kty": "EC",
            "x": _b64url(numbers.x.to_bytes(size, "big")),
            "y": _b64url(numbers.y.to_bytes(size, "big")),
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    return _b64url(hashlib.sha256(canonical.encode()).digest())


def load_provisioner_key(
    path: Path, *, name: str = DEFAULT_PROVISIONER, password: bytes | None = None
) -> ProvisionerKey:
    """Load the provisioner's private key: a decrypted JWK (JSON with ``d``) or a PEM EC key."""
    raw = path.read_bytes()
    text = raw.decode("utf-8", errors="replace").strip()
    key: ec.EllipticCurvePrivateKey
    kid: str | None = None
    if text.startswith("{"):
        jwk = json.loads(text)
        if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256" or "d" not in jwk:
            raise ProvisionError("provisioner JWK must be a decrypted EC P-256 private key")
        d = int.from_bytes(_b64url_decode(jwk["d"]), "big")
        key = ec.derive_private_key(d, ec.SECP256R1())
        kid = jwk.get("kid")
    else:
        loaded = serialization.load_pem_private_key(raw, password=password)
        if not isinstance(loaded, ec.EllipticCurvePrivateKey) or loaded.curve.name != "secp256r1":
            raise ProvisionError("provisioner PEM must be an EC P-256 private key")
        key = loaded
    return ProvisionerKey(name=name, kid=kid or jwk_thumbprint(key.public_key()), key=key)


def root_fingerprint(root_pem: bytes) -> str:
    """step's root fingerprint: lowercase hex SHA-256 of the DER root certificate."""
    cert = x509.load_pem_x509_certificate(root_pem)
    return cert.fingerprint(hashes.SHA256()).hex()


def mint_ott(
    provisioner: ProvisionerKey,
    *,
    ca_url: str,
    subject: str,
    sans: list[str],
    root_sha256: str | None = None,
    ttl_s: int = 900,
    audience_path: str = "/1.0/sign",
    now: float | None = None,
) -> str:
    if not 30 <= ttl_s <= MAX_TOKEN_TTL_S:
        raise ProvisionError(f"token ttl must be within 30..{MAX_TOKEN_TTL_S} s")
    issued = int(now if now is not None else time.time())
    claims: dict[str, Any] = {
        "iss": provisioner.name,
        "aud": ca_url.rstrip("/") + audience_path,
        "sub": subject,
        "iat": issued,
        "nbf": issued,
        "exp": issued + ttl_s,
        "jti": secrets.token_hex(32),
    }
    if audience_path == "/1.0/sign":
        claims["sans"] = list(sans)
    if root_sha256:
        claims["sha"] = root_sha256
    return jwt.encode(claims, provisioner.key, algorithm="ES256", headers={"kid": provisioner.kid, "typ": "JWT"})


def token_expiry(token: str) -> datetime:
    claims = jwt.decode(token, options={"verify_signature": False})
    return datetime.fromtimestamp(int(claims["exp"]), UTC)


def generate_device_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def private_key_pem(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )


def build_csr(key: ec.EllipticCurvePrivateKey, identity: DeviceIdentity) -> bytes:
    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, identity.kiosk_id)]))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName(identity.dns_name), x509.UniformResourceIdentifier(identity.uri)]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    return csr.public_bytes(serialization.Encoding.PEM)


@dataclass(frozen=True)
class IssuedCert:
    certificate_pem: bytes
    chain_pem: bytes

    @property
    def not_after(self) -> datetime:
        return x509.load_pem_x509_certificate(self.certificate_pem).not_valid_after_utc

    @property
    def serial(self) -> str:
        return str(x509.load_pem_x509_certificate(self.certificate_pem).serial_number)


def _client(
    ca_url: str, root_pem_path: Path, cert: tuple[str, str] | None, transport: httpx.BaseTransport | None
) -> httpx.Client:
    if transport is not None:
        return httpx.Client(base_url=ca_url, transport=transport, timeout=15.0)
    ctx = ssl.create_default_context(cafile=str(root_pem_path))
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    if cert is not None:
        ctx.load_cert_chain(*cert)
    return httpx.Client(base_url=ca_url, verify=ctx, timeout=15.0)


def _issued(resp: httpx.Response, what: str) -> IssuedCert:
    if resp.status_code not in (200, 201):
        try:
            message = resp.json().get("message", resp.text[:200])
        except ValueError:
            message = resp.text[:200]
        raise ProvisionError(f"step-ca {what}: HTTP {resp.status_code} {message}")
    body = resp.json()
    crt = body.get("crt")
    if not isinstance(crt, str):
        raise ProvisionError(f"step-ca {what}: response has no certificate")
    chain = body.get("certChain") or [crt, body.get("ca", "")]
    chain_pem = "".join(c if c.endswith("\n") else c + "\n" for c in chain if c)
    return IssuedCert(certificate_pem=crt.encode(), chain_pem=chain_pem.encode())


def sign(
    ca_url: str,
    *,
    csr_pem: bytes,
    ott: str,
    root_pem_path: Path,
    transport: httpx.BaseTransport | None = None,
) -> IssuedCert:
    with _client(ca_url, root_pem_path, None, transport) as client:
        try:
            resp = client.post("/1.0/sign", json={"csr": csr_pem.decode(), "ott": ott})
        except httpx.HTTPError as exc:
            raise ProvisionError(f"step-ca sign: {type(exc).__name__}: {exc}") from exc
    return _issued(resp, "sign")


def renew(
    ca_url: str,
    *,
    cert_path: Path,
    key_path: Path,
    root_pem_path: Path,
    transport: httpx.BaseTransport | None = None,
) -> IssuedCert:
    """Renew over mTLS with the current (still valid) certificate. Expired certificates cannot renew."""
    with _client(ca_url, root_pem_path, (str(cert_path), str(key_path)), transport) as client:
        try:
            resp = client.post("/1.0/renew")
        except httpx.HTTPError as exc:
            raise ProvisionError(f"step-ca renew: {type(exc).__name__}: {exc}") from exc
    return _issued(resp, "renew")


def revoke(
    ca_url: str,
    *,
    serial: str,
    ott: str,
    reason: str,
    root_pem_path: Path,
    transport: httpx.BaseTransport | None = None,
) -> None:
    """Revoke a device certificate by serial (provisioner token whose ``sub`` is the serial)."""
    body = {"serial": serial, "ott": ott, "reason": reason, "reasonCode": 0, "passive": True}
    with _client(ca_url, root_pem_path, None, transport) as client:
        try:
            resp = client.post("/1.0/revoke", json=body)
        except httpx.HTTPError as exc:
            raise ProvisionError(f"step-ca revoke: {type(exc).__name__}: {exc}") from exc
    if resp.status_code != 200:
        raise ProvisionError(f"step-ca revoke: HTTP {resp.status_code} {resp.text[:200]}")
