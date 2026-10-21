"""ed25519 signing of audio manifests (VOX-02: packs are ed25519-signed).

The signature covers the exact bytes of the manifest file, which is written as canonical JSON (sorted
keys, two-space indent, LF, trailing newline), so any verifier (the kiosk's WebCrypto Ed25519, Python,
openssl) checks the same bytes it downloads. The detached signature file mirrors the ``signature`` object
of the release pack (``algorithm``, ``key_id``, ``value``) plus the manifest file name and its sha256.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

KEY_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,127}$")


class SigningError(ValueError):
    """Key or signature problem."""


def canonical_json_bytes(data: Any) -> bytes:
    return (json.dumps(data, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 16), b""):
            h.update(block)
    return h.hexdigest()


@dataclass(frozen=True, slots=True)
class SigningKey:
    key_id: str
    private: Ed25519PrivateKey

    def public_b64(self) -> str:
        raw = self.private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        return base64.b64encode(raw).decode("ascii")


def generate_key(key_id: str, private_path: Path, public_path: Path) -> SigningKey:
    """Create a new key pair: PKCS#8 PEM private key and a JSON public key record."""
    if not KEY_ID_RE.match(key_id):
        raise SigningError(f"invalid key id {key_id!r}")
    if private_path.exists():
        raise SigningError(f"refusing to overwrite existing private key {private_path}")
    private = Ed25519PrivateKey.generate()
    pem = private.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    private_path.parent.mkdir(parents=True, exist_ok=True)
    # Owner-only permissions from creation (O_EXCL also closes the exists() race). Windows ignores the
    # mode; keep keys out of shared folders there.
    fd = os.open(private_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(pem)
    key = SigningKey(key_id=key_id, private=private)
    public_path.parent.mkdir(parents=True, exist_ok=True)
    public_path.write_bytes(
        canonical_json_bytes({"algorithm": "ed25519", "key_id": key_id, "public_key": key.public_b64()})
    )
    return key


def load_private_key(path: Path, key_id: str) -> SigningKey:
    if not KEY_ID_RE.match(key_id):
        raise SigningError(f"invalid key id {key_id!r}")
    loaded = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(loaded, Ed25519PrivateKey):
        raise SigningError(f"{path} is not an ed25519 private key")
    return SigningKey(key_id=key_id, private=loaded)


def load_public_key(path: Path) -> tuple[str, Ed25519PublicKey]:
    record = json.loads(path.read_text(encoding="utf-8"))
    if record.get("algorithm") != "ed25519":
        raise SigningError(f"{path}: algorithm must be ed25519")
    raw = base64.b64decode(record["public_key"], validate=True)
    return str(record["key_id"]), Ed25519PublicKey.from_public_bytes(raw)


def sign_file(manifest_path: Path, key: SigningKey) -> dict[str, str]:
    data = manifest_path.read_bytes()
    sig = key.private.sign(data)
    return {
        "algorithm": "ed25519",
        "key_id": key.key_id,
        "manifest_file": manifest_path.name,
        "manifest_sha256": sha256_hex(data),
        "value": base64.b64encode(sig).decode("ascii"),
    }


def verify_file(manifest_path: Path, signature: dict[str, Any], public: Ed25519PublicKey, key_id: str) -> None:
    """Raise :class:`SigningError` unless the signature over the manifest bytes is valid for ``key_id``."""
    if signature.get("algorithm") != "ed25519":
        raise SigningError("signature algorithm must be ed25519")
    if signature.get("key_id") != key_id:
        raise SigningError(f"signature key_id {signature.get('key_id')!r} does not match {key_id!r}")
    data = manifest_path.read_bytes()
    if signature.get("manifest_sha256") != sha256_hex(data):
        raise SigningError(f"{manifest_path.name}: sha256 does not match the signature record")
    try:
        public.verify(base64.b64decode(str(signature["value"]), validate=True), data)
    except InvalidSignature as exc:
        raise SigningError(f"{manifest_path.name}: invalid ed25519 signature") from exc
