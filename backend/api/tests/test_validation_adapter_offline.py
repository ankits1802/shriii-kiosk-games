"""The API's validation adapter against the real engine, without a database.

The worker persists whatever these wrappers return; a field the engine renames or adds would otherwise
only surface as a failed job in the database-backed run.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import pytest
from shriii_validation.frame import resolve_context

from shriii_api import content
from shriii_api.adapters import validation as adapter
from shriii_api.services import gates as gate_svc

LANGS = ("hi-IN", "ta-IN")
CONSTRUCTS = ("self_control", "risk_preference", "decisiveness", "persistence", "teamwork")


def _frame(n_per_lang: int = 160, n_retest: int = 40, seed: int = 3) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    inds = [i for i in resolve_context(None).indicators.values() if i.construct in CONSTRUCTS and not i.group_only]
    rows: list[dict[str, Any]] = []
    for lang in LANGS:
        for k in range(n_per_lang):
            lat = {c: float(rng.normal()) for c in CONSTRUCTS}
            lat2 = {c: 0.8 * v + 0.6 * float(rng.normal()) for c, v in lat.items()}
            base: dict[str, Any] = {
                "research_id": f"{lang}-{k:04d}",
                "study_id": "s",
                "language": lang,
                "pathway": "B",
                "cohort_id": "holdout" if k % 8 == 0 else "main",
                "holdout": k % 8 == 0,
                "criterion_careless": False,
            }
            for occ, latent in (("T1", lat), ("T2", lat2)) if k < n_retest else (("T1", lat),):
                r: dict[str, Any] = {**base, "occasion_id": occ}
                for i in inds:
                    r["ind__" + i.id] = i.sign * 0.75 * latent[i.construct] + float(rng.normal(scale=0.65))
                r["crit__bscs.total"] = 0.55 * latent["self_control"] + float(rng.normal(scale=0.8))
                r["crit__grit_s.total"] = 0.45 * latent["persistence"] + float(rng.normal())
                r["crit__bfi2_xs.conscientiousness"] = 0.35 * latent["self_control"] + float(rng.normal())
                r["crit__general_risk.risk_willingness"] = 0.45 * latent["risk_preference"] + float(rng.normal())
                r["crit__gdms.avoidant"] = -0.45 * latent["decisiveness"] + float(rng.normal())
                r["crit__bfi2_xs.agreeableness"] = 0.45 * latent["teamwork"] + float(rng.normal())
                rows.append(r)
    return pd.DataFrame(rows)


@pytest.fixture(scope="module")
def frame() -> pd.DataFrame:
    return _frame()


def _context() -> dict[str, Any]:
    return {"provenance": {"snapshot_id": "offline", "git_sha": "test"}, "hypothesis_ids": []}


@pytest.mark.parametrize("analysis", adapter.analyses())
def test_every_analysis_maps_onto_result_rows(frame: pd.DataFrame, analysis: str) -> None:
    params: dict[str, Any] = {"n_boot": 50, "holdout_cohorts": ["holdout"]}
    if analysis in ("measurement_invariance", "dif", "fairness"):
        params["groupings"] = ["language"]
    if analysis == "incremental_validity":
        params.update(outcome="crit__grit_s.total", models=["ridge"])
    out = adapter.run_analysis(analysis, frame, params=params, context=_context())
    assert out.engine.startswith("shriii_validation")
    for r in out.results:
        assert r.metric and r.subject and r.method
        if r.estimate is not None and r.ci_low is not None and r.ci_high is not None:
            assert r.ci_low <= r.ci_high
    if analysis in ("reliability", "construct_validity", "dif", "incremental_validity"):
        assert out.results, f"{analysis} produced no rows on a well-formed frame"
        assert any(r.n for r in out.results)


def test_train_model_maps_onto_model_output(frame: pd.DataFrame) -> None:
    features = sorted(c for c in frame.columns if c.startswith("ind__self_control."))
    out = adapter.train_model(
        frame,
        features=features,
        target="crit__bscs.total",
        algorithm="ridge",
        params={"n_boot": 50},
        holdout_cohort="holdout",
    )
    assert out.n_train > 0
    assert out.n_holdout > 0
    assert "r2" in out.cv_metrics
    assert {p["split"] for p in out.predictions} >= {"cv", "holdout"}
    # Participant-grouped: no person is in both the training folds and the holdout.
    by_split: dict[str, set[str]] = {}
    for p in out.predictions:
        by_split.setdefault(p["split"], set()).add(p["research_id"])
    assert not by_split["cv"] & by_split["holdout"]


def test_generate_norms_maps_onto_norm_output(frame: pd.DataFrame) -> None:
    indicators = [
        ind
        for ind in content.dictionary_pathway("B").data.get("indicators", [])
        if ind["construct"] == "self_control" and ind.get("gate_eligible") and not ind.get("group_only")
    ]
    directions = {ind["id"]: str(ind.get("direction", "")) for ind in indicators}
    t1 = frame[(frame["occasion_id"] == "T1") & ~frame["holdout"] & (frame["language"] == "hi-IN")]
    out = adapter.generate_norms(
        t1,
        indicator_ids=list(directions),
        directions=directions,
        reliability=0.8,
        quantiles=[1 / 3, 2 / 3],
        ci_level=0.9,
        gates=gate_svc.gates_config(),
        trait="self_control",
        norm_table_version="offline",
    )
    assert out.provisional
    assert len(out.cut_points) == 2
    assert out.cut_points[0] <= out.cut_points[1]
    assert out.sem > 0
    assert 0 < out.effective_n <= len(t1)
