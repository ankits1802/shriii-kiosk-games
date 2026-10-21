"""In-process profile of ``shriii_api.services.ingestion.ingest_batch`` (no HTTP, no client noise).

    python -m shriii_loadtest.profile_ingest --batches 12 --out tools/loadtest/results/<label>/profile

Builds realistic 500-event batches from the corpus, registers a kiosk, then ingests every batch in its
own transaction under ``cProfile``. Writes ``ingest.pstats`` (open with snakeviz or ``python -m pstats``),
``top_cumulative.txt`` / ``top_tottime.txt`` and ``timings.json`` (wall time per batch). It reads the API's
own settings (``DATABASE_URL``, ``ENV``), so point it at the load-test database, never production.
This module imports the API package; the rest of the harness never does.
"""

from __future__ import annotations

import argparse
import cProfile
import io
import json
import pstats
import random
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from shriii_loadtest.batches import KioskIdentity, OutboxSession, build_batch, pack_outbox
from shriii_loadtest.corpus import load_or_build_corpus, retarget


def _batches(n: int, kiosk: KioskIdentity, seed: int) -> list[bytes]:
    corpus = load_or_build_corpus()
    rng = random.Random(seed)
    bodies: list[bytes] = []
    start = datetime.now(UTC) - timedelta(hours=2)
    while len(bodies) < n:
        sid, events = retarget(rng.choice(corpus.sessions).events, kiosk_id=kiosk.kiosk_id, site_id=kiosk.site_id,
                               started_at=start, rng=rng)
        for slices in pack_outbox([OutboxSession(sid, events)], 500):
            if sum(len(e) for _, e in slices) == 500:
                bodies.append(build_batch(kiosk, slices, kiosk_t_wall=datetime.now(UTC)).body)
    return bodies[:n]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--batches", type=int, default=12)
    parser.add_argument("--warmup", type=int, default=2)
    parser.add_argument("--kiosk", default="lt-prof-01")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--no-profile", action="store_true", help="time only (no cProfile overhead), for A/B runs")
    args = parser.parse_args(argv)

    from shriii_api.auth.rbac import Principal, Role  # noqa: PLC0415
    from shriii_api.db.session import session_scope  # noqa: PLC0415
    from shriii_api.services.ingestion import ingest_batch  # noqa: PLC0415
    from shriii_api.services.seed import ensure_kiosk  # noqa: PLC0415
    from shriii_api.settings import get_settings  # noqa: PLC0415

    settings = get_settings()
    if not settings.is_dev:
        raise SystemExit("refusing to profile outside ENV=dev/test")
    with session_scope() as db:
        ensure_kiosk(db, args.kiosk, "site-load-01")
    kiosk = KioskIdentity(args.kiosk, "site-load-01", "")
    principal = Principal(sub=f"kiosk:{args.kiosk}", roles=frozenset({Role.KIOSK_DEVICE}), kind="device",
                          kiosk_id=args.kiosk)
    bodies = _batches(args.batches + args.warmup, kiosk, args.seed)

    def ingest(body: bytes) -> dict[str, Any]:
        with session_scope() as db:
            return ingest_batch(db, body, principal, settings)

    for body in bodies[: args.warmup]:
        ingest(body)
    profiler = cProfile.Profile()
    timings: list[float] = []
    for body in bodies[args.warmup :]:
        t = time.perf_counter()
        if not args.no_profile:
            profiler.enable()
        result = ingest(body)
        if not args.no_profile:
            profiler.disable()
        timings.append((time.perf_counter() - t) * 1000)
        assert result["summary"]["accepted"] + result["summary"]["parked"] == 500, result["summary"]
    args.out.mkdir(parents=True, exist_ok=True)
    if not args.no_profile:
        profiler.dump_stats(args.out / "ingest.pstats")
        for key, name in (("cumulative", "top_cumulative.txt"), ("tottime", "top_tottime.txt")):
            buf = io.StringIO()
            pstats.Stats(profiler, stream=buf).strip_dirs().sort_stats(key).print_stats(45)
            (args.out / name).write_text(buf.getvalue(), encoding="utf-8")
    ordered = sorted(timings)
    doc = {
        "batches": len(timings),
        "profiled": not args.no_profile,
        "ms_per_batch": [round(t, 1) for t in timings],
        "mean_ms": round(sum(timings) / len(timings), 1),
        "median_ms": round(ordered[len(ordered) // 2], 1),
        "note": "cProfile overhead inflates absolute times ~1.3-2x" if not args.no_profile else "wall time per batch",
    }
    name = "timings.json" if not args.no_profile else "timings-noprofile.json"
    (args.out / name).write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(json.dumps(doc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
