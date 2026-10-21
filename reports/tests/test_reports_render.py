"""Report renderer: fixtures for every kind, ValidationResult compatibility, integrity rules and CLI."""

from __future__ import annotations

import copy
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from pydantic import ValidationError
from shriii_reports import REPORT_KINDS, ReportBundle, load_registry, prepare_context, render_report, write_report
from shriii_reports.cli import main
from shriii_reports.model import ResultEntry
from shriii_reports.prepare import Registry
from shriii_reports.render import REPORT_SPECS
from shriii_validation.reliability import icc
from shriii_validation.results import EvidenceResult
from shriii_validation.validity import correlation

FIXTURES = Path(__file__).resolve().parent / "fixtures"
ROOT = Path(__file__).resolve().parents[2]
HYP = ROOT / "scoring" / "hypotheses.yaml"
GATES = ROOT / "scoring" / "gates.yaml"


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def raw_fixture(kind: str) -> dict[str, Any]:
    """Fixture JSON with provenance hashes refreshed to the current scoring files."""
    data: dict[str, Any] = json.loads((FIXTURES / f"{kind}.json").read_text(encoding="utf-8"))
    data["provenance"]["hypotheses_sha256"] = _sha(HYP)
    data["provenance"]["gates_sha256"] = _sha(GATES)
    return data


def bundle_of(data: dict[str, Any]) -> ReportBundle:
    return ReportBundle.model_validate(data)


@pytest.fixture(scope="module")
def registry() -> Registry:
    return load_registry(HYP, GATES)


def _result(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "section": "convergent",
        "subject": "self_control",
        "metric": "observed_r",
        "evidence": {
            "analysis": "correlation",
            "estimate": 0.2,
            "ci_low": 0.15,
            "ci_high": 0.25,
            "ci_level": 0.95,
            "n": 500,
            "method": "pearson",
        },
    }
    base.update(kw)
    return base


# ----------------------------------------------------------------------------- fixtures render in every format


@pytest.mark.parametrize("kind", REPORT_KINDS)
@pytest.mark.parametrize("fmt", ["md", "html", "qmd"])
def test_every_fixture_renders_in_every_format(kind: str, fmt: str, registry: Registry) -> None:
    data = raw_fixture(kind)
    bundle = bundle_of(data)
    out = render_report(bundle, fmt, registry)
    assert bundle.report.title in out
    assert bundle.provenance.analysis_run_id in out
    assert bundle.provenance.snapshot_sha256 in out
    assert "REVIEW REQUIRED" in out or "Review required" in out
    assert "object at 0x" not in out
    ctx = prepare_context(bundle, registry, section_order=REPORT_SPECS[kind]["sections"])
    assert ctx["bundle_sha256"] in out
    assert ctx["integrity_warnings"] == []
    assert ctx["classification_warnings"] == []
    # every result's N appears (as a table cell) unless the bundle is empty
    for r in ctx["results"]:
        if r["section"] in {s["key"] for s in ctx["sections"]}:
            assert str(r["n"]) in out
    if fmt == "html":
        assert out.startswith("<!doctype html>") and out.rstrip().endswith("</html>")
    if fmt == "qmd":
        assert out.startswith("---\ntitle:")
        assert "format:\n  html:" in out
        assert "::: {.callout-" in out
    if fmt == "md":
        assert ":::" not in out


@pytest.mark.parametrize("kind", REPORT_KINDS)
def test_rendering_is_deterministic(kind: str, registry: Registry) -> None:
    b = bundle_of(raw_fixture(kind))
    for fmt in ("md", "html", "qmd"):
        assert render_report(b, fmt, registry) == render_report(b, fmt, registry)


def test_stage2_tables_show_n_ci_exclusions_and_provenance(registry: Registry) -> None:
    b = bundle_of(raw_fixture("stage2_pilot"))
    md = render_report(b, "md", registry)
    assert "| 1402 | 1371 | 9 | 1310 |" in md
    assert "session_quality_exclude" in md and "2.9%" in md
    assert "95% [" in md
    assert "Confirmatory (registered primary family)" in md
    assert "Secondary (registered, corrected within family)" in md
    assert "Unregistered: descriptive or exploratory" in md
    # confirmatory section precedes exploratory within the convergent section
    conv = md[md.index("### Convergent validity") :]
    assert conv.index("Confirmatory") < conv.index("Unregistered")
    assert "Erasures applied before snapshot | 3" in md
    for sha in b.provenance.dictionary_sha256.values():
        assert sha in md


# ----------------------------------------------------------------------------- compatibility with shriii_validation


def test_live_evidence_results_round_trip_through_the_model(registry: Registry) -> None:
    rng = np.random.default_rng(1)
    t1 = rng.standard_normal(80)
    data = np.column_stack([t1, 0.7 * t1 + 0.7 * rng.standard_normal(80)])
    results = [
        icc(data, "ICC_A1"),
        correlation(rng.standard_normal(200), rng.standard_normal(200)),
        icc(data[:2], "ICC_A1"),  # insufficient: n < 3
        EvidenceResult.unavailable("cnorm", "cNORM", "R backend not available"),
    ]
    for res in results:
        entry = ResultEntry.model_validate(
            {"section": "retest", "subject": "x", "metric": res.analysis, "evidence": res.to_dict()}
        )
        assert entry.evidence.n == res.n
        assert entry.evidence.status == res.status
        assert entry.evidence.estimate == res.estimate
        if res.provenance is not None:
            assert entry.evidence.provenance is not None
            assert entry.evidence.provenance.inputs_sha256 == res.provenance.inputs_sha256


def test_nan_estimates_are_never_shown() -> None:
    d = EvidenceResult("r", float("nan"), None, None, None, 10, "pearson").to_dict()
    entry = ResultEntry.model_validate({"section": "convergent", "subject": "x", "metric": "r", "evidence": d})
    assert entry.evidence.estimate is None
    entry2 = ResultEntry.model_validate(
        {"section": "convergent", "subject": "x", "metric": "r", "evidence": {**d, "estimate": "nan"}}
    )
    assert entry2.evidence.estimate is None
    assert not math.isnan(float(entry.evidence.n))


def test_flat_statistical_result_rows_are_lifted() -> None:
    e = ResultEntry.model_validate(
        {
            "section": "dif",
            "subject": "item",
            "metric": "delta_r2",
            "estimate": 0.04,
            "ci_low": None,
            "ci_high": None,
            "n": 900,
            "method": "lr",
            "exploratory": False,
            "hypothesis_id": "h1.self_control",
        }
    )
    assert e.evidence.estimate == 0.04
    assert e.evidence.n == 900
    assert e.confirmatory is True


def test_model_rejects_unknown_fields_and_bad_sample() -> None:
    data = raw_fixture("stage2_pilot")
    bad = copy.deepcopy(data)
    bad["results"][0]["unexpected"] = 1
    with pytest.raises(ValidationError):
        bundle_of(bad)
    bad = copy.deepcopy(data)
    bad["sample"]["analysed"] = bad["sample"]["enrolled"] + 1
    with pytest.raises(ValidationError):
        bundle_of(bad)
    bad = copy.deepcopy(data)
    bad["report"]["kind"] = "stage9"
    with pytest.raises(ValidationError):
        bundle_of(bad)


# ----------------------------------------------------------------------------- integrity rules


def _bundle_with(results: list[dict[str, Any]], **report: Any) -> ReportBundle:
    data = raw_fixture("stage2_pilot")
    data["results"] = results
    data["report"].update(report)
    return bundle_of(data)


def test_unregistered_confirmatory_claims_are_demoted(registry: Registry) -> None:
    b = _bundle_with(
        [
            _result(result_id="a", hypothesis_id="h1.not_in_registry", confirmatory=True),
            _result(result_id="b", hypothesis_id="h2.self_control.conscientiousness", confirmatory=True),
            _result(result_id="c", confirmatory=True),
            _result(result_id="d", hypothesis_id="h1.self_control", family="secondary"),
            _result(result_id="e", hypothesis_id="h3.decisiveness.rational"),
        ]
    )
    ctx = prepare_context(b, registry)
    tiers = {r["id"]: r["tier"] for r in ctx["results"]}
    assert tiers == {"a": "exploratory", "b": "secondary", "c": "exploratory", "d": "confirmatory", "e": "exploratory"}
    joined = " ".join(ctx["classification_warnings"])
    assert "not in the registry" in joined
    assert "demoted" in joined
    assert "without a hypothesis_id" in joined
    assert "differs from registry family" in joined
    md = render_report(b, "md", registry)
    assert "Result classification changed during rendering" in md


def test_without_registry_only_explicit_flags_count() -> None:
    b = _bundle_with(
        [
            _result(result_id="a", hypothesis_id="h1.self_control", confirmatory=True),
            _result(result_id="b", hypothesis_id="h1.self_control"),
        ]
    )
    ctx = prepare_context(b, Registry())
    assert {r["id"]: r["tier"] for r in ctx["results"]} == {"a": "confirmatory", "b": "exploratory"}
    # no gates -> no suppression threshold, but rendering still works
    assert "Stage 2" in render_report(b, "md", Registry())


def test_small_subgroup_cells_are_suppressed(registry: Registry) -> None:
    min_n = registry.min_cell_n
    assert min_n is not None
    ev = {
        "analysis": "r",
        "estimate": 0.4321,
        "ci_low": 0.11,
        "ci_high": 0.66,
        "ci_level": 0.95,
        "n": min_n - 1,
        "method": "pearson",
    }
    b = _bundle_with(
        [
            _result(result_id="small", subgroup={"literacy": "not_at_all"}, evidence=ev),
            _result(result_id="whole", evidence={**ev, "estimate": 0.1234}),
        ]
    )
    md = render_report(b, "md", registry)
    assert "0.432" not in md
    assert f"suppressed (n < {min_n})" in md
    assert "0.123" in md  # an all-sample result with the same n is not a subgroup cell


def test_unavailable_results_never_show_numbers(registry: Registry) -> None:
    ev = {
        "analysis": "r",
        "estimate": None,
        "ci_low": None,
        "ci_high": None,
        "ci_level": None,
        "n": 12,
        "method": "pearson",
        "status": "insufficient",
        "warnings": ["need >= 30 pairs"],
    }
    b = _bundle_with([_result(result_id="x", evidence=ev, passed=True)])
    ctx = prepare_context(b, registry)
    assert ctx["results"][0]["passed"] is None
    md = render_report(b, "md", registry)
    assert "not available (insufficient): need >= 30 pairs" in md
    assert "| pass |" not in md


def test_hash_mismatch_and_missing_prereg_are_reported(registry: Registry) -> None:
    data = raw_fixture("stage3_retest")
    data["provenance"]["hypotheses_sha256"] = "0" * 64
    data["provenance"]["gates_sha256"] = "1" * 64
    data["provenance"]["prereg_id"] = None
    ctx = prepare_context(bundle_of(data), registry)
    text = " ".join(ctx["integrity_warnings"])
    assert "hypotheses.yaml" in text and "gates.yaml" in text and "prereg_id" in text
    md = render_report(bundle_of(data), "html", registry)
    assert "Provenance / registration check" in md


def test_stage2_final_decisions_are_flagged(registry: Registry) -> None:
    data = raw_fixture("stage2_pilot")
    data["indicator_decisions"].append({"indicator_id": "x.y", "pathway": "B", "decision": "drop"})
    ctx = prepare_context(bundle_of(data), registry)
    assert any("provisional flags only" in w for w in ctx["integrity_warnings"])


def test_differential_exclusion_uses_the_gates_limit(registry: Registry) -> None:
    ctx = prepare_context(bundle_of(raw_fixture("stage2_pilot")), registry)
    rows = {r["grouping"]: r for r in ctx["differential_exclusion"]}
    limit = registry.gates["battery_gate"]["differential_exclusion_max_pp"] if registry.gates else None
    assert rows["age_band"]["limit_pp"] == f"{float(limit):g}"
    assert rows["age_band"]["within"] == "no"
    assert rows["literacy"]["within"] == "yes"


def test_html_output_is_escaped(registry: Registry) -> None:
    b = _bundle_with([_result(result_id="x", subject="<img src=x onerror=alert(1)>")], title="<b>T</b>")
    html = render_report(b, "html", registry)
    assert "<img src=x" not in html
    assert "&lt;img" in html
    assert "<b>T</b>" not in html
    md = render_report(_bundle_with([_result(result_id="x", subject="a|b")]), "md", registry)
    assert "a\\|b" in md


def test_missing_sections_are_listed(registry: Registry) -> None:
    b = _bundle_with([_result(result_id="x")])
    md = render_report(b, "md", registry)
    assert "Analyses not in this bundle" in md
    assert "Test-retest" not in md  # stage2 template does not expect retest


def test_unknown_section_still_renders(registry: Registry) -> None:
    b = _bundle_with([_result(result_id="x", section="custom_analysis")])
    md = render_report(b, "md", registry)
    assert "Custom analysis" in md


# ----------------------------------------------------------------------------- CLI


def test_cli_render_validate_kinds_schema(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    src = tmp_path / "s2.json"
    src.write_text(json.dumps(raw_fixture("stage2_pilot")), encoding="utf-8")
    out = tmp_path / "out"
    rc = main(["render", str(src), "--out-dir", str(out), "--hypotheses", str(HYP), "--gates", str(GATES), "--strict"])
    assert rc == 0
    assert {p.suffix for p in out.iterdir()} == {".md", ".html", ".qmd"}
    assert main(["validate", str(src)]) == 0
    assert main(["kinds"]) == 0
    capsys.readouterr()
    assert main(["schema"]) == 0
    schema = json.loads(capsys.readouterr().out)
    assert "results" in schema["properties"]


def test_cli_strict_fails_on_integrity_warnings(tmp_path: Path) -> None:
    data = raw_fixture("stage2_pilot")
    data["results"].append(_result(result_id="claim", hypothesis_id="h9.fake", confirmatory=True))
    src = tmp_path / "bad.json"
    src.write_text(json.dumps(data), encoding="utf-8")
    out = tmp_path / "out"
    assert (
        main(["render", str(src), "--out-dir", str(out), "--hypotheses", str(HYP), "--gates", str(GATES), "--strict"])
        == 1
    )
    assert not out.exists() or not any(out.iterdir())
    assert main(["render", str(src), "--out-dir", str(out), "--hypotheses", str(HYP), "--gates", str(GATES)]) == 0


def test_cli_rejects_invalid_bundles(tmp_path: Path) -> None:
    src = tmp_path / "x.json"
    src.write_text(json.dumps({"schema": "nope"}), encoding="utf-8")
    assert main(["validate", str(src)]) == 2
    assert main(["render", str(src), "--no-registry", "--out-dir", str(tmp_path / "o")]) == 2


def test_write_report_names_files_safely(tmp_path: Path, registry: Registry) -> None:
    data = raw_fixture("stage4_fairness")
    data["report"]["study_id"] = "S4/../../evil"
    paths = write_report(bundle_of(data), tmp_path, formats=["md"], registry=registry)
    assert paths["md"].parent == tmp_path
    assert "/" not in paths["md"].name and "\\" not in paths["md"].name
