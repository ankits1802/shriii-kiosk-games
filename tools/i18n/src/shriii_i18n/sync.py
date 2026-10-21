"""Keep translation files aligned with the catalogue (new lines, catalogue order, orphans, stale sources)."""

from __future__ import annotations

from dataclasses import dataclass, field

from .models import Catalogue, TranslationEntry, TranslationFile, Workflow
from .repo import CATALOGUE_REL
from .text import source_hash


@dataclass
class SyncReport:
    language: str
    added: list[str] = field(default_factory=list)
    orphans: list[str] = field(default_factory=list)
    pruned: list[str] = field(default_factory=list)
    stale: list[str] = field(default_factory=list)
    reordered: bool = False

    @property
    def changed(self) -> bool:
        return bool(self.added or self.pruned or self.reordered)


def empty_translation_file(catalogue: Catalogue, workflow: Workflow, language: str) -> TranslationFile:
    lang = workflow.language(language)
    return TranslationFile(
        schema_version="1.0",
        language=lang.tag,
        script=lang.script,
        source_catalogue=CATALOGUE_REL.as_posix(),
        source_catalogue_version=catalogue.catalogue_version,
        provenance="Skeleton created by `shriii-i18n sync`; no translations yet.",
        register_guide=f"content/i18n/translations/register-guide.yaml#{lang.tag}",
        entries=[],
    )


def sync_translation_file(
    data: TranslationFile, catalogue: Catalogue, workflow: Workflow, *, prune: bool = False
) -> tuple[TranslationFile, SyncReport]:
    """Return an aligned copy of ``data``. Never rewrites text or status; stale entries are only reported."""
    report = SyncReport(language=data.language)
    existing = data.by_id()
    lines = catalogue.by_id()
    new_entries: list[TranslationEntry] = []
    for line in catalogue.lines:
        entry = existing.get(line.id)
        if entry is None:
            entry = TranslationEntry(
                id=line.id,
                source_text=line.reference_text,
                source_hash=source_hash(line.reference_text),
                status=workflow.initial_status,
            )
            report.added.append(line.id)
        elif entry.source_hash != source_hash(line.reference_text):
            report.stale.append(line.id)
        new_entries.append(entry)
    for entry in data.entries:
        if entry.id not in lines:
            if prune:
                report.pruned.append(entry.id)
            else:
                report.orphans.append(entry.id)
                new_entries.append(entry)
    old_order = [e.id for e in data.entries]
    kept_old_order = [i for i in old_order if i in {e.id for e in new_entries}]
    report.reordered = [e.id for e in new_entries if e.id in set(old_order)] != kept_old_order
    updated = data.model_copy(update={"entries": new_entries, "source_catalogue_version": catalogue.catalogue_version})
    return updated, report
