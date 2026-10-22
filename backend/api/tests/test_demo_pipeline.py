"""The end-to-end demo pipeline against PostgreSQL at a small scale (simulator, HTTP ingestion, worker processes).

Runs in every CI build (not marked slow) so the whole chain is verified per change; the nightly workflow runs
the full-size pipeline (``shriii-api demo-pipeline --preset full``).
"""

from __future__ import annotations

from typing import Any

from shriii_api.services.demo_pipeline import DemoConfig, render_summary, run_demo_pipeline

PER_LANGUAGE = 24
RETESTS = 8


def test_demo_pipeline_runs_end_to_end(settings: Any) -> None:
    config = DemoConfig.preset(
        "fast",
        participants_per_language=PER_LANGUAGE,
        retests=RETESTS,
        seed=424242,
        workers=2,
        models=("ridge",),
        n_boot=50,
    )
    summary = run_demo_pipeline(settings, config, migrate_first=False)
    assert summary["failed_jobs"] == []
    assert summary["ingestion"]["events"].get("accepted", 0) == summary["simulated"]["events"]
    assert summary["simulated"]["retest_participants"] == RETESTS
    assert summary["linkage"]["planned_missing_items"] > 0
    research = summary["research"]
    assert {r["status"] for r in research["validation_runs"].values()} == {"succeeded"}
    assert set(research["validation_runs"]) >= {
        "reliability",
        "construct_validity",
        "mtmm",
        "factor_structure",
        "measurement_invariance",
        "dif",
        "fairness",
        "incremental_validity",
    }
    snapshot = research["snapshot"]
    assert snapshot["rows"] == PER_LANGUAGE * 2 + RETESTS - snapshot["exclusions"].get("total", 0)
    assert research["model"]["status"] == "succeeded"
    # Provenance on persisted results: snapshot, dictionary, algorithm and git.
    prov = research["provenance"]
    assert prov.get("snapshot_id") == snapshot["snapshot_id"]
    assert prov.get("dictionary_sha256")
    assert prov.get("git_sha")
    # Synthetic data can never open a gate, and a closed battery gate means a thank-you screen.
    assert all(b["status"] == "closed" for b in research["gates"]["battery"])
    assert summary["operations"]["report"]["report_mode"] == "thank_you"
    assert "SHRIII demo pipeline" in render_summary(summary)
