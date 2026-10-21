"""Criterion battery via the API: reverse-scoring, prorating, approvals, corrections, imports."""

from __future__ import annotations

import io
import json
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient
from shriii_contracts.paths import content_dir

STUDY = "s-crit"


def _bscs() -> dict[str, Any]:
    data: dict[str, Any] = yaml.safe_load((content_dir() / "instruments" / "bscs.yaml").read_text(encoding="utf-8"))
    return data


@pytest.fixture
def battery(client: TestClient, admin: dict[str, str], researcher: dict[str, str]) -> dict[str, Any]:
    """Registry synced, BSCS hi-IN approved + licence granted, one participant with criterion consent."""
    assert client.post("/api/v1/instruments/sync", headers=admin).status_code == 200
    r = client.post(
        "/api/v1/instruments/bscs/versions/1.0.0/languages/hi-IN",
        headers=admin,
        json={"itc_state": "approved", "approvers": ["pi-a", "ethics-b"]},
    )
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/instruments/bscs/licensing",
        headers=admin,
        json={
            "holder": "Wiley",
            "licence": "research",
            "permission_status": "granted",
            "permission_document": "DOC-123",
            "allowed_use": "pilot research",
        },
    )
    assert r.status_code == 201, r.text
    client.post(
        "/api/v1/studies", headers=researcher, json={"study_id": STUDY, "code": "S1", "name": "crit", "stage": "pilot"}
    )
    pid = client.post("/api/v1/participants", headers=researcher, json={"study_id": STUDY}).json()["pid"]
    consent = {
        "kind": "criterion",
        "granted": True,
        "consent_script_id": "criterion.v1",
        "script_audio_sha256": "a" * 64,
        "language": "hi-IN",
        "policy_version": "1.0.0",
        "presented_at": "2026-10-21T10:00:00+05:30",
        "decided_at": "2026-10-21T10:01:00+05:30",
    }
    assert client.post(f"/api/v1/participants/{pid}/consents", headers=researcher, json=consent).status_code == 201
    return {"pid": pid}


def _administration(pid: str, responses: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {
        "pid": pid,
        "study_id": STUDY,
        "occasion_id": "T1",
        "instrument_id": "bscs",
        "language": "hi-IN",
        "block": "X",
        "administration_mode": "read_aloud",
        "administrator_id": "admin-7",
        "device_id": "tablet-3",
        "responses": [{"item_id": k, "raw_response": v} for k, v in responses.items()],
        **extra,
    }


def test_reverse_scoring_matches_published_key(
    client: TestClient, researcher: dict[str, str], battery: dict[str, Any]
) -> None:
    inst = _bscs()
    items = inst["items"]
    raw = {it["item_id"]: float((i % 5) + 1) for i, it in enumerate(items)}
    expected_keyed = [6 - raw[it["item_id"]] if it["reverse_keyed"] else raw[it["item_id"]] for it in items]
    expected = sum(expected_keyed) / len(expected_keyed)
    assert any(it["reverse_keyed"] for it in items)
    r = client.post("/api/v1/assessment-responses", headers=researcher, json=_administration(battery["pid"], raw))
    assert r.status_code == 201, r.text
    scores = {s["scale_id"]: s for s in r.json()["scores"]}
    total = scores["total"]
    assert total["score"] == pytest.approx(expected, abs=1e-12)
    assert total["n_answered"] == total["n_items"] == len(items)
    assert total["prorated"] is False and total["na_reason"] is None
    assert total["key_version"] == inst["scoring"]["key_version"]
    assert len(total["source_refs"]["response_ids"]) == len(items)
    assert total["algorithm_version"]


def test_prorating_and_insufficient_items(
    client: TestClient, researcher: dict[str, str], battery: dict[str, Any]
) -> None:
    items = [it["item_id"] for it in _bscs()["items"]]
    some = dict.fromkeys(items[: len(items) - 2], 3.0)  # 11/13 answered >= 80 %
    total = {
        s["scale_id"]: s
        for s in client.post(
            "/api/v1/assessment-responses", headers=researcher, json=_administration(battery["pid"], some)
        ).json()["scores"]
    }["total"]
    assert total["prorated"] is True and "prorated" in total["flags"]
    few = dict.fromkeys(items[:5], 3.0)
    r = client.post(
        "/api/v1/assessment-responses", headers=researcher, json=_administration(battery["pid"], few, occasion_id="T2")
    )
    total = {s["scale_id"]: s for s in r.json()["scores"]}["total"]
    assert total["score"] is None and total["na_reason"] == "insufficient_items"


def test_correction_supersedes_and_rescores(
    client: TestClient, researcher: dict[str, str], battery: dict[str, Any]
) -> None:
    items = [it["item_id"] for it in _bscs()["items"]]
    first = client.post(
        "/api/v1/assessment-responses",
        headers=researcher,
        json=_administration(battery["pid"], dict.fromkeys(items, 3.0)),
    ).json()
    target = next(r for r in first["responses"] if r["item_id"] == items[0])
    corrected = client.post(
        f"/api/v1/assessment-responses/{target['response_id']}/correct",
        headers=researcher,
        json={"raw_response": 5.0, "reason": "transcription error"},
    )
    assert corrected.status_code == 200, corrected.text
    history = client.get(f"/api/v1/assessment-responses/{target['response_id']}/history", headers=researcher).json()
    assert [h["raw_response"] for h in history] == [3.0, 5.0]
    assert history[1]["supersedes_id"] == target["response_id"]
    scores = client.get(
        "/api/v1/assessment-responses/scores",
        headers=researcher,
        params={"study_id": STUDY, "pid": battery["pid"], "include_history": True},
    ).json()
    totals = [s for s in scores if s["scale_id"] == "total"]
    assert [s["is_current"] for s in totals] == [False, True]
    assert totals[0]["scoring_run_id"] != totals[1]["scoring_run_id"]
    # Raw responses are append-only at the database level too.
    from sqlalchemy import text  # noqa: PLC0415
    from sqlalchemy.exc import DBAPIError  # noqa: PLC0415

    from shriii_api.db.session import get_engine  # noqa: PLC0415

    with pytest.raises(DBAPIError, match="append-only"), get_engine().begin() as conn:
        conn.execute(text("UPDATE criterion.responses SET raw_response = 1"))


def test_administration_guards(
    client: TestClient, auth: Any, researcher: dict[str, str], battery: dict[str, Any]
) -> None:
    items = {it["item_id"]: 3.0 for it in _bscs()["items"]}
    r = client.post(
        "/api/v1/assessment-responses",
        headers=researcher,
        json=_administration(battery["pid"], items, language="mr-IN"),
    )
    assert r.status_code == 409 and r.json()["detail"]["code"] == "language_version_not_approved"
    r = client.post(
        "/api/v1/assessment-responses",
        headers=researcher,
        json=_administration(battery["pid"], items, site_mode="open_public"),
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "public_kiosk_context"
    r = client.post(
        "/api/v1/assessment-responses",
        headers=researcher,
        json=_administration(battery["pid"], {**items, "bscs.i01": 9.0}),
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "response_out_of_range"
    r = client.post(
        "/api/v1/assessment-responses",
        headers=researcher,
        json=_administration(battery["pid"], items, rater_role="partner", rated_pid=battery["pid"]),
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "self_rating_forbidden"
    # Field administrators capture responses but never see scores (PRV-08).
    field_admin = auth("administrator", sub="field-1")
    ok = client.post("/api/v1/assessment-responses", headers=field_admin, json=_administration(battery["pid"], items))
    assert ok.status_code == 201 and ok.json()["scores"] is None
    assert (
        client.get("/api/v1/assessment-responses/scores", headers=field_admin, params={"study_id": STUDY}).status_code
        == 403
    )


def test_unlicensed_instrument_cannot_be_administered(
    client: TestClient, admin: dict[str, str], researcher: dict[str, str], battery: dict[str, Any]
) -> None:
    client.post(
        "/api/v1/instruments/grit_s/versions/1.0.0/languages/hi-IN",
        headers=admin,
        json={"itc_state": "approved", "approvers": ["a", "b"]},
    )
    r = client.post(
        "/api/v1/assessment-responses",
        headers=researcher,
        json={**_administration(battery["pid"], {"grit_s.i01": 3.0}), "instrument_id": "grit_s"},
    )
    assert r.status_code == 409 and r.json()["detail"]["code"] == "licence_not_granted"
    inst = client.get("/api/v1/instruments/grit_s", headers=researcher).json()
    assert "permission_not_requested" in inst["licensing_warnings"]


def test_csv_import_with_review_queue(client: TestClient, researcher: dict[str, str], battery: dict[str, Any]) -> None:
    items = [it["item_id"] for it in _bscs()["items"]]
    header = ["PID", *[f"Q{i + 1}" for i in range(len(items))]]
    good = [battery["pid"], *["4"] * len(items)]
    bad_pid = ["ZZZZZZ", *["2"] * len(items)]
    out_of_range = [battery["pid"], "7", *["2"] * (len(items) - 1)]
    csv_text = "\n".join(",".join(row) for row in (header, good, bad_pid, out_of_range))
    spec = {
        "study_id": STUDY,
        "instrument_id": "bscs",
        "language": "hi-IN",
        "occasion_id": "T3",
        "block": "X",
        "column_mapping": {"pid": "PID", **{f"item:{item}": f"Q{i + 1}" for i, item in enumerate(items)}},
    }
    r = client.post(
        "/api/v1/assessment-responses/imports",
        headers=researcher,
        files={"file": ("legacy.csv", io.BytesIO(csv_text.encode()), "text/csv")},
        data={"spec": json.dumps(spec)},
    )
    assert r.status_code == 201, r.text
    staged = r.json()
    assert staged["counts"] == {"ready": 1, "needs_review": 2, "rows": 3}
    import_id = staged["import_id"]
    review = client.get(
        f"/api/v1/assessment-responses/imports/{import_id}/rows",
        headers=researcher,
        params={"status_filter": "needs_review"},
    ).json()
    codes = {row["row_number"]: {i["code"] for i in row["issues"]} for row in review}
    assert "invalid_pid" in codes[2]
    assert {"response_out_of_range", "duplicate_pid_in_file"} <= codes[3]
    blocked = client.post(f"/api/v1/assessment-responses/imports/{import_id}/commit", headers=researcher)
    assert blocked.status_code == 409 and blocked.json()["detail"]["code"] == "review_pending"
    for row_number in (2, 3):
        res = client.post(
            f"/api/v1/assessment-responses/imports/{import_id}/rows/{row_number}/resolve",
            headers=researcher,
            json={"action": "reject", "note": "cannot reconcile"},
        )
        assert res.status_code == 200
    committed = client.post(f"/api/v1/assessment-responses/imports/{import_id}/commit", headers=researcher)
    assert committed.status_code == 200, committed.text
    assert committed.json()["status"] == "committed" and committed.json()["counts"]["committed"] == 1
    scores = client.get(
        "/api/v1/assessment-responses/scores", headers=researcher, params={"study_id": STUDY, "occasion_id": "T3"}
    ).json()
    total = next(s for s in scores if s["scale_id"] == "total")
    reverse = sum(1 for it in _bscs()["items"] if it["reverse_keyed"])
    assert total["score"] == pytest.approx((4 * (len(items) - reverse) + 2 * reverse) / len(items))
    responses = client.get(
        "/api/v1/assessment-responses",
        headers=researcher,
        params={"pid": battery["pid"], "study_id": STUDY, "occasion_id": "T3", "instrument_id": "bscs"},
    ).json()
    assert {r["source"] for r in responses} == {"import_csv"}


def test_xlsx_import(client: TestClient, researcher: dict[str, str], battery: dict[str, Any]) -> None:
    from openpyxl import Workbook  # type: ignore[import-untyped]  # noqa: PLC0415

    items = [it["item_id"] for it in _bscs()["items"]]
    wb = Workbook()
    ws = wb.active
    ws.append(["Participant", *items])
    ws.append([battery["pid"], *[3] * len(items)])
    buf = io.BytesIO()
    wb.save(buf)
    spec = {
        "study_id": STUDY,
        "instrument_id": "bscs",
        "language": "hi-IN",
        "occasion_id": "T4",
        "block": "X",
        "column_mapping": {"pid": "Participant", **{f"item:{i}": i for i in items}},
    }
    r = client.post(
        "/api/v1/assessment-responses/imports",
        headers=researcher,
        files={
            "file": (
                "odk-export.xlsx",
                io.BytesIO(buf.getvalue()),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
        data={"spec": json.dumps(spec)},
    )
    assert r.status_code == 201, r.text
    assert r.json()["file_format"] == "xlsx" and r.json()["counts"]["ready"] == 1
    done = client.post(f"/api/v1/assessment-responses/imports/{r.json()['import_id']}/commit", headers=researcher)
    assert done.status_code == 200 and done.json()["counts"]["committed"] == 1


def _approve_language(client: TestClient, admin: dict[str, str], instrument_id: str) -> None:
    r = client.post(
        f"/api/v1/instruments/{instrument_id}/versions/1.0.0/languages/hi-IN",
        headers=admin,
        json={"itc_state": "approved", "approvers": ["pi-a", "ethics-b"]},
    )
    assert r.status_code == 200, r.text


def _current(client: TestClient, researcher: dict[str, str], pid: str, instrument_id: str) -> dict[str, Any]:
    scores = client.get(
        "/api/v1/assessment-responses/scores", headers=researcher, params={"study_id": STUDY, "pid": pid}
    ).json()
    return {s["scale_id"]: s for s in scores if s["instrument_id"] == instrument_id and s["is_current"]}


def test_attention_correction_rescores_the_whole_occasion(
    client: TestClient, admin: dict[str, str], researcher: dict[str, str], battery: dict[str, Any]
) -> None:
    pid = battery["pid"]
    _approve_language(client, admin, "attention_checks")
    attention = _administration(pid, {}, instrument_id="attention_checks")
    attention["responses"] = [
        {"item_id": "attention_checks.i01", "raw_response": 2.0, "expected_response": 4.0},
        {"item_id": "attention_checks.i02", "raw_response": 3.0, "expected_response": 3.0},
        {"item_id": "attention_checks.i03", "raw_response": 1.0, "expected_response": 1.0},
    ]
    r = client.post("/api/v1/assessment-responses", headers=researcher, json=attention)
    assert r.status_code == 201, r.text
    assert {s["scale_id"]: s["score"] for s in r.json()["scores"]}["failed_count"] == 1.0
    items = [it["item_id"] for it in _bscs()["items"]]
    client.post(
        "/api/v1/assessment-responses", headers=researcher, json=_administration(pid, dict.fromkeys(items, 3.0))
    )
    assert "criterion_careless" in _current(client, researcher, pid, "bscs")["total"]["flags"]
    failed = next(x for x in r.json()["responses"] if x["item_id"] == "attention_checks.i01")
    assert failed["attention_check_failed"] is True
    fixed = client.post(
        f"/api/v1/assessment-responses/{failed['response_id']}/correct",
        headers=researcher,
        json={"raw_response": 4.0, "reason": "entered the wrong tile"},
    )
    assert fixed.status_code == 200, fixed.text
    # The stored key re-evaluates the corrected answer, and every scale of the occasion is rescored.
    assert _current(client, researcher, pid, "attention_checks")["failed_count"]["score"] == 0.0
    assert "criterion_careless" not in _current(client, researcher, pid, "bscs")["total"]["flags"]


def test_performance_task_scored_by_the_engine(
    client: TestClient, admin: dict[str, str], researcher: dict[str, str], battery: dict[str, Any]
) -> None:
    pid = battery["pid"]
    _approve_language(client, admin, "tol_board")
    min_moves = [2, 2, 3, 3, 4, 4, 5, 5]
    responses: list[dict[str, Any]] = []
    for n, mm in enumerate(min_moves, start=1):
        item = f"tol_board.p{n}"
        responses += [
            {"item_id": f"{item}.moves", "raw_response": float(mm + (n % 2)), "expected_response": float(mm)},
            {"item_id": f"{item}.initial_thinking_time_s", "raw_response": float(n)},
            {"item_id": f"{item}.solved_within_limit", "raw_response": 1.0 if n < 8 else 0.0},
        ]
    body = _administration(pid, {}, instrument_id="tol_board", block="performance")
    body["responses"] = responses
    r = client.post("/api/v1/assessment-responses", headers=researcher, json=body)
    assert r.status_code == 201, r.text
    scores = {s["scale_id"]: s for s in r.json()["scores"]}
    assert scores["excess_moves"]["score"] == pytest.approx(4.0)  # odd problems took one extra move
    assert scores["initial_thinking_time"]["score"] == pytest.approx(4.5)  # mean of 1..8 s
    assert scores["solved_within_limit"]["score"] == pytest.approx(7.0)
    assert scores["excess_moves"]["algorithm_version"].startswith("shriii_scoring-")
    # A plain item id or a .moves measure without its minimum is refused for performance tasks.
    bad = dict(body, occasion_id="T2", responses=[{"item_id": "tol_board.p1", "raw_response": 3.0}])
    assert client.post("/api/v1/assessment-responses", headers=researcher, json=bad).json()["detail"]["code"] == (
        "performance_measure_required"
    )
    bad["responses"] = [{"item_id": "tol_board.p1.moves", "raw_response": 3.0}]
    assert client.post("/api/v1/assessment-responses", headers=researcher, json=bad).json()["detail"]["code"] == (
        "performance_key_required"
    )
