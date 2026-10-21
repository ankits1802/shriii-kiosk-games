"""Validation rules shared by `validate` (YAML in git) and `import` (XLSX round-trip)."""

from __future__ import annotations

import datetime as dt
from dataclasses import asdict, dataclass, field
from enum import StrEnum

from .models import (
    Catalogue,
    CatalogueLine,
    GlossaryTerm,
    LanguageDef,
    TranslationEntry,
    TranslationFile,
    Workflow,
)
from .text import estimate_duration, latin_letter_count, normalise, placeholder_mismatch, script_share, source_hash


class Severity(StrEnum):
    ERROR = "error"
    WARNING = "warning"


@dataclass(frozen=True)
class Issue:
    severity: Severity
    code: str
    message: str
    language: str = ""
    line_id: str = ""
    row: int | None = None

    def as_dict(self) -> dict[str, object]:
        out = asdict(self)
        out["severity"] = self.severity.value
        return out

    def render(self) -> str:
        where = " ".join(p for p in (self.language, self.line_id, f"row {self.row}" if self.row else "") if p)
        return (
            f"[{self.severity.value.upper()}] {self.code}: {where}: {self.message}"
            if where
            else (f"[{self.severity.value.upper()}] {self.code}: {self.message}")
        )


@dataclass
class IssueList:
    items: list[Issue] = field(default_factory=list)

    def add(self, severity: Severity, code: str, message: str, **where: object) -> None:
        self.items.append(Issue(severity, code, message, **where))  # type: ignore[arg-type]

    def error(self, code: str, message: str, **where: object) -> None:
        self.add(Severity.ERROR, code, message, **where)

    def warning(self, code: str, message: str, **where: object) -> None:
        self.add(Severity.WARNING, code, message, **where)

    def extend(self, other: IssueList) -> None:
        self.items.extend(other.items)

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.items if i.severity is Severity.ERROR]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.items if i.severity is Severity.WARNING]

    @property
    def ok(self) -> bool:
        return not self.errors


def status_reached(workflow: Workflow, status: str, milestone: str) -> bool:
    """True when ``status`` is at or beyond ``milestone`` on the forward path (revision state never is)."""
    rank, target = workflow.status(status).rank, workflow.status(milestone).rank
    return rank is not None and target is not None and rank >= target


def check_entry_content(
    entry: TranslationEntry,
    line: CatalogueLine,
    lang: LanguageDef,
    workflow: Workflow,
    *,
    row: int | None = None,
) -> IssueList:
    """Content rules that hold for an entry regardless of how it got into its current state."""
    issues = IssueList()
    where: dict[str, object] = {"language": lang.tag, "line_id": entry.id, "row": row}

    if entry.status not in workflow.status_ids():
        issues.error("unknown_status", f"status {entry.status!r} is not declared in workflow.yaml", **where)
        return issues
    status = workflow.status(entry.status)

    if entry.source_hash != source_hash(line.reference_text):
        issues.error(
            "stale_source",
            "catalogue reference_text changed since this translation was made "
            f"(was {entry.source_text!r}, now {line.reference_text!r}); flag for revision and re-translate",
            **where,
        )
    elif normalise(entry.source_text) != normalise(line.reference_text):
        issues.error("source_snapshot_mismatch", "source_text does not match its source_hash", **where)

    for req in status.requires:
        if req == "text" and not entry.text:
            issues.error("missing_text", f"status {entry.status} requires a translation", **where)
        if req == "back_translation" and not entry.back_translation:
            issues.error("missing_back_translation", f"status {entry.status} requires a back-translation", **where)

    if entry.text:
        missing, extra = placeholder_mismatch(line.reference_text, entry.text)
        if missing or extra:
            issues.error(
                "placeholder_mismatch",
                f"placeholders differ from the source (missing {missing or '[]'}, extra {extra or '[]'})",
                **where,
            )
        share = script_share(entry.text, lang.script)
        if share < 0.5:
            issues.error(
                "wrong_script",
                f"only {share:.0%} of letters are in the expected script {lang.script}",
                **where,
            )
        latin = latin_letter_count(entry.text)
        if lang.script != "Latn" and latin > workflow.quality.max_latin_letters:
            issues.warning(
                "latin_in_script",
                f"{latin} Latin letters in a {lang.script} recording script; transliterate loanwords",
                **where,
            )
        if entry.record:
            est = estimate_duration(entry.text, lang.script, lang.tag, line.target_duration_ms, workflow.quality)
            if est.flagged:
                issues.warning(
                    "duration_over_flag_ratio",
                    f"estimated {est.estimated_ms} ms is {est.ratio:.2f}x the {line.target_duration_ms} ms target "
                    f"(flag ratio {workflow.quality.duration_flag_ratio}); shorten or agree a new target",
                    **where,
                )
    if entry.back_translation and entry.text == entry.back_translation:
        issues.error("back_translation_copies_text", "back-translation is identical to the translation", **where)
    if not entry.record and not entry.record_note:
        issues.error("record_note_missing", "record: false needs a record_note explaining why", **where)
    return issues


def check_history(entry: TranslationEntry, workflow: Workflow, *, language: str) -> IssueList:
    """The history must be a valid walk from the initial status that ends at the entry's status."""
    issues = IssueList()
    where: dict[str, object] = {"language": language, "line_id": entry.id}
    current = workflow.initial_status
    last_date: dt.date | None = None
    signers: dict[str, str] = {}
    for n, ev in enumerate(entry.history, start=1):
        if ev.from_status != current:
            issues.error(
                "history_gap", f"event {n} starts at {ev.from_status!r} but the entry was at {current!r}", **where
            )
        problems = transition_problems(
            workflow, ev.from_status, ev.to_status, Signoff(ev.by, ev.role, ev.comment), signers
        )
        for code, msg in problems:
            issues.error(code, f"event {n}: {msg}", **where)
        if last_date and ev.date < last_date:
            issues.error("history_date_order", f"event {n} is dated before the previous event", **where)
        last_date = ev.date
        signers[ev.to_status] = ev.by
        current = ev.to_status
    if current != entry.status:
        issues.error("history_status_mismatch", f"history ends at {current!r} but status is {entry.status!r}", **where)
    return issues


@dataclass(frozen=True)
class Signoff:
    """Who signed a status change, in which role, with what comment."""

    signer: str
    role: str
    comment: str = ""


def transition_problems(
    workflow: Workflow,
    from_status: str,
    to_status: str,
    signoff: Signoff,
    prior_signers: dict[str, str],
) -> list[tuple[str, str]]:
    """Return (code, message) problems for one status transition and its sign-off.

    ``prior_signers`` maps each status already reached to the person who signed it (independence rules).
    """
    role, signer, comment = signoff.role, signoff.signer, signoff.comment
    problems: list[tuple[str, str]] = []
    known = workflow.status_ids()
    if from_status not in known or to_status not in known:
        return [("unknown_status", f"{from_status!r} -> {to_status!r} uses an undeclared status")]
    allowed = workflow.transitions.get(from_status, [])
    if to_status not in allowed:
        f_rank, t_rank = workflow.status(from_status).rank, workflow.status(to_status).rank
        kind = "backward" if (f_rank is not None and t_rank is not None and t_rank < f_rank) else "skipping"
        problems.append(
            (
                "illegal_transition",
                f"{from_status} -> {to_status} is not allowed ({kind}); allowed next: {', '.join(allowed) or 'none'}",
            )
        )
    target = workflow.status(to_status)
    if not signer.strip():
        problems.append(("signoff_missing", f"moving to {to_status} needs a reviewer name"))
    if target.signoff_role == "*":
        if role not in workflow.roles:
            problems.append(("signoff_role", f"role {role!r} is not a known role"))
    elif target.signoff_role and role != target.signoff_role:
        problems.append(
            ("signoff_role", f"moving to {to_status} must be signed by a {target.signoff_role}, got {role!r}")
        )
    if "review_comment" in target.requires and not comment.strip():
        problems.append(("comment_missing", f"moving to {to_status} needs a review comment"))
    for a, b in workflow.independent_signers:
        if to_status == b and a in prior_signers and prior_signers[a].strip().casefold() == signer.strip().casefold():
            problems.append(("signoff_not_independent", f"{b} must be signed by someone other than the {a} signer"))
    return problems


def field_edit_allowed(workflow: Workflow, field_name: str, old_status: str, new_status: str) -> bool:
    rule = workflow.fields[field_name]  # type: ignore[index]
    if old_status == new_status:
        return new_status in rule.editable_in
    return new_status in rule.editable_on_entering


def check_glossary(
    entry: TranslationEntry, line: CatalogueLine, language: str, glossary: list[GlossaryTerm], *, row: int | None = None
) -> IssueList:
    """Warn when a source concept is present but none of the accepted target forms appears in the script."""
    issues = IssueList()
    if not entry.text:
        return issues
    text = normalise(entry.text)
    for term in glossary:
        accepted = term.terms.get(language)
        if not accepted or not term.applies_to(line.reference_text):
            continue
        if not any(normalise(form) in text for form in accepted):
            issues.warning(
                "glossary_term",
                f"source mentions '{term.concept}' but the script uses none of: {', '.join(accepted)}",
                language=language,
                line_id=entry.id,
                row=row,
            )
    return issues


def validate_translation_file(
    data: TranslationFile,
    catalogue: Catalogue,
    workflow: Workflow,
    glossary: list[GlossaryTerm] | None = None,
) -> IssueList:
    """Full validation of one language file against the catalogue, the workflow and (optionally) the glossary."""
    issues = IssueList()
    lang = workflow.language(data.language)
    if data.script != lang.script:
        issues.error(
            "script_mismatch", f"file declares script {data.script}, workflow says {lang.script}", language=lang.tag
        )
    if data.source_catalogue_version != catalogue.catalogue_version:
        issues.warning(
            "catalogue_version",
            f"made from catalogue {data.source_catalogue_version}, current is {catalogue.catalogue_version}",
            language=lang.tag,
        )
    lines = catalogue.by_id()
    entries = data.by_id()
    for line_id in lines:
        if line_id not in entries:
            issues.error(
                "missing_line",
                "catalogue line has no translation entry (run `shriii-i18n sync`)",
                language=lang.tag,
                line_id=line_id,
            )
    for entry in data.entries:
        if entry.id not in lines:
            issues.error(
                "orphan_entry",
                "entry has no catalogue line (run `shriii-i18n sync --prune`)",
                language=lang.tag,
                line_id=entry.id,
            )
            continue
        issues.extend(check_entry_content(entry, lines[entry.id], lang, workflow))
        issues.extend(check_history(entry, workflow, language=lang.tag))
        if glossary:
            issues.extend(check_glossary(entry, lines[entry.id], lang.tag, glossary))
    order = [e.id for e in data.entries if e.id in lines]
    expected = [line.id for line in catalogue.lines if line.id in entries]
    if order != expected:
        issues.warning("entry_order", "entries are not in catalogue order (run `shriii-i18n sync`)", language=lang.tag)
    return issues
