#!/usr/bin/env python3
"""Kiosk -> API end-to-end check (run after a full-session bot played against the real API).

The bot (``frontend/apps/kiosk/e2e/full-session.mjs --api``) plays one session in a kiosk build whose
uploader points at the API and leaves ``summary.json`` + ``events.ndjson`` (the kiosk outbox copy). This
script then checks, through the public API with a dev research token, that

* the server holds the session with no missing seq ranges and in a completed state;
* every event the kiosk stored was accepted: the server's raw events have exactly the kiosk's seqs, gapless
  from the first, with the same event ids;
* after the job worker drained the queue (``shriii-api worker --once``), the scoring pipeline wrote indicator
  rows for the session (at least ``--min-indicators``; values may be missing where timing flags excluded trials).

Usage::

    uv run python cicd/e2e/kiosk_api_check.py --api-url http://127.0.0.1:8000 \
        --bot-dir e2e-artifacts/kiosk-api --token "$(uv run shriii-api dev-token --roles admin,researcher)"
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def get(api: str, path: str, token: str) -> Any:
    req = urllib.request.Request(f"{api}{path}", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"GET {path}: HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:500]}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="kiosk-api-check", description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--bot-dir", type=Path, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--min-indicators", type=int, default=1)
    args = parser.parse_args(argv)
    api = args.api_url.rstrip("/")
    summary = json.loads((args.bot_dir / "summary.json").read_text(encoding="utf-8"))
    local = [json.loads(line) for line in (args.bot_dir / "events.ndjson").read_text("utf-8").splitlines() if line]
    sid = summary["sessionId"]
    failures: list[str] = []

    def check(ok: bool, msg: str) -> None:
        print(("PASS " if ok else "FAIL ") + msg)
        if not ok:
            failures.append(msg)

    detail = get(api, f"/api/v1/sessions/{sid}", args.token)
    session = detail.get("session", {})
    check(detail.get("missing_ranges") == [], f"no missing seq ranges ({detail.get('missing_ranges')})")
    check(session.get("status") in {"completed"}, f"session status ({session.get('status')})")

    server: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = get(api, f"/api/v1/sessions/{sid}/events?limit=1000&offset={offset}", args.token)
        rows = page.get("events", [])
        server.extend(rows)
        if len(rows) < 1000:
            break
        offset += 1000
    seqs = [int(e["seq"]) for e in server]
    check(len(server) == len(local), f"server holds every kiosk event ({len(server)} of {len(local)})")
    check(all(b == a + 1 for a, b in itertools.pairwise(seqs)), "server seq is gapless")
    check(
        [e["event_id"] for e in server] == [e["event_id"] for e in local],
        "server event ids match the kiosk outbox in seq order",
    )

    values = get(api, f"/api/v1/features?session_id={sid}", args.token)
    with_value = [v for v in values if v.get("value") is not None]
    # Headless CI Chromium has no GPU, so most trials carry timing flags and the scorer excludes them
    # (expected): the check is that the pipeline ran and wrote indicator rows for this session.
    check(
        len(values) >= args.min_indicators,
        f"scoring produced indicator rows ({len(values)} rows, {len(with_value)} with a value)",
    )
    statuses: dict[str, int] = {}
    for v in values:
        statuses[str(v.get("status"))] = statuses.get(str(v.get("status")), 0) + 1
    print(f"  indicator statuses: {statuses}")
    for v in with_value[:10]:
        print(f"  {v.get('indicator_id')} = {v.get('value')} (n={v.get('n_valid_trials')})")
    print(f"kiosk-api-check: {len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
