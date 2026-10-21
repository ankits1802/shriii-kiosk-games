"""Per-language coverage report: ITC status distribution, milestone coverage, pack readiness and quality flags."""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field

from .checks import Severity, status_reached, validate_translation_file
from .models import Catalogue, GlossaryTerm, TranslationFile, Workflow
from .text import estimate_duration


@dataclass
class LanguageCoverage:
    language: str
    name: str
    total_lines: int
    entries: int
    to_record: int
    with_text: int
    with_back_translation: int
    status_counts: dict[str, int]
    milestones: dict[str, float]
    pack_ready: dict[str, float]
    by_category: dict[str, dict[str, int]]
    errors: int
    warnings: int
    issue_codes: dict[str, int]
    duration_within_tolerance: int
    duration_flagged: int
    duration_checked: int
    stale: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return self.__dict__.copy()


def language_coverage(
    data: TranslationFile, catalogue: Catalogue, workflow: Workflow, glossary: list[GlossaryTerm] | None = None
) -> LanguageCoverage:
    lang = workflow.language(data.language)
    lines = catalogue.by_id()
    entries = [e for e in data.entries if e.id in lines]
    total = len(catalogue.lines)
    to_record = [e for e in entries if e.record]
    status_counts = Counter(e.status for e in entries)
    milestones: dict[str, float] = {}
    for st in workflow.forward_path():
        reached = sum(1 for e in entries if status_reached(workflow, e.status, st.id))
        milestones[st.id] = round(reached / total, 4) if total else 0.0
    pack_ready: dict[str, float] = {}
    for pack, allowed in workflow.pack_eligibility.items():
        # Only lines this language records go into its audio pack.
        ok = sum(1 for e in to_record if e.status in allowed)
        pack_ready[pack] = round(ok / len(to_record), 4) if to_record else 0.0
    by_category: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for e in entries:
        by_category[lines[e.id].category][e.status] += 1
    within = flagged = checked = 0
    for e in to_record:
        if e.text:
            est = estimate_duration(e.text, lang.script, lang.tag, lines[e.id].target_duration_ms, workflow.quality)
            checked += 1
            within += est.within_tolerance
            flagged += est.flagged
    issues = validate_translation_file(data, catalogue, workflow, glossary)
    return LanguageCoverage(
        language=lang.tag,
        name=lang.name,
        total_lines=total,
        entries=len(entries),
        to_record=len(to_record),
        with_text=sum(1 for e in entries if e.text),
        with_back_translation=sum(1 for e in entries if e.back_translation),
        status_counts={s: status_counts.get(s, 0) for s in workflow.status_ids()},
        milestones=milestones,
        pack_ready=pack_ready,
        by_category={k: dict(v) for k, v in sorted(by_category.items())},
        errors=len(issues.errors),
        warnings=len(issues.warnings),
        issue_codes=dict(Counter(i.code for i in issues.items)),
        duration_within_tolerance=within,
        duration_flagged=flagged,
        duration_checked=checked,
        stale=sorted(i.line_id for i in issues.items if i.code == "stale_source"),
        missing=sorted(i.line_id for i in issues.items if i.code == "missing_line" and i.severity is Severity.ERROR),
    )


def _pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def render_markdown(reports: list[LanguageCoverage], workflow: Workflow, catalogue: Catalogue) -> str:
    out: list[str] = [
        "# Localisation coverage report",
        "",
        f"Catalogue `{catalogue.catalogue_version}` ({len(catalogue.lines)} lines). "
        "Milestone columns give the share of catalogue lines at or beyond that ITC status; "
        "pack readiness counts only lines the language records.",
        "",
        "## Summary",
        "",
    ]
    milestones = [s.id for s in workflow.forward_path()]
    head = [
        "Language",
        "Entries",
        "Text",
        "Back-tr.",
        *milestones,
        *(f"{p} pack" for p in workflow.pack_eligibility),
        "Errors",
        "Warnings",
    ]
    out.append("| " + " | ".join(head) + " |")
    out.append("|" + "---|" * len(head))
    for r in reports:
        row = [
            f"{r.name} ({r.language})",
            f"{r.entries}/{r.total_lines}",
            str(r.with_text),
            str(r.with_back_translation),
            *(_pct(r.milestones[m]) for m in milestones),
            *(_pct(r.pack_ready[p]) for p in workflow.pack_eligibility),
            str(r.errors),
            str(r.warnings),
        ]
        out.append("| " + " | ".join(row) + " |")
    for r in reports:
        out += ["", f"## {r.name} ({r.language})", "", "| Status | Lines |", "|---|---|"]
        for st, n in r.status_counts.items():
            if n:
                out.append(f"| {st} | {n} |")
        out += [
            "",
            "| Category | " + " | ".join(workflow.status_ids()) + " |",
            "|---|" + "---|" * len(workflow.status_ids()),
        ]
        for cat, counts in r.by_category.items():
            out.append(f"| {cat} | " + " | ".join(str(counts.get(s, 0)) for s in workflow.status_ids()) + " |")
        tol = workflow.quality.duration_tolerance
        out += [
            "",
            f"- Lines recorded in this language: {r.to_record}",
            f"- Estimated spoken duration within +-{tol:.0%} of target: "
            f"{r.duration_within_tolerance}/{r.duration_checked}; "
            f"over {workflow.quality.duration_flag_ratio}x target (VOX-02 flag): {r.duration_flagged}",
        ]
        if r.issue_codes:
            out.append("- Issues: " + ", ".join(f"`{k}` x{v}" for k, v in sorted(r.issue_codes.items())))
        if r.missing:
            out.append(f"- Missing entries: {', '.join(r.missing)}")
        if r.stale:
            out.append(f"- Stale (source changed): {', '.join(r.stale)}")
    return "\n".join(out) + "\n"
