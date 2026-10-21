"""Template sessions for load generation.

Sessions come from ``shriii_simulator`` (Pathway B and Pathway A players with planted traits), so batch
sizes, event mixes and payload shapes match what the kiosk engine emits. Simulating is slow (about 2 s
per session), so the corpus is cached as gzipped JSON under ``tools/loadtest/.cache``. If the simulator
cannot be imported, the shared contract fixture is cloned instead; the run report records which engine
produced the corpus.

At run time every template is *re-targeted* (``retarget``): fresh session and event ids, the target
kiosk and site, and kiosk wall-clock times shifted to the simulated play time. ``seq`` and monotonic
timing are kept, so the server sees exactly the gapless sequences a real outbox produces.
"""

from __future__ import annotations

import gzip
import json
import random
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from shriii_loadtest.ids import pseudonymous_pid, uuid7_from

__all__ = ["Corpus", "TemplateSession", "default_cache_dir", "load_or_build_corpus", "retarget"]

IST = timezone(timedelta(hours=5, minutes=30))


def default_cache_dir() -> Path:
    return Path(__file__).resolve().parents[2] / ".cache"


@dataclass(slots=True)
class TemplateSession:
    pathway: str
    events: list[dict[str, Any]]

    @property
    def size(self) -> int:
        return len(self.events)


@dataclass(slots=True)
class Corpus:
    engine: str
    seed: int
    sessions: list[TemplateSession] = field(default_factory=list)

    @property
    def total_events(self) -> int:
        return sum(s.size for s in self.sessions)

    def describe(self) -> dict[str, Any]:
        sizes = sorted(s.size for s in self.sessions)
        return {
            "engine": self.engine,
            "seed": self.seed,
            "sessions": len(self.sessions),
            "events": self.total_events,
            "events_per_session": {
                "min": sizes[0] if sizes else 0,
                "median": sizes[len(sizes) // 2] if sizes else 0,
                "max": sizes[-1] if sizes else 0,
            },
            "pathways": {p: sum(1 for s in self.sessions if s.pathway == p) for p in ("A", "B")},
            "mean_event_bytes": round(
                sum(len(json.dumps(e, separators=(",", ":"))) for s in self.sessions for e in s.events)
                / max(1, self.total_events),
                1,
            ),
        }


def _simulate(n_b: int, n_a: int, seed: int) -> Corpus:
    from shriii_simulator.session import simulate_study  # noqa: PLC0415  (heavy import, optional)

    corpus = Corpus(engine="shriii_simulator", seed=seed)
    for pathway, n, offset in (("B", n_b, 0), ("A", n_a, 1)):
        if n <= 0:
            continue
        study = simulate_study(n, pathway, seed=seed + offset)  # type: ignore[arg-type]
        for s in study.sessions:
            corpus.sessions.append(TemplateSession(pathway=pathway, events=sorted(s.events, key=lambda e: e["seq"])))
    return corpus


def _fixture_corpus(n: int, seed: int) -> Corpus:
    from shriii_contracts.paths import fixtures_dir  # noqa: PLC0415

    template = json.loads((fixtures_dir() / "sessions" / "minimal-session.json").read_text(encoding="utf-8"))
    corpus = Corpus(engine="fixture-clone", seed=seed)
    for _ in range(max(1, n)):
        corpus.sessions.append(TemplateSession(pathway="B", events=sorted(template, key=lambda e: e["seq"])))
    return corpus


def load_or_build_corpus(
    *, sessions_b: int = 24, sessions_a: int = 8, seed: int = 20261021, cache_dir: Path | None = None
) -> Corpus:
    """Load the cached corpus for (counts, seed) or simulate and cache it."""
    cache = cache_dir or default_cache_dir()
    path = cache / f"corpus-b{sessions_b}-a{sessions_a}-s{seed}.json.gz"
    if path.exists():
        doc = json.loads(gzip.decompress(path.read_bytes()))
        return Corpus(
            engine=doc["engine"],
            seed=doc["seed"],
            sessions=[TemplateSession(pathway=s["pathway"], events=s["events"]) for s in doc["sessions"]],
        )
    try:
        corpus = _simulate(sessions_b, sessions_a, seed)
    except ImportError:
        corpus = _fixture_corpus(sessions_b + sessions_a, seed)
    cache.mkdir(parents=True, exist_ok=True)
    doc = {
        "engine": corpus.engine,
        "seed": corpus.seed,
        "sessions": [{"pathway": s.pathway, "events": s.events} for s in corpus.sessions],
    }
    path.write_bytes(gzip.compress(json.dumps(doc, separators=(",", ":")).encode(), compresslevel=6))
    return corpus


def _parse_wall(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def retarget(
    template: Sequence[dict[str, Any]],
    *,
    kiosk_id: str,
    site_id: str,
    started_at: datetime,
    rng: random.Random,
    synthetic: bool = True,
) -> tuple[str, list[dict[str, Any]]]:
    """Copy a template session onto a kiosk: new ids, kiosk/site, wall clock starting at ``started_at``.

    Returns ``(session_id, events)``; events are sorted by ``seq``. Only the fields that change are
    copied (``context``, ``timing``), the rest of each event is shared with the template, which keeps
    building thousands of batches cheap.
    """
    if not template:
        raise ValueError("template session has no events")
    base_ms = int(started_at.timestamp() * 1000)
    session_id = uuid7_from(rng, base_ms)
    pid = pseudonymous_pid(rng)
    first_wall = _parse_wall(template[0]["timing"]["kiosk_t_wall"])
    shift = started_at.astimezone(UTC) - first_wall.astimezone(UTC)
    out: list[dict[str, Any]] = []
    for event in template:
        wall = (_parse_wall(event["timing"]["kiosk_t_wall"]) + shift).astimezone(IST)
        copy = dict(event)
        copy["event_id"] = uuid7_from(rng, int(wall.timestamp() * 1000))
        copy["session_id"] = session_id
        context = dict(event["context"])
        context["kiosk_id"] = kiosk_id
        context["site_id"] = site_id
        context["synthetic"] = synthetic
        if context.get("participant_pid") is not None:
            context["participant_pid"] = pid  # one fresh pseudonymous pid per re-targeted session
        copy["context"] = context
        timing = dict(event["timing"])
        timing["kiosk_t_wall"] = wall.isoformat(timespec="milliseconds")
        copy["timing"] = timing
        out.append(copy)
    out.sort(key=lambda e: e["seq"])
    return session_id, out
