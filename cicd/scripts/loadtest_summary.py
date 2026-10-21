"""Summarise a ``shriii-loadtest suite`` run for the GitHub job summary and decide the job verdict.

Reads ``<results>/index.json`` plus each ``<name>.json`` the suite wrote, prints a Markdown table of the
ING-02 metric (p95 of first-attempt, full 500-event batches) against the target in
``tools/loadtest/targets.yaml``, and exits non-zero when a gating check fails.

Gating: data-correctness checks (``terminal_failures``, ``duplicate_rows``, ``still_parked``,
``exactly_once``) always gate. ``ing02_p95`` gates only with ``--enforce-p95`` (shared CI runners put the
client, API and database on one small VM, so latency is reported against the target rather than gating by
default). Checks whose target is marked ``proposed`` (research API) are reported only.

    python cicd/scripts/loadtest_summary.py tools/loadtest/results/ci-123 [--enforce-p95] [--out summary.md]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

CORRECTNESS_CHECKS = ("terminal_failures", "duplicate_rows", "still_parked", "exactly_once")


def _num(v: Any) -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "n/a"
    if isinstance(v, float):
        return f"{v:,.1f}"
    return str(v)


def load_runs(results: Path) -> list[dict[str, Any]]:
    index = json.loads((results / "index.json").read_text(encoding="utf-8"))
    runs: list[dict[str, Any]] = []
    for entry in index:
        doc = json.loads((results / f"{entry['name']}.json").read_text(encoding="utf-8"))
        runs.append({"name": entry["name"], "checks": doc["checks"], "summary": doc["summary"]})
    return runs


def failures(runs: list[dict[str, Any]], *, enforce_p95: bool) -> list[str]:
    gating = (*CORRECTNESS_CHECKS, "ing02_p95") if enforce_p95 else CORRECTNESS_CHECKS
    out: list[str] = []
    for run in runs:
        for key in gating:
            check = run["checks"].get(key)
            if check is not None and not check["passed"]:
                out.append(f"{run['name']}: {key}")
    return out


def render(runs: list[dict[str, Any]], *, enforce_p95: bool) -> str:
    target = next((r["checks"]["ing02_p95"]["target_ms"] for r in runs if "ing02_p95" in r["checks"]), None)
    lines = [
        "## Load test (ING-02)",
        "",
        f"Target: p95 < {_num(target)} ms per 500-event batch (first attempt, HTTP 200). "
        f"p95 {'gates' if enforce_p95 else 'is reported only'}; data-correctness checks gate.",
        "",
        "| Scenario | Kiosks | Full batches | p50 ms | p95 ms | p99 ms | ING-02 p95 | Correctness |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for run in runs:
        ing = run["summary"]["ing02_full_batches_first_attempt"]
        p95_check = run["checks"].get("ing02_p95", {})
        correct = all(run["checks"][k]["passed"] for k in CORRECTNESS_CHECKS if k in run["checks"])
        verdict = "PASS" if p95_check.get("passed") else ("n/a" if not ing.get("n") else "MISS")
        lines.append(
            f"| {run['name']} | {_num(p95_check.get('kiosks'))} | {_num(ing.get('n'))} | {_num(ing.get('p50_ms'))} "
            f"| {_num(ing.get('p95_ms'))} | {_num(ing.get('p99_ms'))} | {verdict} | {'PASS' if correct else 'FAIL'} |"
        )
    research = [(r["name"], r["checks"]["research_p95"]) for r in runs if "research_p95" in r["checks"]]
    if research:
        lines += ["", "| Scenario | Research p95 ms | Target ms | Error rate | Status |", "|---|---|---|---|---|"]
        for name, c in research:
            status = c.get("status") or "gating"
            lines.append(
                f"| {name} | {_num(c['observed_ms'])} | {_num(c['target_ms'])} | {c['error_rate']} "
                f"| {'PASS' if c['passed'] else 'MISS'} ({status}) |"
            )
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("results", type=Path)
    parser.add_argument("--enforce-p95", action="store_true")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args(argv)
    runs = load_runs(args.results)
    md = render(runs, enforce_p95=args.enforce_p95)
    if args.out:
        args.out.write_text(md, encoding="utf-8")
    print(md)
    for run in runs:
        check = run["checks"].get("ing02_p95")
        if check is not None and check["observed_ms"] is not None and not check["passed"] and not args.enforce_p95:
            print(
                f"::warning title=ING-02 p95 target missed::{run['name']}: p95 {_num(check['observed_ms'])} ms "
                f"(target < {_num(check['target_ms'])} ms)"
            )
    failed = failures(runs, enforce_p95=args.enforce_p95)
    for f in failed:
        print(f"::error title=Load test check failed::{f}")
    return 1 if failed or not runs else 0


if __name__ == "__main__":
    sys.exit(main())
