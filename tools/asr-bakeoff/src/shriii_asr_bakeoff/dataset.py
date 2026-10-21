"""Dataset manifest loading and validation (schemas/dataset.schema.json)."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from shriii_asr_bakeoff.schema import validate


@dataclass(frozen=True, slots=True)
class SpeakerRow:
    speaker_id: str
    language: str
    age_band: str
    gender: str
    split: str

    def group(self, field: str) -> str:
        return str(getattr(self, field))


@dataclass(frozen=True, slots=True)
class UtteranceRow:
    utterance_id: str
    speaker_id: str
    language: str
    kind: str
    code: str | None
    file: Path
    duration_ms: float


@dataclass(frozen=True, slots=True)
class Dataset:
    root: Path
    dataset_id: str
    kind: str
    manifest_sha256: str
    speakers: dict[str, SpeakerRow]
    utterances: list[UtteranceRow]

    def languages(self) -> list[str]:
        return sorted({u.language for u in self.utterances})

    def speakers_for(self, language: str, split: str | None = None) -> list[SpeakerRow]:
        return [s for s in self.speakers.values() if s.language == language and (split is None or s.split == split)]


class DatasetError(ValueError):
    pass


def load_dataset(manifest: Path, today: date | None = None) -> Dataset:
    raw: dict[str, Any] = json.loads(manifest.read_text(encoding="utf-8"))
    validate(raw, "dataset.schema.json")
    if raw["kind"] == "asr_eval":
        due = date.fromisoformat(raw["consent"]["deletion_due"])
        if (today or date.today()) > due:
            raise DatasetError(
                f"asr_eval dataset {raw['dataset_id']} passed its deletion date {due}: "
                "delete it (PRV-05), do not evaluate"
            )
    root = manifest.parent
    speakers = {
        s["speaker_id"]: SpeakerRow(**{k: s[k] for k in SpeakerRow.__dataclass_fields__}) for s in raw["speakers"]
    }
    utts = []
    for u in raw["utterances"]:
        spk = speakers.get(u["speaker_id"])
        if spk is None:
            raise DatasetError(f"utterance {u['utterance_id']}: unknown speaker {u['speaker_id']}")
        if spk.language != u["language"]:
            raise DatasetError(f"utterance {u['utterance_id']}: language differs from its speaker")
        path = root / u["file"]
        if not path.is_file():
            raise DatasetError(f"utterance {u['utterance_id']}: missing file {u['file']}")
        utts.append(
            UtteranceRow(
                utterance_id=u["utterance_id"],
                speaker_id=u["speaker_id"],
                language=u["language"],
                kind=u["kind"],
                code=u["code"],
                file=path,
                duration_ms=float(u["duration_ms"]),
            )
        )
    return Dataset(
        root=root,
        dataset_id=raw["dataset_id"],
        kind=raw["kind"],
        manifest_sha256=hashlib.sha256(manifest.read_bytes()).hexdigest(),
        speakers=speakers,
        utterances=utts,
    )
