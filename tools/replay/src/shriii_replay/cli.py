"""``shriii-replay`` command line.

    shriii-replay check events.ndjson --trial-params tp.json --stored indicators.json --html out.html
    shriii-replay check upload_batches.json --session <uuid> --json report.json
    shriii-replay score events.ndjson --trial-params tp.json --out indicators.json
    shriii-replay fixture --pathway B --seed 11 --out fixtures/b11

Exit codes: 0 valid and reproducible; 1 usage / input error; 2 contract or sequence errors;
3 valid but not reproducible.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from shriii_replay.html import render_html
from shriii_replay.load import load_input, load_json_or_ndjson, load_trial_params
from shriii_replay.replay import ReplayInputError, ReplayReport, replay_session
from shriii_replay.reproduce import DEFAULT_TOLERANCE, score_session


def _summary(r: ReplayReport) -> str:
    d = r.as_dict()
    v = d["verdict"]
    lines = [
        f"session {r.session_id} ({d['session']['pathway']}, {d['session']['language']}, "
        f"{len(r.timeline.modules)} modules, {len(r.timeline.trials)} trials, {r.n_events} events)",
        f"contracts+seq valid: {v['valid']}   reproducible: {v['reproducible']}   "
        f"dictionary sha match: {v['dictionary_sha_match']}   errors: {v['errors']}   warnings: {v['warnings']}",
    ]
    if r.reproducibility:
        counts = ", ".join(f"{k}={n}" for k, n in sorted(r.reproducibility.counts.items()))
        lines.append(f"indicators ({r.reproducibility.mode}): {counts}")
    for i in [i for i in r.all_issues if i.severity == "error"][:15]:
        lines.append(f"  ERROR {i.code} @ {i.where}: {i.message}")
    return "\n".join(lines)


def _trial_params(path: str | None, session_id: str | None) -> dict[str, Any] | None:
    if path is None:
        return None
    p = Path(path)
    if session_id is None:
        doc = json.loads(p.read_text(encoding="utf-8"))
        return doc if isinstance(doc, dict) else None
    return load_trial_params(p, session_id)


def cmd_check(a: argparse.Namespace) -> int:
    loaded = load_input(Path(a.events))
    sessions = sorted({str(e.get("session_id")) for e in loaded.events})
    sid = a.session or (sessions[0] if len(sessions) == 1 else None)
    stored = load_json_or_ndjson(Path(a.stored)) if a.stored else None
    partition = load_input(Path(a.partition_events)).events if a.partition_events else None
    report = replay_session(
        loaded,
        session_id=sid,
        trial_params=_trial_params(a.trial_params, sid),
        stored=stored,
        mode=a.mode,
        rescore=not a.no_rescore,
        tolerance=a.tolerance,
        partition_events=partition,
        allow_synthetic=True if a.allow_synthetic else None,
    )
    if a.json:
        Path(a.json).write_text(json.dumps(report.as_dict(), indent=1, default=str) + "\n", encoding="utf-8")
    if a.html:
        Path(a.html).write_text(render_html(report), encoding="utf-8")
    print(_summary(report))
    return report.exit_code


def cmd_score(a: argparse.Namespace) -> int:
    loaded = load_input(Path(a.events))
    synthetic = any((e.get("context") or {}).get("synthetic") for e in loaded.events)
    _, result = score_session(
        loaded.events, _trial_params(a.trial_params, None), allow_synthetic=synthetic or a.allow_synthetic
    )
    text = json.dumps(
        {"manifest_scoring_run_id": result.manifest.scoring_run_id, "rows": result.to_records()}, indent=1
    )
    if a.out:
        Path(a.out).write_text(text + "\n", encoding="utf-8")
    else:
        sys.stdout.write(text + "\n")
    print(f"{len(result.rows)} indicator rows for {len(result.sessions)} session(s)", file=sys.stderr)
    return 0


def cmd_fixture(a: argparse.Namespace) -> int:
    from shriii_replay.fixtures import make_fixture, write_fixture  # noqa: PLC0415 - simulator only on demand

    fx = make_fixture(a.pathway, seed=a.seed, n_sessions=a.sessions, index=a.index)
    for k, p in write_fixture(fx, Path(a.out)).items():
        print(f"{k}: {p}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="shriii-replay", description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    ck = sub.add_parser("check", help="validate, rebuild the timeline, rescore and report one session")
    ck.add_argument("events", help="NDJSON / JSON array of events, or UploadBatch JSON (plain dev chunks)")
    ck.add_argument("--session", help="session_id (required when the input holds several sessions)")
    ck.add_argument("--trial-params", help="GameTrialSpec.params JSON: session -> trial -> params, or trial -> params")
    ck.add_argument("--stored", help="stored indicator rows (JSON array, {rows: [...]}, or NDJSON)")
    ck.add_argument("--partition-events", help="events of the whole scoring partition (batch-model indicators)")
    ck.add_argument("--mode", choices=("strict", "reader"), default="strict", help="writer-strict or tolerant reader")
    ck.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE)
    ck.add_argument("--no-rescore", action="store_true", help="skip the indicator engine")
    ck.add_argument("--allow-synthetic", action="store_true", help="score synthetic sessions (auto for simulator data)")
    ck.add_argument("--html", help="write the self-contained HTML timeline here")
    ck.add_argument("--json", help="write the machine-readable report here")
    ck.set_defaults(fn=cmd_check)

    sc = sub.add_parser("score", help="score events with the indicator engine and write the rows")
    sc.add_argument("events")
    sc.add_argument("--trial-params")
    sc.add_argument("--allow-synthetic", action="store_true")
    sc.add_argument("--out")
    sc.set_defaults(fn=cmd_score)

    fx = sub.add_parser("fixture", help="write a simulator fixture session (events, batches, params, stored)")
    fx.add_argument("--pathway", choices=("A", "B"), default="B")
    fx.add_argument("--seed", type=int, default=11)
    fx.add_argument("--sessions", type=int, default=4, help="sessions in the simulated partition")
    fx.add_argument("--index", type=int, default=0, help="which simulated session to export")
    fx.add_argument("--out", required=True)
    fx.set_defaults(fn=cmd_fixture)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        rc: int = args.fn(args)
    except (ReplayInputError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return rc


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
