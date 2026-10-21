#!/usr/bin/env python3
"""Playwright smoke test (PLT-04 "Playwright E2E", smoke tier) against a running stack.

Checks that
* the API answers ``/healthz`` and ``/readyz`` (database, identity database and migrations ready);
* the kiosk build loads in Chromium with a 1920x1080 touch viewport, mounts into ``#root``, makes no request to
  a third-party origin (KSK-01: no remote origins) and raises no uncaught page errors;
* optionally (``--web-url``) the web app serves ``/``, ``/kiosk`` and ``/research`` without a 5xx.

Run (Python Playwright, isolated from the workspace lockfile)::

    uv run --with playwright python -m playwright install --with-deps chromium
    uv run --with playwright python .github/e2e/smoke.py --api-url http://127.0.0.1:8000 \
        --kiosk-url http://127.0.0.1:4173 [--web-url http://127.0.0.1:3000] --artifacts e2e-artifacts
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse


@dataclass
class Result:
    failures: list[str] = field(default_factory=list)
    passed: list[str] = field(default_factory=list)

    def check(self, ok: bool, name: str, detail: str = "") -> None:
        (self.passed if ok else self.failures).append(name + (f": {detail}" if detail and not ok else ""))


def get_json(url: str, timeout: float = 10.0) -> tuple[int, object]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except json.JSONDecodeError:
            return exc.code, body


def wait_for(url: str, deadline_s: float) -> bool:
    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        try:
            with urllib.request.urlopen(url, timeout=3) as resp:
                if resp.status < 500:
                    return True
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(1)
    return False


def check_api(api: str, res: Result) -> None:
    status, body = get_json(f"{api}/healthz")
    res.check(status == 200 and isinstance(body, dict) and body.get("status") == "ok", "api /healthz", str(body))
    status, body = get_json(f"{api}/readyz")
    ok = status == 200 and isinstance(body, dict) and body.get("status") == "ok"
    res.check(ok, "api /readyz", str(body))


def check_pages(kiosk: str | None, web: str | None, artifacts: Path, res: Result) -> None:
    from playwright.sync_api import sync_playwright  # noqa: PLC0415 - optional dependency

    artifacts.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        context = browser.new_context(viewport={"width": 1920, "height": 1080}, has_touch=True, locale="en-IN")
        if kiosk:
            page = context.new_page()
            errors: list[str] = []
            foreign: list[str] = []
            allowed = {urlparse(kiosk).netloc}
            page.on("pageerror", lambda exc: errors.append(str(exc)))

            def on_request(req: object) -> None:
                url = getattr(req, "url", "")
                host = urlparse(url).netloc
                if (
                    url.startswith(("http://", "https://"))
                    and host not in allowed
                    and not host.startswith(("127.0.0.1", "localhost"))
                ):
                    foreign.append(url)

            page.on("request", on_request)
            response = page.goto(kiosk, wait_until="networkidle", timeout=60_000)
            res.check(response is not None and response.ok, "kiosk index loads", str(response and response.status))
            try:
                page.wait_for_function(
                    "() => document.querySelector('#root') && document.querySelector('#root').childElementCount > 0",
                    timeout=30_000,
                )
                mounted = True
            except Exception:
                mounted = False
            res.check(mounted, "kiosk app mounts into #root")
            page.wait_for_timeout(2_000)
            page.screenshot(path=str(artifacts / "kiosk.png"))
            res.check(not errors, "kiosk has no uncaught page errors", "; ".join(errors[:5]))
            res.check(not foreign, "kiosk makes no third-party requests", ", ".join(foreign[:5]))
            page.close()
        if web:
            for path in ("/", "/kiosk", "/research"):
                page = context.new_page()
                response = page.goto(web.rstrip("/") + path, wait_until="domcontentloaded", timeout=60_000)
                status = response.status if response else 0
                res.check(0 < status < 500, f"web {path} responds", f"HTTP {status}")
                page.screenshot(path=str(artifacts / f"web{path.replace('/', '_') or '_root'}.png"))
                page.close()
        browser.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="e2e-smoke", description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--kiosk-url")
    parser.add_argument("--web-url")
    parser.add_argument("--artifacts", type=Path, default=Path("e2e-artifacts"))
    parser.add_argument("--wait", type=float, default=120.0, help="seconds to wait for each target to come up")
    args = parser.parse_args(argv)
    res = Result()
    for name, url in (("api", f"{args.api_url}/healthz"), ("kiosk", args.kiosk_url), ("web", args.web_url)):
        if url and not wait_for(url, args.wait):
            res.check(False, f"{name} reachable", url)
    if not res.failures:
        check_api(args.api_url.rstrip("/"), res)
        check_pages(args.kiosk_url, args.web_url, args.artifacts, res)
    for name in res.passed:
        sys.stdout.write(f"PASS {name}\n")
    for name in res.failures:
        sys.stdout.write(f"FAIL {name}\n")
    sys.stdout.write(f"e2e-smoke: {len(res.passed)} passed, {len(res.failures)} failed\n")
    return 1 if res.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
