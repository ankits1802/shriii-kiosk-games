"""The end-to-end demo pipeline at a tiny scale (slow: simulator, HTTP ingestion, worker processes)."""

from __future__ import annotations

from typing import Any

import pytest


@pytest.mark.slow
def test_demo_pipeline_runs_end_to_end(settings: Any) -> None:
    from shriii_api.services.demo_pipeline import DemoConfig, render_summary, run_demo_pipeline  # noqa: PLC0415

    config = DemoConfig(
        participants_per_language=8, retests=4, seed=424242, workers=1, models=("ridge",), n_boot=50
    )
    summary = run_demo_pipeline(settings, config, migrate_first=False)
    assert summary["failed_jobs"] == []
    assert summary["ingestion"]["events"].get("accepted", 0) == summary["simulated"]["events"]
    assert summary["linkage"]["planned_missing_items"] > 0
    research = summary["research"]
    assert {r["status"] for r in research["validation_runs"].values()} == {"succeeded"}
    assert research["snapshot"]["rows"] == 8 * 2 + 4 - research["snapshot"]["exclusions"].get("total", 0)
    assert all(b["status"] == "closed" for b in research["gates"]["battery"])
    assert summary["operations"]["report"]["report_mode"] == "thank_you"
    assert "SHRIII demo pipeline" in render_summary(summary)
