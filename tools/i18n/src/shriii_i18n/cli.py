"""`shriii-i18n` command line: validate, sync, export, import, coverage and ITC trail export."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from .checks import IssueList, validate_translation_file
from .coverage import language_coverage, render_markdown
from .repo import Repo, RepoError
from .spreadsheet import WorkbookError, export_workbook, import_workbook, read_workbook_language
from .sync import empty_translation_file, sync_translation_file

EXIT_OK, EXIT_INVALID, EXIT_USAGE = 0, 1, 2


def _languages(repo: Repo, requested: list[str] | None) -> list[str]:
    workflow = repo.load_workflow()
    known = [lang.tag for lang in workflow.languages]
    if not requested:
        return known
    unknown = [r for r in requested if r not in known]
    if unknown:
        raise RepoError(f"unknown language(s) {', '.join(unknown)}; configured: {', '.join(known)}")
    return requested


def _print_issues(issues: IssueList, *, quiet_warnings: bool) -> None:
    for issue in issues.items:
        if quiet_warnings and issue.severity.value == "warning":
            continue
        print(issue.render())


def cmd_validate(args: argparse.Namespace, repo: Repo) -> int:
    catalogue, workflow = repo.load_catalogue(), repo.load_workflow()
    guide = repo.load_register_guide()
    glossary = guide.glossary if guide else None
    total = IssueList()
    for tag in _languages(repo, args.lang):
        issues = validate_translation_file(repo.load_translations(workflow, tag), catalogue, workflow, glossary)
        total.extend(issues)
        print(f"{tag}: {len(issues.errors)} error(s), {len(issues.warnings)} warning(s)")
    _print_issues(total, quiet_warnings=not args.warnings)
    if args.strict and total.warnings:
        return EXIT_INVALID
    return EXIT_OK if total.ok else EXIT_INVALID


def cmd_sync(args: argparse.Namespace, repo: Repo) -> int:
    catalogue, workflow = repo.load_catalogue(), repo.load_workflow()
    for tag in _languages(repo, args.lang):
        path = repo.translation_path(workflow, tag)
        data = (
            repo.load_translations(workflow, tag) if path.exists() else empty_translation_file(catalogue, workflow, tag)
        )
        updated, report = sync_translation_file(data, catalogue, workflow, prune=args.prune)
        print(
            f"{tag}: +{len(report.added)} added, {len(report.pruned)} pruned, {len(report.orphans)} orphan(s), "
            f"{len(report.stale)} stale{', reordered' if report.reordered else ''}"
        )
        for line_id in report.stale:
            print(f"  stale: {line_id} (source text changed; flag for revision)")
        for line_id in report.orphans:
            print(f"  orphan: {line_id} (not in catalogue; use --prune to remove)")
        if not args.dry_run and (report.changed or not path.exists() or updated != data):
            repo.save_translations(workflow, updated)
    return EXIT_OK


def cmd_export(args: argparse.Namespace, repo: Repo) -> int:
    catalogue, workflow = repo.load_catalogue(), repo.load_workflow()
    out_dir: Path = args.out_dir
    stamp = dt.date.today().isoformat()
    for tag in _languages(repo, args.lang):
        data = repo.load_translations(workflow, tag)
        path = export_workbook(out_dir / f"shriii-translations_{tag}_{stamp}.xlsx", data, catalogue, workflow)
        print(f"{tag}: wrote {path}")
    return EXIT_OK


def cmd_import(args: argparse.Namespace, repo: Repo) -> int:
    catalogue, workflow = repo.load_catalogue(), repo.load_workflow()
    status = EXIT_OK
    reports = []
    for wb_path in args.workbooks:
        tag = read_workbook_language(wb_path)
        data = repo.load_translations(workflow, tag)
        today = dt.date.fromisoformat(args.today) if args.today else None
        guide = repo.load_register_guide()
        result = import_workbook(
            wb_path, data, catalogue, workflow, today=today, glossary=guide.glossary if guide else None
        )
        reports.append(result.summary())
        _print_issues(result.issues, quiet_warnings=False)
        verdict = "OK" if result.ok else "REJECTED"
        print(
            f"{wb_path.name} ({tag}): {verdict}; {len(result.changes)} row(s) changed, "
            f"{len(result.issues.errors)} error(s), {len(result.issues.warnings)} warning(s)"
        )
        if not result.ok:
            status = EXIT_INVALID
        elif result.updated is not None and not args.dry_run:
            print(f"  updated {repo.save_translations(workflow, result.updated)}")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
    return status


def cmd_coverage(args: argparse.Namespace, repo: Repo) -> int:
    catalogue, workflow = repo.load_catalogue(), repo.load_workflow()
    guide = repo.load_register_guide()
    glossary = guide.glossary if guide else None
    reports = [
        language_coverage(repo.load_translations(workflow, t), catalogue, workflow, glossary)
        for t in _languages(repo, args.lang)
    ]
    if args.format == "json":
        text = json.dumps([r.as_dict() for r in reports], ensure_ascii=False, indent=2)
    else:
        text = render_markdown(reports, workflow, catalogue)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        sys.stdout.write(text)
    if args.min_status:
        workflow.status(args.min_status)  # KeyError -> usage error below
        failing = [r for r in reports if r.milestones.get(args.min_status, 0.0) < args.min_ratio]
        for r in failing:
            print(
                f"{r.language}: only {r.milestones.get(args.min_status, 0.0):.1%} of lines at or beyond "
                f"{args.min_status} (need {args.min_ratio:.0%})",
                file=sys.stderr,
            )
        if failing:
            return EXIT_INVALID
    return EXIT_OK


def cmd_trail(args: argparse.Namespace, repo: Repo) -> int:
    workflow = repo.load_workflow()
    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    for tag in _languages(repo, args.lang):
        data = repo.load_translations(workflow, tag)
        path = out_dir / f"shriii-itc-trail_{tag}.csv"
        with path.open("w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(
                [
                    "language",
                    "line_id",
                    "seq",
                    "from_status",
                    "to_status",
                    "by",
                    "role",
                    "date",
                    "comment",
                    "source",
                    "current_status",
                ]
            )
            for entry in data.entries:
                if not entry.history:
                    writer.writerow(
                        [tag, entry.id, 0, "", entry.status, "", "", "", "no sign-offs yet", "", entry.status]
                    )
                for n, ev in enumerate(entry.history, start=1):
                    writer.writerow(
                        [
                            tag,
                            entry.id,
                            n,
                            ev.from_status,
                            ev.to_status,
                            ev.by,
                            ev.role,
                            ev.date.isoformat(),
                            ev.comment,
                            ev.source,
                            entry.status,
                        ]
                    )
        print(f"{tag}: wrote {path}")
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="shriii-i18n", description=__doc__)
    parser.add_argument("--root", type=Path, default=None, help="repository root (default: discovered from cwd)")
    sub = parser.add_subparsers(dest="command", required=True)

    def lang_opt(p: argparse.ArgumentParser) -> None:
        p.add_argument("--lang", action="append", help="language tag (repeatable; default: all configured)")

    p = sub.add_parser("validate", help="validate translation YAML against the catalogue and workflow (CI)")
    lang_opt(p)
    p.add_argument("--warnings", action="store_true", help="print warnings as well as errors")
    p.add_argument("--strict", action="store_true", help="fail on warnings too")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("sync", help="add new catalogue lines as drafts, restore catalogue order, report stale/orphans")
    lang_opt(p)
    p.add_argument("--prune", action="store_true", help="remove entries whose line left the catalogue")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("export", help="write one review workbook (.xlsx) per language")
    lang_opt(p)
    p.add_argument("--out-dir", type=Path, default=Path("i18n-exports"))
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("import", help="validate reviewed workbooks and apply them to the YAML (all-or-nothing)")
    p.add_argument("workbooks", type=Path, nargs="+")
    p.add_argument("--dry-run", action="store_true", help="validate only; never write YAML")
    p.add_argument("--report", type=Path, help="write a JSON issue report")
    p.add_argument("--today", help="override today's date (YYYY-MM-DD) for the future-date check")
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("coverage", help="coverage report per language (markdown or JSON)")
    lang_opt(p)
    p.add_argument("--format", choices=["md", "json"], default="md")
    p.add_argument("--out", type=Path)
    p.add_argument("--min-status", help="fail unless --min-ratio of lines are at or beyond this status")
    p.add_argument("--min-ratio", type=float, default=1.0)
    p.set_defaults(func=cmd_coverage)

    p = sub.add_parser("trail", help="export the ITC sign-off trail per language as CSV")
    lang_opt(p)
    p.add_argument("--out-dir", type=Path, default=Path("i18n-exports"))
    p.set_defaults(func=cmd_trail)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        repo = Repo.discover(args.root)
        return int(args.func(args, repo))
    except (RepoError, WorkbookError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID
    except KeyError as exc:
        print(f"error: unknown key {exc}", file=sys.stderr)
        return EXIT_USAGE
    except ValueError as exc:  # pydantic ValidationError is a ValueError
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
