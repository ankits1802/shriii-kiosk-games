#!/usr/bin/env python3
"""Simulated-player parameter-recovery run (PLT-04 / QA-02) for CI.

Runs ``shriii_simulator.recovery.run_recovery`` per pathway (and per Pathway B slot form with ``--slot-forms``),
writes ``recovery-<pathway>[-<slot>].json`` plus a Markdown summary, and exits 1 when any indicator misses its
recovery threshold. Thresholds and generative coefficients come from the simulator package
(``data/simulator.yaml``) and ``run_recovery`` itself; this script only orchestrates and reports.

    uv run python .github/scripts/sim_recovery.py --n 50 --pathways B --out-dir sim-out      # per-PR smoke
    uv run python .github/scripts/sim_recovery.py --n 400 --pathways A B --slot-forms         # nightly
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any


def _slot_forms() -> list[str]:
    from shriii_contracts.paths import content_dir  # noqa: PLC0415 - imported lazily (heavy workspace deps)

    plan = json.loads((content_dir() / "games" / "session-plan.json").read_text(encoding="utf-8"))
    return list(plan["pathways"]["B"]["slot_candidates"])


def _clean(value: Any) -> Any:
    if isinstance(value, float) and math.isnan(value):
        return None
    return value


def run(args: argparse.Namespace) -> tuple[list[dict[str, Any]], int]:
    from shriii_simulator.recovery import run_recovery  # noqa: PLC0415

    runs: list[tuple[str, str | None]] = []
    for pathway in args.pathways:
        if pathway == "B" and args.slot_forms:
            runs.extend(("B", slot) for slot in _slot_forms())
        else:
            runs.append((pathway, None))
    summaries: list[dict[str, Any]] = []
    failures = 0
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for i, (pathway, slot) in enumerate(runs):
        started = time.perf_counter()
        kwargs: dict[str, Any] = {"seed": args.seed + i, "min_n": args.min_n, "slot_form": slot}
        if args.tolerance is not None:
            kwargs["tolerance"] = args.tolerance
        report = run_recovery(args.n, pathway, **kwargs)  # type: ignore[arg-type]
        elapsed = time.perf_counter() - started
        results = [
            {
                "indicator": r.indicator_id,
                "construct": r.construct,
                "n": r.n,
                "r_latent": _clean(round(r.r_latent, 4)),
                "parallel_reliability": _clean(round(r.parallel_reliability, 4)),
                "threshold": _clean(round(r.threshold, 4)),
                "model_reliability": None if r.model_reliability is None else round(r.model_reliability, 4),
                "passed": r.passed,
            }
            for r in report.results
        ]
        failed = [r for r in results if not r["passed"]]
        failures += len(failed)
        summary = {
            "pathway": pathway,
            "slot_form": slot,
            "n_persons": args.n,
            "seed": args.seed + i,
            "tolerance": report.tolerance,
            "indicators": len(results),
            "failed": len(failed),
            "skipped": report.skipped,
            "seconds": round(elapsed, 1),
            "results": results,
        }
        name = f"recovery-{pathway}" + (f"-{slot}" if slot else "") + ".json"
        (args.out_dir / name).write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        summaries.append(summary)
        sys.stdout.write(
            f"{pathway}{'/' + slot if slot else ''}: {len(results) - len(failed)}/{len(results)} recovered, "
            f"{len(report.skipped)} skipped, {elapsed:.0f}s\n"
        )
    return summaries, failures


def render_markdown(summaries: Sequence[dict[str, Any]]) -> str:
    lines = ["## Simulated-player parameter recovery", ""]
    lines += ["| Pathway | Slot | Persons | Indicators | Failed | Skipped | Seconds |", "|---|---|---|---|---|---|---|"]
    for s in summaries:
        lines.append(
            f"| {s['pathway']} | {s['slot_form'] or '-'} | {s['n_persons']} | {s['indicators']} | {s['failed']} "
            f"| {len(s['skipped'])} | {s['seconds']} |"
        )
    failed = [(s, r) for s in summaries for r in s["results"] if not r["passed"]]
    if failed:
        lines += ["", "### Indicators below their recovery threshold", ""]
        lines += ["| Pathway | Slot | Indicator | r(latent) | Threshold | Parallel r |", "|---|---|---|---|---|---|"]
        for s, r in failed:
            lines.append(
                f"| {s['pathway']} | {s['slot_form'] or '-'} | {r['indicator']} | {r['r_latent']} | {r['threshold']} "
                f"| {r['parallel_reliability']} |"
            )
    return "\n".join(lines) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sim-recovery", description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--n", type=int, default=400, help="simulated persons per run (default: %(default)s)")
    parser.add_argument("--pathways", nargs="+", choices=("A", "B"), default=["A", "B"])
    parser.add_argument("--slot-forms", action="store_true", help="run Pathway B once per planned-missingness slot")
    parser.add_argument("--seed", type=int, default=11)
    parser.add_argument("--min-n", type=int, default=30, help="minimum persons per indicator (default: %(default)s)")
    parser.add_argument("--tolerance", type=float, default=None, help="override run_recovery's default tolerance")
    parser.add_argument("--out-dir", type=Path, default=Path("sim-recovery"))
    parser.add_argument("--report-only", action="store_true", help="always exit 0 (report failures only)")
    args = parser.parse_args(argv)
    summaries, failures = run(args)
    markdown = render_markdown(summaries)
    (args.out_dir / "summary.md").write_text(markdown, encoding="utf-8")
    sys.stdout.write("\n" + markdown)
    return 0 if failures == 0 or args.report_only else 1


if __name__ == "__main__":
    raise SystemExit(main())
