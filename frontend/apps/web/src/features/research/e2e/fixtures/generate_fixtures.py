"""Regenerate the research e2e fixtures from the real validation engine (no database needed).

    python -m uv run python frontend/apps/web/src/features/research/e2e/fixtures/generate_fixtures.py

Writes, next to this file:
- engine-results.json: every analysis the API adapter runs, the trait/battery gate evaluation and
  model-registry training output, on simulator-shaped data (200 per language x hi-IN/ta-IN, 60 retests,
  seed 11). SYNTHETIC data; used only by the research screenshot/smoke suite's API mock.
- snapshot.parquet: the same frame with design columns, written with zstd like the backend snapshots.

It reuses the frame builder of backend/api/tests/test_validation_adapter_offline.py so the shape
matches what the API adapter receives. Takes ~15 minutes (bootstrap CIs).
"""

from __future__ import annotations

import dataclasses
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[7]
sys.path.insert(0, str(ROOT / "backend" / "api" / "tests"))

from shriii_api import content  # noqa: E402
from shriii_api.adapters import validation as adapter  # noqa: E402
from test_validation_adapter_offline import _context, _frame  # noqa: E402


def clean(v: Any) -> Any:
    if isinstance(v, float):
        return None if math.isnan(v) or math.isinf(v) else round(v, 4)
    if isinstance(v, dict):
        return {str(k): clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    if hasattr(v, "item"):
        return clean(v.item())
    return v


def main() -> None:
    frame = _frame(n_per_lang=200, n_retest=60, seed=11)
    analyses: dict[str, list[dict[str, Any]]] = {}
    for analysis in adapter.analyses():
        params: dict[str, Any] = {"n_boot": 200, "holdout_cohorts": ["holdout"]}
        if analysis in ("measurement_invariance", "dif", "fairness"):
            params["groupings"] = ["language"]
        if analysis == "incremental_validity":
            params.update(n_boot=100, outcome="crit__grit_s.total", models=["ridge", "random_forest"])
        res = adapter.run_analysis(analysis, frame, params=params, context=_context())
        rows = []
        for r in res.results:
            row = clean(dataclasses.asdict(r))
            for key in ("fold_metrics", "best_params", "pairs", "observed_pc", "threshold_pc"):
                row["details"].pop(key, None)
            prov = row.get("provenance") or {}
            row["provenance"] = {
                k: prov[k] for k in ("analysis", "algorithm_version", "inputs_sha256", "frame_sha256") if k in prov
            }
            rows.append(row)
        analyses[analysis] = rows
        print(analysis, len(rows), file=sys.stderr)

    gate_rows = [
        {
            "analysis": a,
            **{
                k: r.get(k)
                for k in (
                    "subject",
                    "subject_kind",
                    "metric",
                    "estimate",
                    "ci_low",
                    "ci_high",
                    "ci_level",
                    "n",
                    "passed",
                    "hypothesis_id",
                    "exploratory",
                    "subgroup",
                    "details",
                )
            },
        }
        for a, rows in analyses.items()
        for r in rows
    ]
    gates = content.gates()
    constructs = {c["id"]: dict(c) for c in content.dictionary_shared().data.get("constructs", [])}
    evaluation = adapter.evaluate_gates(
        gate_rows,
        gates=gates.data,
        constructs=constructs,
        hypotheses=content.hypotheses().data,
        pathway="B",
        languages=["hi-IN", "ta-IN"],
        site_modes=["supervised"],
        norms={},
        signoffs={},
        evaluate_only=True,
        gates_sha256=gates.sha256,
    )

    models: dict[str, Any] = {}
    for target, prefix in (("crit__bscs.total", "ind__self_control."), ("crit__grit_s.total", "ind__persistence.")):
        features = sorted(c for c in frame.columns if c.startswith(prefix))
        for algorithm in ("ridge", "random_forest", "xgboost", "elastic_net"):
            out = adapter.train_model(
                frame,
                features=features,
                target=target,
                algorithm=algorithm,
                params={"n_boot": 100},
                holdout_cohort="holdout",
            )
            m = clean(dataclasses.asdict(out))
            # Keep a CV sample for the scatter plus every holdout prediction (the holdout panel).
            cv = [x for x in m["predictions"] if x["split"] == "cv"][:75]
            m["predictions"] = cv + [x for x in m["predictions"] if x["split"] == "holdout"]
            m["details"].pop("fold_metrics", None)
            models[f"{target}|{algorithm}"] = m

    doc = {
        "_comment": "Validation-engine output on simulator data (200 per language x hi-IN/ta-IN, 60 retests, "
        "seed 11). SYNTHETIC: used only by the research e2e/screenshot mock; regenerate with generate_fixtures.py.",
        "engine": adapter.engine_version(),
        "analyses": analyses,
        "gate_evaluation": clean(evaluation),
        "models": models,
    }
    out = HERE / "engine-results.json"
    out.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False), "utf-8")
    # Match the repo formatter so `biome check` stays clean (it must stay under biome's 1 MiB limit).
    subprocess.run(
        ["pnpm", "exec", "biome", "format", "--write", str(out)],
        cwd=ROOT / "frontend" / "apps" / "web",
        check=True,
        shell=sys.platform == "win32",
    )

    rng = np.random.default_rng(5)
    ids = sorted(frame["research_id"].unique())

    def pick(options: list[str], p: list[float]) -> dict[str, str]:
        return {i: options[k] for i, k in zip(ids, rng.choice(len(options), size=len(ids), p=p), strict=True)}

    f = frame.copy()
    for col, opts, p in (
        ("age_band", ["18-24", "25-34", "35-49", "50+"], [0.25, 0.35, 0.25, 0.15]),
        ("literacy_band", ["low", "medium", "high"], [0.3, 0.4, 0.3]),
        ("edu_band", ["none", "primary", "secondary", "tertiary"], [0.1, 0.3, 0.4, 0.2]),
        ("gender", ["female", "male"], [0.5, 0.5]),
        ("arm_id", ["B_fixed", "A_narrative"], [0.5, 0.5]),
        ("app_version", ["0.4.0", "0.4.1"], [0.45, 0.55]),
    ):
        f[col] = f["research_id"].map(pick(opts, p))
    f["wave"], f["site_mode"], f["criterion_block"] = 1, "supervised", "X"
    design = [
        "research_id",
        "study_id",
        "occasion_id",
        "wave",
        "cohort_id",
        "arm_id",
        "criterion_block",
        "language",
        "pathway",
        "site_mode",
        "age_band",
        "literacy_band",
        "edu_band",
        "gender",
        "app_version",
        "criterion_careless",
        "holdout",
    ]
    measures = sorted(c for c in f.columns if c.startswith(("ind__", "crit__")))
    f = f[design + measures].sort_values(["research_id", "occasion_id"]).reset_index(drop=True)
    f.to_parquet(HERE / "snapshot.parquet", compression="zstd", index=False)
    print("done", f.shape, file=sys.stderr)


if __name__ == "__main__":
    main()
