"""Read-only access to the voice-line catalogue (``content/i18n/lines.yaml``, VOX-02/VOX-07)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from shriii_audio.contracts import validate

ITC_ORDER: tuple[str, ...] = (
    "draft",
    "forward_translated",
    "back_translated",
    "expert_reviewed",
    "recorded",
    "audio_qc",
    "think_aloud_tested",
    "approved",
)
"""Linear ITC workflow (``flagged_for_revision`` sits outside the order)."""

LANGUAGE_RE = re.compile(r"^[a-z]{2,3}-[A-Z]{2}$")
LINE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,127}$")


@dataclass(frozen=True, slots=True)
class LineStatus:
    status: str
    itc_state: str


@dataclass(frozen=True, slots=True)
class Line:
    id: str
    category: str
    module_id: str | None
    speaker_role: str
    context: str
    reference_text: str
    target_duration_ms: int
    tone: str
    voice_forbidden: bool
    recording: dict[str, LineStatus]


@dataclass(frozen=True, slots=True)
class Catalogue:
    path: str
    schema_version: str
    catalogue_version: str
    reference_language: str
    languages: tuple[str, ...]
    lines: tuple[Line, ...]

    def by_id(self) -> dict[str, Line]:
        return {line.id: line for line in self.lines}

    def get(self, line_id: str) -> Line | None:
        return self.by_id().get(line_id)


class CatalogueError(ValueError):
    """The catalogue is invalid or inconsistent."""


def _line(raw: dict[str, Any]) -> Line:
    return Line(
        id=raw["id"],
        category=raw["category"],
        module_id=raw["module_id"],
        speaker_role=raw["speaker_role"],
        context=raw["context"],
        reference_text=raw["reference_text"],
        target_duration_ms=int(raw["target_duration_ms"]),
        tone=raw["tone"],
        voice_forbidden=bool(raw["voice_forbidden"]),
        recording={
            lang: LineStatus(status=s["status"], itc_state=s["itc_state"]) for lang, s in raw["recording"].items()
        },
    )


def load_catalogue(path: Path) -> Catalogue:
    """Load and schema-validate the catalogue. The file is never written by this tool."""
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    validate(raw, "voice-line-catalogue.v1.schema.json")
    lines = tuple(_line(item) for item in raw["lines"])
    seen: set[str] = set()
    for line in lines:
        if line.id in seen:
            raise CatalogueError(f"duplicate line id {line.id!r} in {path}")
        seen.add(line.id)
    return Catalogue(
        path=str(path),
        schema_version=raw["schema_version"],
        catalogue_version=raw["catalogue_version"],
        reference_language=raw["reference_language"],
        languages=tuple(raw["languages"]),
        lines=lines,
    )


def itc_rank(state: str) -> int:
    """Position in the ITC order; ``flagged_for_revision`` ranks below ``draft``."""
    return ITC_ORDER.index(state) if state in ITC_ORDER else -1
