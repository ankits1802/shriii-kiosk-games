"""Build the report-bundle fixtures from real ``shriii_validation`` results on seeded synthetic data.

Run from the repository root to regenerate the committed JSON fixtures:

    uv run python stats/reports/tests/fixtures/build_fixtures.py

Every ``evidence`` object is produced by ``EvidenceResult.to_dict()`` (so the fixtures exercise the exact
serialised shape), with ``computed_at`` and library versions pinned for stable files. Some rows use the
flat ``statistical_results`` form on purpose (the renderer lifts them into ``evidence``).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import yaml
from shriii_validation.fairness import disparity, tost_two_sample
from shriii_validation.reliability import cronbach_alpha, icc
from shriii_validation.results import EvidenceResult
from shriii_validation.validity import cohens_d, correlation

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
PINNED_TIME = "2026-10-21T00:00:00+00:00"


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def ev(result: EvidenceResult) -> dict[str, Any]:
    d = result.to_dict()
    if d.get("provenance"):
        d["provenance"]["computed_at"] = PINNED_TIME
        d["provenance"]["library_versions"] = {"numpy": "pinned", "scipy": "pinned"}
    return d


def provenance(run: str) -> dict[str, Any]:
    return {
        "analysis_run_id": run,
        "snapshot_id": "0193f1c2-7a00-7000-8000-000000005201",
        "snapshot_sha256": "5f" * 32,
        "generated_at": PINNED_TIME,
        "git_sha": "1b01cae",
        "image_digest": "sha256:" + "ab" * 32,
        "prereg_id": "osf.io/fixture",
        "protocol_version": "1.0.0",
        "hypotheses_sha256": _sha(ROOT / "stats" / "measurement-model" / "hypotheses.yaml"),
        "gates_sha256": _sha(ROOT / "stats" / "measurement-model" / "gates.yaml"),
        "dictionary_sha256": {
            "shared": _sha(ROOT / "stats" / "measurement-model" / "dictionary" / "shared.yaml"),
            "A": _sha(ROOT / "stats" / "measurement-model" / "dictionary" / "dictionary.A.yaml"),
            "B": _sha(ROOT / "stats" / "measurement-model" / "dictionary" / "dictionary.B.yaml"),
        },
        "validation_algorithm_version": "0.1.0",
        "scoring_run_id": "scoring-run-fixture-1",
        "erasures_applied": 3,
        "seeds": {"bootstrap": 20261021, "permutation": 7},
    }


def correlated(rng: np.random.Generator, n: int, r: float) -> tuple[np.ndarray, np.ndarray]:
    x = rng.standard_normal(n)
    y = r * x + np.sqrt(1 - r**2) * rng.standard_normal(n)
    return x, y


def items(rng: np.random.Generator, n: int, k: int, loading: float) -> np.ndarray:
    f = rng.standard_normal(n)
    return np.column_stack([loading * f + np.sqrt(1 - loading**2) * rng.standard_normal(n) for _ in range(k)])


def entry(section: str, subject: str, metric: str, result: EvidenceResult, **kw: Any) -> dict[str, Any]:
    out = {"section": section, "subject": subject, "metric": metric, "evidence": ev(result)}
    out.update(kw)
    return out


def stage2(rng: np.random.Generator) -> dict[str, Any]:
    gates = yaml.safe_load((ROOT / "stats" / "measurement-model" / "gates.yaml").read_text(encoding="utf-8"))
    r0 = 0.10
    results: list[dict[str, Any]] = []
    # descriptives: flat statistical_results row (lifted by the model)
    results.append(
        {
            "result_id": "s2-desc-1",
            "section": "descriptives",
            "subject": "self_control.nogo_commission_rate",
            "metric": "floor_ceiling_share",
            "estimate": 0.04,
            "ci_low": None,
            "ci_high": None,
            "ci_level": None,
            "n": 1310,
            "method": "share_at_bounds",
            "threshold": gates["quality"]["floor_ceiling_flag_share"],
            "threshold_rule": f"<= {gates['quality']['floor_ceiling_flag_share']}",
            "passed": True,
            "exploratory": True,
        }
    )
    a = cronbach_alpha(items(rng, 600, 6, 0.6))
    results.append(
        entry(
            "reliability",
            "decisiveness.composite",
            "cronbach_alpha",
            a,
            result_id="s2-rel-1",
            pathway="B",
            threshold=gates["trait_gate"]["reliability"]["point_min"],
            threshold_rule=">= 0.70 point and >= 0.60 lower bound",
            passed=bool(a.estimate and a.estimate >= 0.70 and a.ci_low and a.ci_low >= 0.60),
        )
    )
    results.append(
        {
            "result_id": "s2-cinv-1",
            "section": "criterion_invariance",
            "subject": "bscs.total",
            "subject_kind": "criterion",
            "metric": "delta_cfi_scalar",
            "estimate": -0.006,
            "ci_low": None,
            "ci_high": None,
            "ci_level": None,
            "n": 1310,
            "method": "multi_group_cfa_wlsmv",
            "threshold": -0.010,
            "threshold_rule": "delta CFI >= -0.010",
            "passed": True,
            "subgroup": {"grouping": "language"},
            "exploratory": True,
        }
    )
    for hid, subject, _criterion, r_true, sign in (
        ("h1.self_control", "self_control", "bscs.total", 0.22, 1),
        ("h1.decisiveness", "decisiveness", "gdms.avoidant", -0.08, -1),
        ("h1.persistence", "persistence", "grit_s.total", 0.17, 1),
    ):
        x, y = correlated(rng, 1310, r_true)
        c = correlation(x, y)
        lo, hi = c.ci_low or 0.0, c.ci_high or 0.0
        keyed_lo = lo if sign > 0 else -hi
        results.append(
            entry(
                "convergent",
                subject,
                "observed_r",
                c,
                result_id=f"s2-{hid}",
                hypothesis_id=hid,
                family="primary",
                confirmatory=True,
                subject_kind="trait",
                threshold=r0,
                threshold_rule=f"sign {'+' if sign > 0 else '-'}; keyed lower bound > {r0}",
                passed=bool(keyed_lo > r0),
            )
        )
    x, y = correlated(rng, 1310, 0.15)
    c = correlation(x, y)
    results.append(
        entry(
            "convergent",
            "self_control",
            "observed_r",
            c,
            result_id="s2-h2-sc-c",
            hypothesis_id="h2.self_control.conscientiousness",
            family="secondary",
            subject_kind="trait",
            threshold=r0,
            threshold_rule=f"lower bound > {r0}",
            passed=bool((c.ci_low or 0) > r0),
        )
    )
    x, y = correlated(rng, 1310, 0.05)
    results.append(
        entry(
            "convergent",
            "self_control.ezd_drift_nogo",
            "observed_r",
            correlation(x, y, kind="spearman"),
            result_id="s2-expl-1",
            subject_kind="indicator",
            pathway="B",
        )
    )
    # a per-language x arm cell below the disclosure minimum (suppressed when rendered)
    x, y = correlated(rng, 24, 0.2)
    results.append(
        entry(
            "convergent",
            "self_control",
            "observed_r",
            correlation(x, y),
            result_id="s2-cell-small",
            hypothesis_id="h1.self_control",
            family="primary",
            confirmatory=True,
            language="ta-IN",
            subgroup={"arm": "A_narrative", "literacy": "not_at_all"},
        )
    )
    # an analysis that could not run: shown without a number
    results.append(
        entry(
            "discriminant_pattern",
            "self_control",
            "r_contrast_cv",
            EvidenceResult.unavailable(
                "r_contrast_cv",
                "r_contrast_cv_permutation",
                "criterion block C not yet scored",
                n=0,
                status="insufficient",
            ),
            result_id="s2-hp-1",
            hypothesis_id="hp.self_control",
            family="discriminant_pattern",
        )
    )
    xb, xa = rng.normal(0.1, 1, 650), rng.normal(0.0, 1, 660)
    results.append(
        entry(
            "pathway_comparison",
            "self_control.nogo_commission_rate",
            "cohens_d",
            cohens_d(xb, xa),
            result_id="s2-bva-1",
            subgroup={"comparison": "B_fixed - A_narrative"},
        )
    )
    return {
        "schema": "shriii-report-bundle",
        "schema_version": "1.0",
        "report": {
            "kind": "stage2_pilot",
            "title": "Stage 2 pilot report (fixture)",
            "study_id": "S2",
            "stage": "S2",
            "wave": "1",
            "languages": ["hi-IN", "mr-IN", "ta-IN"],
            "pathways": ["A", "B"],
            "site_mode": "supervised",
            "data_cutoff": "2026-09-30",
            "status": "draft",
            "authors": ["Analyst (fixture)"],
            "summary": "Synthetic fixture: results are simulated and carry no scientific meaning.",
        },
        "provenance": provenance("run-s2-fixture"),
        "sample": {
            "enrolled": 1402,
            "consented": 1371,
            "analysed": 1310,
            "withdrawn": 9,
            "cells": [
                {"group": {"language": lang, "arm": arm}, "n": n, "target": 225}
                for lang, arm, n in (
                    ("hi-IN", "B_fixed", 222),
                    ("hi-IN", "A_narrative", 219),
                    ("mr-IN", "B_fixed", 220),
                    ("mr-IN", "A_narrative", 216),
                    ("ta-IN", "B_fixed", 218),
                    ("ta-IN", "A_narrative", 215),
                )
            ],
        },
        "exclusions": [
            {
                "rule_id": "session_quality_exclude",
                "description": "Sessions graded exclude by the data-quality flag engine (SCR-12).",
                "n_sessions": 41,
                "n_participants": 41,
                "by_group": {"literacy": {"easily": 0.024, "with_difficulty": 0.031, "not_at_all": 0.046}},
            },
            {
                "rule_id": "level_not_fixed_l2",
                "description": "Sessions not at L2 analysed separately (SCR-11).",
                "n_sessions": 20,
                "n_participants": 20,
                "by_group": {"age_band": {"18-29": 0.008, "30-44": 0.012, "45-59": 0.019, "60+": 0.081}},
            },
        ],
        "targets": [
            {
                "metric": "completion",
                "group": {"language": "hi-IN", "arm": "B_fixed"},
                "observed": 0.91,
                "target": 0.85,
                "n": 240,
            },
            {
                "metric": "completion",
                "group": {"language": "ta-IN", "arm": "A_narrative"},
                "observed": 0.82,
                "target": 0.85,
                "n": 262,
            },
            {
                "metric": "play_again",
                "group": {"language": "hi-IN", "arm": "B_fixed"},
                "observed": 0.77,
                "target": 0.70,
                "n": 222,
            },
        ],
        "results": results,
        "trait_gates": [
            {
                "trait": "self_control",
                "language": "hi-IN",
                "pathway": "B",
                "status": "unvalidated",
                "evaluated_status": "unvalidated",
                "rules": {
                    "B1": "missing",
                    "B2": "pass",
                    "B3": "pass",
                    "B4": "missing",
                    "B5": "missing",
                    "B6": "missing",
                },
                "reasons": ["B1 retest evidence missing (Stage 3)"],
                "capped": False,
                "evaluate_only": True,
            }
        ],
        "battery_gates": [
            {
                "language": "hi-IN",
                "pathway": "B",
                "site_mode": "supervised",
                "status": "closed",
                "rules": {"A1": "fail", "A2": "missing", "A3": "missing", "A4": "pass", "A5": "missing"},
                "reasons": ["fail closed: retest evidence missing"],
                "qualifying_languages": [],
            }
        ],
        "indicator_decisions": [
            {
                "indicator_id": "composure.pressure_slope_accuracy",
                "pathway": "B",
                "decision": "provisional",
                "provisional_flags": ["low_reliability"],
                "rationale": "Split-half below target; review at Stage 3.",
                "signers": [],
            }
        ],
        "notes": ["Fixture bundle generated by stats/reports/tests/fixtures/build_fixtures.py."],
    }


def stage3(rng: np.random.Generator) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for lang in ("hi-IN", "mr-IN", "ta-IN"):
        t1 = rng.standard_normal(100)
        t2 = 0.68 * t1 + np.sqrt(1 - 0.68**2) * rng.standard_normal(100) + 0.1
        data = np.column_stack([t1, t2])
        a1 = icc(data, "ICC_A1")
        results.append(
            entry(
                "retest",
                "self_control",
                "icc_a1",
                a1,
                result_id=f"s3-icc-{lang}",
                hypothesis_id=None,
                language=lang,
                subject_kind="trait",
                threshold=0.60,
                threshold_rule="point >= 0.60 and lower bound >= 0.40",
                passed=bool(a1.estimate and a1.estimate >= 0.60 and a1.ci_low and a1.ci_low >= 0.40),
            )
        )
        results.append(
            entry(
                "retest",
                "self_control",
                "icc_c1",
                icc(data, "ICC_C1"),
                result_id=f"s3-iccc-{lang}",
                language=lang,
                subject_kind="trait",
            )
        )
    t1 = rng.standard_normal(100)
    t2 = 0.7 * t1 + rng.standard_normal(100) * 0.7
    results.append(
        entry(
            "retest",
            "stability",
            "icc_a1",
            icc(np.column_stack([t1, t2]), "ICC_A1"),
            result_id="s3-hr-stab",
            hypothesis_id="hr.stability",
            family="retest",
            subject_kind="trait",
            threshold=0.60,
            threshold_rule="point >= 0.60 and lower bound >= 0.40",
            passed=False,
        )
    )
    results.append(
        entry(
            "practice_effects",
            "self_control.nogo_commission_rate",
            "cohens_d",
            cohens_d(rng.normal(0.2, 1, 300), rng.normal(0, 1, 300)),
            result_id="s3-pe-1",
            threshold=0.30,
            threshold_rule="|d| < 0.30 (flag otherwise)",
            passed=True,
        )
    )
    results.append(
        {
            "result_id": "s3-attr-1",
            "section": "attrition",
            "subject": "retest_completion",
            "subject_kind": "battery",
            "metric": "odds_ratio_literacy",
            "estimate": 1.42,
            "ci_low": 0.98,
            "ci_high": 2.05,
            "ci_level": 0.95,
            "n": 480,
            "method": "logistic_regression",
            "subgroup": {"predictor": "literacy not_at_all vs easily"},
            "exploratory": True,
        }
    )
    return {
        "schema": "shriii-report-bundle",
        "schema_version": "1.0",
        "report": {
            "kind": "stage3_retest",
            "title": "Stage 3 retest report (fixture)",
            "study_id": "S3",
            "stage": "S3",
            "wave": "1",
            "languages": ["hi-IN", "mr-IN", "ta-IN"],
            "pathways": ["B"],
            "site_mode": "supervised",
            "status": "draft",
        },
        "provenance": provenance("run-s3-fixture"),
        "sample": {"enrolled": 480, "consented": 480, "analysed": 300, "withdrawn": 2},
        "exclusions": [
            {
                "rule_id": "out_of_window",
                "description": "Retest outside 14-28 days (flagged; excluded from primary analysis).",
                "n_sessions": 38,
                "n_participants": 38,
            }
        ],
        "results": results,
        "indicator_decisions": [
            {
                "indicator_id": "self_control.nogo_commission_rate",
                "pathway": "B",
                "decision": "retain",
                "rationale": "ICC(A,1) meets B1 in all languages.",
                "evidence_ids": ["s3-icc-hi-IN", "s3-icc-mr-IN", "s3-icc-ta-IN"],
                "signers": ["research_lead", "ethics_officer"],
            },
            {
                "indicator_id": "stability.shift_slope",
                "pathway": "B",
                "decision": "revise",
                "rationale": "Retest below target; redesign in wave 2.",
                "signers": ["research_lead", "ethics_officer"],
            },
        ],
    }


def stage4(rng: np.random.Generator) -> dict[str, Any]:
    gates = yaml.safe_load((ROOT / "stats" / "measurement-model" / "gates.yaml").read_text(encoding="utf-8"))
    min_n = int(gates["quality"]["fairness_cell_min_n"])
    results: list[dict[str, Any]] = []
    for grouping, dcfi in (("language", -0.004), ("literacy", -0.013), ("device_familiarity", -0.007)):
        results.append(
            {
                "section": "invariance",
                "subject": "self_control.nogo_commission_rate",
                "metric": "delta_cfi_scalar",
                "estimate": dcfi,
                "ci_low": None,
                "ci_high": None,
                "ci_level": None,
                "n": 1310,
                "method": "trial_level_glmm_invariance",
                "threshold": -0.010,
                "threshold_rule": "delta CFI >= -0.010",
                "passed": dcfi >= -0.010,
                "subgroup": {"grouping": grouping},
                "exploratory": True,
            }
        )
    results.append(
        {
            "section": "dif",
            "subject": "dont_tap.trial_017",
            "subject_kind": "item",
            "metric": "nagelkerke_delta_r2",
            "estimate": 0.041,
            "ci_low": None,
            "ci_high": None,
            "ci_level": None,
            "n": 1310,
            "method": "logistic_dif_purified",
            "details": {"p_adjusted": 0.003, "class": "moderate"},
            "threshold": 0.035,
            "threshold_rule": "delta R2 < 0.035 (Jodoin-Gierl moderate)",
            "passed": False,
            "subgroup": {"grouping": "literacy"},
            "exploratory": True,
        }
    )
    flags = rng.random(1310) < np.where(rng.random(1310) < 0.5, 0.03, 0.06)
    groups = np.where(rng.random(1310) < 0.5, "easily", "not_at_all")
    results.append(
        entry(
            "differential_exclusion",
            "session_quality_exclude",
            "rate_difference_pp",
            disparity(
                flags,
                groups,
                threshold_pp=float(gates["battery_gate"]["differential_exclusion_max_pp"]),
                min_cell_n=min_n,
            ),
            subject_kind="battery",
            subgroup={"grouping": "literacy"},
        )
    )
    results.append(
        entry(
            "mode_equivalence",
            "self_control.nogo_commission_rate",
            "tost_mean_difference",
            tost_two_sample(rng.normal(0, 1, 420), rng.normal(0.05, 1, 380), bound=0.2),
            subgroup={"site_mode": "supervised vs open_public", "language": "hi-IN"},
        )
    )
    results.append(
        {
            "section": "asr",
            "subject": "asr.prompt_yes_no",
            "subject_kind": "module",
            "metric": "gender_gap_pp",
            "estimate": 3.1,
            "ci_low": 0.4,
            "ci_high": 5.8,
            "ci_level": 0.95,
            "n": 64,
            "method": "bootstrap_difference",
            "threshold": float(gates["asr_policy"]["max_group_gap_pp"]),
            "threshold_rule": "gap <= 5 pp",
            "passed": True,
            "subgroup": {"language": "mr-IN"},
            "exploratory": True,
        }
    )
    results.append(
        {
            "section": "asr",
            "subject": "asr.prompt_yes_no",
            "subject_kind": "module",
            "metric": "age_gap_pp",
            "estimate": 9.0,
            "ci_low": 1.0,
            "ci_high": 17.0,
            "ci_level": 0.95,
            "n": 18,
            "method": "bootstrap_difference",
            "subgroup": {"language": "ta-IN", "age_band": "60+"},
            "exploratory": True,
        }
    )
    return {
        "schema": "shriii-report-bundle",
        "schema_version": "1.0",
        "report": {
            "kind": "stage4_fairness",
            "title": "Stage 4 fairness report (fixture)",
            "study_id": "S4",
            "stage": "S4",
            "wave": "1",
            "languages": ["hi-IN", "mr-IN", "ta-IN"],
            "pathways": ["B"],
            "status": "internal",
        },
        "provenance": provenance("run-s4-fixture"),
        "sample": {"enrolled": 1700, "consented": 1650, "analysed": 1610},
        "exclusions": [
            {
                "rule_id": "session_quality_exclude",
                "description": "Sessions graded exclude (SCR-12).",
                "n_sessions": 40,
                "by_group": {"literacy": {"easily": 0.021, "not_at_all": 0.083}},
            }
        ],
        "results": results,
        "battery_gates": [
            {
                "language": "hi-IN",
                "pathway": "B",
                "site_mode": "open_public",
                "status": "closed",
                "rules": {"A4": "missing"},
                "reasons": ["VAL-18 mode equivalence not yet passed"],
            }
        ],
    }


def stage5(rng: np.random.Generator) -> dict[str, Any]:
    return {
        "schema": "shriii-report-bundle",
        "schema_version": "1.0",
        "report": {
            "kind": "stage5_norming",
            "title": "Stage 5 criterion validity and norming (fixture)",
            "study_id": "S5",
            "stage": "S5",
            "languages": ["hi-IN"],
            "pathways": ["B"],
            "status": "draft",
        },
        "provenance": provenance("run-s5-fixture"),
        "sample": {"enrolled": 900, "consented": 880, "analysed": 850},
        "results": [
            {
                "section": "incremental_validity",
                "subject": "supervisor_rating",
                "subject_kind": "model",
                "metric": "delta_r2_cv",
                "estimate": 0.018,
                "ci_low": 0.002,
                "ci_high": 0.034,
                "ci_level": 0.95,
                "n": 850,
                "method": "grouped_cv_ridge",
                "details": {"outer_folds": 5},
                "exploratory": True,
            },
            {
                "section": "norming",
                "subject": "self_control",
                "subject_kind": "norm",
                "metric": "kish_effective_n",
                "estimate": 712.4,
                "ci_low": None,
                "ci_high": None,
                "ci_level": None,
                "n": 850,
                "method": "raking_trimmed",
                "exploratory": True,
            },
        ],
        "norm_tables": [
            {
                "version": "0.1.0-provisional",
                "trait": "self_control",
                "language_group": "hi-IN",
                "method": "weighted_percentiles",
                "weights_scheme": "raked: age x education x gender",
                "provisional": True,
                "cells": [
                    {
                        "label": "18-29",
                        "n": 310,
                        "effective_n": 260.5,
                        "provisional": False,
                        "percentiles": {"10": -1.21, "25": -0.62, "50": 0.04, "75": 0.66, "90": 1.25},
                    },
                    {
                        "label": "60+",
                        "n": 22,
                        "effective_n": 17.0,
                        "provisional": True,
                        "percentiles": {"10": -1.4, "25": -0.8, "50": -0.1, "75": 0.5, "90": 1.1},
                    },
                ],
            }
        ],
        "trait_gates": [
            {
                "trait": "self_control",
                "language": "hi-IN",
                "pathway": "B",
                "status": "validated_banded",
                "evaluated_status": "validated_banded",
                "rules": {"B1": "pass", "B2": "pass", "B3": "pass", "B4": "pass", "B5": "pass", "B6": "pass"},
                "evaluate_only": False,
            }
        ],
    }


def technical_manual(rng: np.random.Generator) -> dict[str, Any]:
    s2 = stage2(rng)
    s3 = stage3(rng)
    return {
        "schema": "shriii-report-bundle",
        "schema_version": "1.0",
        "report": {
            "kind": "technical_manual",
            "title": "SHRIII technical manual (fixture skeleton)",
            "study_id": "SHRIII",
            "stage": "manual",
            "languages": ["hi-IN", "mr-IN", "ta-IN"],
            "pathways": ["A", "B"],
            "status": "draft",
        },
        "provenance": provenance("run-manual-fixture"),
        "sample": s2["sample"],
        "results": [r for r in s2["results"] if r["section"] in {"reliability", "convergent"}]
        + [r for r in s3["results"] if r["section"] == "retest"][:2],
        "trait_gates": s2["trait_gates"],
        "battery_gates": s2["battery_gates"],
    }


def main() -> None:
    builders = {
        "stage2_pilot": stage2,
        "stage3_retest": stage3,
        "stage4_fairness": stage4,
        "stage5_norming": stage5,
        "technical_manual": technical_manual,
    }
    for name, fn in builders.items():
        bundle = fn(np.random.default_rng(20261021))
        (HERE / f"{name}.json").write_text(json.dumps(bundle, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(f"wrote {name}.json")


if __name__ == "__main__":
    main()
