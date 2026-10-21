"""``shriii-asr-bakeoff`` command line.

synth            write a TTS-free synthetic placeholder dataset (pipeline rehearsal only)
validate         validate a dataset manifest (schema, files, asr_eval consent and deletion date)
run              run the bake-off; writes results JSON, trials JSONL, HTML report and asr-config files
report           re-render the HTML report from a results JSON
tokenize         print model tokens for phrases (BPE model or tokens.txt) to review grammars
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from shriii_asr_bakeoff.asr_config import write_asr_configs
from shriii_asr_bakeoff.config import TOOL_ROOT, load_conditions, load_engines, load_policy, load_vocab
from shriii_asr_bakeoff.dataset import load_dataset
from shriii_asr_bakeoff.report import write_report
from shriii_asr_bakeoff.runner import run_bakeoff
from shriii_asr_bakeoff.schema import validate
from shriii_asr_bakeoff.synth import build_placeholder_dataset


def cmd_synth(args: argparse.Namespace) -> int:
    vocab = load_vocab(args.vocab)
    langs = args.language or sorted(vocab.languages)
    path = build_placeholder_dataset(
        args.out,
        {lang: vocab.codes(lang) for lang in langs},
        n_speakers=args.speakers,
        n_enroll=args.enroll,
        reps=args.reps,
        seed=args.seed,
    )
    print(path)
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    ds = load_dataset(args.manifest)
    for lang in ds.languages():
        held = len(ds.speakers_for(lang, "heldout"))
        print(
            f"{lang}: {len(ds.speakers_for(lang))} speakers ({held} held-out), "
            f"{sum(1 for u in ds.utterances if u.language == lang)} utterances"
        )
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    ds = load_dataset(args.manifest)
    vocab = load_vocab(args.vocab)
    policy = load_policy(args.policy)
    conditions = load_conditions(args.conditions)
    specs = load_engines(args.engines)
    if args.engine:
        specs = [s for s in specs if s.id in args.engine]
    out = run_bakeoff(
        ds,
        vocab,
        specs,
        policy,
        conditions,
        args.out,
        languages=args.language or None,
        progress=(lambda m: print(m, file=sys.stderr)) if args.verbose else None,
    )
    report = write_report(out.results, args.out)
    configs = write_asr_configs(
        args.out / "asr-config", out.results, out.artifacts, vocab, policy, args.grammar_version
    )
    print(f"results: {args.out / ('results-' + out.results['run_id'] + '.json')}")
    print(f"trials:  {out.trials_path}\nreport:  {report}")
    for c in configs:
        print(f"config:  {c}")
    for lang, w in sorted(out.results["winners"].items()):
        print(f"{lang}: winner={w['engine_id']} voice prompts={w['voice_enabled_prompts']}")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    results = json.loads(args.results.read_text(encoding="utf-8"))
    validate(results, "results.schema.json")
    print(write_report(results, args.results.parent))
    return 0


def cmd_tokenize(args: argparse.Namespace) -> int:
    from shriii_asr_bakeoff.tokenize import BpeTokenizer, GreedyTokenizer, read_token_list  # noqa: PLC0415

    tok: BpeTokenizer | GreedyTokenizer
    tok = BpeTokenizer(args.model) if args.model.suffix == ".model" else GreedyTokenizer(read_token_list(args.model))
    for phrase in args.phrase:
        print(f"{phrase}\t{' '.join(tok.encode(phrase))}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="shriii-asr-bakeoff", description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("synth")
    s.add_argument("--out", type=Path, default=TOOL_ROOT / "data" / "synthetic")
    s.add_argument("--vocab", type=Path, default=None)
    s.add_argument("--language", action="append")
    s.add_argument("--speakers", type=int, default=40)
    s.add_argument("--enroll", type=int, default=8)
    s.add_argument("--reps", type=int, default=2)
    s.add_argument("--seed", type=int, default=7)
    s.set_defaults(func=cmd_synth)

    s = sub.add_parser("validate")
    s.add_argument("manifest", type=Path)
    s.set_defaults(func=cmd_validate)

    s = sub.add_parser("run")
    s.add_argument("manifest", type=Path)
    s.add_argument("--out", type=Path, default=TOOL_ROOT / "out")
    s.add_argument("--vocab", type=Path, default=None)
    s.add_argument("--policy", type=Path, default=None)
    s.add_argument("--conditions", type=Path, default=None)
    s.add_argument("--engines", type=Path, default=None)
    s.add_argument("--engine", action="append", help="only these engine ids")
    s.add_argument("--language", action="append")
    s.add_argument("--grammar-version", default="0.1.0")
    s.add_argument("--verbose", action="store_true")
    s.set_defaults(func=cmd_run)

    s = sub.add_parser("report")
    s.add_argument("results", type=Path)
    s.set_defaults(func=cmd_report)

    s = sub.add_parser("tokenize")
    s.add_argument("model", type=Path, help="bpe.model or tokens.txt")
    s.add_argument("phrase", nargs="+")
    s.set_defaults(func=cmd_tokenize)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    code: int = args.func(args)
    return code


if __name__ == "__main__":
    sys.exit(main())
