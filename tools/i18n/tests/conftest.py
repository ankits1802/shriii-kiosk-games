from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml
from shriii_i18n.repo import Repo, find_repo_root
from shriii_i18n.sync import empty_translation_file, sync_translation_file

REAL_ROOT = find_repo_root(Path(__file__).resolve().parent)

MINI_CATALOGUE: dict[str, object] = {
    "schema_version": "1.0",
    "catalogue_version": "9.9.9",
    "reference_language": "en-IN",
    "languages": ["en-IN", "hi-IN", "mr-IN", "ta-IN"],
    "lines": [
        {
            "id": "attract.touch_to_start",
            "category": "attract",
            "module_id": None,
            "speaker_role": "guide",
            "context": "Attract loop call to action.",
            "reference_text": "Touch the screen to begin.",
            "target_duration_ms": 2500,
            "tone": "warm",
            "voice_forbidden": False,
        },
        {
            "id": "weighing_post.quantity",
            "category": "guide",
            "module_id": "weighing_post",
            "speaker_role": "guide",
            "context": "Quantity read-out with a placeholder.",
            "reference_text": "The needle shows {quantity}.",
            "target_duration_ms": 2000,
            "tone": "neutral",
            "voice_forbidden": False,
        },
        {
            "id": "feedback.well_done",
            "category": "feedback",
            "module_id": None,
            "speaker_role": "guide",
            "context": "Neutral-positive feedback.",
            "reference_text": "Well done!",
            "target_duration_ms": 900,
            "tone": "encouraging",
            "voice_forbidden": False,
        },
    ],
}

HI_TEXT = {
    "attract.touch_to_start": ("शुरू करने के लिए स्क्रीन को छुइए।", "To start, touch the screen."),
    "weighing_post.quantity": ("सुई {quantity} बता रही है।", "The needle is telling {quantity}."),
    "feedback.well_done": ("बहुत बढ़िया!", "Very good!"),
}


def write_catalogue(root: Path, catalogue: dict[str, object]) -> None:
    path = root / "content/i18n/lines.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(catalogue, allow_unicode=True, sort_keys=False), encoding="utf-8")


@pytest.fixture
def mini_repo(tmp_path: Path) -> Repo:
    """A throw-away repository with a 3-line catalogue, the real workflow/register guide and a hi-IN draft file."""
    write_catalogue(tmp_path, MINI_CATALOGUE)
    tdir = tmp_path / "content/i18n/translations"
    tdir.mkdir(parents=True, exist_ok=True)
    for name in ("workflow.yaml", "register-guide.yaml"):
        shutil.copy(REAL_ROOT / "content/i18n/translations" / name, tdir / name)
    repo = Repo(tmp_path)
    catalogue, workflow = repo.load_catalogue(), repo.load_workflow()
    data, _ = sync_translation_file(empty_translation_file(catalogue, workflow, "hi-IN"), catalogue, workflow)
    entries = [
        e.model_copy(update={"text": HI_TEXT[e.id][0], "back_translation": HI_TEXT[e.id][1]}) for e in data.entries
    ]
    repo.save_translations(workflow, data.model_copy(update={"entries": entries}))
    return repo
