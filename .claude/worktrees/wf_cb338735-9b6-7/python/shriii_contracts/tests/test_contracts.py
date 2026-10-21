"""Shared-fixture parity: jsonschema (strict + reader) and Pydantic agree on every fixture."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError
from shriii_contracts import (
    EVENT_TYPES,
    ContractModel,
    ResponseEvent,
    UnknownFieldsError,
    check_event_invariants,
    check_session_sequence,
    check_trial_spec_invariants,
    codegen,
    find_forbidden_field_names,
    parse_contract,
    parse_event,
    payload_ext,
    unknown_fields,
)
from shriii_contracts import GameTrialSpec as GameTrialSpecModel
from shriii_contracts.paths import fixtures_dir
from shriii_contracts.schema_validation import CONTRACT_FILES, is_valid, load_schemas


def _load(kind: str) -> list[tuple[str, str, Any]]:
    root = fixtures_dir() / kind
    out: list[tuple[str, str, Any]] = []
    for contract_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        for f in sorted(contract_dir.glob("*.json")):
            out.append((contract_dir.name, f.stem, json.loads(f.read_text(encoding="utf-8"))))
    return out


VALID = _load("valid")
INVALID = _load("invalid")
FORWARD = _load("forward-compat")


def _ids(items: list[tuple[str, str, Any]]) -> list[str]:
    return [f"{c}/{n}" for c, n, _ in items]


def test_generated_models_are_in_sync_with_schemas() -> None:
    assert codegen.main(["--check"]) == 0


def test_every_contract_has_fixtures() -> None:
    contracts = {c for c, _, _ in VALID}
    expected = {
        "event-envelope",
        "upload-batch",
        "upload-batch-result",
        "session-context",
        "content-manifest",
        "game-trial-spec",
        "criterion-response",
        "criterion-scale-score",
        "consent-artefact",
        "report-artefact",
        "release-pack",
    }
    assert expected <= contracts
    assert contracts <= set(CONTRACT_FILES)


def test_valid_fixture_exists_for_every_event_type() -> None:
    types = {d["event_type"] for c, _, d in VALID if c == "event-envelope"}
    assert types == set(EVENT_TYPES)
    assert len(EVENT_TYPES) == 54


@pytest.mark.parametrize(("contract", "name", "data"), VALID, ids=_ids(VALID))
def test_valid_fixtures_pass_everywhere(contract: str, name: str, data: Any) -> None:
    assert is_valid(contract, data, "strict"), name
    assert is_valid(contract, data, "reader"), name
    model = parse_contract(contract, data, strict=True)
    # Round trip: dumping the model reproduces the fixture exactly.
    assert model.model_dump(mode="json", by_alias=True, exclude_unset=True) == data


@pytest.mark.parametrize(("contract", "name", "data"), INVALID, ids=_ids(INVALID))
def test_invalid_fixtures_fail_everywhere(contract: str, name: str, data: Any) -> None:
    assert not is_valid(contract, data, "strict"), name
    assert not is_valid(contract, data, "reader"), name
    with pytest.raises((ValidationError, UnknownFieldsError)):
        parse_contract(contract, data, strict=True)
    with pytest.raises(ValidationError):
        parse_contract(contract, data, strict=False)


@pytest.mark.parametrize(("contract", "name", "data"), FORWARD, ids=_ids(FORWARD))
def test_forward_compat_readers_tolerate_unknown_fields(contract: str, name: str, data: Any) -> None:
    assert is_valid(contract, data, "reader"), name
    assert not is_valid(contract, data, "strict"), name
    model = parse_contract(contract, data, strict=False)
    assert unknown_fields(model), "unknown fields must be retained for payload_ext"
    with pytest.raises(UnknownFieldsError):
        parse_contract(contract, data, strict=True)


def test_payload_ext_drops_privacy_forbidden_names() -> None:
    data = next(d for c, n, d in VALID if c == "event-envelope" and n == "response")
    data = json.loads(json.dumps(data))
    data["payload"]["asr_alternatives"] = ["serve", "stop"]
    data["payload"]["pressure_intensity"] = 2
    event = parse_event(data)
    ext = payload_ext(event)
    assert ext == {"/payload/pressure_intensity": 2}


@pytest.mark.parametrize("file", sorted(load_schemas()))
def test_no_forbidden_field_names_in_any_schema(file: str) -> None:
    assert find_forbidden_field_names(load_schemas()[file]) == []


def test_kiosk_fixtures_satisfy_invariants() -> None:
    for c, n, d in VALID:
        if c == "event-envelope" and "server_ingested" not in n:
            assert check_event_invariants(parse_event(d)) == [], n


def test_response_invariants_detect_violations() -> None:
    data = next(d for c, n, d in VALID if c == "event-envelope" and n == "response")
    event = parse_event(data)
    assert isinstance(event, ResponseEvent)
    timeout = event.model_copy(update={"payload": event.payload.model_copy(update={"input_mode": "timeout"})})
    assert "latency_null_iff_timeout" in {v.code for v in check_event_invariants(timeout)}
    early = event.model_copy(update={"payload": event.payload.model_copy(update={"latency_ms": -40.0})})
    assert "barge_in_sign" in {v.code for v in check_event_invariants(early)}


def test_minimal_session_ordering() -> None:
    raw = json.loads((fixtures_dir() / "sessions" / "minimal-session.json").read_text(encoding="utf-8"))
    events = [parse_event(e, strict=True) for e in raw]
    assert check_session_sequence(events) == []
    gapped = [e for e in events if e.seq != 4]
    assert "seq_gap" in {v.code for v in check_session_sequence(gapped)}


def test_trial_spec_voice_subset() -> None:
    raw = json.loads(
        (fixtures_dir() / "valid" / "game-trial-spec" / "weighing_say_or_touch.json").read_text(encoding="utf-8")
    )
    spec = GameTrialSpecModel.model_validate(raw)
    assert check_trial_spec_invariants(spec) == []
    bad = spec.model_copy(update={"voice_vocabulary": ["approve", "bribe"]})
    assert "voice_not_subset_of_touch" in {v.code for v in check_trial_spec_invariants(bad)}


def test_strict_mode_does_not_coerce_strings_to_numbers() -> None:
    data = next(d for c, n, d in VALID if c == "event-envelope" and n == "pump")
    data = json.loads(json.dumps(data))
    data["seq"] = "5"
    assert not is_valid("event-envelope", data)
    with pytest.raises(ValidationError):
        parse_event(data)


def test_number_fields_accept_integers() -> None:
    data = next(d for c, n, d in VALID if c == "event-envelope" and n == "idle")
    data = json.loads(json.dumps(data))
    data["timing"]["t_mono_ms"] = 1000
    assert is_valid("event-envelope", data)
    assert parse_event(data).timing.t_mono_ms == 1000


def test_contract_model_base_is_tolerant() -> None:
    assert ContractModel.model_config.get("extra") == "allow"
    assert ContractModel.model_config.get("strict") is True


def test_fixture_dir_resolves() -> None:
    assert Path(fixtures_dir()).is_dir()
