"""Typed models for the line catalogue, the per-language translation files and the ITC workflow config.

The catalogue (``content/i18n/lines.yaml``) is owned by the content pipeline and is read-only here; only the
fields this tool needs are modelled and unknown fields are ignored. Translation files and the workflow config
are owned by this tool and are validated strictly (unknown keys are rejected).
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

LanguageTag = Annotated[str, StringConstraints(pattern=r"^[a-z]{2,3}-[A-Z]{2}$")]
LineId = Annotated[str, StringConstraints(pattern=r"^[a-z0-9_]+(\.[a-z0-9_]+)+$")]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=False)


# --------------------------------------------------------------------------------------------------------------
# Catalogue (read-only input)
# --------------------------------------------------------------------------------------------------------------


class CatalogueLine(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: LineId
    category: str
    module_id: str | None = None
    speaker_role: str
    context: str
    reference_text: str
    target_duration_ms: int = Field(gt=0)
    tone: str
    voice_forbidden: bool = False


class Catalogue(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema_version: str
    catalogue_version: str
    reference_language: LanguageTag
    languages: list[LanguageTag]
    lines: list[CatalogueLine]

    @model_validator(mode="after")
    def _unique_ids(self) -> Catalogue:
        seen: set[str] = set()
        for line in self.lines:
            if line.id in seen:
                raise ValueError(f"duplicate catalogue line id {line.id!r}")
            seen.add(line.id)
        return self

    def by_id(self) -> dict[str, CatalogueLine]:
        return {line.id: line for line in self.lines}


# --------------------------------------------------------------------------------------------------------------
# Workflow config (content/i18n/translations/workflow.yaml)
# --------------------------------------------------------------------------------------------------------------


class StatusDef(_Strict):
    id: str
    rank: int | None = Field(
        default=None, description="Position on the forward ITC path; null for the revision side-state."
    )
    label: str
    description: str
    signoff_role: str | None = Field(
        default=None, description="Role that must sign a transition INTO this status; '*' = any known role."
    )
    requires: list[Literal["text", "back_translation", "review_comment"]] = Field(default_factory=list)
    machine_draft: bool = False


class FieldEditRule(_Strict):
    editable_in: list[str] = Field(description="Statuses in which the field may be edited without a transition.")
    editable_on_entering: list[str] = Field(description="Statuses whose entry may carry an edit to the field.")


class QualityConfig(_Strict):
    duration_tolerance: float = Field(gt=0, lt=1)
    duration_flag_ratio: float = Field(gt=1)
    syllables_per_second: dict[str, float]
    sentence_pause_ms: int = Field(ge=0)
    clause_pause_ms: int = Field(ge=0)
    max_latin_letters: int = Field(ge=0)


class LanguageDef(_Strict):
    tag: LanguageTag
    name: str
    script: Literal["Deva", "Taml", "Latn"]
    translation_file: str


class Workflow(_Strict):
    schema_version: str
    initial_status: str
    roles: list[str]
    statuses: list[StatusDef]
    transitions: dict[str, list[str]]
    fields: dict[Literal["text", "back_translation"], FieldEditRule]
    independent_signers: list[tuple[str, str]] = Field(default_factory=list)
    pack_eligibility: dict[str, list[str]]
    languages: list[LanguageDef]
    quality: QualityConfig

    @model_validator(mode="after")
    def _consistent(self) -> Workflow:
        ids = [s.id for s in self.statuses]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate status ids in workflow")
        known = set(ids)
        if self.initial_status not in known:
            raise ValueError(f"initial_status {self.initial_status!r} is not a declared status")
        for src, dsts in self.transitions.items():
            if src not in known:
                raise ValueError(f"transition source {src!r} is not a declared status")
            for dst in dsts:
                if dst not in known:
                    raise ValueError(f"transition target {dst!r} (from {src!r}) is not a declared status")
                src_rank, dst_rank = self.status(src).rank, self.status(dst).rank
                if src_rank is not None and dst_rank is not None and dst_rank <= src_rank:
                    raise ValueError(f"transition {src} -> {dst} is not forward-only")
        for s in self.statuses:
            if s.signoff_role not in (None, "*") and s.signoff_role not in self.roles:
                raise ValueError(f"status {s.id!r} names unknown signoff role {s.signoff_role!r}")
        for rule in self.fields.values():
            for st in [*rule.editable_in, *rule.editable_on_entering]:
                if st not in known:
                    raise ValueError(f"field rule references unknown status {st!r}")
        for a, b in self.independent_signers:
            if a not in known or b not in known:
                raise ValueError(f"independent_signers pair ({a}, {b}) references unknown status")
        for pack, statuses in self.pack_eligibility.items():
            for st in statuses:
                if st not in known:
                    raise ValueError(f"pack {pack!r} references unknown status {st!r}")
        for lang in self.languages:
            if lang.tag not in self.quality.syllables_per_second:
                raise ValueError(f"no speech rate configured for {lang.tag}")
        return self

    def status(self, status_id: str) -> StatusDef:
        for s in self.statuses:
            if s.id == status_id:
                return s
        raise KeyError(status_id)

    def status_ids(self) -> list[str]:
        return [s.id for s in self.statuses]

    def forward_path(self) -> list[StatusDef]:
        return sorted((s for s in self.statuses if s.rank is not None), key=lambda s: s.rank or 0)

    def language(self, tag: str) -> LanguageDef:
        for lang in self.languages:
            if lang.tag == tag:
                return lang
        raise KeyError(tag)


# --------------------------------------------------------------------------------------------------------------
# Translation files (content/i18n/translations/<lang>.yaml)
# --------------------------------------------------------------------------------------------------------------


class HistoryEvent(_Strict):
    from_status: str
    to_status: str
    by: str = Field(min_length=1)
    role: str = Field(min_length=1)
    date: dt.date
    comment: str = ""
    source: str = Field(default="manual", description="e.g. 'xlsx:<file name>' or 'machine-draft'.")


class TranslationEntry(_Strict):
    id: LineId
    source_text: str = Field(description="Snapshot of the catalogue reference_text this entry was made from.")
    source_hash: str = Field(pattern=r"^[0-9a-f]{16}$")
    status: str
    text: str = ""
    back_translation: str = ""
    register_note: str = ""
    translator_note: str = ""
    record: bool = Field(default=True, description="False when this language never records this line.")
    record_note: str = ""
    history: list[HistoryEvent] = Field(default_factory=list)

    @field_validator("text", "back_translation", "register_note", "translator_note", "record_note")
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()


class TranslationFile(_Strict):
    schema_version: Literal["1.0"]
    language: LanguageTag
    script: Literal["Deva", "Taml", "Latn"]
    source_catalogue: str
    source_catalogue_version: str
    provenance: str
    register_guide: str
    entries: list[TranslationEntry]

    @model_validator(mode="after")
    def _unique(self) -> TranslationFile:
        seen: set[str] = set()
        for entry in self.entries:
            if entry.id in seen:
                raise ValueError(f"duplicate translation entry {entry.id!r} in {self.language}")
            seen.add(entry.id)
        return self

    def by_id(self) -> dict[str, TranslationEntry]:
        return {e.id: e for e in self.entries}


# --------------------------------------------------------------------------------------------------------------
# Register guide glossary (content/i18n/translations/register-guide.yaml)
# --------------------------------------------------------------------------------------------------------------


class GlossaryTerm(BaseModel):
    """A concept whose rendering must stay consistent; per-language accepted forms are matched as substrings."""

    model_config = ConfigDict(extra="forbid")

    concept: str
    source_pattern: str
    terms: dict[str, list[str]]

    @model_validator(mode="before")
    @classmethod
    def _collect_language_keys(cls, raw: object) -> object:
        if not isinstance(raw, dict) or "terms" in raw:
            return raw
        fixed = {k: v for k, v in raw.items() if k in ("concept", "source_pattern")}
        fixed["terms"] = {k: v for k, v in raw.items() if k not in ("concept", "source_pattern")}
        return fixed

    @field_validator("source_pattern")
    @classmethod
    def _compiles(cls, value: str) -> str:
        re.compile(value)
        return value

    def applies_to(self, source_text: str) -> bool:
        return re.search(self.source_pattern, source_text, flags=re.IGNORECASE) is not None


class RegisterGuide(BaseModel):
    model_config = ConfigDict(extra="allow")

    schema_version: str
    languages: dict[str, dict[str, object]]
    tone_notes: dict[str, str]
    glossary: list[GlossaryTerm] = Field(default_factory=list)
