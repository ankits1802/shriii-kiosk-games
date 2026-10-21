"""Tests for cicd/plan-lint (PLT-08 acceptance: green on the plan, a cycle makes it fail)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import plan_lint as pl
import pytest

EN = "\u2013"  # the plan writes month ranges with en dashes
MILESTONES = f"Milestones are defined in §8: M0 P5{EN}P7, M1 P6{EN}P9, M2 P6-P10, M3 P8{EN}P11, PG post-grant.\n\n"


def make_plan(*headers: str, appendix: str = "") -> str:
    return "# Plan\n\n" + MILESTONES + "\n".join(f"#### {h}\nBody text.\n" for h in headers) + appendix


def codes(text: str, **kw: bool) -> list[str]:
    return [f.code for f in pl.lint(pl.parse_plan_markdown(text), **kw)]


GOOD = make_plan(
    "AAA-01 · Root — P0 · M0 · deps: — · src: x",
    "AAA-02 · Child — P0 · M1 · deps: AAA-01 · src: y",
    "BBB-01 · Later — P1 · M3 · deps: AAA-01, AAA-02 · src: z",
    "BBB-02 · Post grant — P2 · PG · deps: BBB-01 · src: z",
)


def test_real_plan_is_green() -> None:
    plan = pl.load_plan(pl.DEFAULT_PLAN)
    findings = pl.lint(plan)
    assert findings == [], [f.render() for f in findings]
    assert len(plan.features) == 145
    order = [f.id for f in pl.topological_order(plan)]
    assert len(order) == len(set(order)) == 145
    pos = {fid: i for i, fid in enumerate(order)}
    for f in plan.features:
        for d in f.deps:
            assert pos[d] < pos[f.id], (d, f.id)


def test_real_plan_milestones_are_parsed_from_the_document() -> None:
    starts = pl.parse_milestones(pl.DEFAULT_PLAN.read_text(encoding="utf-8"))
    assert starts["M0"] == 5 and starts["M1"] == 6 and starts["M3"] == 8 and starts["M6"] == 20
    assert math.isinf(starts["PG"])


def test_good_plan_passes_and_orders() -> None:
    plan = pl.parse_plan_markdown(GOOD)
    assert pl.lint(plan) == []
    assert [f.id for f in pl.topological_order(plan)] == ["AAA-01", "AAA-02", "BBB-01", "BBB-02"]
    assert plan.by_id()["BBB-01"].deps == ("AAA-01", "AAA-02")
    assert plan.by_id()["AAA-01"].deps == ()


def test_introducing_a_cycle_fails() -> None:
    text = make_plan(
        "AAA-01 · A — P0 · M0 · deps: AAA-03 · src: x",
        "AAA-02 · B — P0 · M0 · deps: AAA-01 · src: x",
        "AAA-03 · C — P0 · M0 · deps: AAA-02 · src: x",
        "AAA-04 · Outside — P0 · M0 · deps: AAA-03 · src: x",
    )
    findings = pl.lint(pl.parse_plan_markdown(text))
    assert [f.code for f in findings] == ["cycle"]
    assert "AAA-01 -> AAA-03 -> AAA-02 -> AAA-01" in findings[0].message
    with pytest.raises(ValueError, match="cycle"):
        pl.topological_order(pl.parse_plan_markdown(text))


def test_self_dependency_is_a_cycle() -> None:
    assert codes(make_plan("AAA-01 · A — P0 · M0 · deps: AAA-01 · src: x")) == ["cycle"]


def test_unknown_dependency() -> None:
    assert codes(make_plan("AAA-01 · A — P0 · M0 · deps: ZZZ-99 · src: x")) == ["unknown-dep"]


def test_later_milestone_dependency() -> None:
    text = make_plan(
        "AAA-01 · A — P0 · M3 · deps: — · src: x",
        "AAA-02 · B — P0 · M1 · deps: AAA-01 · src: x",
    )
    assert codes(text) == ["later-milestone-dep"]


def test_overlapping_milestones_with_equal_start_are_allowed() -> None:
    # M1 and M2 both start in P6, so an M1 feature may depend on an M2 feature.
    text = make_plan(
        "AAA-01 · A — P0 · M2 · deps: — · src: x",
        "AAA-02 · B — P0 · M1 · deps: AAA-01 · src: x",
    )
    assert codes(text) == []


def test_dependency_on_post_grant_is_later() -> None:
    text = make_plan(
        "AAA-01 · A — P0 · PG · deps: — · src: x",
        "AAA-02 · B — P0 · M3 · deps: AAA-01 · src: x",
    )
    assert codes(text) == ["later-milestone-dep"]


@pytest.mark.parametrize(
    ("feature_p", "dep_p", "fails"),
    [("P0", "P1", True), ("P1", "P2", True), ("P2", "PG", True), ("P1", "P0", False), ("P2", "P2", False)],
)
def test_lower_priority_dependency(feature_p: str, dep_p: str, fails: bool) -> None:
    text = make_plan(
        f"AAA-01 · A — {dep_p} · M0 · deps: — · src: x",
        f"AAA-02 · B — {feature_p} · M0 · deps: AAA-01 · src: x",
    )
    assert codes(text) == (["lower-priority-dep"] if fails else [])


def test_duplicate_ids_and_malformed_headers() -> None:
    text = make_plan(
        "AAA-01 · A — P0 · M0 · deps: — · src: x",
        "AAA-01 · A again — P0 · M0 · deps: — · src: x",
        "AAA-02 · Missing priority · M0 · deps: — · src: x",
    )
    assert sorted(codes(text)) == ["duplicate-id", "malformed-header"]


def test_suffixed_ids_and_headers_in_code_fences() -> None:
    text = (
        make_plan(
            "PRV-06a · Minimal erasure — P0 · M0 · deps: — · src: x",
            "PRV-06 · Full erasure — P1 · M3 · deps: PRV-06a · src: x",
        )
        + "```\n#### NOT-01 · inside a fence — P0 · M0 · deps: XXX-01\n```\n"
    )
    plan = pl.parse_plan_markdown(text)
    assert [f.id for f in plan.features] == ["PRV-06a", "PRV-06"]
    assert pl.lint(plan) == []


def test_unknown_milestone() -> None:
    assert codes(make_plan("AAA-01 · A — P0 · M9 · deps: — · src: x")) == ["unknown-milestone"]


def test_missing_milestone_definition_is_an_error() -> None:
    with pytest.raises(ValueError, match="Milestones are defined"):
        pl.parse_plan_markdown("#### AAA-01 · A — P0 · M0 · deps: — · src: x\n")


def test_appendix_counts_are_checked() -> None:
    appendix = (
        "\n## Appendix A: feature counts\n\n| Area | P0 | P1 | P2 | PG | Total |\n|---|---|---|---|---|---|\n"
        "| AAA | 2 | 0 | 0 | 0 | 2 |\n| BBB | 0 | 1 | 1 | 0 | 2 |\n"
        "| **Total** | **2** | **1** | **1** | **0** | **4** |\n\n"
        "By milestone: M0 1, M1 1, M3 1, PG 1.\n\n## Appendix B\n"
    )
    good = GOOD + appendix
    assert codes(good) == []
    wrong = good.replace("| AAA | 2 | 0 | 0 | 0 | 2 |", "| AAA | 3 | 0 | 0 | 0 | 3 |").replace("M3 1", "M3 2")
    assert codes(wrong).count("appendix-counts") == 3
    assert codes(wrong, check_appendix=False) == []


def test_render_counts_round_trips_through_the_appendix_parser() -> None:
    plan = pl.load_plan(pl.DEFAULT_PLAN)
    table = pl.render_counts(plan.features)
    reparsed = pl.parse_appendix(["## Appendix A: feature counts", *table.splitlines()])
    assert reparsed is not None and plan.appendix is not None
    assert reparsed.by_area == plan.appendix.by_area
    assert reparsed.by_milestone == plan.appendix.by_milestone


def test_features_yaml_mirror(tmp_path: Path) -> None:
    pytest.importorskip("yaml")
    mirror = tmp_path / "features.yaml"
    mirror.write_text(
        "features:\n"
        "  - {id: AAA-01, title: A, priority: P0, milestone: M0, deps: []}\n"
        "  - {id: AAA-02, title: B, priority: P0, milestone: M0, deps: [AAA-03]}\n",
        encoding="utf-8",
    )
    plan_md = tmp_path / "plan.md"
    plan_md.write_text(MILESTONES, encoding="utf-8")
    plan = pl.load_plan(plan_md, mirror)
    assert [f.code for f in pl.lint(plan)] == ["unknown-dep"]


def test_cli_exit_codes_and_json(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    ok = tmp_path / "ok.md"
    ok.write_text(GOOD, encoding="utf-8")
    assert pl.main(["--plan", str(ok), "--order", "--counts"]) == 0
    out = capsys.readouterr().out
    assert "plan-lint: OK - 4 features" in out and "## M3" in out and "| **Total** |" in out

    bad = tmp_path / "bad.md"
    bad.write_text(make_plan("AAA-01 · A — P0 · M0 · deps: AAA-01 · src: x"), encoding="utf-8")
    assert pl.main(["--plan", str(bad), "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False and payload["findings"][0]["code"] == "cycle" and payload["order"] == []

    assert pl.main(["--plan", str(tmp_path / "missing.md")]) == 2
