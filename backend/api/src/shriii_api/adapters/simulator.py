"""Adapter over ``shriii_simulator`` with a fixture-based fallback (dev/test data only).

Probed entry point: ``shriii_simulator.session.simulate_study(n, pathway, seed=..., occasions=...)``
returning an object with ``sessions`` (``session_id``, ``person`` (``pid``, ``latent``), ``occasion``,
``events``). Without it, sessions are cloned from the shared ``minimal-session.json`` fixture with
fresh identifiers, so the end-to-end path can still be exercised.
"""

from __future__ import annotations

import copy
import importlib
import json
import random
import uuid
from dataclasses import dataclass, field
from typing import Any

from shriii_contracts.paths import fixtures_dir


@dataclass(slots=True)
class SyntheticSession:
    session_id: str
    pid: str
    occasion: int
    pathway: str
    language: str
    latent: dict[str, float]
    events: list[dict[str, Any]]


@dataclass(slots=True)
class SyntheticDataset:
    engine: str
    sessions: list[SyntheticSession] = field(default_factory=list)


def _uuid7(rng: random.Random) -> str:
    value = rng.getrandbits(128)
    value = (value & ~(0xF << 76)) | (0x7 << 76)
    value = (value & ~(0x3 << 62)) | (0x2 << 62)
    return str(uuid.UUID(int=value))


def _fallback(n: int, seed: int, occasions: int) -> SyntheticDataset:
    template = json.loads((fixtures_dir() / "sessions" / "minimal-session.json").read_text(encoding="utf-8"))
    rng = random.Random(seed)
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    out = SyntheticDataset(engine="fixture-clone")
    for _ in range(n):
        pid = "".join(rng.choice(alphabet) for _ in range(10))
        latent = {"self_control": rng.gauss(0, 1)}
        for occ in range(1, occasions + 1):
            sid = _uuid7(rng)
            events = []
            for e in copy.deepcopy(template):
                e["event_id"] = _uuid7(rng)
                e["session_id"] = sid
                e["context"]["kiosk_id"] = "kiosk-sim-01"
                e["context"]["mode"] = "pilot" if occ == 1 else "retest"
                if e["context"]["participant_pid"] is not None:
                    e["context"]["participant_pid"] = pid
                events.append(e)
            out.sessions.append(
                SyntheticSession(
                    session_id=sid, pid=pid, occasion=occ, pathway="B", language="hi-IN", latent=latent, events=events
                )
            )
    return out


def generate(n: int, *, seed: int, occasions: int = 1, pathway: str = "B") -> SyntheticDataset:
    try:
        module = importlib.import_module("shriii_simulator.session")
        simulate_study = module.simulate_study
    except (ImportError, AttributeError):
        return _fallback(n, seed, occasions)
    study = simulate_study(n, pathway, seed=seed, occasions=occasions)
    out = SyntheticDataset(engine="shriii_simulator")
    for s in study.sessions:
        out.sessions.append(
            SyntheticSession(
                session_id=s.session_id,
                pid=s.person.pid,
                occasion=int(s.occasion),
                pathway=s.pathway,
                language=s.person.language,
                latent={k: float(v) for k, v in s.person.latent.items()},
                events=list(s.events),
            )
        )
    return out
