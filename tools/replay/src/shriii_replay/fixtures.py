"""Fixture sessions from the simulator (QA-02): raw events, UploadBatches, trial params, stored values.

The stored indicator values are produced by scoring the whole simulated study (the full partition), as
a scoring run would, so a replay of one session from its raw events must reproduce them.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np
from shriii_scoring import IndicatorEngine
from shriii_simulator import SimulatedStudy, simulate_study
from shriii_simulator.ids import uuid7

from shriii_replay.jcs import canonical_sha256

MAX_BATCH_EVENTS = 500  # upload-batch.v1 event_count maximum


@dataclass(slots=True)
class Fixture:
    study: SimulatedStudy
    session_id: str
    events: list[dict[str, Any]]
    stored_rows: list[dict[str, Any]]

    @property
    def trial_params(self) -> dict[str, dict[str, dict[str, Any]]]:
        return self.study.trial_params

    @property
    def partition_events(self) -> list[dict[str, Any]]:
        return self.study.events


def make_fixture(
    pathway: Literal["A", "B"] = "B",
    *,
    seed: int = 11,
    n_sessions: int = 4,
    index: int = 0,
    engine: IndicatorEngine | None = None,
) -> Fixture:
    study = simulate_study(n_sessions, pathway, seed=seed)
    session = study.sessions[index]
    eng = engine or IndicatorEngine(allow_synthetic=True)
    result = eng.score(study.events, study.trial_params)
    rows = [r for r in result.to_records() if r["session_id"] == session.session_id]
    return Fixture(study=study, session_id=session.session_id, events=list(session.events), stored_rows=rows)


def upload_batches(events: Sequence[dict[str, Any]], *, seed: int = 0) -> list[dict[str, Any]]:
    """Split one session's events into development (``none_dev``) UploadBatches with valid JCS hashes."""
    rng = np.random.default_rng(seed)
    out: list[dict[str, Any]] = []
    ordered = sorted(events, key=lambda e: int(e["seq"]))
    for start in range(0, len(ordered), MAX_BATCH_EVENTS):
        chunk_events = ordered[start : start + MAX_BATCH_EVENTS]
        last = chunk_events[-1]
        chunk = {
            "encryption": "none_dev",
            "session_id": last["session_id"],
            "first_seq": int(chunk_events[0]["seq"]),
            "last_seq": int(last["seq"]),
            "event_count": len(chunk_events),
            "events": chunk_events,
        }
        chunks = [chunk]
        out.append(
            {
                "schema_version": "1.0",
                "batch_id": uuid7(rng, 1_792_000_000_000 + start),
                "kiosk_id": last["context"]["kiosk_id"],
                "kiosk_t_wall": last["timing"]["kiosk_t_wall"],
                "sha256": canonical_sha256(chunks),
                "event_count": len(chunk_events),
                "session_chunks": chunks,
            }
        )
    return out


def write_fixture(fx: Fixture, out: Path) -> dict[str, Path]:
    out.mkdir(parents=True, exist_ok=True)
    paths = {
        "events": out / "events.ndjson",
        "upload_batches": out / "upload_batches.json",
        "trial_params": out / "trial_params.json",
        "partition_events": out / "partition_events.ndjson",
        "stored": out / "stored_indicators.json",
        "manifest": out / "manifest.json",
    }

    def ndjson(rows: Sequence[dict[str, Any]]) -> str:
        return "".join(json.dumps(r, separators=(",", ":"), ensure_ascii=False) + "\n" for r in rows)

    paths["events"].write_text(ndjson(fx.events), encoding="utf-8")
    paths["upload_batches"].write_text(json.dumps(upload_batches(fx.events), ensure_ascii=False), encoding="utf-8")
    paths["trial_params"].write_text(json.dumps(fx.trial_params, sort_keys=True), encoding="utf-8")
    paths["partition_events"].write_text(ndjson(fx.partition_events), encoding="utf-8")
    paths["stored"].write_text(json.dumps({"rows": fx.stored_rows}, indent=1), encoding="utf-8")
    paths["manifest"].write_text(
        json.dumps(
            {
                "session_id": fx.session_id,
                "sessions": [s.session_id for s in fx.study.sessions],
                "seed": fx.study.seed,
                "files": {k: p.name for k, p in paths.items() if k != "manifest"},
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    return paths
