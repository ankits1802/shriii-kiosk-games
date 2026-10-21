"""Tests for the load-test job summary / verdict (.github/scripts/loadtest_summary.py)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import loadtest_summary as ls
import pytest


def _run(name: str, *, p95: float | None, p95_ok: bool, dup_ok: bool = True) -> dict[str, Any]:
    ing = {"n": 0 if p95 is None else 40, "p50_ms": p95, "p95_ms": p95, "p99_ms": p95}
    checks: dict[str, Any] = {
        "ing02_p95": {"target_ms": 300, "observed_ms": p95, "n": ing["n"], "kiosks": 50, "passed": p95_ok},
        "terminal_failures": {"target": 0, "observed": 0, "passed": True},
        "duplicate_rows": {"target": 0, "observed": 0 if dup_ok else 3, "passed": dup_ok},
        "still_parked": {"target": 0, "observed": 0, "passed": True},
        "exactly_once": {"observed": 0, "passed": True},
    }
    return {"name": name, "checks": checks, "summary": {"ing02_full_batches_first_attempt": ing}}


def _write(tmp: Path, runs: list[dict[str, Any]]) -> Path:
    (tmp / "index.json").write_text(json.dumps([{"name": r["name"]} for r in runs]), encoding="utf-8")
    for r in runs:
        (tmp / f"{r['name']}.json").write_text(json.dumps(r), encoding="utf-8")
    return tmp


def test_p95_miss_is_reported_not_gating_by_default(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    results = _write(tmp_path, [_run("steady", p95=812.5, p95_ok=False), _run("sealed", p95=None, p95_ok=False)])
    assert ls.main([str(results), "--out", str(tmp_path / "s.md")]) == 0
    out = capsys.readouterr().out
    assert "| steady | 50 | 40 | 812.5 | 812.5 | 812.5 | MISS | PASS |" in out
    assert "| sealed | 50 | 0 | n/a | n/a | n/a | n/a | PASS |" in out
    assert out.count("::warning") == 1
    assert (tmp_path / "s.md").read_text(encoding="utf-8").startswith("## Load test (ING-02)")


def test_enforce_p95_gates(tmp_path: Path) -> None:
    results = _write(tmp_path, [_run("steady", p95=812.5, p95_ok=False)])
    assert ls.main([str(results), "--enforce-p95"]) == 1
    ok = _write(tmp_path, [_run("steady", p95=120.0, p95_ok=True)])
    assert ls.main([str(ok), "--enforce-p95"]) == 0


def test_correctness_failure_always_gates(tmp_path: Path) -> None:
    runs = [_run("dup", p95=100.0, p95_ok=True, dup_ok=False)]
    assert ls.failures(runs, enforce_p95=False) == ["dup: duplicate_rows"]
    assert ls.main([str(_write(tmp_path, runs))]) == 1
