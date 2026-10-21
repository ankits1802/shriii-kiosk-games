"""Command line: ``shriii-reports render`` / ``validate`` / ``kinds``.

Exit codes: 0 success; 1 integrity problem with ``--strict``; 2 usage, input or validation error.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path

import yaml
from pydantic import ValidationError

from shriii_reports.model import REPORT_KINDS, ReportBundle
from shriii_reports.prepare import load_registry, prepare_context
from shriii_reports.render import REPORT_SPECS, load_bundle, write_report

__all__ = ["main"]


def _default(name: str) -> Path | None:
    here = Path.cwd().resolve()
    for parent in [here, *here.parents]:
        cand = parent / "stats" / "measurement-model" / name
        if cand.is_file():
            return cand
    return None


def _parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="shriii-reports", description=__doc__)
    sub = ap.add_subparsers(dest="command", required=True)
    r = sub.add_parser("render", help="render one or more report bundles")
    r.add_argument("bundles", nargs="+", type=Path, help="report bundle JSON file(s)")
    r.add_argument("--formats", default="md,html,qmd", help="comma-separated: md,html,qmd")
    r.add_argument("--out-dir", type=Path, default=Path("build/reports"))
    r.add_argument(
        "--hypotheses",
        type=Path,
        default=None,
        help="hypotheses.yaml (default: stats/measurement-model/hypotheses.yaml)",
    )
    r.add_argument("--gates", type=Path, default=None, help="gates.yaml (default: stats/measurement-model/gates.yaml)")
    r.add_argument(
        "--no-registry", action="store_true", help="render without hypotheses/gates (classification unchecked)"
    )
    r.add_argument("--strict", action="store_true", help="exit 1 if any integrity or classification warning arises")
    v = sub.add_parser("validate", help="validate bundle JSON against the report-bundle model")
    v.add_argument("bundles", nargs="+", type=Path)
    sub.add_parser("kinds", help="list report kinds")
    sub.add_parser("schema", help="print the report-bundle JSON Schema")
    return ap


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "kinds":
        for k in REPORT_KINDS:
            print(f"{k}: {REPORT_SPECS[k]['template']}")
        return 0
    if args.command == "schema":
        print(json.dumps(ReportBundle.model_json_schema(by_alias=True), indent=2))
        return 0
    if args.command == "validate":
        rc = 0
        for b in args.bundles:
            try:
                bundle = load_bundle(b)
                print(f"ok: {b} ({bundle.report.kind}, {len(bundle.results)} results)")
            except (OSError, ValueError, ValidationError) as exc:
                print(f"invalid: {b}: {exc}", file=sys.stderr)
                rc = 2
        return rc

    formats = [f.strip() for f in args.formats.split(",") if f.strip()]
    if args.no_registry:
        registry = load_registry(None, None)
    else:
        hyp = args.hypotheses or _default("hypotheses.yaml")
        gates = args.gates or _default("gates.yaml")
        if hyp is None or gates is None:
            print(
                "error: hypotheses.yaml / gates.yaml not found; pass --hypotheses/--gates or --no-registry",
                file=sys.stderr,
            )
            return 2
        try:
            registry = load_registry(hyp, gates)
        except (OSError, ValueError, yaml.YAMLError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
    rc = 0
    for b in args.bundles:
        try:
            bundle = load_bundle(b)
        except (OSError, ValueError, ValidationError) as exc:
            print(f"invalid: {b}: {exc}", file=sys.stderr)
            return 2
        ctx = prepare_context(bundle, registry, section_order=REPORT_SPECS[bundle.report.kind]["sections"])
        problems = [*ctx["integrity_warnings"], *ctx["classification_warnings"]]
        if args.no_registry and args.strict:
            problems.append("rendered with --no-registry: confirmatory classification was not checked")
        for p in problems:
            print(f"warning: {b.name}: {p}", file=sys.stderr)
        if args.strict and problems:
            rc = 1
            continue
        written = write_report(bundle, args.out_dir, formats=formats, registry=registry)
        for fmt, path in written.items():
            print(f"wrote {fmt}: {path}")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
