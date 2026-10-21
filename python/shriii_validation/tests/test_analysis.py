"""Entry points used by the API worker: run_analysis on snapshot frames, train_model, generate_norms,
evaluate_gates. A synthetic snapshot frame with planted structure (latent traits, retest stability, one
indicator with language DIF, holdout cohort, careless responders, a group-only column) checks that each
analysis recovers what was planted and records N, CI, exclusions and provenance."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import numpy as np
import pandas as pd
import pytest
from shriii_validation import ANALYSES, evaluate_gates, generate_norms, run_analysis, train_model
from shriii_validation.analysis import AnalysisReport, ResultRecord, canonical_analysis
from shriii_validation.frame import resolve_context
from shriii_validation.modeling import MODEL_ALIASES

LANGS = ("hi-IN", "ta-IN")
DIF_INDICATOR = "self_control.nogo_commission_rate"
CONSTRUCTS = ("self_control", "risk_preference", "decisiveness", "persistence", "teamwork")


def _frame(n_per_lang: int = 300, n_retest: int = 60, seed: int = 11) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    ctx = resolve_context(None)
    inds = [i for i in ctx.indicators.values() if i.construct in CONSTRUCTS and not i.group_only]
    rows: list[dict[str, Any]] = []
    for lang in LANGS:
        for k in range(n_per_lang):
            lat = {c: float(rng.normal()) for c in CONSTRUCTS}
            lat2 = {c: 0.8 * v + 0.6 * float(rng.normal()) for c, v in lat.items()}
            base = {
                "research_id": f"{lang}-{k:04d}",
                "study_id": "s",
                "language": lang,
                "pathway": "B",
                "cohort_id": "holdout" if k % 8 == 0 else "main",
                "holdout": k % 8 == 0,
                "age_band": str(rng.choice(["18_24", "25_34"])),
                "edu_band": str(rng.choice(["primary", "secondary"])),
                "device_familiarity": str(rng.choice(["never", "daily"])),
                "criterion_careless": k % 50 == 1,
                "ind__integrity.dice_overreport_rate": float(rng.normal()),  # group-only: must be dropped
            }
            for occ, latent in (("T1", lat), ("T2", lat2)) if k < n_retest else (("T1", lat),):
                r = dict(base, occasion_id=occ)
                for i in inds:
                    v = i.sign * 0.75 * latent[i.construct] + float(rng.normal(scale=0.65))
                    if i.id == DIF_INDICATOR and lang == "ta-IN":
                        v += 0.7  # planted DIF: more commissions at equal self-control
                    r["ind__" + i.id] = v
                r["crit__bscs.total"] = 0.55 * latent["self_control"] + float(rng.normal(scale=0.8))
                r["crit__bfi2_xs.conscientiousness"] = 0.35 * latent["self_control"] + float(rng.normal())
                r["crit__bfi2_xs.extraversion"] = float(rng.normal())
                r["crit__gdms.spontaneous"] = float(rng.normal())
                r["crit__grit_s.total"] = (
                    0.45 * latent["persistence"] + 0.2 * latent["self_control"] + float(rng.normal())
                )
                r["crit__general_risk.risk_willingness"] = 0.45 * latent["risk_preference"] + float(rng.normal())
                r["crit__gdms.avoidant"] = -0.45 * latent["decisiveness"] + float(rng.normal())
                r["crit__bfi2_xs.agreeableness"] = 0.45 * latent["teamwork"] + float(rng.normal())
                rows.append(r)
    return pd.DataFrame(rows)


@pytest.fixture(scope="module")
def frame() -> pd.DataFrame:
    return _frame()


@pytest.fixture(scope="module")
def run(frame: pd.DataFrame) -> Callable[..., AnalysisReport]:
    cache: dict[str, AnalysisReport] = {}

    def go(analysis: str, **params: Any) -> AnalysisReport:
        key = f"{analysis}:{sorted(params.items())}"
        if key not in cache:
            context = {"pathway": "B", "hypothesis_ids": ["h1.self_control"], "provenance": {"snapshot_id": "snap-1"}}
            cache[key] = run_analysis(analysis, frame, params={"n_boot": 200, **params}, context=context)
        return cache[key]

    return go


def _rows(report: AnalysisReport, **match: Any) -> list[ResultRecord]:
    out = []
    for r in report.results:
        if all((r.subgroup.get(k[4:]) if k.startswith("sub_") else getattr(r, k)) == v for k, v in match.items()):
            out.append(r)
    return out


def test_analysis_names_and_aliases() -> None:
    assert canonical_analysis("validity") == "construct_validity"
    assert canonical_analysis("prediction") == "incremental_validity"
    assert set(ANALYSES) >= {"reliability", "dif", "fairness", "measurement_invariance", "incremental_validity"}
    with pytest.raises(ValueError, match="unknown analysis"):
        canonical_analysis("astrology")


def test_shared_exclusions_and_provenance(run: Callable[..., AnalysisReport]) -> None:
    rep = run("descriptives")
    assert rep.exclusions["columns_dropped"]["group_level_only"] == ["integrity.dice_overreport_rate"]
    assert rep.exclusions["by_reason"]["holdout_cohort"] > 0
    assert rep.exclusions["by_reason"]["criterion_careless_values_blanked"] > 0
    assert set(rep.exclusions["by_reason_language"]["holdout_cohort"]) == set(LANGS)
    assert not any(r.subject == "integrity.dice_overreport_rate" for r in rep.results)
    row = _rows(rep, subject="bscs.total", metric="mean", subgroup={})[0]
    assert row.n is not None and row.estimate is not None and row.ci_low is not None and row.ci_high is not None
    assert row.exclusions["rows_available"] >= row.n and row.ci_low < row.estimate < row.ci_high
    assert row.provenance["snapshot_id"] == "snap-1" and len(row.provenance["frame_sha256"]) == 64
    assert rep.provenance["algorithm_version"] and rep.provenance["library_versions"]["numpy"]


def test_reliability_retest_and_composite(run: Callable[..., AnalysisReport]) -> None:
    rep = run("reliability")
    sc = _rows(rep, subject="self_control", subject_kind="construct", metric="icc_a1")
    pooled = next(r for r in sc if not r.subgroup)
    assert pooled.n == 2 * 60 - sum(1 for k in range(60) if k % 8 == 0) * 2  # holdout pairs excluded
    assert pooled.estimate is not None and 0.55 < pooled.estimate < 0.95
    assert pooled.details["pearson_r_never_for_gates"] is not None and "practice_effect" in pooled.details
    per_lang = [r for r in sc if r.subgroup.get("language")]
    assert {r.subgroup["language"] for r in per_lang} == set(LANGS)
    # Cells below min_pairs_per_cell carry no verdict (gate rule B1).
    for r in per_lang:
        assert r.n is not None and (r.passed is None) == (r.n < 30)
    omega = _rows(rep, subject="self_control", metric="omega_total", subgroup={})
    alpha = _rows(rep, subject="self_control", metric="alpha", subgroup={})
    comp = (omega or alpha)[0]
    assert comp.estimate is not None and comp.threshold == pytest.approx(0.70)


def test_construct_validity_confirmatory_family(run: Callable[..., AnalysisReport]) -> None:
    rep = run("construct_validity")
    h = next(r for r in rep.results if r.hypothesis_id == "h1.self_control" and set(r.subgroup) == {"pathway"})
    assert not h.exploratory and h.passed is True and h.details["family"] == "primary"
    assert h.details["sign_correct"] is True and h.details["p_adjusted"] >= h.details["p"]
    pattern = next(r for r in rep.results if r.hypothesis_id == "hp.self_control" and set(r.subgroup) == {"pathway"})
    assert pattern.metric == "r_contrast_cv" and pattern.estimate is not None and pattern.estimate > 0
    # Group-level hypotheses are never computed on individuals.
    group = [r for r in rep.results if r.hypothesis_id and r.hypothesis_id.startswith("hg.")]
    assert group and all(r.estimate is None and r.details["status"] == "not_available" for r in group)
    exploratory = _rows(rep, subject_kind="indicator_criterion")
    assert exploratory and all(r.exploratory for r in exploratory)


def test_mtmm_and_structure(run: Callable[..., AnalysisReport]) -> None:
    mt = run("mtmm")
    diag = _rows(mt, metric="validity_diagonal_r", subgroup={})
    assert {r.subject for r in diag} >= {"self_control", "risk_preference"}
    st = run("factor_structure")
    pa = _rows(st, metric="parallel_analysis_n_factors")[0]
    assert pa.estimate is not None and pa.estimate >= 2
    cfa_rows = _rows(st, metric="cfa_cfi")
    assert cfa_rows and all(r.details["status"] in ("ok", "insufficient") for r in cfa_rows)


def test_measurement_invariance_by_language(run: Callable[..., AnalysisReport]) -> None:
    rep = run("measurement_invariance")
    levels = _rows(rep, metric="invariance_level", sub_grouping="language")
    assert levels and all(
        r.details["level"] in ("scalar", "partial_scalar", "metric", "configural", "none") for r in levels
    )
    crit = _rows(rep, metric="criterion_invariance")[0]
    assert crit.details["status"] == "not_available" and crit.passed is None  # fail closed


def test_dif_recovers_the_planted_indicator(run: Callable[..., AnalysisReport]) -> None:
    rep = run("dif")
    planted = _rows(rep, subject=DIF_INDICATOR, metric="dif_delta_r2")[0]
    assert planted.details["class"] in ("B", "C") and planted.details["significant_fdr"]
    assert planted.details["uniform_shift_sd"] > 0.2 and planted.details["matching"].startswith("criterion:")
    others = [r for r in _rows(rep, metric="dif_delta_r2") if r.subject != DIF_INDICATOR]
    assert sum(r.details["class"] == "C" for r in others) <= 1
    summary = _rows(rep, metric="unresolved_large_dif")[0]
    assert summary.estimate is not None


def test_fairness_tost_prediction_and_exclusions(frame: pd.DataFrame) -> None:
    context = {
        "pathway": "B",
        "snapshot_exclusions": {"by_reason_language": {"session_quality": {"hi-IN": 10, "ta-IN": 40}}},
    }
    rep = run_analysis("fairness", frame, params={"n_boot": 100}, context=context)
    tost = _rows(rep, metric="mean_difference_tost")
    assert tost and all(r.ci_level == pytest.approx(0.90) for r in tost if r.ci_level is not None)
    dif_ind = next(r for r in tost if r.subject == DIF_INDICATOR)
    assert dif_ind.passed is False  # the planted shift is not equivalent
    excl = _rows(rep, metric="differential_exclusion_pp")[0]
    assert excl.estimate is not None and excl.estimate > 5 and excl.passed is False
    assert _rows(rep, metric="slope_difference")


def test_incremental_validity_four_comparisons_and_holdout(run: Callable[..., AnalysisReport]) -> None:
    rep = run("incremental_validity", outcome="crit__grit_s.total", models=["ridge", "elastic_net"])
    keys = {r.subject for r in _rows(rep, metric="cv_r2")}
    assert keys == {"criterion_from_game", "outcome_from_battery", "outcome_from_game", "outcome_from_game_and_battery"}
    inc = _rows(rep, metric="incremental_cv_r2")[0]
    assert inc.details["primary_model"] == "ridge" and inc.ci_low is not None
    hold = _rows(rep, metric="holdout_r2")
    assert hold and all(r.subgroup["split"] == "holdout" for r in hold)
    cv = next(
        r for r in _rows(rep, metric="cv_r2") if r.subject == "criterion_from_game" and r.subgroup["model"] == "ridge"
    )
    assert cv.details["grouping"].startswith("research_id") and cv.estimate is not None and cv.estimate > 0.05


def test_incremental_validity_refuses_leakage(frame: pd.DataFrame) -> None:
    with pytest.raises(ValueError, match="leakage"):
        run_analysis(
            "incremental_validity",
            frame,
            params={"outcome": "crit__grit_s.total", "battery_features": ["crit__grit_s.total"], "models": ["ridge"]},
            context={"pathway": "B"},
        )


@pytest.mark.parametrize("analysis", ANALYSES)
def test_degenerate_and_empty_frames_do_not_crash(analysis: str) -> None:
    rng = np.random.default_rng(0)
    n = 80
    df = pd.DataFrame(
        {
            "research_id": [f"r{i}" for i in range(n)],
            "occasion_id": "T1",
            "language": ["hi-IN", "ta-IN"] * (n // 2),
            "ind__self_control.nogo_commission_rate": 0.5,  # constant
            "ind__self_control.ezd_drift_nogo": np.nan,  # empty
            "ind__risk_preference.adjusted_pumps": rng.normal(size=n),
            "crit__bscs.total": rng.normal(size=n),
        }
    )
    params = {"n_boot": 50, "models": ["ridge"]}
    if analysis == "incremental_validity":
        params["outcome"] = "crit__bscs.total"
    rep = run_analysis(analysis, df, params=params, context={"pathway": "B"})
    assert isinstance(rep.results, list)
    empty = run_analysis(
        analysis, pd.DataFrame(), params=params if analysis != "incremental_validity" else {}, context={}
    )
    assert empty.results == [] and "no analysable rows" in " ".join(empty.notes)


def test_train_model_grouped_cv_and_holdout(frame: pd.DataFrame) -> None:
    feats = ["ind__self_control.nogo_commission_rate", "ind__self_control.ezd_drift_nogo"]
    out = train_model(
        frame,
        features=feats,
        target="crit__bscs.total",
        algorithm="ridge",
        params={"n_boot": 100},
        holdout_cohort="holdout",
    )
    cv_preds = [p for p in out["predictions"] if p["split"] == "cv"]
    folds_per_participant: dict[str, set[int]] = {}
    for p in cv_preds:
        folds_per_participant.setdefault(p["research_id"], set()).add(p["fold"])
    assert all(len(f) == 1 for f in folds_per_participant.values())  # retest rows never split across folds
    hold_ids = {p["research_id"] for p in out["predictions"] if p["split"] == "holdout"}
    assert hold_ids and hold_ids.isdisjoint(folds_per_participant)
    assert out["cv_metrics"]["r2"]["mean"] > 0.05 and out["cv_metrics"]["r2"]["ci_low"] is not None
    assert set(out["holdout_metrics"]) == {"r2", "mae", "rmse"} and out["n_holdout"] > 0
    with pytest.raises(ValueError, match="leakage"):
        train_model(
            frame, features=["crit__bscs.total"], target="crit__bscs.total", algorithm="ridge", holdout_cohort=None
        )
    with pytest.raises(ValueError, match="unsupported algorithm"):
        train_model(frame, features=feats, target="crit__bscs.total", algorithm="astrology", holdout_cohort=None)


def test_train_model_small_sample() -> None:
    rng = np.random.default_rng(1)
    df = pd.DataFrame({"research_id": [f"p{i}" for i in range(6)], "x": rng.normal(size=6), "y": rng.normal(size=6)})
    out = train_model(
        df, features=["x"], target="y", algorithm="ridge", params={"n_splits": 3, "n_boot": 20}, holdout_cohort=None
    )
    assert out["details"]["model"] == "ridge" and len(out["predictions"]) == 6
    assert MODEL_ALIASES["gradient_boosting"] == "xgboost"


def test_generate_norms(frame: pd.DataFrame) -> None:
    t1 = frame[(frame["occasion_id"] == "T1") & (frame["language"] == "hi-IN")]
    ids = ["self_control.nogo_commission_rate", "self_control.ezd_drift_nogo"]
    out = generate_norms(
        t1,
        indicator_ids=ids,
        directions={"self_control.nogo_commission_rate": "higher_less", "self_control.ezd_drift_nogo": "higher_more"},
        reliability=0.75,
        quantiles=[1 / 3, 2 / 3],
        ci_level=0.90,
    )
    lo, hi = out["cut_points"]
    assert lo < 0 < hi
    assert out["sem"] == pytest.approx(out["details"]["composite_sd"] * np.sqrt(0.25))
    assert out["details"]["standardisation"]["self_control.nogo_commission_rate"]["sign"] == -1.0
    assert out["provisional"] is (out["effective_n"] < 200)
    assert out["details"]["cells_age_x_education"]
    with pytest.raises(ValueError, match="reliability"):
        generate_norms(t1, indicator_ids=ids, directions={}, reliability=1.0, quantiles=[0.5], ci_level=0.9)


def test_evaluate_gates_fails_closed_and_never_promotes(run: Callable[..., AnalysisReport]) -> None:
    ctx = resolve_context(None)
    rows = [
        r.to_dict()
        for a in ("reliability", "construct_validity", "measurement_invariance", "dif")
        for r in run(a).results
    ]
    out = evaluate_gates(
        rows, gates=ctx.gates, constructs=ctx.constructs, hypotheses=ctx.hypotheses, pathway="B", languages=list(LANGS)
    )
    by = {(d["trait"], d["language"]): d for d in out["trait_gates"]}
    sc = by[("self_control", "hi-IN")]
    assert sc["status"] in ("unvalidated", "research_only") and sc["evaluate_only"]
    assert sc["rules"]["B5"] == "missing" and sc["rules"]["B6"] == "missing"
    assert by[("emotional_regulation", "hi-IN")]["status"] == "withheld"  # permanently withheld in B
    assert all(b["status"] == "closed" for b in out["battery_gates"])
    # Full evidence with norms and sign-offs still cannot promote in evaluate-only mode.
    signed = evaluate_gates(
        rows,
        gates=ctx.gates,
        constructs=ctx.constructs,
        hypotheses=ctx.hypotheses,
        pathway="B",
        languages=list(LANGS),
        norms={("self_control", lang): "provisional" for lang in LANGS},
        signoffs={("self_control", lang): ["pi", "ethics"] for lang in LANGS},
    )
    assert all(d["status"] != "validated_banded" for d in signed["trait_gates"])


def test_identical_retest_occasions_give_no_interval_rather_than_crash() -> None:
    rng = np.random.default_rng(3)
    t1 = pd.DataFrame(
        {
            "research_id": [f"r{i}" for i in range(40)],
            "occasion_id": "T1",
            "ind__x": rng.integers(0, 3, 40).astype(float),
        }
    )
    frame = pd.concat([t1, t1.assign(occasion_id="T2")], ignore_index=True)
    rep = run_analysis("reliability", frame, params={}, context={})
    row = next(r for r in rep.results if r.subject == "x" and r.metric == "icc_a1" and not r.subgroup)
    assert row.estimate == pytest.approx(1.0) and row.ci_low is None and row.passed is None
