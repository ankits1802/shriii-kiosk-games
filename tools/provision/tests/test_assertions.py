from __future__ import annotations

import copy
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from shriii_provision import ProvisionError
from shriii_provision import assertions as asr

BRAND = "a" * 32
VARS = {
    "BRAND_ACCOUNT_ID": BRAND,
    "BRAND_STORE_ID": "shriii-brand-store",
    "GADGET_SNAP_ID": "G" * 32,
    "KIOSK_SNAP_ID": "K" * 32,
    "MODEL_TIMESTAMP": "2026-10-22T00:00:00+00:00",
}


@pytest.fixture
def template(repo_root: Path) -> Any:
    return json.loads((repo_root / "infra/kiosk-image/model/shriii-kiosk-pc-24.json").read_text())


@pytest.fixture
def model(template: Any) -> Any:
    return asr.render(template, VARS)


def test_repository_template_is_valid_with_placeholders(template: Any) -> None:
    assert asr.validate_model(template, allow_placeholders=True, require_production=True) == []
    assert asr.placeholders(template) == set(VARS)


def test_rendered_model_is_valid(model: Any) -> None:
    assert asr.validate_model(model, require_production=True) == []
    assert model["authority-id"] == BRAND
    assert {s["name"] for s in model["snaps"]} >= {"ubuntu-frame", "shriii-kiosk", "pipewire", "mesa-2404"}


def test_unresolved_placeholders_rejected(template: Any) -> None:
    problems = asr.validate_model(template)
    assert any("unresolved placeholders" in p for p in problems)


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (lambda m: m.update(grade="dangerous"), "must not be grade dangerous"),
        (lambda m: m.pop("storage-safety"), "storage-safety must be 'encrypted'"),
        (lambda m: m.update(base="core22"), "base must be core24"),
        (lambda m: m.update(series=16), "series must be the string '16'"),
        (lambda m: m.update({"brand-id": "b" * 32}), "authority-id must equal brand-id"),
        (lambda m: m.update({"system-user-authority": "*"}), "system-user-authority '*'"),
        (lambda m: m.update({"validation-sets": []}), "shriii-wave-freeze"),
        (lambda m: m["validation-sets"][0].update(mode="monitor"), "must be mode 'enforce'"),
        (lambda m: m["validation-sets"][0].update(sequence=3), "must not pin a sequence"),
        (lambda m: m.update(timestamp="yesterday"), "timestamp must be RFC 3339"),
        (lambda m: m["snaps"].pop(), "required snap 'shriii-kiosk' is missing"),
        (lambda m: m["snaps"].append({"name": "lxd", "type": "app", "id": "L" * 32}), "'lxd' is not allowed"),
        (lambda m: m["snaps"].append(dict(m["snaps"][0])), "exactly one gadget"),
        (lambda m: m["snaps"][1].update(id="short"), "id must be 32"),
        (lambda m: m["snaps"][1].update({"default-channel": "24/bogus"}), "default-channel"),
        (lambda m: m["snaps"][-1].update(presence="optional"), "must be required"),
    ],
)
def test_model_rules(model: Any, mutate: Any, expected: str) -> None:
    broken = copy.deepcopy(model)
    mutate(broken)
    problems = asr.validate_model(broken, require_production=True)
    assert any(expected in p for p in problems), problems


def test_missing_keys_short_circuit() -> None:
    assert asr.validate_model({"type": "model"})[0].startswith("missing")
    assert asr.validate_model([]) == ["model must be a JSON object"]


def test_render_leaves_unknown_placeholders() -> None:
    assert asr.render({"a": ["${X}", "${Y}-1"], "${X}": 2}, {"X": "x"}) == {"a": ["x", "${Y}-1"], "x": 2}


def test_wave_freeze_assertion() -> None:
    stamp = datetime(2026, 10, 22, 12, 30, 15, 999, tzinfo=UTC)
    out = asr.wave_freeze_assertion(
        account_id=BRAND,
        sequence=4,
        snaps=[
            {"name": "shriii-kiosk", "id": "K" * 32, "revision": "17"},
            {"name": "ubuntu-frame", "id": "BPZbvWzvoMTrpec4goCXlckLe2IhfthK", "revision": "20083"},
        ],
        timestamp=stamp,
    )
    assert out["type"] == "validation-set"
    assert out["name"] == "shriii-wave-freeze"
    assert out["sequence"] == "4"
    assert out["timestamp"] == "2026-10-22T12:30:15Z"
    assert all(s["presence"] == "required" and s["revision"].isdigit() for s in out["snaps"])


@pytest.mark.parametrize(
    ("snaps", "match"),
    [
        ([{"name": "shriii-kiosk", "id": "K" * 32, "revision": "1"}], "must pin ubuntu-frame"),
        (
            [
                {"name": "shriii-kiosk", "id": "K" * 32, "revision": "0"},
                {"name": "ubuntu-frame", "id": "F" * 32, "revision": "1"},
            ],
            "positive integer",
        ),
        ([{"name": "Bad_Name", "id": "K" * 32, "revision": "1"}], "invalid snap name"),
        ([{"name": "shriii-kiosk", "id": "nope", "revision": "1"}], "32 alphanumeric"),
    ],
)
def test_wave_freeze_rejects(snaps: list[dict[str, str]], match: str) -> None:
    with pytest.raises(ProvisionError, match=match):
        asr.wave_freeze_assertion(account_id=BRAND, sequence=1, snaps=snaps)
