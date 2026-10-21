"""``shriii-audio`` command line.

Subcommands::

    keygen   create an ed25519 signing key pair (private PEM + public JSON)
    check    validate recording file names against the catalogue (no processing)
    process  QC + master + encode a folder of recordings; write signed manifests, QC report, status YAML
    promote  apply an approvals YAML (think_aloud_tested / approved / flagged) and re-sign
    verify   verify manifest signatures, schema and clip hashes of a pack directory
    scripts  write per-language recording scripts (XLSX + printable HTML)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from shriii_audio import manifest as manifest_mod
from shriii_audio.catalogue import load_catalogue
from shriii_audio.config import load_qc_config
from shriii_audio.paths import default_catalogue, default_out_dir
from shriii_audio.process import parse_filename, process_directory
from shriii_audio.report import write_report
from shriii_audio.scripts import load_translations, write_scripts
from shriii_audio.signing import SigningKey, generate_key, load_private_key, load_public_key
from shriii_audio.status import write_status


def _key_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--key", type=Path, default=os.environ.get("SHRIII_AUDIO_SIGNING_KEY"), help="private key PEM")
    p.add_argument("--key-id", default=os.environ.get("SHRIII_AUDIO_KEY_ID"), help="signing key id")


def _load_key(args: argparse.Namespace) -> SigningKey:
    if not args.key or not args.key_id:
        raise SystemExit("a signing key is required: --key/--key-id or SHRIII_AUDIO_SIGNING_KEY/SHRIII_AUDIO_KEY_ID")
    return load_private_key(Path(args.key), args.key_id)


def _parse_speakers(values: list[str] | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for v in values or []:
        lang, _, spk = v.partition("=")
        if not lang or not spk:
            raise SystemExit(f"--speaker expects <lang>=<speaker_id>, got {v!r}")
        out[lang] = spk
    return out


def cmd_keygen(args: argparse.Namespace) -> int:
    key = generate_key(args.key_id, args.private, args.public)
    print(f"key {key.key_id}: private {args.private}, public {args.public}")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    cat = load_catalogue(args.catalogue)
    ids = cat.by_id()
    bad = 0
    for path in sorted(args.input.iterdir()):
        if not path.is_file() or path.name.startswith("."):
            continue
        parsed = parse_filename(path.name)
        reason = None
        if parsed is None:
            reason = "name does not match <line_id>.<lang>[.take<N>].wav"
        elif parsed.language not in cat.languages:
            reason = f"unknown language {parsed.language}"
        elif parsed.line_id not in ids:
            reason = f"unknown line id {parsed.line_id}"
        if reason:
            bad += 1
            print(f"REJECT {path.name}: {reason}")
        else:
            print(f"ok     {path.name}")
    return 1 if bad else 0


def cmd_process(args: argparse.Namespace) -> int:
    cat = load_catalogue(args.catalogue)
    cfg = load_qc_config(args.config)
    key = _load_key(args)
    batch = process_directory(args.input, cat, cfg, args.out, args.language or None)
    written = manifest_mod.build_manifests(
        batch,
        args.out,
        key,
        pack_version=args.pack_version,
        speakers=_parse_speakers(args.speaker),
        merge_previous=not args.no_merge,
    )
    report = write_report(batch, cfg, args.out)
    status = write_status(batch, args.out)
    for w in written:
        print(f"{w.language}: {w.clip_count} clip(s) -> {w.manifest_path.name} (+ {w.signature_path.name})")
    fails = [c for c in batch.clips if c.selected and c.status == "fail"]
    for c in fails:
        print(f"FAIL {c.source_file}: " + "; ".join(i.code for i in c.issues if i.severity == "error"))
    for f, r in batch.rejected_files:
        print(f"REJECTED {f}: {r}")
    print(f"QC report: {report}\nStatus:    {status}")
    return 1 if (fails or batch.rejected_files) and args.strict else 0


def cmd_promote(args: argparse.Namespace) -> int:
    key = _load_key(args)
    for w in manifest_mod.promote(args.packs, args.approvals, key):
        print(f"{w.language}: re-signed {w.manifest_path.name}")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    key_id, public = load_public_key(args.public)
    langs = args.language or sorted(
        p.name.removeprefix("manifest.").removesuffix(".json")
        for p in args.packs.glob("manifest.*.json")
        if not p.name.endswith(".sig.json")
    )
    status = 0
    for lang in langs:
        try:
            n = manifest_mod.verify_pack(args.packs, lang, public, key_id)
            print(f"{lang}: OK ({n} clips)")
        except manifest_mod.ManifestError as exc:
            status = 1
            print(f"{lang}: INVALID - {exc}")
    return status


def cmd_scripts(args: argparse.Namespace) -> int:
    cat = load_catalogue(args.catalogue)
    cfg = load_qc_config(args.config)
    langs = args.language or list(cat.languages)
    translations = {}
    for spec in args.translations or []:
        lang, _, file = spec.partition("=")
        translations[lang] = load_translations(Path(file))
    for p in write_scripts(cat, langs, cfg, args.out, translations=translations, include_all=args.all):
        print(p)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="shriii-audio", description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("keygen", help="create an ed25519 signing key pair")
    p.add_argument("--key-id", required=True)
    p.add_argument("--private", type=Path, required=True, help="private key PEM output (keep out of git)")
    p.add_argument("--public", type=Path, required=True, help="public key JSON output")
    p.set_defaults(func=cmd_keygen)

    p = sub.add_parser("check", help="validate recording names against the catalogue")
    p.add_argument("input", type=Path)
    p.add_argument("--catalogue", type=Path, default=default_catalogue())
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("process", help="QC, master, encode and sign")
    p.add_argument("input", type=Path, help="folder of <line_id>.<lang>.wav recordings")
    p.add_argument("--catalogue", type=Path, default=default_catalogue())
    p.add_argument("--config", type=Path, default=None, help="QC config (default config/qc.yaml)")
    p.add_argument("--out", type=Path, default=default_out_dir())
    p.add_argument("--language", action="append", help="only these languages (repeatable)")
    p.add_argument("--pack-version", default="0.1.0")
    p.add_argument("--speaker", action="append", help="<lang>=<speaker_id> (repeatable)")
    p.add_argument("--no-merge", action="store_true", help="do not keep clips of the previous manifest")
    p.add_argument("--strict", action="store_true", help="exit 1 if any clip fails or any file is rejected")
    _key_args(p)
    p.set_defaults(func=cmd_process)

    p = sub.add_parser("promote", help="apply review approvals and re-sign")
    p.add_argument("approvals", type=Path)
    p.add_argument("--packs", type=Path, default=default_out_dir() / "packs")
    _key_args(p)
    p.set_defaults(func=cmd_promote)

    p = sub.add_parser("verify", help="verify signed packs")
    p.add_argument("--packs", type=Path, default=default_out_dir() / "packs")
    p.add_argument("--public", type=Path, required=True, help="public key JSON")
    p.add_argument("--language", action="append")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("scripts", help="write recording scripts (XLSX + HTML)")
    p.add_argument("--catalogue", type=Path, default=default_catalogue())
    p.add_argument("--config", type=Path, default=None)
    p.add_argument("--out", type=Path, default=default_out_dir())
    p.add_argument("--language", action="append")
    p.add_argument("--translations", action="append", help="<lang>=<translations.yaml> (repeatable)")
    p.add_argument("--all", action="store_true", help="include lines already approved")
    p.set_defaults(func=cmd_scripts)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result: int = args.func(args)
    return result


if __name__ == "__main__":
    sys.exit(main())
