"""Report gating fails closed (VAL-14 display rule, REP-01..03)."""

from __future__ import annotations

import random
import re
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text

from shriii_api.db.models.scored import TraitEstimate
from shriii_api.db.session import get_engine, session_scope
from shriii_api.testing import make_batch, session_events

EVIDENCE = ["val-run-1"]
SIGNERS = ["pi-a", "ethics-b"]


def _gate(
    client: TestClient, admin: dict[str, str], language: str, status: str = "open", approvers: list[str] | None = None
) -> Any:
    return client.post(
        "/api/v1/admin/gates/battery",
        headers=admin,
        json={
            "language": language,
            "pathway": "B",
            "site_mode": "supervised",
            "status": status,
            "evidence_ids": EVIDENCE if status == "open" else [],
            "approvers": SIGNERS if approvers is None else approvers,
        },
    )


def _trait(
    client: TestClient, admin: dict[str, str], trait: str, status: str, language: str = "hi-IN", pathway: str = "B"
) -> Any:
    return client.post(
        "/api/v1/admin/gates/trait",
        headers=admin,
        json={
            "trait": trait,
            "language": language,
            "pathway": pathway,
            "status": status,
            "evidence_ids": EVIDENCE,
            "approvers": SIGNERS,
        },
    )


@pytest.fixture
def scene(client: TestClient, admin: dict[str, str], kiosk: dict[str, Any]) -> dict[str, Any]:
    """A completed, valid hi-IN pathway-B session with a banded self_control estimate."""
    from shriii_api.services.seed import seed_reference  # noqa: PLC0415

    with session_scope() as db:
        seed_reference(db, "test")
    events = session_events(pid=None)
    assert (
        client.post("/api/v1/events/batch", json=make_batch(events), headers=kiosk["headers"]).json()["summary"][
            "accepted"
        ]
        == 10
    )
    sid = events[0]["session_id"]
    with session_scope() as db:
        for trait, band, sem in (("self_control", "pole_a", 0.30), ("composure", "centre", 0.20)):
            db.add(
                TraitEstimate(
                    session_id=uuid.UUID(sid),
                    trait=trait,
                    pathway="B",
                    language="hi-IN",
                    composite=0.8,
                    sem=sem,
                    band=band,
                    not_enough_to_say=False,
                    is_current=True,
                    algorithm_version="test",
                    dictionary_version="0.1.0",
                    source_refs={},
                )
            )
    interps = client.get("/api/v1/norms/interpretations", headers=admin).json()
    for i in interps:
        if (i["trait"], i["band"]) in {("self_control", "pole_a"), ("composure", "centre")}:
            assert (
                client.post(
                    f"/api/v1/norms/interpretations/{i['id']}/approve", headers=admin, json={"approvers": SIGNERS}
                ).status_code
                == 200
            )
    return {"session_id": sid}


def _report(client: TestClient, kiosk: dict[str, Any], sid: str, mode: str = "player_report") -> dict[str, Any]:
    r = client.post(
        "/api/v1/reports",
        headers=kiosk["headers"],
        json={"session_id": sid, "report_mode": mode, "delivery_modes": ["qr", "spoken"]},
    )
    assert r.status_code == 201, r.text
    body: dict[str, Any] = r.json()
    return body


def _evaluation(client: TestClient, researcher: dict[str, str], sid: str) -> dict[str, Any]:
    rows: list[dict[str, Any]] = client.get("/api/v1/reports", headers=researcher, params={"session_id": sid}).json()
    evaluation: dict[str, Any] = rows[0]["gate_evaluation"]
    return evaluation


def _open_everything(client: TestClient, admin: dict[str, str]) -> None:
    assert _gate(client, admin, "hi-IN").status_code == 201
    assert _gate(client, admin, "mr-IN").status_code == 201
    assert _trait(client, admin, "self_control", "validated_banded").status_code == 201
    assert client.post("/api/v1/admin/gates/release-pack", headers=admin).status_code == 201


def test_all_gates_pass_shows_banded_traits(
    client: TestClient, admin: dict[str, str], researcher: dict[str, str], kiosk: dict[str, Any], scene: dict[str, Any]
) -> None:
    _open_everything(client, admin)
    out = _report(client, kiosk, scene["session_id"])
    art = out["artefact"]
    assert art["report_mode"] == "player_report"
    assert art["traits_shown"] == [
        {"trait": "self_control", "band": "pole_a", "phrase_key": "report.self_control.pole_a"}
    ]
    assert art["release_pack_version"] is not None and art["disclaimer_key"]
    ev = _evaluation(client, researcher, scene["session_id"])
    assert ev["suppressed"] == {"composure": "trait_gate_not_validated"}
    # Token / QR retrieval, and no numerals anywhere in participant-facing keys.
    token = art["token"]
    assert out["qr_url"].endswith(token)
    fetched = client.get(f"/api/v1/reports/by-token/{token}").json()
    assert fetched["traits_shown"] == art["traits_shown"]
    for t in fetched["traits_shown"]:
        assert not re.search(r"\d", t["phrase_key"] + t["band"])


def test_no_release_pack_is_thank_you(
    client: TestClient, admin: dict[str, str], researcher: dict[str, str], kiosk: dict[str, Any], scene: dict[str, Any]
) -> None:
    _gate(client, admin, "hi-IN")
    _gate(client, admin, "mr-IN")
    _trait(client, admin, "self_control", "validated_banded")
    art = _report(client, kiosk, scene["session_id"])["artefact"]
    assert art["report_mode"] == "thank_you" and art["traits_shown"] == []
    assert "no_release_pack" in _evaluation(client, researcher, scene["session_id"])["failures"]


def test_single_language_gate_stays_closed(
    client: TestClient, admin: dict[str, str], researcher: dict[str, str], kiosk: dict[str, Any], scene: dict[str, Any]
) -> None:
    _gate(client, admin, "hi-IN")
    _trait(client, admin, "self_control", "validated_banded")
    client.post("/api/v1/admin/gates/release-pack", headers=admin)
    art = _report(client, kiosk, scene["session_id"])["artefact"]
    assert art["report_mode"] == "thank_you" and art["traits_shown"] == []
    ev = _evaluation(client, researcher, scene["session_id"])
    assert "battery_gate_closed" in ev["failures"] and ev["battery_gate"]["open_languages"] == ["hi-IN"]


def test_regression_recloses_gate(
    client: TestClient, admin: dict[str, str], kiosk: dict[str, Any], scene: dict[str, Any]
) -> None:
    _open_everything(client, admin)
    assert _report(client, kiosk, scene["session_id"])["artefact"]["report_mode"] == "player_report"
    _gate(client, admin, "mr-IN", status="closed")  # regression in another language closes this one too
    assert _report(client, kiosk, scene["session_id"])["artefact"]["report_mode"] == "thank_you"


def test_tampered_pack_fails_closed(
    client: TestClient, admin: dict[str, str], researcher: dict[str, str], kiosk: dict[str, Any], scene: dict[str, Any]
) -> None:
    _open_everything(client, admin)
    with get_engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE validation.release_packs SET pack = jsonb_set(pack, '{expires_at}', "
                "to_jsonb('2099-01-01T00:00:00+00:00'::text))"
            )
        )
    art = _report(client, kiosk, scene["session_id"])["artefact"]
    assert art["report_mode"] == "thank_you"
    assert "release_pack_invalid_signature" in _evaluation(client, researcher, scene["session_id"])["failures"]


def test_invalid_session_fails_closed(
    client: TestClient, admin: dict[str, str], researcher: dict[str, str], kiosk: dict[str, Any], scene: dict[str, Any]
) -> None:
    _open_everything(client, admin)
    client.post(
        f"/api/v1/sessions/{scene['session_id']}/invalidate",
        headers=researcher,
        json={"reason": "observer saw coaching"},
    )
    art = _report(client, kiosk, scene["session_id"])["artefact"]
    assert art["report_mode"] == "thank_you"
    assert "session_not_valid_for_report" in _evaluation(client, researcher, scene["session_id"])["failures"]


def test_not_enough_to_say_is_suppressed(
    client: TestClient, admin: dict[str, str], kiosk: dict[str, Any], scene: dict[str, Any]
) -> None:
    _open_everything(client, admin)
    with session_scope() as db:
        for est in db.execute(select(TraitEstimate)).scalars():
            est.not_enough_to_say = True
    assert _report(client, kiosk, scene["session_id"])["artefact"]["report_mode"] == "thank_you"


def test_thank_you_and_demo_modes(
    client: TestClient, admin: dict[str, str], kiosk: dict[str, Any], scene: dict[str, Any]
) -> None:
    _open_everything(client, admin)
    art = _report(client, kiosk, scene["session_id"], mode="thank_you")["artefact"]
    assert art["report_mode"] == "thank_you" and art["traits_shown"] == []
    r = client.post(
        "/api/v1/reports", headers=kiosk["headers"], json={"session_id": scene["session_id"], "report_mode": "demo"}
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "demo_not_server_side"


def test_gate_write_rules(client: TestClient, admin: dict[str, str]) -> None:
    r = _gate(client, admin, "hi-IN", approvers=["only-one"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "insufficient_signoff"
    r = _trait(client, admin, "integrity", "validated_banded")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "status_capped"
    assert _trait(client, admin, "integrity", "validated_broad_style").status_code == 201
    r = _trait(client, admin, "emotional_regulation", "validated_broad_style", pathway="B")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "permanently_withheld"
    history = client.get("/api/v1/admin/gates", headers=admin, params={"include_history": True}).json()
    assert [t["status"] for t in history["trait_history"]] == ["validated_broad_style"]


def test_random_gate_states_never_leak(
    client: TestClient, admin: dict[str, str], kiosk: dict[str, Any], scene: dict[str, Any]
) -> None:
    """Property-style check over random gate states: traits appear only when every condition holds."""
    rng = random.Random(20261021)
    for _ in range(10):
        hi_open, mr_open = rng.random() < 0.6, rng.random() < 0.6
        status = rng.choice(["unvalidated", "research_only", "validated_broad_style", "validated_banded"])
        pack = rng.random() < 0.7
        _gate(client, admin, "hi-IN", "open" if hi_open else "closed")
        _gate(client, admin, "mr-IN", "open" if mr_open else "closed")
        _trait(client, admin, "self_control", status)
        if pack:
            client.post("/api/v1/admin/gates/release-pack", headers=admin)
        else:
            current = client.get("/api/v1/admin/gates/release-pack/current", headers=admin)
            if current.status_code == 200:
                client.post(
                    f"/api/v1/admin/gates/release-pack/{current.json()['release_pack_version']}/revoke", headers=admin
                )
        art = _report(client, kiosk, scene["session_id"])["artefact"]
        should_show = hi_open and mr_open and pack and status in ("validated_broad_style", "validated_banded")
        assert (art["report_mode"] == "player_report") == should_show, (hi_open, mr_open, status, pack)
        if not should_show:
            assert art["traits_shown"] == []


def test_integrity_is_withheld_from_player_reports_even_when_validated(
    client: TestClient, admin: dict[str, str], researcher: dict[str, str], kiosk: dict[str, Any], scene: dict[str, Any]
) -> None:
    """config/report_policy.yaml withholds integrity (BUILD_DECISIONS #6) on top of every gates.yaml rule."""
    from shriii_api.services import report_policy  # noqa: PLC0415

    assert report_policy.withheld_reason("integrity", "A") is not None
    assert report_policy.withheld_reason("self_control", "B") is None
    with session_scope() as db:
        db.add(
            TraitEstimate(
                session_id=uuid.UUID(scene["session_id"]),
                trait="integrity",
                pathway="B",
                language="hi-IN",
                composite=0.9,
                sem=0.05,  # the most reliable estimate: it would be shown first if it were allowed
                band="pole_b",
                not_enough_to_say=False,
                is_current=True,
                algorithm_version="test",
                dictionary_version="0.1.0",
                source_refs={},
            )
        )
    for i in client.get("/api/v1/norms/interpretations", headers=admin).json():
        if i["trait"] == "integrity":
            client.post(f"/api/v1/norms/interpretations/{i['id']}/approve", headers=admin, json={"approvers": SIGNERS})
    assert _trait(client, admin, "integrity", "validated_broad_style").status_code == 201
    _open_everything(client, admin)
    pack = client.get("/api/v1/admin/gates/release-pack/current", headers=admin).json()["pack"]
    assert not any(a["trait"] == "integrity" for a in pack["phrase_allowlist"])
    art = _report(client, kiosk, scene["session_id"])["artefact"]
    assert [t["trait"] for t in art["traits_shown"]] == ["self_control"]
    assert (
        _evaluation(client, researcher, scene["session_id"])["suppressed"]["integrity"] == "withheld_from_player_report"
    )
