"""Layer 5 band reference: SEM rule, composites, display rule (property test), report safety."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

import pytest
import yaml
from hypothesis import given, settings
from hypothesis import strategies as st
from shriii_contracts.paths import scoring_dir
from shriii_scoring.bands import band_for, composite_score, display_allowed, release_pack_valid, report_bands

GATES: dict[str, Any] = yaml.safe_load((scoring_dir() / "gates.yaml").read_text(encoding="utf-8"))
SEM_RULE = GATES["trait_gate"]["norms"]["sem_rule"]
ALLOW = [
    {"trait": "self_control", "band": b, "phrase_key": f"report.self_control.{b}"}
    for b in ("pole_a", "centre", "pole_b")
]


def test_band_lookup_and_sem_rule() -> None:
    r = band_for("self_control", 1.5, [-0.5, 0.5], 0.2, SEM_RULE, phrase_allowlist=ALLOW)
    assert r.band == "pole_b" and not r.not_enough_to_say and r.phrase_key == "report.self_control.pole_b"
    r = band_for("self_control", 0.0, [-0.5, 0.5], 0.4, SEM_RULE, phrase_allowlist=ALLOW)
    assert r.not_enough_to_say  # 90 % CI +-0.66 overlaps both boundaries
    r = band_for("self_control", 0.0, [-0.3, 0.3], 0.31, SEM_RULE, phrase_allowlist=ALLOW)
    assert r.not_enough_to_say and r.reason in ("band_narrower_than_sem_rule", "ci_overlaps_band_boundaries")
    assert band_for("self_control", None, [-0.5, 0.5], 0.2, SEM_RULE).not_enough_to_say


def test_composite_fails_closed() -> None:
    comp = {
        "indicators": [
            {"indicator_id": "a.x", "weight": 1, "mean": 0, "sd": 1, "direction": "positive"},
            {"indicator_id": "a.y", "weight": 1, "mean": 10, "sd": 2, "direction": "negative"},
        ]
    }
    assert composite_score({"a.x": 1.0, "a.y": 8.0}, comp) == pytest.approx((1.0 + 1.0) / 2)
    assert composite_score({"a.x": 1.0}, comp) is None


@given(
    battery=st.sampled_from(["open", "closed"]),
    status=st.sampled_from(["unvalidated", "research_only", "validated_broad_style", "validated_banded", "withheld"]),
    valid=st.booleans(),
    nets=st.booleans(),
    pack=st.booleans(),
    mode=st.sampled_from(["thank_you", "demo", "player_report"]),
)
@settings(max_examples=300, deadline=None)
def test_display_rule_property(*, battery: str, status: str, valid: bool, nets: bool, pack: bool, mode: str) -> None:
    shown = display_allowed(
        display_rule=GATES["display_rule"],
        battery_gate=battery,
        trait_status=status,
        session_valid_for_report=valid,
        not_enough_to_say=nets,
        release_pack_ok=pack,
        report_mode=mode,
    )
    expected = (
        battery == "open"
        and status in ("validated_banded", "validated_broad_style")
        and valid
        and not nets
        and pack
        and mode == "player_report"
    )
    assert shown == expected


def _pack(battery: str, status: str, expires: str = "2026-12-01T00:00:00Z") -> dict[str, Any]:
    return {
        "issued_at": "2026-10-01T00:00:00Z",
        "expires_at": expires,
        "dictionary_sha256": {"A": "a" * 64, "B": "b" * 64},
        "battery_gates": [{"language": "hi-IN", "pathway": "B", "site_mode": "supervised", "status": battery}],
        "trait_gates": [{"trait": "self_control", "language": "hi-IN", "pathway": "B", "status": status}],
        "composites": [
            {
                "trait": "self_control",
                "language": "hi-IN",
                "pathway": "B",
                "method": "unit_weighted_z",
                "indicators": [
                    {
                        "indicator_id": "self_control.nogo_commission_rate",
                        "weight": 1,
                        "mean": 0.3,
                        "sd": 0.1,
                        "direction": "negative",
                    }
                ],
            }
        ],
        "norm_tables": [
            {
                "trait": "self_control",
                "language": "hi-IN",
                "pathway": "B",
                "cut_points": [-0.6, 0.6],
                "sem": 0.2,
                "ci_level": 0.9,
                "provisional": True,
                "effective_n": 300,
            }
        ],
        "phrase_allowlist": ALLOW,
        "disclaimer_key": "report.disclaimer",
    }


@given(
    battery=st.sampled_from(["open", "closed"]),
    status=st.sampled_from(["unvalidated", "validated_banded", "validated_broad_style", "withheld"]),
    value=st.floats(min_value=0.0, max_value=0.8),
    valid=st.booleans(),
)
@settings(max_examples=120, deadline=None)
def test_report_safety_property(battery: str, status: str, value: float, valid: bool) -> None:
    now = datetime(2026, 10, 21, tzinfo=UTC)
    dec = report_bands(
        indicator_values={"self_control.nogo_commission_rate": value},
        release_pack=_pack(battery, status),
        gates=GATES,
        language="hi-IN",
        pathway="B",
        site_mode="supervised",
        session_valid_for_report=valid,
        report_mode="player_report",
        now=now,
    )
    if battery == "closed" or status not in ("validated_banded", "validated_broad_style") or not valid:
        assert dec.traits == ()
    for t in dec.traits:
        assert t.phrase_key is not None and not re.search(r"\d", t.phrase_key)
        assert t.band in ("pole_a", "centre", "pole_b")
    if dec.traits:
        assert dec.disclaimer_key == "report.disclaimer"


def test_expired_pack_and_dictionary_mismatch_fail_closed() -> None:
    now = datetime(2026, 10, 21, tzinfo=UTC)
    assert release_pack_valid(_pack("open", "validated_banded"), now)
    assert not release_pack_valid(_pack("open", "validated_banded", expires="2026-10-20T00:00:00Z"), now)
    assert not release_pack_valid(_pack("open", "validated_banded"), now, {"B": "c" * 64})
    dec = report_bands(
        indicator_values={"self_control.nogo_commission_rate": 0.1},
        release_pack=_pack("open", "validated_banded", expires="2026-10-20T00:00:00Z"),
        gates=GATES,
        language="hi-IN",
        pathway="B",
        site_mode="supervised",
        session_valid_for_report=True,
        report_mode="player_report",
        now=now,
    )
    assert dec.traits == () and dec.withheld_reason == "release_pack_invalid"
