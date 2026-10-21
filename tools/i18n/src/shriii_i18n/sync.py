"""Keep translation files aligned with the catalogue (new lines, catalogue order, orphans, stale sources)."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

from .checks import Signoff, transition_problems
from .models import Catalogue, HistoryEvent, TranslationEntry, TranslationFile, Workflow
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


@dataclass
class RebaseReport:
    language: str
    rebased: list[str] = field(default_factory=list)
    flagged: list[str] = field(default_factory=list)
    problems: list[tuple[str, str]] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


def rebase_stale(
    data: TranslationFile,
    catalogue: Catalogue,
    workflow: Workflow,
    *,
    by: str = "",
    role: str = "",
    today: dt.date | None = None,
) -> tuple[TranslationFile, RebaseReport]:
    """Point stale entries at the current catalogue text so they can be re-translated.

    Entries with no sign-off against the old source (machine drafts) or already in the revision state only
    get a new source snapshot. Every other stale entry is moved to the workflow's revision state with a signed
    history event (``by`` / ``role``), because its script, back-translation and any recording no longer match it.
    Nothing is changed when any entry cannot be rebased (all-or-nothing).
    """
    today = today or dt.date.today()
    report = RebaseReport(language=data.language)
    lines = catalogue.by_id()
    new_entries: list[TranslationEntry] = []
    for entry in data.entries:
        line = lines.get(entry.id)
        if line is None or entry.source_hash == source_hash(line.reference_text):
            new_entries.append(entry)
            continue
        update: dict[str, object] = {
            "source_text": line.reference_text,
            "source_hash": source_hash(line.reference_text),
        }
        if entry.status == workflow.initial_status or workflow.status(entry.status).rank is None:
            report.rebased.append(entry.id)
            new_entries.append(entry.model_copy(update=update))
            continue
        revision = [t for t in workflow.transitions.get(entry.status, []) if workflow.status(t).rank is None]
        if not revision:
            report.problems.append((entry.id, f"status {entry.status} has no transition to a revision state"))
            new_entries.append(entry)
            continue
        target = revision[0]
        comment = f"Source text changed: {entry.source_text!r} -> {line.reference_text!r}"
        prior = {ev.to_status: ev.by for ev in entry.history}
        problems = transition_problems(workflow, entry.status, target, Signoff(by, role, comment), prior)
        if entry.history and today < entry.history[-1].date:
            problems.append(("history_date_order", "today is before the previous sign-off"))
        if problems:
            report.problems.extend((entry.id, f"{code}: {msg}") for code, msg in problems)
            new_entries.append(entry)
            continue
        event = HistoryEvent(
            from_status=entry.status,
            to_status=target,
            by=by.strip(),
            role=role,
            date=today,
            comment=comment,
            source="sync:rebase-stale",
        )
        update.update({"status": target, "history": [*entry.history, event]})
        report.flagged.append(entry.id)
        new_entries.append(entry.model_copy(update=update))
    if not report.ok:
        return data, report
    return data.model_copy(update={"entries": new_entries}), report
