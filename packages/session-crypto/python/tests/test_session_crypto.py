from __future__ import annotations

import base64
import copy
import gzip
import json
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from shriii_session_crypto import (
    DecryptionError,
    decrypt_chunk_with_dek,
    decrypt_session_chunk,
    derive_key_pair,
    open_dek,
    parse_sealed_dek,
    public_from_private,
    sealed_dek_kid,
)
from shriii_session_crypto.hpke import decap, encap, key_schedule, setup_base_r, setup_base_s
from shriii_session_crypto.session import chunk_aad

VECTORS_DIR = Path(__file__).resolve().parents[2] / "test-vectors"
RFC = json.loads((VECTORS_DIR / "hpke-rfc9180.json").read_text(encoding="utf-8"))["vectors"]
FIXTURE = json.loads((VECTORS_DIR / "session-chunk-fixture.json").read_text(encoding="utf-8"))
KEYS = {r["kid"]: bytes.fromhex(r["private_key_hex"]) for r in FIXTURE["recipients"]}


def h(x: str) -> bytes:
    return bytes.fromhex(x)


@pytest.mark.parametrize("v", RFC, ids=lambda v: f"aead{v['aead_id']}")
def test_rfc9180_known_answer_vectors(v: dict[str, Any]) -> None:
    sk_e, pk_e = derive_key_pair(h(v["ikmE"]))
    assert sk_e.hex() == v["skEm"]
    assert pk_e.hex() == v["pkEm"]
    sk_r, pk_r = derive_key_pair(h(v["ikmR"]))
    assert (sk_r.hex(), pk_r.hex()) == (v["skRm"], v["pkRm"])
    assert public_from_private(sk_r).hex() == v["pkRm"]

    shared, enc = encap(h(v["pkRm"]), h(v["ikmE"]))
    assert enc.hex() == v["enc"]
    assert shared.hex() == v["shared_secret"]
    assert decap(enc, h(v["skRm"])).hex() == v["shared_secret"]

    ks = key_schedule(v["aead_id"], shared, h(v["info"]))
    assert ks.key_schedule_context.hex() == v["key_schedule_context"]
    assert ks.secret.hex() == v["secret"]
    assert ks.key.hex() == v["key"]
    assert ks.base_nonce.hex() == v["base_nonce"]
    assert ks.exporter_secret.hex() == v["exporter_secret"]

    _, sender = setup_base_s(v["aead_id"], h(v["pkRm"]), h(v["info"]), h(v["ikmE"]))
    receiver = setup_base_r(v["aead_id"], h(v["enc"]), h(v["skRm"]), h(v["info"]))
    for e in v["encryptions"]:
        ct = sender.seal(h(e["aad"]), h(e["pt"]))
        assert ct.hex() == e["ct"]
        assert receiver.open(h(e["aad"]), ct).hex() == e["pt"]


def test_decrypts_typescript_fixture() -> None:
    events = decrypt_session_chunk(FIXTURE["chunk"], KEYS.get)
    assert events == FIXTURE["events"]
    assert sealed_dek_kid(FIXTURE["chunk"]["sealed_dek"]) == "backend-2026-10"
    dek = open_dek(FIXTURE["chunk"]["sealed_dek"], FIXTURE["chunk"]["session_id"], KEYS.get)
    assert dek.hex() == FIXTURE["dek_hex"]


def _flip_b64(text: str, index: int) -> str:
    raw = bytearray(base64.b64decode(text))
    raw[index] ^= 0x01
    return base64.b64encode(bytes(raw)).decode()


def test_every_sealed_dek_byte_is_authenticated() -> None:
    sealed = FIXTURE["chunk"]["sealed_dek"]
    for i in range(len(base64.b64decode(sealed))):
        chunk = {**FIXTURE["chunk"], "sealed_dek": _flip_b64(sealed, i)}
        with pytest.raises(DecryptionError):
            decrypt_session_chunk(chunk, KEYS.get)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("session_id", "01928c6e-7d3a-7b2c-8f00-ffffffffffff"),
        ("first_seq", 1),
        ("last_seq", 3),
        ("event_count", 2),
    ],
)
def test_header_fields_are_bound(field: str, value: Any) -> None:
    chunk = {**FIXTURE["chunk"], field: value}
    with pytest.raises(DecryptionError):
        decrypt_session_chunk(chunk, KEYS.get)


def test_ciphertext_nonce_tamper_and_unknown_kid() -> None:
    for i in (0, 10, len(base64.b64decode(FIXTURE["chunk"]["ciphertext"])) - 1):
        chunk = {**FIXTURE["chunk"], "ciphertext": _flip_b64(FIXTURE["chunk"]["ciphertext"], i)}
        with pytest.raises(DecryptionError):
            decrypt_session_chunk(chunk, KEYS.get)
    with pytest.raises(DecryptionError):
        decrypt_session_chunk({**FIXTURE["chunk"], "nonce": _flip_b64(FIXTURE["chunk"]["nonce"], 0)}, KEYS.get)
    with pytest.raises(DecryptionError, match="no private key"):
        decrypt_session_chunk(FIXTURE["chunk"], lambda _kid: None)
    with pytest.raises(DecryptionError, match="encryption"):
        decrypt_session_chunk({**FIXTURE["chunk"], "encryption": "none_dev"}, KEYS.get)
    with pytest.raises(DecryptionError, match="base64"):
        decrypt_session_chunk({**FIXTURE["chunk"], "sealed_dek": "@@@"}, KEYS.get)


def test_wrong_private_key_fails() -> None:
    wrong = dict.fromkeys(KEYS, KEYS["backend-2027-01"])
    with pytest.raises(DecryptionError):
        decrypt_session_chunk(FIXTURE["chunk"], wrong.get)


def _reencrypt(dek: bytes, chunk: dict[str, Any], plaintext: bytes) -> dict[str, Any]:
    nonce = b"\x07" * 12
    aad = chunk_aad(chunk["session_id"], chunk["first_seq"], chunk["last_seq"], chunk["event_count"])
    out = copy.deepcopy(chunk)
    out["nonce"] = base64.b64encode(nonce).decode()
    out["ciphertext"] = base64.b64encode(AESGCM(dek).encrypt(nonce, plaintext, aad)).decode()
    return out


def test_consistency_checks_and_bomb_guard() -> None:
    dek = h(FIXTURE["dek_hex"])
    shuffled = [FIXTURE["events"][0], FIXTURE["events"][2], FIXTURE["events"][1]]
    body = "".join(json.dumps(e) + "\n" for e in shuffled).encode()
    with pytest.raises(DecryptionError, match="contiguous"):
        decrypt_chunk_with_dek(dek, _reencrypt(dek, FIXTURE["chunk"], gzip.compress(body)))
    bomb = gzip.compress(b"\0" * (20 * 1024 * 1024))
    with pytest.raises(DecryptionError, match="too large"):
        decrypt_chunk_with_dek(dek, _reencrypt(dek, FIXTURE["chunk"], bomb))
    with pytest.raises(DecryptionError, match="gzip"):
        decrypt_chunk_with_dek(dek, _reencrypt(dek, FIXTURE["chunk"], b"not gzip"))


def test_parse_rejects_bad_lengths() -> None:
    raw = base64.b64decode(FIXTURE["chunk"]["sealed_dek"])
    with pytest.raises(DecryptionError):
        parse_sealed_dek(base64.b64encode(raw[:-1]).decode())
    with pytest.raises(DecryptionError):
        parse_sealed_dek(base64.b64encode(raw + b"\0").decode())
