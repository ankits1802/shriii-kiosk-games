#!/usr/bin/env python3
"""Container health probes (no curl in slim images).

shriii-healthcheck http <url>   exit 0 when the URL answers 2xx/3xx within the timeout
shriii-healthcheck db           exit 0 when the research database accepts ``SELECT 1``
"""

from __future__ import annotations

import sys
import urllib.error
import urllib.request

TIMEOUT_S = 4.0


def check_http(url: str) -> int:
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_S) as resp:
            return 0 if 200 <= resp.status < 400 else 1
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        sys.stderr.write(f"healthcheck: {url}: {exc}\n")
        return 1


def check_db() -> int:
    try:
        from shriii_api.db.session import get_engine  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415 - only available in the backend image

        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
        return 0
    except Exception as exc:
        sys.stderr.write(f"healthcheck: database: {type(exc).__name__}: {exc}\n")
        return 1


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "http":
        return check_http(argv[1])
    if argv[:1] == ["db"]:
        return check_db()
    sys.stderr.write(__doc__ or "")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
