"""Checks on the committed localisation content.

Draft translations, register guide, adaptation sheets and the ITC checklist.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from shriii_i18n.checks import validate_translation_file
from shriii_i18n.models import Catalogue, RegisterGuide, Workflow
from shriii_i18n.repo import Repo, find_repo_root
from shriii_i18n.text import script_share

ROOT = find_repo_root(Path(__file__).resolve().parent)
LANGS = ["hi-IN", "mr-IN", "ta-IN"]
SCRIPTS = {"hi-IN": "Deva", "mr-IN": "Deva", "ta-IN": "Taml"}
ADAPT = ROOT / "content/i18n/adaptation"
SCENARIO_IDS = {
    "market",
    "bribe",
    "weighing",
    "customer_rudeness",
    "partner_sharing",
    "dice_luck_tokens",
    "gender_roles",
}
SESSION_STAGES = {"onboarding", "hub", "report"}


@pytest.fixture(scope="module")
def repo() -> Repo:
    return Repo(ROOT)


@pytest.fixture(scope="module")
def catalogue(repo: Repo) -> Catalogue:
    return repo.load_catalogue()


@pytest.fixture(scope="module")
def workflow(repo: Repo) -> Workflow:
    return repo.load_workflow()


@pytest.fixture(scope="module")
def guide(repo: Repo) -> RegisterGuide:
    g = repo.load_register_guide()
    assert g is not None
    return g


def _yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("lang", LANGS)
def test_translation_file_validates_without_errors(
    repo: Repo, catalogue: Catalogue, workflow: Workflow, guide: RegisterGuide, lang: str
) -> None:
    data = repo.load_translations(workflow, lang)
    issues = validate_translation_file(data, catalogue, workflow, guide.glossary)
    assert issues.errors == [], "\n".join(i.render() for i in issues.errors)
    # The only tolerated warnings are duration estimates (reviewed by the panel), never glossary or script issues.
    assert {i.code for i in issues.warnings} <= {"duration_over_flag_ratio"}


@pytest.mark.parametrize("lang", LANGS)
def test_every_line_has_a_draft_in_the_right_script(
    repo: Repo, catalogue: Catalogue, workflow: Workflow, lang: str
) -> None:
    data = repo.load_translations(workflow, lang)
    assert [e.id for e in data.entries] == [line.id for line in catalogue.lines]
    for entry in data.entries:
        assert entry.status == "draft_machine_needs_native_review"
        assert entry.text and entry.back_translation and entry.register_note
        assert script_share(entry.text, SCRIPTS[lang]) == 1.0, entry.id
        assert script_share(entry.back_translation, "Latn") > 0.9, entry.id
        assert entry.history == []
    assert "Not yet reviewed by any native speaker" in data.provenance


@pytest.mark.parametrize("lang", LANGS)
def test_only_foreign_language_faces_are_not_recorded(repo: Repo, workflow: Workflow, lang: str) -> None:
    data = repo.load_translations(workflow, lang)
    own = lang.replace("-", "_").lower()
    for entry in data.entries:
        is_face = entry.id.startswith(("onboarding.language_face.", "onboarding.language_confirm."))
        expected = not is_face or entry.id.endswith(own)
        assert entry.record is expected, entry.id
        if not entry.record:
            assert entry.record_note


def test_greetings_are_culturally_adapted(repo: Repo, workflow: Workflow) -> None:
    texts = {lang: repo.load_translations(workflow, lang).by_id()["attract.greeting"].text for lang in LANGS}
    assert texts["hi-IN"].startswith("नमस्ते")
    assert texts["mr-IN"].startswith("नमस्कार")
    assert texts["ta-IN"].startswith("வணக்கம்")


def test_hindi_report_phrases_avoid_gendered_habitual_verbs(repo: Repo, workflow: Workflow) -> None:
    data = repo.load_translations(workflow, "hi-IN")
    for entry in data.entries:
        if (
            entry.id.startswith("report.")
            and entry.id.count(".") == 2
            and entry.id.split(".")[-1] in {"pole_a", "centre", "pole_b"}
        ):
            for gendered in ("करते हैं", "करती हैं", "रहते हैं", "रहती हैं", "लेते हैं", "लेती हैं", "देते हैं", "देती हैं"):
                assert gendered not in entry.text, (entry.id, gendered)


def test_register_guide_covers_languages_tones_and_glossary(guide: RegisterGuide, catalogue: Catalogue) -> None:
    assert set(LANGS) <= set(guide.languages)
    assert {line.tone for line in catalogue.lines} <= set(guide.tone_notes)
    assert len(guide.glossary) >= 15
    for term in guide.glossary:
        assert any(term.applies_to(line.reference_text) for line in catalogue.lines), term.concept
        for lang, forms in term.terms.items():
            assert lang in LANGS
            assert all(script_share(f, SCRIPTS[lang]) == 1.0 for f in forms), (term.concept, lang)


def _scenario_files() -> list[Path]:
    return sorted((ADAPT / "scenarios").glob("*.yaml"))


def test_all_scenarios_present() -> None:
    ids = {_yaml(p)["scenario_id"] for p in _scenario_files()}
    assert ids == SCENARIO_IDS


@pytest.mark.parametrize("path", _scenario_files(), ids=lambda p: p.stem)
def test_scenario_sheet_structure(path: Path, catalogue: Catalogue) -> None:
    sheet = _yaml(path)
    regions = _yaml(ADAPT / "regions.yaml")["languages"]
    docs = [json.loads(p.read_text(encoding="utf-8")) for p in (ROOT / "content/games").glob("*/*.json")]
    modules = {d["module_id"] for d in docs if "module_id" in d}  # shared rule documents have no module_id
    assert path.stem == sheet["scenario_id"].replace("_", "-")
    assert set(sheet["appears_in"]) <= modules | SESSION_STAGES
    assert set(sheet["lines"]) <= set(catalogue.by_id()), set(sheet["lines"]) - set(catalogue.by_id())
    for key in ("purpose", "locked_elements", "adaptable_surface", "construct_risks", "observer_codes", "signoff"):
        assert sheet[key], key
    assert "cultural_mismatch" in sheet["observer_codes"]
    assert sheet["signoff"]["decision_options"] == [
        "equivalent",
        "equivalent_with_surface_change",
        "not_equivalent_redesign",
    ]
    assert len(sheet["universal_probes"]) >= 5
    probe_ids = [p["id"] for p in sheet["universal_probes"]]
    assert len(set(probe_ids)) == len(probe_ids)
    for probe in sheet["universal_probes"]:
        assert probe["en"] and probe["listen_for"]
        for lang in LANGS:
            assert script_share(probe[lang], SCRIPTS[lang]) > 0.9, (probe["id"], lang)
    assert set(sheet["regions"]) == set(LANGS)
    for lang, section in sheet["regions"].items():
        assert section["regions"] == [r["id"] for r in regions[lang]["regions"]]
        assert section["considerations"] and section["region_probes"]


def test_customer_rudeness_has_tone_ordering_acceptance() -> None:
    sheet = _yaml(ADAPT / "scenarios/customer-rudeness.yaml")
    assert "Kendall" in sheet["acceptance"]["criterion"]


def test_itc_checklist_covers_all_18_guidelines() -> None:
    doc = _yaml(ADAPT / "itc-checklist.yaml")
    ids = [g["id"] for g in doc["guidelines"]]
    assert ids == [
        "PC-1",
        "PC-2",
        "PC-3",
        "TD-1",
        "TD-2",
        "TD-3",
        "TD-4",
        "TD-5",
        "C-1",
        "C-2",
        "C-3",
        "C-4",
        "A-1",
        "A-2",
        "SSI-1",
        "SSI-2",
        "D-1",
        "D-2",
    ]
    assert [g["number"] for g in doc["guidelines"]] == list(range(1, 19))
    for g in doc["guidelines"]:
        assert g["guideline"] and g["evidence"] and g["owner_role"]
        assert g["status"] == ("partially_met" if g["open_gaps"] else "met")
        for ev in g["evidence"]:
            assert ev["status"] in doc["evidence_status_values"]
            if "path" in ev:
                assert ev["status"] == "in_repo"
                assert (ROOT / ev["path"]).exists(), ev["path"]
            else:
                assert ev["feature"]
