"""Tests for tools/trial-budget (SCR-03 budget sheet, ONB-08 session budget check)."""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import trial_budget as tb
import yaml

ROOT = tb.REPO_ROOT
COPY = [
    "content/games",
    "scoring/dictionary",
    "docs/IMPLEMENTATION_PLAN.md",
    "python/shriii_scoring/src/shriii_scoring/data/scoring_params.yaml",
]


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A minimal copy of the repository inputs the tool reads, safe to mutate."""
    for rel in COPY:
        src, dst = ROOT / rel, tmp_path / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    return tmp_path


def edit_json(path: Path, fn: Callable[[Any], None]) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    fn(data)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def config_copy(tmp_path: Path, fn: Callable[[Any], None] | None = None) -> Path:
    cfg = yaml.safe_load(tb.DEFAULT_CONFIG.read_text(encoding="utf-8"))
    if fn:
        fn(cfg)
    out = tmp_path / "budget.yaml"
    out.write_text(yaml.safe_dump(cfg, sort_keys=False), encoding="utf-8")
    return out


def codes(report: tb.Report, severity: str = "error") -> list[str]:
    return sorted(f.code for f in report.findings if f.severity == severity)


# ----------------------------------------------------------------------------- real repository


def test_repository_budgets_pass() -> None:
    report = tb.build_report()
    assert report.errors == [], [f.render() for f in report.errors]
    forms = {(f.pathway, f.form): f for f in report.forms}
    assert {("B", "slot=wait_or_now"), ("B", "slot=private_dice"), ("A", "episodes")} <= set(forms)
    for (pathway, name), f in forms.items():
        if name.startswith("substudy="):
            continue
        assert f.ceiling_total_s <= 890 and f.slow_total_s <= 900, (pathway, name)
        assert 540 <= f.scored_median_l2_s <= 630, (pathway, name)


def test_module_durations_match_the_stamped_estimates() -> None:
    """The tool's duration model must agree with the estimates stored in each config (content README)."""
    games = tb.load_games(ROOT)
    for mid, game in games.items():
        mb = tb.module_budget(game, ["L1", "L2", "L3"])
        for level in ("L1", "L2", "L3"):
            est = game["levels"][level]["estimated_duration_ms"]
            assert round(mb.durations[level]["median"] * 1000) == est["median"], (mid, level)
            assert round(mb.durations[level]["slow"] * 1000) == est["slow"], (mid, level)
            assert round(mb.durations[level]["slow_trimmed"] * 1000) == est["slow_trimmed"], (mid, level)


def test_plan_section_4_4_is_parsed() -> None:
    cfg = yaml.safe_load(tb.DEFAULT_CONFIG.read_text(encoding="utf-8"))
    targets = tb.parse_plan_section_4_4(
        (ROOT / "docs" / "IMPLEMENTATION_PLAN.md").read_text(encoding="utf-8"), cfg["plan_section_4_4"]
    )
    assert targets["cap_s"] == 900
    assert targets["total"] == {"B": 890, "A": 890}
    assert targets["segments"]["onboarding"] == {"B": 90, "A": 90}
    assert targets["segments"]["practice_warmup"] == {"B": 60, "A": 60}
    assert targets["segments"]["contact_optin"] == {"B": 30, "A": 30}
    assert targets["scored"]["B"] == {"min": 570, "max": 620}
    assert targets["scored"]["A"] == {"min": 600, "max": 600}


def test_every_dictionary_indicator_has_a_supply_rule() -> None:
    report = tb.build_report()
    assert all(r.verdict != "unmapped" for r in report.supply)
    assert len(report.supply) == sum(
        len(yaml.safe_load((ROOT / "scoring" / "dictionary" / f"dictionary.{p}.yaml").read_text("utf-8"))["indicators"])
        for p in "AB"
    )


def test_slot_indicators_are_evaluated_only_in_their_form() -> None:
    rows = {(r.pathway, r.indicator): r for r in tb.build_report().supply}
    assert rows[("B", "integrity.dice_overreport_rate")].form == "slot=private_dice"
    assert rows[("B", "self_control.nogo_commission_rate")].form == "all forms"
    assert rows[("A", "teamwork.turn_waiting")].form == "substudy=coplay"
    # cross-module RT pool is smallest when the slot contributes no RT trials
    assert rows[("B", "response_consistency.loc_scale_sigma")].form == "slot=private_dice"


# ----------------------------------------------------------------------------- failure modes


def test_inflated_module_breaks_scored_play_and_caps(repo: Path) -> None:
    def inflate(g: dict[str, Any], *, raise_caps: bool) -> None:
        g["blocks"][1]["trials"] += 150
        g["blocks"][1]["min_trials"] += 150
        if raise_caps:
            g["budget"]["soft_cap_ms"] = 290_000
            g["budget"]["hard_cap_ms"] = 300_000

    path = repo / "content/games/pathway-b/dont-tap.json"
    original = path.read_text(encoding="utf-8")
    edit_json(path, lambda g: inflate(g, raise_caps=False))
    found = set(codes(tb.build_report(repo)))
    assert {"module-range", "scored-play", "min-duration", "soft-cap", "hard-cap"} <= found

    path.write_text(original, encoding="utf-8")
    edit_json(path, lambda g: inflate(g, raise_caps=True))
    found = set(codes(tb.build_report(repo)))
    assert {"module-range", "scored-play", "slow-bot", "session-ceiling", "min-duration"} <= found
    assert "soft-cap" not in found and "hard-cap" not in found


def test_session_plan_segment_above_plan_4_4_fails(repo: Path) -> None:
    def widen(sp: dict[str, Any]) -> None:
        sp["segments_max_s"]["onboarding"] = 95

    edit_json(repo / "content/games/session-plan.json", widen)
    report = tb.build_report(repo)
    assert "plan-4.4" in codes(report)
    assert "session-ceiling" in codes(report)  # 300 -> 305 s of ceilings pushes A over 890


def test_cap_mismatch_with_plan(repo: Path) -> None:
    edit_json(repo / "content/games/session-plan.json", lambda sp: sp.update(session_cap_s=950))
    assert "plan-4.4" in codes(tb.build_report(repo))


def test_target_above_cap(repo: Path) -> None:
    edit_json(repo / "content/games/session-plan.json", lambda sp: sp.update(session_target_max_s=910))
    found = codes(tb.build_report(repo))
    assert "session-cap" in found and "plan-4.4" in found


def test_trial_shortfall_on_plan_ac_basis_is_an_error(repo: Path) -> None:
    def fewer(g: dict[str, Any]) -> None:
        g["min_counts"]["nogo"] = 15

    edit_json(repo / "content/games/pathway-b/dont-tap.json", fewer)
    report = tb.build_report(repo)
    errs = [f for f in report.errors if f.code == "trial-supply"]
    assert [f.subject for f in errs] == ["B:self_control.nogo_commission_rate"]


def test_trial_shortfall_on_pending_basis_is_a_warning(repo: Path) -> None:
    def fewer(g: dict[str, Any]) -> None:
        g["min_counts"]["free_rider_rounds"] = 2

    edit_json(repo / "content/games/pathway-b/share-pot.json", fewer)
    report = tb.build_report(repo)
    assert "trial-supply" not in codes(report)
    assert "trial-supply" in codes(report, "warning")


def test_demoted_indicator_shortfall_is_accepted(repo: Path) -> None:
    path = repo / "scoring/dictionary/dictionary.B.yaml"
    d = yaml.safe_load(path.read_text(encoding="utf-8"))
    for ind in d["indicators"]:
        if ind["id"] == "self_control.nogo_commission_rate":
            ind["status"] = "research_only"
            ind["min_valid_trials"]["count"] = 999
    path.write_text(yaml.safe_dump(d, sort_keys=False), encoding="utf-8")
    report = tb.build_report(repo)
    row = next(r for r in report.supply if r.pathway == "B" and r.indicator == "self_control.nogo_commission_rate")
    assert row.verdict == "demoted"
    assert report.errors == []


def test_unmapped_task_and_bad_config(repo: Path, tmp_path: Path) -> None:
    unmapped_dir = tmp_path / "c1"
    unmapped_dir.mkdir()
    cfg = config_copy(unmapped_dir, lambda c: c["supply"]["B"].pop("tower.solvable"))
    report = tb.build_report(repo, cfg)
    assert codes(report).count("supply-unmapped") == 4  # four tower.solvable indicators

    def bad_term(c: Any) -> None:
        c["supply"]["B"]["tower.solvable"]["problems"] = [{"module": "tower", "count": "nope"}]

    bad_dir = tmp_path / "c2"
    bad_dir.mkdir()
    assert "supply-config" in codes(tb.build_report(repo, config_copy(bad_dir, bad_term)))


def test_stale_waiver_fails(repo: Path, tmp_path: Path) -> None:
    def add_delay_trials(g: dict[str, Any]) -> None:
        for b in g["blocks"]:
            if b["block_id"] == "delay":
                b["min_trials"] = b["trials"] = 12

    edit_json(repo / "content/games/pathway-b/wait-or-now.json", add_delay_trials)
    report = tb.build_report(repo)
    assert "stale-waiver" in codes(report)

    cfg = config_copy(tmp_path, lambda c: c["waivers"]["B"].update({"no.such_indicator": {"reason": "x"}}))
    assert "stale-waiver" in codes(tb.build_report(ROOT, cfg))


def test_term_supply_kinds() -> None:
    game = {
        "module_id": "m",
        "context_shift": {"kind": "x"},
        "min_counts": {"a": 5, "b": 2},
        "blocks": [
            {"block_id": "x", "min_trials": 3, "beats": ["e"]},
            {"block_id": "probe", "min_trials": 5, "beats": []},
        ],
    }
    assert tb.term_supply({"module": "m", "blocks": ["x", "probe"]}, game, 2) == 8
    assert tb.term_supply({"module": "m", "count": "a", "times": 2}, game, 2) == 10
    assert tb.term_supply({"module": "m", "count": "a", "times_count": "b"}, game, 2) == 10
    assert tb.term_supply({"module": "m", "count": "a", "minus_count": "b"}, game, 2) == 3
    assert tb.term_supply({"module": "m", "probe_segments": True}, game, 2) == 2
    assert tb.term_supply({"module": "m", "context_shift": True}, game, 2) == 1
    assert tb.term_supply({"module": "m", "beat_blocks": "e"}, game, 2) == 1
    with pytest.raises(KeyError):
        tb.term_supply({"module": "m", "blocks": ["zzz"]}, game, 2)
    with pytest.raises(ValueError, match="unsupported"):
        tb.term_supply({"module": "m"}, game, 2)


# ----------------------------------------------------------------------------- CLI


def test_cli_formats(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "budget.md"
    assert tb.main(["--out", str(out)]) == 0
    md = capsys.readouterr().out
    assert "## Trial-time budget" in md and "| B | slot=wait_or_now |" in md and "**PASS**" in md
    assert out.read_text(encoding="utf-8") == md

    assert tb.main(["--format", "json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True and payload["session_plan"]["session_cap_s"] == 900

    assert tb.main(["--format", "csv"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[0].startswith("pathway,indicator,construct") and len(lines) == 101

    assert tb.main(["--strict"]) == 1  # the repository currently carries warnings (waiver, design target)
    capsys.readouterr()
    assert tb.main(["--root", str(tmp_path / "missing")]) == 2
