"""Studies (enrollment, block randomisation, quotas, retests, prereg) and the snapshot/validation flow."""

from __future__ import annotations

from collections import Counter
from typing import Any

from fastapi.testclient import TestClient

STUDY = "s2-test"


def _study(client: TestClient, researcher: dict[str, str], code: str = "S2") -> None:
    r = client.post(
        "/api/v1/studies",
        headers=researcher,
        json={"study_id": STUDY, "code": code, "name": "pilot", "stage": "criterion_pilot"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["requires_prereg"] is (code != "S1")
    for arm in ("B_fixed", "A_narrative"):
        assert client.post(f"/api/v1/studies/{STUDY}/arms", headers=researcher, json={"arm_id": arm}).status_code == 201
    client.post(
        f"/api/v1/studies/{STUDY}/quotas", headers=researcher, json={"cell": {"language": "hi-IN"}, "target": 4}
    )
    client.post(
        f"/api/v1/studies/{STUDY}/occasions", headers=researcher, json={"occasion_id": "T1", "label": "baseline"}
    )
    client.post(
        f"/api/v1/studies/{STUDY}/occasions",
        headers=researcher,
        json={"occasion_id": "T2", "label": "retest", "sequence": 2, "offset_days_min": 14, "offset_days_max": 28},
    )


def _participant(client: TestClient, researcher: dict[str, str]) -> str:
    return str(client.post("/api/v1/participants", headers=researcher, json={"study_id": STUDY}).json()["pid"])


def test_block_randomisation_is_balanced_and_quota_warns(client: TestClient, researcher: dict[str, str]) -> None:
    _study(client, researcher)
    arms: Counter[str] = Counter()
    blocks: Counter[str] = Counter()
    warnings: list[list[str]] = []
    for _ in range(6):
        pid = _participant(client, researcher)
        r = client.post(
            f"/api/v1/studies/{STUDY}/enrollments",
            headers=researcher,
            json={"pid": pid, "cell": {"language": "hi-IN", "age_band": "25_34"}},
        )
        assert r.status_code == 201, r.text
        arms[r.json()["enrollment"]["arm_id"]] += 1
        blocks[r.json()["enrollment"]["criterion_block"]] += 1
        warnings.append(r.json()["warnings"])
    assert arms == {"B_fixed": 3, "A_narrative": 3}
    assert blocks == {"A": 2, "B": 2, "C": 2}
    assert warnings[4] == ["cell_full"] and warnings[0] == []
    quota = client.get(f"/api/v1/studies/{STUDY}/quotas", headers=researcher).json()[0]
    assert quota["enrolled"] == 6 and quota["full"] is True


def test_ineligible_and_minor_refused(client: TestClient, researcher: dict[str, str]) -> None:
    _study(client, researcher)
    pid = _participant(client, researcher)
    r = client.post(
        f"/api/v1/studies/{STUDY}/enrollments", headers=researcher, json={"pid": pid, "eligibility": {"adult": False}}
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "ineligible"


def test_retests_require_contact_opt_in_and_flag_out_of_window(client: TestClient, researcher: dict[str, str]) -> None:
    _study(client, researcher)
    with_opt_in, without = _participant(client, researcher), _participant(client, researcher)
    client.post(
        f"/api/v1/participants/{with_opt_in}/consents",
        headers=researcher,
        json={
            "kind": "contact",
            "granted": True,
            "consent_script_id": "contact.v1",
            "script_audio_sha256": "c" * 64,
            "language": "hi-IN",
            "policy_version": "1.0.0",
            "presented_at": "2026-10-01T10:00:00Z",
            "decided_at": "2026-10-01T10:00:02Z",
        },
    )
    r = client.post(
        f"/api/v1/studies/{STUDY}/retests",
        headers=researcher,
        json={"occasion_id": "T2", "anchors": {with_opt_in: "2026-10-01", without: "2026-10-01"}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert [s["pid"] for s in body["scheduled"]] == [with_opt_in]
    assert body["scheduled"][0]["window_start"] == "2026-10-15" and body["scheduled"][0]["window_end"] == "2026-10-29"
    assert body["refused"] == [{"pid": without, "reason": "no_contact_opt_in"}]
    late = client.post(
        f"/api/v1/studies/{STUDY}/retests/complete",
        headers=researcher,
        json={"pid": with_opt_in, "occasion_id": "T2", "completed_on": "2026-11-15"},
    )
    assert late.json()["status"] == "out_of_window"


def test_s2_analysis_refused_without_prereg_then_allowed(
    client: TestClient, researcher: dict[str, str], auth: Any
) -> None:
    from shriii_api.testing import drain  # noqa: PLC0415

    _study(client, researcher)
    snap = client.post(
        "/api/v1/validation/datasets", headers=researcher, json={"study_id": STUDY, "name": "empty", "spec": {}}
    ).json()
    drain()
    ready = client.get(f"/api/v1/validation/datasets/{snap['snapshot_id']}", headers=researcher).json()
    assert ready["status"] == "ready" and ready["row_count"] == 0 and ready["sha256"]
    analyst = auth("analyst", sub="an-1")
    r = client.post(
        "/api/v1/validation/runs",
        headers=analyst,
        json={"snapshot_id": snap["snapshot_id"], "analysis": "descriptives"},
    )
    assert r.status_code == 409 and r.json()["detail"]["code"] == "prereg_required"
    plan = client.post(
        f"/api/v1/studies/{STUDY}/analysis-plans", headers=researcher, json={"version": "1.0.0", "prereg_id": "osf-123"}
    )
    assert plan.status_code == 201 and len(plan.json()["hypotheses_sha256"]) == 64
    ok = client.post(
        "/api/v1/validation/runs",
        headers=analyst,
        json={"snapshot_id": snap["snapshot_id"], "analysis": "descriptives"},
    )
    assert ok.status_code == 202, ok.text
    confirmatory = client.post(
        "/api/v1/validation/runs",
        headers=analyst,
        json={
            "snapshot_id": snap["snapshot_id"],
            "analysis": "construct_validity",
            "confirmatory": True,
            "hypothesis_ids": ["h1.self_control"],
        },
    )
    assert confirmatory.status_code == 409 and confirmatory.json()["detail"]["code"] == "snapshot_not_frozen"
    client.post(f"/api/v1/validation/datasets/{snap['snapshot_id']}/freeze", headers=researcher)
    bad = client.post(
        "/api/v1/validation/runs",
        headers=analyst,
        json={
            "snapshot_id": snap["snapshot_id"],
            "analysis": "construct_validity",
            "confirmatory": True,
            "hypothesis_ids": ["h9.not_registered"],
        },
    )
    assert bad.status_code == 422
    good = client.post(
        "/api/v1/validation/runs",
        headers=analyst,
        json={
            "snapshot_id": snap["snapshot_id"],
            "analysis": "construct_validity",
            "confirmatory": True,
            "hypothesis_ids": ["h1.self_control"],
        },
    )
    assert good.status_code == 202, good.text
    fairness = client.post(
        "/api/v1/validation/runs", headers=analyst, json={"snapshot_id": snap["snapshot_id"], "analysis": "fairness"}
    ).json()
    drain()
    done = client.get(f"/api/v1/validation/runs/{ok.json()['run_id']}", headers=analyst).json()
    assert done["status"] == "succeeded" and done["engine"] and done["manifest"]["snapshot_sha256"] == ready["sha256"]
    failed = client.get(f"/api/v1/validation/runs/{fairness['run_id']}", headers=analyst).json()
    assert failed["status"] == "failed" and "shriii_validation" in (failed["error"] or "")
    # Frozen studies are locked.
    client.post(f"/api/v1/studies/{STUDY}/freeze", headers=researcher, json={"reason": "stage 2 lock"})
    locked = client.post(f"/api/v1/studies/{STUDY}/cohorts", headers=researcher, json={"cohort_id": "c", "name": "c"})
    assert locked.status_code == 409


def test_synthetic_end_to_end(client: TestClient, researcher: dict[str, str], settings: Any) -> None:
    """Simulator (or fixture fallback) -> ingestion -> linkage -> battery -> jobs -> snapshot -> analyses -> models."""
    from shriii_api.services.synthetic import ingest_synthetic  # noqa: PLC0415
    from shriii_api.testing import drain  # noqa: PLC0415

    summary = ingest_synthetic(settings, participants=6, seed=11, occasions=1)
    assert summary["participants"] == 6 and summary["sessions"] == 6
    assert summary["events"].get("accepted", 0) > 0
    assert summary["events"].get("rejected_terminal", 0) == 0, summary
    assert summary["administrations"] == 12
    assert summary["snapshot"]["status"] == "ready" and summary["snapshot"]["rows"] == 6
    assert set(summary["validation_runs"].values()) == {"succeeded"}
    snapshot_id = summary["snapshot"]["snapshot_id"]
    snap = client.get(f"/api/v1/validation/datasets/{snapshot_id}", headers=researcher).json()
    columns = set(snap["manifest"]["columns"])
    assert {"research_id", "crit__bscs.total", "crit__bfi2_xs.conscientiousness"} <= columns
    assert "pid" not in columns and snap["manifest"]["parquet_sha256"] == snap["sha256"]
    download = client.get(f"/api/v1/validation/datasets/{snapshot_id}/download", headers=researcher)
    assert download.status_code == 200 and download.content[:4] == b"PAR1"
    # Participant-grouped model evaluation (battery -> battery here; game features once indicators exist).
    model = client.post(
        "/api/v1/models",
        headers=researcher,
        json={
            "name": "bscs-from-bfi",
            "version": "0.1.0",
            "comparison": "battery_to_outcome",
            "target": "crit__bscs.total",
            "features": ["crit__bfi2_xs.conscientiousness"],
            "snapshot_id": snapshot_id,
            "params": {"n_splits": 3},
        },
    )
    assert model.status_code == 202, model.text
    leak = client.post(
        "/api/v1/models",
        headers=researcher,
        json={
            "name": "leaky",
            "version": "0.1.0",
            "comparison": "battery_to_outcome",
            "target": "crit__bscs.total",
            "features": ["crit__bscs.total"],
            "snapshot_id": snapshot_id,
        },
    )
    assert leak.status_code == 422 and leak.json()["detail"]["code"] == "target_in_features"
    drain()
    model_id = model.json()["model_id"]
    runs = client.get(f"/api/v1/models/{model_id}/training-runs", headers=researcher).json()
    assert runs[0]["status"] == "succeeded", runs
    assert runs[0]["metrics"]["grouping"].startswith("research_id")
    evals = {
        (e["split"], e["metric"])
        for e in client.get(f"/api/v1/models/{model_id}/evaluations", headers=researcher).json()
    }
    assert {("cv", "r2"), ("cv", "mae"), ("cv", "rmse")} <= evals
    preds = client.get(f"/api/v1/models/{model_id}/predictions", headers=researcher).json()
    assert len(preds) == 6 and all("pid" not in p for p in preds)
    # Matching job and table.
    job = client.post("/api/v1/validation/matching", headers=researcher, params={"study_id": "demo-s2-pilot"})
    assert job.status_code == 202
    drain()
    matched = client.get(
        "/api/v1/validation/matched-records", headers=researcher, params={"study_id": "demo-s2-pilot"}
    ).json()
    assert len(matched) == 6 and all(m["has_game"] and m["has_criterion"] for m in matched)
