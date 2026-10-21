from __future__ import annotations

import datetime as dt
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError
from shriii_i18n.checks import (
    Signoff,
    check_history,
    field_edit_allowed,
    status_reached,
    transition_problems,
    validate_translation_file,
)
from shriii_i18n.models import HistoryEvent, Workflow
from shriii_i18n.repo import Repo, find_repo_root
from shriii_i18n.sync import sync_translation_file

REAL_ROOT = find_repo_root(Path(__file__).resolve().parent)


@pytest.fixture
def workflow() -> Workflow:
    return Repo(REAL_ROOT).load_workflow()


def test_workflow_forward_path(workflow: Workflow) -> None:
    path = [s.id for s in workflow.forward_path()]
    assert path == [
        "draft_machine_needs_native_review",
        "forward_translated",
        "back_translated",
        "expert_reviewed",
        "recorded",
        "audio_qc",
        "think_aloud_tested",
        "approved",
    ]
    assert workflow.initial_status == "draft_machine_needs_native_review"
    assert workflow.pack_eligibility["production"] == ["approved"]
    assert status_reached(workflow, "approved", "back_translated")
    assert not status_reached(workflow, "flagged_for_revision", "forward_translated")


def test_workflow_rejects_backward_transition_in_config() -> None:
    raw = yaml.safe_load((REAL_ROOT / "content/i18n/translations/workflow.yaml").read_text(encoding="utf-8"))
    raw["transitions"]["back_translated"].append("forward_translated")
    with pytest.raises(ValidationError, match="not forward-only"):
        Workflow.model_validate(raw)


def test_workflow_rejects_unknown_role_and_status() -> None:
    raw = yaml.safe_load((REAL_ROOT / "content/i18n/translations/workflow.yaml").read_text(encoding="utf-8"))
    raw["statuses"][1]["signoff_role"] = "intern"
    with pytest.raises(ValidationError, match="unknown signoff role"):
        Workflow.model_validate(raw)
    raw = yaml.safe_load((REAL_ROOT / "content/i18n/translations/workflow.yaml").read_text(encoding="utf-8"))
    raw["transitions"]["approved"] = ["published"]
    with pytest.raises(ValidationError, match="not a declared status"):
        Workflow.model_validate(raw)


def _codes(workflow: Workflow, src: str, dst: str, signoff: Signoff, prior: dict[str, str] | None = None) -> set[str]:
    return {code for code, _ in transition_problems(workflow, src, dst, signoff, prior or {})}


def test_transition_problems(workflow: Workflow) -> None:
    asha = {"forward_translated": "Asha"}
    assert _codes(workflow, "forward_translated", "back_translated", Signoff("Ravi", "back_translator"), asha) == set()
    assert _codes(workflow, "forward_translated", "back_translated", Signoff("ASHA ", "back_translator"), asha) == {
        "signoff_not_independent"
    }
    assert _codes(workflow, "approved", "flagged_for_revision", Signoff("F", "field_researcher")) == {"comment_missing"}
    assert _codes(workflow, "approved", "flagged_for_revision", Signoff("F", "nobody", "x")) == {"signoff_role"}
    assert _codes(workflow, "recorded", "expert_reviewed", Signoff("E", "expert_reviewer")) == {"illegal_transition"}
    assert _codes(workflow, "draft_machine_needs_native_review", "forward_translated", Signoff("", "translator")) == {
        "signoff_missing"
    }


def test_field_edit_rules(workflow: Workflow) -> None:
    assert field_edit_allowed(workflow, "text", "forward_translated", "forward_translated")
    assert not field_edit_allowed(workflow, "text", "back_translated", "back_translated")
    assert field_edit_allowed(workflow, "text", "back_translated", "expert_reviewed")
    assert not field_edit_allowed(workflow, "text", "expert_reviewed", "recorded")
    assert field_edit_allowed(workflow, "back_translation", "forward_translated", "back_translated")
    assert not field_edit_allowed(workflow, "back_translation", "approved", "approved")


def test_history_chain_validation(mini_repo: Repo) -> None:
    workflow = mini_repo.load_workflow()
    data = mini_repo.load_translations(workflow, "hi-IN")
    entry = data.entries[0]
    good = entry.model_copy(
        update={
            "status": "back_translated",
            "history": [
                HistoryEvent(
                    from_status="draft_machine_needs_native_review",
                    to_status="forward_translated",
                    by="Asha",
                    role="translator",
                    date=dt.date(2026, 1, 2),
                ),
                HistoryEvent(
                    from_status="forward_translated",
                    to_status="back_translated",
                    by="Ravi",
                    role="back_translator",
                    date=dt.date(2026, 1, 3),
                ),
            ],
        }
    )
    assert check_history(good, workflow, language="hi-IN").ok
    bad = good.model_copy(update={"status": "expert_reviewed"})
    assert {i.code for i in check_history(bad, workflow, language="hi-IN").errors} == {"history_status_mismatch"}
    out_of_order = good.model_copy(update={"history": list(reversed(good.history))})
    codes = {i.code for i in check_history(out_of_order, workflow, language="hi-IN").errors}
    assert {"history_gap", "history_date_order"} <= codes


def test_sync_adds_reports_and_prunes(mini_repo: Repo) -> None:
    workflow = mini_repo.load_workflow()
    cat_raw = yaml.safe_load(mini_repo.catalogue_path.read_text(encoding="utf-8"))
    new_line = dict(cat_raw["lines"][0], id="attract.new_line", reference_text="A new line.")
    cat_raw["lines"].insert(1, new_line)
    cat_raw["lines"][2]["reference_text"] = "The needle now shows {quantity}."
    removed = cat_raw["lines"].pop()  # feedback.well_done leaves the catalogue
    mini_repo.catalogue_path.write_text(yaml.safe_dump(cat_raw, allow_unicode=True), encoding="utf-8")
    catalogue = mini_repo.load_catalogue()
    data = mini_repo.load_translations(workflow, "hi-IN")

    updated, report = sync_translation_file(data, catalogue, workflow)
    assert report.added == ["attract.new_line"]
    assert report.stale == ["weighing_post.quantity"]
    assert report.orphans == [removed["id"]]
    assert [e.id for e in updated.entries] == [
        "attract.touch_to_start",
        "attract.new_line",
        "weighing_post.quantity",
        "feedback.well_done",
    ]
    new = updated.by_id()["attract.new_line"]
    assert new.status == workflow.initial_status and new.text == ""
    codes = {i.code for i in validate_translation_file(updated, catalogue, workflow).errors}
    assert {"orphan_entry", "stale_source"} <= codes

    pruned, report = sync_translation_file(data, catalogue, workflow, prune=True)
    assert report.pruned == ["feedback.well_done"]
    assert "feedback.well_done" not in pruned.by_id()


def test_validate_detects_wrong_script_and_missing_line(mini_repo: Repo, tmp_path: Path) -> None:
    workflow, catalogue = mini_repo.load_workflow(), mini_repo.load_catalogue()
    data = mini_repo.load_translations(workflow, "hi-IN")
    entries = [
        e.model_copy(update={"text": "Touch it"}) if e.id == "attract.touch_to_start" else e for e in data.entries[:-1]
    ]
    issues = validate_translation_file(data.model_copy(update={"entries": entries}), catalogue, workflow)
    codes = {i.code for i in issues.errors}
    assert {"wrong_script", "missing_line"} <= codes
