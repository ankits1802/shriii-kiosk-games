"""Summaries of a run: latency by request kind, ING-02 verdict, correctness and database hot spots."""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import yaml

from shriii_loadtest.runner import RunResult, Sample, status_totals
from shriii_loadtest.stats import summarise

__all__ = ["evaluate", "load_targets", "render_markdown", "summarise_run"]

TARGETS_PATH = Path(__file__).resolve().parents[2] / "targets.yaml"


def load_targets(path: Path | None = None) -> dict[str, Any]:
    return dict(yaml.safe_load((path or TARGETS_PATH).read_text(encoding="utf-8")))


def _group(samples: Sequence[Sample]) -> dict[str, list[Sample]]:
    groups: dict[str, list[Sample]] = defaultdict(list)
    for s in samples:
        groups[s.kind].append(s)
    return groups


def summarise_run(result: RunResult, full_batch: int = 500) -> dict[str, Any]:
    samples = result.samples
    ok = [s for s in samples if s.http_status == 200]
    first_full = [s for s in ok if s.attempt == 1 and s.event_count == full_batch and not s.duplicate_batch]
    by_kind = {
        kind: {
            **summarise(s.latency_ms for s in group if s.http_status == 200).as_dict(),
            "requests": len(group),
            "http_errors": dict(Counter(f"{s.http_status}:{s.error}" for s in group if s.outcome == "http_error")),
            "transport_errors": sum(1 for s in group if s.outcome == "transport_error"),
            "retryable_responses": sum(1 for s in group if s.outcome == "retryable"),
            "duplicate_batch_responses": sum(1 for s in group if s.duplicate_batch),
        }
        for kind, group in sorted(_group(samples).items())
    }
    events_ok = sum(s.event_count for s in ok if not s.duplicate_batch)
    research = {
        kind: {
            **summarise(s.latency_ms for s in group if s.http_status == 200).as_dict(),
            "requests": len(group),
            "errors": sum(1 for s in group if s.http_status != 200),
            "statuses": dict(Counter(str(s.http_status) for s in group)),
        }
        for kind, group in sorted(_group(result.research_samples).items())
    }
    all_research_ok = [s.latency_ms for s in result.research_samples if s.http_status == 200]
    return {
        "plan": result.plan,
        "wall_s": round(result.wall_s, 2),
        "requests": len(samples),
        "throughput": {
            "unique_events_per_s": round(result.plan["unique_events"] / result.wall_s, 1)
            if result.wall_s
            else math.nan,
            "requests_per_s": round(len(samples) / result.wall_s, 2) if result.wall_s else math.nan,
            "events_per_s": round(events_ok / result.wall_s, 1) if result.wall_s else math.nan,
        },
        "ing02_full_batches_first_attempt": summarise(s.latency_ms for s in first_full).as_dict(),
        "all_ok_requests": summarise(s.latency_ms for s in ok).as_dict(),
        "by_kind": by_kind,
        "event_statuses": status_totals(samples),
        "terminal_failures": result.terminal_failures[:20],
        "terminal_failure_count": len(result.terminal_failures),
        "research": research,
        "research_all": summarise(all_research_ok).as_dict(),
    }


def evaluate(summary: dict[str, Any], verification: dict[str, Any] | None, targets: dict[str, Any]) -> dict[str, Any]:
    ing = targets["ingestion"]
    p95 = summary["ing02_full_batches_first_attempt"]["p95_ms"]
    checks: dict[str, Any] = {
        "ing02_p95": {
            "target_ms": ing["p95_ms"],
            "observed_ms": p95,
            "n": summary["ing02_full_batches_first_attempt"]["n"],
            "kiosks": summary["plan"]["kiosks"],
            "passed": bool(not math.isnan(p95) and p95 < ing["p95_ms"]),
        },
        "terminal_failures": {
            "target": ing["terminal_failures"],
            "observed": summary["terminal_failure_count"],
            "passed": summary["terminal_failure_count"] <= ing["terminal_failures"],
        },
    }
    if verification is not None:
        checks["duplicate_rows"] = {
            "target": ing["duplicate_rows"],
            "observed": verification["duplicate_rows"],
            "passed": verification["duplicate_rows"] <= ing["duplicate_rows"],
        }
        checks["still_parked"] = {
            "target": ing["still_parked_after_run"],
            "observed": verification["still_parked"],
            "passed": verification["still_parked"] <= ing["still_parked_after_run"],
        }
        checks["exactly_once"] = {"observed": verification["missing_events"], "passed": verification["passed"]}
    if summary["research_all"]["n"]:
        rt = targets["research_api"]
        errors = sum(v["errors"] for v in summary["research"].values())
        total = sum(v["requests"] for v in summary["research"].values())
        checks["research_p95"] = {
            "status": rt.get("status"),
            "target_ms": rt["p95_ms"],
            "observed_ms": summary["research_all"]["p95_ms"],
            "error_rate": round(errors / total, 4) if total else 0.0,
            "passed": summary["research_all"]["p95_ms"] < rt["p95_ms"] and errors / max(1, total) <= rt["error_rate"],
        }
    return checks


def _fmt(v: Any) -> str:
    if isinstance(v, float):
        return "n/a" if math.isnan(v) else f"{v:,.1f}"
    return str(v)


def render_markdown(
    name: str,
    summary: dict[str, Any],
    checks: dict[str, Any],
    verification: dict[str, Any] | None,
    meta: dict[str, Any],
) -> str:
    lines = [f"# Load run: {name}", ""]
    lines += [f"- {k}: `{v}`" for k, v in meta.items()]
    p = summary["plan"]
    lines += [
        f"- plan: {p['kiosks']} kiosks, {p['sessions']} sessions, {p['unique_events']} unique events, "
        f"{p['requests']} planned requests, "
        f"batch bytes mean {p['batch_bytes']['mean']:,} (max {p['batch_bytes']['max']:,})",
        f"- wall time {summary['wall_s']} s, {summary['throughput']['requests_per_s']} req/s, "
        f"{summary['throughput'].get('unique_events_per_s', 'n/a')} unique events/s stored "
        f"(responses reported {summary['throughput']['events_per_s']} new events/s)",
        "",
        "## Checks",
        "",
        "| Check | Target | Observed | Result |",
        "|---|---|---|---|",
    ]
    for key, c in checks.items():
        target = c.get("target_ms", c.get("target", ""))
        observed = c.get("observed_ms", c.get("observed", ""))
        lines.append(f"| {key} | {_fmt(target)} | {_fmt(observed)} | {'PASS' if c['passed'] else 'FAIL'} |")
    lines += [
        "",
        "## Latency by request kind (HTTP 200 only, ms)",
        "",
        "| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for kind, k in summary["by_kind"].items():
        errors = sum(k["http_errors"].values()) + k["transport_errors"]
        lines.append(
            f"| {kind} | {k['requests']} | {_fmt(k['p50_ms'])} | {_fmt(k['p95_ms'])} | {_fmt(k['p99_ms'])} | "
            f"{_fmt(k['max_ms'])} | {k['retryable_responses']} | {k['duplicate_batch_responses']} | {errors} |"
        )
    f = summary["ing02_full_batches_first_attempt"]
    lines += [
        "",
        f"Full 500-event batches, first attempt: n={f['n']}, p50 {_fmt(f['p50_ms'])}, p95 {_fmt(f['p95_ms'])}, "
        f"p99 {_fmt(f['p99_ms'])} ms.",
        "",
        f"Per-event statuses: `{summary['event_statuses']}`",
    ]
    if summary["research"]:
        lines += [
            "",
            "## Research API (ms)",
            "",
            "| Route | Requests | p50 | p95 | p99 | errors |",
            "|---|---|---|---|---|---|",
        ]
        for kind, k in summary["research"].items():
            lines.append(
                f"| {kind.removeprefix('research:')} | {k['requests']} | {_fmt(k['p50_ms'])} | {_fmt(k['p95_ms'])} | "
                f"{_fmt(k['p99_ms'])} | {k['errors']} |"
            )
    if verification is not None:
        lines += ["", "## Database verification", "", "```", *(f"{k}: {v}" for k, v in verification.items()), "```"]
    if summary["terminal_failures"]:
        lines += ["", "## Terminal failures (first 20)", "", "```", *map(str, summary["terminal_failures"]), "```"]
    return "\n".join(lines) + "\n"
