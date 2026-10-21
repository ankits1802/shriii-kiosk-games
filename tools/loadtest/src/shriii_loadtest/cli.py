"""``shriii-loadtest`` command line.

shriii-loadtest corpus                      # simulate + cache template sessions
shriii-loadtest provision --kiosks 60       # register the fleet, cache device tokens
shriii-loadtest run saturate --kiosks 50    # one scenario, verified against the DB
shriii-loadtest suite                       # the standard ING-02 suite, results under results/
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from shriii_loadtest import __version__
from shriii_loadtest.corpus import default_cache_dir, load_or_build_corpus
from shriii_loadtest.provision import load_fleet, provision_fleet, save_fleet
from shriii_loadtest.report import evaluate, load_targets, render_markdown, summarise_run
from shriii_loadtest.runner import ResearchOptions, run_plan
from shriii_loadtest.scenarios import SCENARIOS, PlanOptions, build_plan
from shriii_loadtest.verify import pgstats_reset, pgstats_top, table_sizes, verify_plan

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "results"
DEFAULT_DB = "postgresql://load:load@localhost:55442/shriii_load"

# The standard suite: (name, scenario, options, research users).
SUITE: list[tuple[str, str, dict[str, Any], int]] = [
    # Unloaded service time: one kiosk, batches back to back (no queueing).
    ("single-kiosk", "saturate", {"kiosks": 1, "sessions_per_kiosk": 4}, 0),
    ("steady-50k", "steady", {"kiosks": 50, "sessions_per_kiosk": 1, "think_s": 3.0}, 0),
    ("saturate-50k", "saturate", {"kiosks": 50, "sessions_per_kiosk": 2}, 0),
    (
        "saturate-50k-sealed",
        "saturate",
        {"kiosks": 50, "sessions_per_kiosk": 1, "encryption": "sealed", "max_body_bytes": 1_048_576},
        0,
    ),
    ("retry-50k", "retry", {"kiosks": 50, "sessions_per_kiosk": 1, "think_s": 2.0}, 0),
    ("dup-storm-20x", "dup_storm", {"kiosks": 20, "storm_batches": 20, "copies": 10}, 0),
    ("out-of-order-skew", "out_of_order", {"kiosks": 50, "sessions_per_kiosk": 1}, 0),
    ("reconnect-50k-backlog", "reconnect", {"kiosks": 50, "sessions_per_kiosk": 4, "jitter_s": 2.0}, 0),
    ("mixed-research", "steady", {"kiosks": 50, "sessions_per_kiosk": 1, "think_s": 3.0}, 10),
]


def _db_url(args: argparse.Namespace) -> str:
    return args.db_url or os.environ.get("LOADTEST_DATABASE_URL") or DEFAULT_DB


def _fleet_path(args: argparse.Namespace) -> Path:
    return Path(args.fleet) if args.fleet else default_cache_dir() / "fleet.json"


def _research_token(base_url: str) -> str:
    import httpx  # noqa: PLC0415

    from shriii_loadtest.provision import dev_token  # noqa: PLC0415

    with httpx.Client(base_url=base_url, timeout=30) as client:
        return dev_token(client, ["researcher"], "loadtest-researcher")


def run_one(
    name: str,
    scenario: str,
    opts: dict[str, Any],
    *,
    base_url: str,
    fleet_path: Path,
    db_url: str,
    research_users: int,
    out_dir: Path,
    corpus_args: dict[str, int],
    label: str,
    verify: bool = True,
) -> dict[str, Any]:
    fleet = load_fleet(fleet_path)
    corpus = load_or_build_corpus(**corpus_args)
    options = PlanOptions(**opts)
    if options.encryption == "sealed":
        options.public_key = fleet.public_key_bytes
    print(f"[{name}] building plan ({scenario})...", file=sys.stderr)
    plan = build_plan(scenario, corpus, fleet.kiosks, options)
    print(f"[{name}] plan: {plan.describe()}", file=sys.stderr)
    research = None
    if research_users:
        research = ResearchOptions(users=research_users, token=_research_token(base_url))
    pg_ok = pgstats_reset(db_url)
    result = asyncio.run(run_plan(plan, base_url, research=research))
    summary = summarise_run(result)
    verification = verify_plan(db_url, plan.expected_sessions) if verify else None
    checks = evaluate(summary, verification, load_targets())
    summary["pg_stat_statements_top"] = pgstats_top(db_url) if pg_ok else []
    summary["table_sizes"] = table_sizes(db_url)
    meta = {
        "label": label,
        "scenario": scenario,
        "options": dict(opts),
        "research_users": research_users,
        "corpus": plan.corpus,
        "harness": __version__,
        "client_host": f"{platform.system()} {platform.release()} / Python {platform.python_version()}",
        "finished_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{name}.json").write_text(
        json.dumps(
            {"meta": meta, "checks": checks, "summary": summary, "verification": verification}, indent=2, default=str
        ),
        encoding="utf-8",
    )
    md_meta = {k: v for k, v in meta.items() if k in ("label", "scenario", "options", "research_users", "finished_at")}
    md_meta["corpus"] = (
        f"{plan.corpus['engine']}, {plan.corpus['sessions']} templates, mean {plan.corpus['mean_event_bytes']} B/event"
    )
    (out_dir / f"{name}.md").write_text(render_markdown(name, summary, checks, verification, md_meta), encoding="utf-8")
    raw_dir = default_cache_dir() / "samples"
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / f"{label}-{name}.json").write_text(json.dumps(result.to_json(), default=str), encoding="utf-8")
    print(f"[{name}] checks: { {k: v['passed'] for k, v in checks.items()} }", file=sys.stderr)
    return {"name": name, "checks": checks, "summary": summary, "verification": verification}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="shriii-loadtest", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--base-url", default=os.environ.get("LOADTEST_BASE_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--fleet", default=None, help="fleet file (default .cache/fleet.json)")
    parser.add_argument("--db-url", default=None, help="Postgres URL for verification (default load-test compose DB)")
    parser.add_argument("--corpus-b", type=int, default=24)
    parser.add_argument("--corpus-a", type=int, default=8)
    parser.add_argument("--corpus-seed", type=int, default=20261021)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("corpus", help="Simulate and cache template sessions")
    p = sub.add_parser("provision", help="Register kiosks and cache device tokens")
    p.add_argument("--kiosks", type=int, default=60)
    p.add_argument("--prefix", default="lt")
    p = sub.add_parser("run", help="Run one scenario")
    p.add_argument("scenario", choices=sorted(SCENARIOS))
    p.add_argument("--name", default=None)
    p.add_argument("--kiosks", type=int, default=50)
    p.add_argument("--sessions-per-kiosk", type=int, default=2)
    p.add_argument("--encryption", choices=["none_dev", "sealed"], default="none_dev")
    p.add_argument("--max-body-bytes", type=int, default=None)
    p.add_argument("--think-s", type=float, default=5.0)
    p.add_argument("--copies", type=int, default=10)
    p.add_argument("--storm-batches", type=int, default=10)
    p.add_argument("--research-users", type=int, default=0)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--label", default="adhoc")
    p.add_argument("--no-verify", action="store_true")
    p = sub.add_parser("suite", help="Run the standard suite")
    p.add_argument("--label", default=datetime.now(UTC).strftime("%Y%m%d-%H%M"))
    p.add_argument("--only", nargs="*", default=None, help="subset of suite entry names")
    args = parser.parse_args(argv)
    corpus_args = {"sessions_b": args.corpus_b, "sessions_a": args.corpus_a, "seed": args.corpus_seed}

    if args.cmd == "corpus":
        print(json.dumps(load_or_build_corpus(**corpus_args).describe(), indent=2))
    elif args.cmd == "provision":
        fleet = provision_fleet(args.base_url, args.kiosks, prefix=args.prefix)
        save_fleet(fleet, _fleet_path(args))
        print(json.dumps({"kiosks": len(fleet.kiosks), "fleet_file": str(_fleet_path(args))}))
    elif args.cmd == "run":
        opts = {
            "kiosks": args.kiosks,
            "sessions_per_kiosk": args.sessions_per_kiosk,
            "encryption": args.encryption,
            "max_body_bytes": args.max_body_bytes,
            "think_s": args.think_s,
            "copies": args.copies,
            "storm_batches": args.storm_batches,
            "seed": args.seed,
        }
        out = run_one(
            args.name or args.scenario,
            args.scenario,
            opts,
            base_url=args.base_url,
            fleet_path=_fleet_path(args),
            db_url=_db_url(args),
            research_users=args.research_users,
            out_dir=RESULTS / args.label,
            corpus_args=corpus_args,
            label=args.label,
            verify=not args.no_verify,
        )
        print(json.dumps(out["checks"], indent=2))
    elif args.cmd == "suite":
        index: list[dict[str, Any]] = []
        for name, scenario, opts, users in SUITE:
            if args.only and name not in args.only:
                continue
            out = run_one(
                name,
                scenario,
                opts,
                base_url=args.base_url,
                fleet_path=_fleet_path(args),
                db_url=_db_url(args),
                research_users=users,
                out_dir=RESULTS / args.label,
                corpus_args=corpus_args,
                label=args.label,
            )
            index.append(
                {
                    "name": name,
                    "passed": all(c["passed"] for c in out["checks"].values()),
                    "ing02": out["summary"]["ing02_full_batches_first_attempt"],
                }
            )
        (RESULTS / args.label / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
        print(json.dumps(index, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
