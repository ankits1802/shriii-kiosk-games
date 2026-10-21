"""Command line: ``shriii-prereg generate`` and ``shriii-prereg verify``.

Exit codes: 0 success; 1 verification mismatch or strict-mode check failure; 2 usage / input error.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from shriii_prereg.build import PreregBuildError, build_document
from shriii_prereg.inputs import find_repo_root, load_inputs
from shriii_prereg.render import write_outputs
from shriii_prereg.verify import verify_document

__all__ = ["main"]


def _parse_time(value: str) -> datetime:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"not an ISO-8601 timestamp: {value!r}") from exc
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="shriii-prereg", description=__doc__)
    ap.add_argument("--repo-root", type=Path, default=None, help="repository root (default: auto-detect)")
    sub = ap.add_subparsers(dest="command", required=True)

    g = sub.add_parser("generate", help="generate the pre-registration document")
    g.add_argument(
        "--scoring-dir", type=Path, default=None, help="directory with hypotheses.yaml, gates.yaml, dictionary/"
    )
    g.add_argument(
        "--config", type=Path, default=None, help="generator config (default tools/prereg/prereg.config.yaml)"
    )
    g.add_argument("--out-dir", type=Path, default=Path("build/prereg"), help="output directory (default build/prereg)")
    g.add_argument("--formats", default="md,html,json", help="comma-separated: md,html,json")
    g.add_argument("--basename", default="preregistration")
    g.add_argument(
        "--generated-at", type=_parse_time, default=None, help="fixed timestamp for reproducible output (ISO-8601)"
    )
    g.add_argument("--strict", action="store_true", help="fail (exit 1) on any cross-reference error")
    g.add_argument("--require-frozen", action="store_true", help="fail (exit 1) unless every input is frozen")

    v = sub.add_parser("verify", help="verify a generated document's embedded input hashes")
    v.add_argument("document", type=Path, help="generated .md, .html or .json")
    return ap


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        root = (args.repo_root or find_repo_root(Path.cwd())).resolve()
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.command == "verify":
        try:
            res = verify_document(args.document, root)
        except (OSError, ValueError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        for c in res.checked:
            print(f"{'OK      ' if c['match'] else 'CHANGED '} {c['path']}")
        for p in res.problems:
            print(f"problem: {p}", file=sys.stderr)
        print("verified: inputs unchanged" if res.ok else "NOT verified: inputs differ from the registered document")
        return 0 if res.ok else 1

    formats = [f.strip() for f in args.formats.split(",") if f.strip()]
    try:
        inputs = load_inputs(args.scoring_dir, args.config, root)
        doc = build_document(
            inputs, generated_at=args.generated_at, strict=args.strict, require_frozen=args.require_frozen
        )
    except PreregBuildError as exc:
        for i in exc.issues:
            print(f"[{i['severity']}] {i['code']}: {i['message']}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    out_dir = args.out_dir if args.out_dir.is_absolute() else Path.cwd() / args.out_dir
    try:
        written = write_outputs(doc, out_dir, formats=formats, basename=args.basename, repo_root=root)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    for i in doc["issues"]:
        print(f"[{i['severity']}] {i['code']}: {i['message']}", file=sys.stderr)
    for fmt, path in written.items():
        print(f"wrote {fmt}: {path}")
    print(f"status: {doc['meta']['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
