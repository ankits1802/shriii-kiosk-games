"""Pure unit tests: JCS canonicalisation, pid check characters, crypto helpers, validation adapter."""

from __future__ import annotations

import json
import os

import numpy as np
import pytest

from shriii_api.adapters.scoring import reverse_code, score_instrument
from shriii_api.canonical import canonical_json
from shriii_api.security import (
    CROCKFORD,
    CryptoFailureError,
    decrypt_chunk,
    derive_pid,
    encrypt_chunk,
    is_valid_code,
    new_pairing_code,
    new_pid,
    normalise_code,
    seal_dek,
    unseal_dek,
    x25519_public_key,
)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0.0, "0"),
        (-0.0, "0"),
        (1.0, "1"),
        (100.0, "100"),
        (123.456, "123.456"),
        (1e21, "1e+21"),
        (1e-7, "1e-7"),
        (0.000001, "0.000001"),
        (5e-324, "5e-324"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
        (333333333.33333329, "333333333.3333333"),
        (-1.5, "-1.5"),
        (9007199254740992.0, "9007199254740992"),
    ],
)
def test_jcs_numbers_match_ecmascript(value: float, expected: str) -> None:
    assert canonical_json(value) == expected


def test_jcs_objects_sorted_and_compact() -> None:
    doc = {"b": [1, 2.0, {"z": None, "a": True}], "a": "é\n", "€": 1, "\U0001f600": 2}
    assert canonical_json(doc) == '{"a":"é\\n","b":[1,2,{"a":true,"z":null}],"€":1,"😀":2}'
    with pytest.raises(ValueError, match="NaN"):
        canonical_json(float("nan"))


def test_js_compatible_with_json_stringify_for_simple_docs() -> None:
    doc = {"session_id": "x", "seq": 3, "t": 12.5, "ok": False, "list": [0.5, 10]}
    js_like = json.dumps(dict(sorted(doc.items())), separators=(",", ":"), ensure_ascii=False)
    assert canonical_json(doc) == js_like


def test_pid_and_pairing_codes_detect_single_character_errors() -> None:
    for _ in range(50):
        for code in (new_pid(), new_pairing_code()):
            assert is_valid_code(code)
            for pos in range(len(code)):
                for ch in CROCKFORD:
                    if ch != code[pos]:
                        assert not is_valid_code(code[:pos] + ch + code[pos + 1 :])
    assert len(new_pairing_code()) == 6 and len(new_pid()) == 10
    assert normalise_code(" ab-io ") == "AB10"


def test_derived_pid_is_deterministic_and_keyed() -> None:
    a = derive_pid(b"k" * 32, "s1", "legacy-42")
    assert a == derive_pid(b"k" * 32, "s1", "legacy-42")
    assert a != derive_pid(b"j" * 32, "s1", "legacy-42")
    assert is_valid_code(a)


def test_sealed_dek_round_trip() -> None:
    sk = os.urandom(32)
    dek = os.urandom(32)
    sealed = seal_dek(x25519_public_key(sk), dek)
    assert unseal_dek(sk, sealed) == dek
    nonce, ct = encrypt_chunk(dek, b"hello")
    assert decrypt_chunk(dek, nonce, ct) == b"hello"
    with pytest.raises(CryptoFailureError):
        decrypt_chunk(os.urandom(32), nonce, ct)
    with pytest.raises(CryptoFailureError):
        unseal_dek(os.urandom(32), sealed)


def test_reference_criterion_scoring() -> None:
    instrument = {
        "response_scale": {
            "type": "likert",
            "min": 1,
            "max": 5,
            "anchors": [],
            "reverse_formula": "min_plus_max_minus_x",
        },
        "items": [{"item_id": f"i{i}", "reverse_keyed": i in (2, 4)} for i in range(1, 6)],
        "subscales": [
            {
                "scale_id": "total",
                "items": [f"i{i}" for i in range(1, 6)],
                "score_type": "sum",
                "min_answered_prop": 0.8,
            },
            {"scale_id": "mean", "items": ["i1", "i2"], "score_type": "mean", "min_answered_prop": 1.0},
        ],
        "scoring": {"prorate_min_prop": 0.8},
    }
    assert reverse_code(2, 1, 5) == 4
    scales, version = score_instrument(instrument, {"i1": 5, "i2": 1, "i3": 3, "i4": 2, "i5": None})
    by = {s.scale_id: s for s in scales}
    # keyed: 5, 5, 3, 4 -> mean 4.25 -> prorated sum 21.25 over 5 items
    assert by["total"].score == pytest.approx(21.25) and by["total"].prorated
    assert by["mean"].score == pytest.approx(5.0)
    assert version
    scales, _ = score_instrument(instrument, {"i1": 5}, attention_failed=True)
    by = {s.scale_id: s for s in scales}
    assert by["total"].na_reason == "insufficient_items" and "criterion_careless" in by["total"].flags


def test_oidc_jwt_verification(monkeypatch: pytest.MonkeyPatch) -> None:
    import time  # noqa: PLC0415

    import jwt  # noqa: PLC0415
    from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: PLC0415

    from shriii_api.auth import tokens  # noqa: PLC0415
    from shriii_api.auth.rbac import Role  # noqa: PLC0415
    from shriii_api.settings import Settings  # noqa: PLC0415

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    class _Key:
        def __init__(self) -> None:
            self.key = key.public_key()

    class _Client:
        def get_signing_key_from_jwt(self, token: str) -> _Key:
            return _Key()

    monkeypatch.setattr(tokens, "_jwks_client", lambda url: _Client())
    s = Settings(
        ENV="prod",
        auth_mode="oidc",
        oidc_jwks_url="https://idp.example/jwks",
        jwt_issuer="https://idp",
        jwt_audience="shriii",
        oidc_roles_claim="groups",
        pid_hmac_pepper="a" * 44,
        session_key_kek="a" * 44,
        backend_x25519_private_key="a" * 44,
        release_pack_signing_key="a" * 44,
        identity_vault_key="a" * 44,
    )
    now = int(time.time())
    claims = {
        "sub": "u1",
        "iss": "https://idp",
        "aud": "shriii",
        "exp": now + 60,
        "groups": ["Researcher", "x"],
        "studies": ["s2"],
    }
    principal = tokens.verify_jwt(s, jwt.encode(claims, key, algorithm="RS256"))
    assert principal.roles == frozenset({Role.RESEARCHER}) and principal.studies == frozenset({"s2"})
    with pytest.raises(tokens.AuthError):
        tokens.verify_jwt(s, jwt.encode({**claims, "aud": "other"}, key, algorithm="RS256"))
    with pytest.raises(tokens.AuthError):  # devices never authenticate with user JWTs
        tokens.verify_jwt(s, jwt.encode({**claims, "groups": ["kiosk_device"]}, key, algorithm="RS256"))


def test_trait_estimates_use_the_band_reference() -> None:
    from shriii_api.adapters.scoring import estimate_traits  # noqa: PLC0415

    pack = {
        "composites": [
            {
                "trait": "self_control",
                "pathway": "B",
                "language": "hi-IN",
                "method": "unit_weighted_z",
                "indicators": [
                    {"indicator_id": "a", "mean": 0.0, "sd": 1.0, "weight": 1.0, "direction": "positive"},
                    {"indicator_id": "b", "mean": 10.0, "sd": 2.0, "weight": 1.0, "direction": "negative"},
                ],
            },
            {"trait": "other_language", "pathway": "B", "language": "ta-IN", "method": "x", "indicators": []},
        ],
        "norm_tables": [
            {"trait": "self_control", "pathway": "B", "language": "hi-IN", "cut_points": [-0.5, 0.5], "sem": 0.1}
        ],
        "phrase_allowlist": [{"trait": "self_control", "band": "pole_b", "phrase_key": "sc.high"}],
    }
    sem_rule = {"ci_level": 0.90, "max_band_boundaries_overlapped": 1, "min_band_width_sem": 2.0}
    rows, version = estimate_traits({"a": 1.0, "b": 8.0}, pack, pathway="B", language="hi-IN", sem_rule=sem_rule)
    assert version.startswith("shriii_scoring-bands-")
    assert len(rows) == 1
    # z(a) = 1, z(b) reversed = +1 -> composite 1.0 > 0.5 -> pole_b with an allowlisted phrase.
    assert rows[0].composite == pytest.approx(1.0) and rows[0].band == "pole_b" and not rows[0].not_enough_to_say
    missing, _ = estimate_traits({"a": 1.0}, pack, pathway="B", language="hi-IN", sem_rule=sem_rule)
    assert missing[0].band is None and missing[0].not_enough_to_say  # fail closed on a missing indicator


def test_construct_validity_runs_the_registered_hypotheses_with_family_corrections() -> None:
    import pandas as pd  # noqa: PLC0415

    from shriii_api.adapters.validation import run_analysis  # noqa: PLC0415
    from shriii_api.services.provenance import dictionary_context  # noqa: PLC0415

    rng = np.random.default_rng(7)
    n = 240
    latent = rng.normal(size=n)
    frame = pd.DataFrame(
        {
            "research_id": [f"r{i}" for i in range(n)],
            "occasion_id": "T1",
            "language": ["hi-IN", "ta-IN"] * (n // 2),
            "pathway": "B",
            # Commission rate is construct-keyed "higher_less": more self-control -> fewer commissions.
            "ind__self_control.nogo_commission_rate": -0.7 * latent + rng.normal(scale=0.7, size=n),
            "crit__bscs.total": 0.6 * latent + rng.normal(scale=0.8, size=n),
            "crit__bfi2_xs.conscientiousness": 0.4 * latent + rng.normal(size=n),
        }
    )
    context = {**dictionary_context("B"), "hypothesis_ids": ["h1.self_control"], "provenance": {"snapshot_id": "s1"}}
    out = run_analysis("construct_validity", frame, params={"n_boot": 200}, context=context)
    assert out.engine.startswith("shriii_validation-")
    rows = [r for r in out.results if r.hypothesis_id == "h1.self_control"]
    pooled = next(r for r in rows if "language" not in r.subgroup)
    assert not pooled.exploratory and pooled.passed is True and pooled.estimate is not None and pooled.estimate > 0.3
    assert pooled.details["family"] == "primary" and pooled.details["p_adjusted"] >= pooled.details["p"]
    assert pooled.threshold == pytest.approx(0.10)
    assert pooled.provenance["snapshot_id"] == "s1" and pooled.provenance["algorithm_version"]
    assert pooled.exclusions["rows_used"] == n
    # Per-language rows exist for the gate cells and are labelled exploratory.
    assert {r.subgroup.get("language") for r in rows} == {None, "hi-IN", "ta-IN"}
    assert all(r.exploratory for r in rows if "language" in r.subgroup)


def test_retest_reliability_needs_the_minimum_pairs_for_a_verdict() -> None:
    import pandas as pd  # noqa: PLC0415

    from shriii_api.adapters.validation import run_analysis  # noqa: PLC0415

    rng = np.random.default_rng(3)
    true = rng.normal(size=10)
    rows = []
    for i, t in enumerate(true):
        for occ in ("T1", "T2"):
            rows.append({"research_id": f"r{i}", "occasion_id": occ, "ind__x": t + rng.normal(scale=0.1)})
    gates = {
        "trait_gate": {
            "retest": {"point_min": 0.6, "lower_bound_min": 0.4, "min_pairs_per_cell": 30, "ci_level": 0.95},
            "reliability": {"point_min": 0.7, "lower_bound_min": 0.6, "ci_level": 0.95},
        },
        "group_only_indicators": [],
    }
    out = run_analysis("reliability", pd.DataFrame(rows), params={}, context={"gates": gates})
    (row,) = [r for r in out.results if r.subject == "x" and r.metric == "icc_a1"]
    assert row.estimate is None and row.passed is None and row.details["status"] == "insufficient"
    assert row.n == 10


def test_adapter_reports_unavailable_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    import importlib  # noqa: PLC0415

    import pandas as pd  # noqa: PLC0415

    from shriii_api.adapters import validation as adapter  # noqa: PLC0415
    from shriii_api.adapters.scoring import AdapterUnavailableError  # noqa: PLC0415

    real = importlib.import_module

    def fake(name: str, package: str | None = None) -> object:
        if name == "shriii_validation":
            raise ImportError("not installed")
        return real(name, package)

    monkeypatch.setattr(importlib, "import_module", fake)
    with pytest.raises(AdapterUnavailableError, match="adapter_unavailable"):
        adapter.run_analysis("descriptives", pd.DataFrame(), params={}, context={})
    assert adapter.analyses() == adapter.STATIC_ANALYSES
