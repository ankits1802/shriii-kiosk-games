"""Pre-registration generator: content, hashes, determinism, power, checks, verification and CLI."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
import yaml
from shriii_prereg import build_document, load_inputs, render_document, verify_document, write_outputs
from shriii_prereg.build import PreregBuildError
from shriii_prereg.cli import main
from shriii_prereg.render import md_cell

FIXED_TIME = datetime(2026, 10, 21, 0, 0, tzinfo=UTC)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def _edit_yaml(path: Path, fn: Any) -> None:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    fn(data)
    path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")


@pytest.fixture
def real_doc(real_root: Path) -> dict[str, Any]:
    return build_document(load_inputs(repo_root=real_root), generated_at=FIXED_TIME)


# ----------------------------------------------------------------------------- content from the real inputs


def test_real_inputs_have_no_cross_reference_errors(real_doc: dict[str, Any]) -> None:
    errors = [i for i in real_doc["issues"] if i["severity"] == "error"]
    assert errors == []


def test_every_input_is_hashed_with_the_canonical_convention(real_doc: dict[str, Any], real_root: Path) -> None:
    roles = {f["role"] for f in real_doc["inputs"]}
    assert {"hypotheses", "gates", "dictionary.shared", "dictionary.A", "dictionary.B", "config"} <= roles
    for f in real_doc["inputs"]:
        assert f["sha256"] == _sha(real_root / f["path"]), f["path"]
        assert re.fullmatch(r"[0-9a-f]{64}", f["sha256"])


def test_families_and_counts_come_from_the_registry(real_doc: dict[str, Any], real_root: Path) -> None:
    reg = yaml.safe_load((real_root / "scoring" / "hypotheses.yaml").read_text(encoding="utf-8"))
    fams = {f["id"]: f for f in real_doc["families"]}
    assert set(fams) == {f["id"] for f in reg["families"]}
    for f in reg["families"]:
        expected = sum(1 for h in reg["hypotheses"] if h["family"] == f["id"])
        assert fams[f["id"]]["n_hypotheses"] == expected
        assert fams[f["id"]]["correction"] == f["correction"]
    primary = fams["primary"]
    assert primary["kind"] == "confirmatory"
    assert primary["smallest_per_test_alpha"] == pytest.approx(primary["alpha"] / primary["n_hypotheses"])


def test_markdown_and_html_contain_every_hypothesis_and_threshold(real_doc: dict[str, Any], real_root: Path) -> None:
    md = render_document(real_doc, "md")
    html = render_document(real_doc, "html")
    gates = yaml.safe_load((real_root / "scoring" / "gates.yaml").read_text(encoding="utf-8"))
    for h in real_doc["hypotheses"]:
        assert h["id"] in md
        assert h["id"] in html
    retest = gates["trait_gate"]["retest"]
    assert f"point >= {retest['point_min']:g}" in md
    assert f"lower bound >= {retest['lower_bound_min']:g}" in md
    assert f"lower bound > {gates['trait_gate']['convergent']['lower_bound_gt']:g}" in md
    for rule in ("not_scorable", "anticipatory_response", "session_quality_exclude", "synthetic_session"):
        assert rule in md
    for section in (
        "## 1. Study information",
        "## 2. Design plan",
        "## 3. Sampling plan",
        "## 4. Variables",
        "## 5. Analysis plan",
        "## 6. Other",
    ):
        assert section in md
    assert html.startswith("<!doctype html>")
    assert html.rstrip().endswith("</html>")
    assert "REVIEW REQUIRED" in md and "REVIEW REQUIRED" in html
    assert "DRAFT: Not for submission" in md
    for out in (md, html):
        assert "object at 0x" not in out  # no Python reprs leak into the document


def test_every_input_hash_is_embedded_in_every_format(real_doc: dict[str, Any]) -> None:
    for fmt in ("md", "html", "json"):
        out = render_document(real_doc, fmt)
        for f in real_doc["inputs"]:
            assert f["sha256"] in out, (fmt, f["path"])


def test_all_17_constructs_and_indicators_are_listed(real_doc: dict[str, Any]) -> None:
    assert len(real_doc["constructs"]) == 17
    md = render_document(real_doc, "md")
    for p, rows in real_doc["indicators"].items():
        assert rows, p
        for r in rows:
            assert r["id"] in md


def test_output_is_deterministic_for_a_fixed_timestamp(real_root: Path) -> None:
    a = build_document(load_inputs(repo_root=real_root), generated_at=FIXED_TIME)
    b = build_document(load_inputs(repo_root=real_root), generated_at=FIXED_TIME)
    for fmt in ("md", "html", "json"):
        assert render_document(a, fmt) == render_document(b, fmt)


def test_json_output_round_trips(real_doc: dict[str, Any]) -> None:
    doc = json.loads(render_document(real_doc, "json"))
    assert doc["schema"] == "shriii-prereg-document"
    assert doc["meta"]["generated_at"] == "2026-10-21T00:00:00Z"


# ----------------------------------------------------------------------------- power


def test_power_rows_match_the_plan_defaults(real_doc: dict[str, Any]) -> None:
    rows = {r["id"]: r for r in real_doc["power"]["rows"]}
    # Plan VAL-02: .25 vs .10 at Holm alpha .00625 needs about 470; 675 per arm pooled covers it.
    assert 460 <= rows["primary_pooled_per_arm"]["required_n"] <= 475
    assert rows["primary_pooled_per_arm"]["planned_n"] == 675
    assert rows["primary_pooled_per_arm"]["adequate"] is True
    # Per language and arm, sign with LB > 0 for r = .25 needs about 100.
    assert 95 <= rows["per_language_arm_sign"]["required_n"] <= 105
    # Retest: 100 pairs gives ICC .60 half-width about .12 per language and about .07 pooled.
    assert rows["retest_icc"]["halfwidth_per_language"] == pytest.approx(0.126, abs=0.005)
    assert rows["retest_icc"]["halfwidth_pooled"] == pytest.approx(0.073, abs=0.005)
    assert real_doc["power"]["status"] == "pending_val02"


def test_power_flags_an_inadequate_plan(repo_copy: Path) -> None:
    def shrink(cfg: dict[str, Any]) -> None:
        cfg["power"]["planned"]["per_arm_per_language"] = 50

    _edit_yaml(repo_copy / "tools" / "prereg" / "prereg.config.yaml", shrink)
    doc = build_document(load_inputs(repo_root=repo_copy), generated_at=FIXED_TIME)
    rows = {r["id"]: r for r in doc["power"]["rows"]}
    assert rows["primary_pooled_per_arm"]["adequate"] is False
    assert rows["per_language_arm_sign"]["adequate"] is False


# ----------------------------------------------------------------------------- cross-reference checks


def test_broken_registry_is_reported_and_strict_mode_fails(repo_copy: Path) -> None:
    def break_it(reg: dict[str, Any]) -> None:
        reg["hypotheses"][0]["family"] = "no_such_family"
        reg["hypotheses"][1]["indicators"] = ["emotional_regulation.does_not_exist"]
        reg["hypotheses"][2]["indicators"] = ["integrity.dice_overreport_rate"]
        reg["hypotheses"][3]["expected_sign"] = None
        reg["coverage"] = [c for c in reg["coverage"] if c["construct"] != "persistence"]

    _edit_yaml(repo_copy / "scoring" / "hypotheses.yaml", break_it)
    inputs = load_inputs(repo_root=repo_copy)
    doc = build_document(inputs, generated_at=FIXED_TIME)
    codes = {i["code"] for i in doc["issues"] if i["severity"] == "error"}
    assert {
        "unknown_family",
        "unknown_indicator",
        "group_only_in_individual_test",
        "missing_sign",
        "coverage_missing",
    } <= codes
    with pytest.raises(PreregBuildError) as exc:
        build_document(inputs, generated_at=FIXED_TIME, strict=True)
    assert any(i["code"] == "unknown_family" for i in exc.value.issues)
    out = repo_copy / "out"
    assert main(["--repo-root", str(repo_copy), "generate", "--strict", "--out-dir", str(out)]) == 1
    assert not out.exists()


def test_confirmatory_coverage_requires_a_primary_hypothesis(repo_copy: Path) -> None:
    def drop(reg: dict[str, Any]) -> None:
        reg["hypotheses"] = [h for h in reg["hypotheses"] if h["id"] != "h1.persistence"]

    _edit_yaml(repo_copy / "scoring" / "hypotheses.yaml", drop)
    doc = build_document(load_inputs(repo_root=repo_copy), generated_at=FIXED_TIME)
    msgs = [i["message"] for i in doc["issues"] if i["code"] == "confirmatory_without_hypothesis"]
    assert any("persistence" in m for m in msgs)


def test_unknown_exclusion_rule_is_an_error(repo_copy: Path) -> None:
    def bad(d: dict[str, Any]) -> None:
        d["indicators"][0]["exclusions"].append("made_up_rule")

    _edit_yaml(repo_copy / "scoring" / "dictionary" / "dictionary.B.yaml", bad)
    doc = build_document(load_inputs(repo_root=repo_copy), generated_at=FIXED_TIME)
    assert any(i["code"] == "unknown_exclusion" and "made_up_rule" in i["message"] for i in doc["issues"])


def test_require_frozen_and_frozen_status(repo_copy: Path) -> None:
    with pytest.raises(PreregBuildError):
        build_document(load_inputs(repo_root=repo_copy), generated_at=FIXED_TIME, require_frozen=True)

    def freeze(d: dict[str, Any]) -> None:
        d["status"] = "frozen"
        d["frozen_at"] = "2026-10-20T10:00:00Z"

    for p in [
        repo_copy / "scoring" / "hypotheses.yaml",
        repo_copy / "scoring" / "gates.yaml",
        *sorted((repo_copy / "scoring" / "dictionary").glob("*.yaml")),
    ]:
        _edit_yaml(p, freeze)
    doc = build_document(load_inputs(repo_root=repo_copy), generated_at=FIXED_TIME, require_frozen=True)
    assert doc["meta"]["status"] == "frozen"
    assert not [i for i in doc["issues"] if i["code"] == "not_frozen"]
    assert "Not for submission" not in render_document(doc, "md")


def test_crlf_checkout_hashes_like_lf(repo_copy: Path) -> None:
    p = repo_copy / "scoring" / "gates.yaml"
    lf = load_inputs(repo_root=repo_copy).gates.sha256
    p.write_bytes(p.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
    assert load_inputs(repo_root=repo_copy).gates.sha256 == lf


# ----------------------------------------------------------------------------- escaping and safety


def test_html_escapes_and_markdown_cells_are_safe(repo_copy: Path) -> None:
    def inject(cfg: dict[str, Any]) -> None:
        cfg["study"]["description"] = "<script>alert(1)</script> a | b"
        cfg["study"]["contributors"][0]["name"] = "A | B"

    _edit_yaml(repo_copy / "tools" / "prereg" / "prereg.config.yaml", inject)
    doc = build_document(load_inputs(repo_root=repo_copy), generated_at=FIXED_TIME)
    html = render_document(doc, "html")
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html
    md = render_document(doc, "md")
    assert "| A \\| B |" in md
    assert md_cell(None) == "-"
    assert md_cell(["x", "y"]) == "x, y"


def test_refuses_to_write_into_the_scoring_directory(repo_copy: Path) -> None:
    doc = build_document(load_inputs(repo_root=repo_copy), generated_at=FIXED_TIME)
    with pytest.raises(ValueError, match="read-only scoring"):
        write_outputs(doc, repo_copy / "scoring" / "out", repo_root=repo_copy)


def test_inputs_are_never_modified(repo_copy: Path) -> None:
    before = {p: p.read_bytes() for p in (repo_copy / "scoring").rglob("*.yaml")}
    assert (
        main(
            [
                "--repo-root",
                str(repo_copy),
                "generate",
                "--out-dir",
                str(repo_copy / "build"),
                "--generated-at",
                "2026-10-21T00:00:00Z",
            ]
        )
        == 0
    )
    after = {p: p.read_bytes() for p in (repo_copy / "scoring").rglob("*.yaml")}
    assert before == after


# ----------------------------------------------------------------------------- verification and CLI


def test_cli_generate_then_verify_detects_changes(repo_copy: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = repo_copy / "build" / "prereg"
    rc = main(
        ["--repo-root", str(repo_copy), "generate", "--out-dir", str(out), "--generated-at", "2026-10-21T00:00:00Z"]
    )
    assert rc == 0
    for ext in ("md", "html", "json"):
        assert (out / f"preregistration.{ext}").is_file()
        assert verify_document(out / f"preregistration.{ext}", repo_copy).ok
    assert main(["--repo-root", str(repo_copy), "verify", str(out / "preregistration.md")]) == 0

    def amend(g: dict[str, Any]) -> None:
        g["trait_gate"]["retest"]["point_min"] = 0.55

    _edit_yaml(repo_copy / "scoring" / "gates.yaml", amend)
    for ext in ("md", "html", "json"):
        res = verify_document(out / f"preregistration.{ext}", repo_copy)
        assert not res.ok
        assert any("scoring/gates.yaml" in p for p in res.problems)
    capsys.readouterr()
    assert main(["--repo-root", str(repo_copy), "verify", str(out / "preregistration.html")]) == 1
    assert "NOT verified" in capsys.readouterr().out


def test_verify_flags_an_added_dictionary_file(repo_copy: Path) -> None:
    out = repo_copy / "build"
    doc = build_document(load_inputs(repo_root=repo_copy), generated_at=FIXED_TIME)
    paths = write_outputs(doc, out, formats=["md"], repo_root=repo_copy)
    (repo_copy / "scoring" / "dictionary" / "dictionary.C.yaml").write_text(
        "document: pathway\npathway: C\n", encoding="utf-8"
    )
    res = verify_document(paths["md"], repo_copy)
    assert not res.ok
    assert any("dictionary.C.yaml" in p for p in res.problems)


def test_cli_rejects_bad_timestamp_and_missing_document(repo_copy: Path) -> None:
    with pytest.raises(SystemExit):
        main(["--repo-root", str(repo_copy), "generate", "--generated-at", "yesterday"])
    assert main(["--repo-root", str(repo_copy), "verify", str(repo_copy / "nope.md")]) == 2


def test_verify_checks_the_dictionary_dir_it_was_generated_from(repo_copy: Path) -> None:
    alt = repo_copy / "alt_scoring"
    shutil.copytree(repo_copy / "scoring", alt)
    out = repo_copy / "build"
    doc = build_document(load_inputs(scoring_dir=alt, repo_root=repo_copy), generated_at=FIXED_TIME)
    paths = write_outputs(doc, out, formats=["md"], repo_root=repo_copy)
    assert verify_document(paths["md"], repo_copy).ok
    (alt / "dictionary" / "dictionary.C.yaml").write_text("document: pathway\npathway: C\n", encoding="utf-8")
    res = verify_document(paths["md"], repo_copy)
    assert not res.ok
    assert any("alt_scoring/dictionary/dictionary.C.yaml" in p for p in res.problems)
