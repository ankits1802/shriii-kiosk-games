"""End-to-end demo pipeline (dev/test only): ``shriii-api demo-pipeline``.

1. migrate, seed instruments / dictionary / games and a fresh demo study (two arms, T1/T2, quotas, plan);
2. simulate ``participants_per_language`` synthetic players per language with ``shriii_simulator`` (Pathway B),
   ``retests`` of them with a T2 parallel-form retest, item-level criterion responses with rotating
   planned-missing blocks and a few careless responders, and planted DIF in one indicator
   (``nuisance.trial_dif``: no-go errors harder in one language at equal latent self-control);
3. upload every raw event through the real ``POST /api/v1/events/batch`` route (kiosk device token,
   JCS checksum, per-event statuses) and link participants, consent, enrolment (with an untouched
   holdout cohort) and criterion administrations (planned-missing items stored with the responses);
4. run the worker: event validation -> canonical trials -> features; then matching, a frozen snapshot,
   every validation analysis (confirmatory construct validity on the registered primary hypotheses),
   a predictive model with holdout, provisional norms, a fail-closed release pack + report, kiosk health
   and a retention dry run;
5. evaluate the trait and battery gates (evaluate-only) and return a summary.

Everything is marked synthetic (``context.synthetic = true``) and lives in its own study; the gates stay
closed because synthetic data, missing invariance groupings and absent sign-offs can never open them.
"""

from __future__ import annotations

import gc
import json
import logging
import math
import os
import pickle
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from collections import Counter, defaultdict
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import numpy as np
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from shriii_api import content
from shriii_api.auth.tokens import DEVICE_TOKEN_PREFIX, issue_dev_token
from shriii_api.canonical import canonical_sha256
from shriii_api.db.models.criterion import InstrumentVersion
from shriii_api.db.models.kiosk_raw import GameSession
from shriii_api.db.models.ops import Job, Kiosk
from shriii_api.db.models.participants import Participant, ParticipantLink
from shriii_api.db.models.study import MeasurementOccasion, Study
from shriii_api.db.models.validation import AnalysisPlan
from shriii_api.db.session import session_scope
from shriii_api.security import keyed_hmac, new_opaque_token, new_uuid7, token_digest
from shriii_api.services import consent as consent_svc
from shriii_api.services import criterion as criterion_svc
from shriii_api.services import seed as seed_svc
from shriii_api.services import studies as study_svc
from shriii_api.services.synthetic import _approve_for_dev
from shriii_api.settings import Settings
from shriii_api.worker.queue import enqueue
from shriii_api.worker.runner import drain

log = logging.getLogger(__name__)
ACTOR = "system:demo-pipeline"
KIOSK_ID = "kiosk-sim-01"
MAX_EVENTS_PER_BATCH = 400
ROTATING = ("A", "B", "C")
DEFAULT_MODELS = ("ridge", "elastic_net", "random_forest", "xgboost")


@dataclass(frozen=True, slots=True)
class DemoConfig:
    participants_per_language: int = 400
    languages: tuple[str, ...] = ("hi-IN", "ta-IN")
    retests: int = 100
    seed: int | None = None
    pathway: Literal["A", "B"] = "B"
    dif_trial: str = "dont_tap.nogo"
    dif_language: str | None = None
    """Focal language of the planted DIF (default: the last language)."""
    dif_logit_shift: float = 0.8
    dif_indicator: str = "self_control.nogo_commission_rate"
    """The indicator the planted trial-level DIF should surface in."""
    careless_share: float = 0.02
    holdout_share: float = 0.15
    outcome: str = "crit__grit_s.total"
    models: tuple[str, ...] = DEFAULT_MODELS
    n_boot: int = 500
    workers: int = 4
    study_id: str | None = None
    skip_ingestion: bool = False
    """Resume ``study_id``: skip simulation, upload, linkage and per-session scoring."""


@dataclass(slots=True)
class _Clock:
    started: float = field(default_factory=time.perf_counter)
    steps: dict[str, float] = field(default_factory=dict)

    @contextmanager
    def step(self, name: str) -> Iterator[None]:
        t0 = time.perf_counter()
        _say(f"[demo] {name} ...")
        yield
        self.steps[name] = round(time.perf_counter() - t0, 1)
        _say(f"[demo] {name} done in {self.steps[name]:.1f}s")


def _say(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


# ---------------------------------------------------------------- simulation


@dataclass(slots=True)
class _SimPerson:
    pid: str
    language: str
    block: str
    sessions: list[Any] = field(default_factory=list)  # SimulatedSession per occasion
    retest: bool = False


@dataclass(slots=True)
class _Simulated:
    persons: dict[str, _SimPerson]
    sessions: list[Any]
    criterion: dict[str, Any]  # occasion_id -> SimulatedCriterion
    careless: set[str]
    params_sha256: str
    dif: dict[str, dict[str, float]]


def simulate(config: DemoConfig, seed: int, study_id: str) -> _Simulated:
    """Synthetic players per language (+ T2 retests) and their item-level criterion battery."""
    from shriii_simulator.criterion import simulate_criterion  # noqa: PLC0415 - dev-only dependency
    from shriii_simulator.params import load_sim_params  # noqa: PLC0415
    from shriii_simulator.session import simulate_study  # noqa: PLC0415

    focal = config.dif_language or config.languages[-1]
    dif = {config.dif_trial: {focal: config.dif_logit_shift}}
    prm = load_sim_params().with_overrides({"nuisance.trial_dif": dif, "nuisance.walkaway_probability": 0.0})
    per_lang_retest = config.retests // len(config.languages)
    persons: dict[str, _SimPerson] = {}
    sessions: list[Any] = []
    t1_people: list[Any] = []
    t2_people: list[Any] = []
    for k, language in enumerate(config.languages):
        retest_n = per_lang_retest + (1 if k < config.retests % len(config.languages) else 0)
        main_n = config.participants_per_language - retest_n
        for n, occasions, offset in ((retest_n, 2, 1), (main_n, 1, 2)):
            if n <= 0:
                continue
            study = simulate_study(
                n,
                config.pathway,
                seed=seed * 10 + k * 3 + offset,
                params=prm,
                occasions=occasions,
                language=language,
            )
            for s in study.sessions:
                p = persons.setdefault(s.person.pid, _SimPerson(s.person.pid, language, "X", retest=occasions == 2))
                p.sessions.append(s)
                sessions.append(s)
            t1_people += list(study.occasion_persons[1].values())
            if occasions == 2:
                t2_people += list(study.occasion_persons[2].values())
    rng = np.random.default_rng(seed)
    careless = {p.pid for p in t1_people if rng.random() < config.careless_share}
    crit_t1 = simulate_criterion(
        t1_people, seed=seed, params=prm, occasion_id="T1", study_id=study_id, careless=sorted(careless)
    )
    for pid, block in crit_t1.blocks.items():
        persons[pid].block = block
    criterion = {"T1": crit_t1}
    if t2_people:
        crit_t2 = simulate_criterion(t2_people, seed=seed + 1, params=prm, occasion_id="T2", study_id=study_id)
        # A person keeps the T1 rotating block at T2: drop T2 responses from other blocks.
        crit_t2.responses = [
            r for r in crit_t2.responses if r["block"] not in ROTATING or r["block"] == persons[r["pid"]].block
        ]
        criterion["T2"] = crit_t2
    return _Simulated(persons, sessions, criterion, careless, prm.sha256, dif)


@dataclass(frozen=True, slots=True)
class _SessionRef:
    session_id: str
    occasion: int


def _without_events(sim: _Simulated) -> _Simulated:
    """The simulation without raw events (sessions reduced to id + occasion)."""
    for p in sim.persons.values():
        p.sessions = [_SessionRef(s.session_id, int(s.occasion)) for s in p.sessions]
    return _Simulated(sim.persons, [], sim.criterion, sim.careless, sim.params_sha256, sim.dif)


# ---------------------------------------------------------------- ingestion through the HTTP route


def _device_token(db: Session) -> str:
    token = seed_svc.ensure_kiosk(db, KIOSK_ID, "site-sim-01")
    if token is not None:
        return token
    kiosk = db.get(Kiosk, KIOSK_ID)
    assert kiosk is not None
    token = DEVICE_TOKEN_PREFIX + new_opaque_token(32)
    kiosk.token_digest = token_digest(token)
    kiosk.status, kiosk.revoked_at = "active", None
    return token


def _batches(session: Any) -> Iterator[dict[str, Any]]:
    events = sorted(session.events, key=lambda e: e["seq"])
    for start in range(0, len(events), MAX_EVENTS_PER_BATCH):
        part = events[start : start + MAX_EVENTS_PER_BATCH]
        chunks = [
            {
                "encryption": "none_dev",
                "session_id": session.session_id,
                "first_seq": part[0]["seq"],
                "last_seq": part[-1]["seq"],
                "event_count": len(part),
                "events": part,
            }
        ]
        yield {
            "schema_version": "1.0",
            "batch_id": str(new_uuid7()),
            "kiosk_id": KIOSK_ID,
            "kiosk_t_wall": part[-1]["timing"]["kiosk_t_wall"],
            "sha256": canonical_sha256(chunks),
            "event_count": len(part),
            "session_chunks": chunks,
        }


def _upload_shard(client: TestClient, token: str, sessions: Sequence[Any]) -> tuple[Counter[str], int, int]:
    statuses: Counter[str] = Counter()
    batches = duplicates = 0
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    for s in sessions:
        for body in _batches(s):
            r = client.post("/api/v1/events/batch", content=json.dumps(body), headers=headers)
            if r.status_code != 200:
                raise RuntimeError(f"batch upload failed ({r.status_code}): {r.text[:500]}")
            out = r.json()
            batches += 1
            duplicates += int(bool(out.get("duplicate_batch")))
            for status, count in out["summary"].items():
                statuses[status] += int(count)
    return statuses, batches, duplicates


RESULT_PREFIX = "SHRIII-DEMO-SHARD-RESULT "


def _run_shards(kind: str, payloads: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Run ``kind`` over each payload in its own interpreter (the work is CPU-bound under the GIL)."""
    tmp = Path(tempfile.mkdtemp(prefix="shriii-demo-"))
    try:
        procs = []
        for k, payload in enumerate(payloads):
            f = tmp / f"{kind}-{k}.pkl"
            f.write_bytes(pickle.dumps({"kind": kind, **payload}, protocol=pickle.HIGHEST_PROTOCOL))
            procs.append(
                subprocess.Popen(
                    [sys.executable, "-m", "shriii_api.services.demo_pipeline", str(f)],
                    env=dict(os.environ),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
            )
        results: list[dict[str, Any]] = []
        for proc in procs:
            out, err = proc.communicate()
            lines = [ln for ln in (out or "").splitlines() if ln.startswith(RESULT_PREFIX)]
            if proc.returncode != 0 or not lines:
                raise RuntimeError(f"{kind} shard failed ({proc.returncode}): {(err or '')[-3000:]}")
            results.append(json.loads(lines[-1][len(RESULT_PREFIX) :]))
        return results
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def upload_events(token: str, sessions: Sequence[Any], *, processes: int = 1) -> dict[str, Any]:
    """POST every session's events to ``/api/v1/events/batch`` (kiosk device token, JCS checksum).

    Sessions are sharded over ``processes`` interpreters, each with its own HTTP client against the app;
    a session's batches stay in order within one shard.
    """
    n = max(1, min(processes, len(sessions)))
    shards = [{"token": token, "sessions": list(sessions[k::n])} for k in range(n)]
    statuses: Counter[str] = Counter()
    batches = duplicates = 0
    for part in _run_shards("upload", shards):
        statuses.update(part["events"])
        batches += int(part["batches"])
        duplicates += int(part["duplicate_batches"])
    return {"batches": batches, "duplicate_batches": duplicates, "events": dict(statuses), "processes": n}


def _upload_worker(payload: Mapping[str, Any]) -> dict[str, Any]:
    from shriii_api.main import create_app  # noqa: PLC0415

    with TestClient(create_app()) as client:
        statuses, batches, duplicates = _upload_shard(client, str(payload["token"]), payload["sessions"])
    return {"events": dict(statuses), "batches": batches, "duplicate_batches": duplicates}


# ---------------------------------------------------------------- participants, linkage, criterion


def _shared_item_aliases() -> dict[str, tuple[str, int, int]]:
    from shriii_scoring.params import load_params  # noqa: PLC0415

    out: dict[str, tuple[str, int, int]] = {}
    for s in load_params().get("criterion.shared_items"):
        lo, hi = (int(v) for v in s["numbers"])
        out[str(s["instrument"])] = (str(s["source"]), lo, hi)
    return out


@dataclass(frozen=True, slots=True)
class _Instrument:
    version: str
    definition: dict[str, Any]


def _administrations(
    sim: _Simulated,
    instruments: Mapping[str, _Instrument],
    occasion_id: str,
    wanted: Sequence[str],
    pids: Sequence[str],
) -> Iterator[tuple[str, str, list[criterion_svc.ItemResponse], list[str], str, str]]:
    """(pid, instrument, responses, planned-missing items, block, rater role) per administration."""
    crit = sim.criterion.get(occasion_id)
    if crit is None:
        return
    aliases = _shared_item_aliases()
    keep = set(pids)
    by: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for r in crit.responses:
        if r["pid"] in keep:
            by[(r["pid"], r["instrument_id"])].append(r)
    # Attention checks first: the careless flag then applies to every instrument scored after it.
    ordered = sorted(wanted, key=lambda i: (i != "attention_checks", i))
    for pid in sorted({k[0] for k in by}):
        person = sim.persons[pid]
        for inst_id in ordered:
            inst = instruments.get(inst_id)
            if inst is None:
                continue
            items = {str(it["item_id"]): it for it in inst.definition["items"]}
            rows = by.get((pid, inst_id), [])
            if inst_id in aliases and not rows:
                # BFI-2-XS is administered once as BFI-2-S items 1-15 (criterion.shared_items).
                source, lo, hi = aliases[inst_id]
                src = {r["item_id"]: r for r in by.get((pid, source), [])}
                rows = [
                    {**src[f"{source}.i{int(it['number']):02d}"], "item_id": iid, "instrument_id": inst_id}
                    for iid, it in items.items()
                    if lo <= int(it["number"]) <= hi and f"{source}.i{int(it['number']):02d}" in src
                ]
            if not rows:
                continue
            responses: list[criterion_svc.ItemResponse] = []
            rotating = False
            for r in rows:
                iid = str(r["item_id"])
                base = iid if iid in items else ".".join(iid.split(".")[:2])  # "<item>.<measure>" -> "<item>"
                item = items.get(base, {})
                rotating |= str(item.get("block")) in ROTATING
                expected: float | None = None
                if item.get("attention_check"):
                    expected = float(crit.attention_key[iid])
                elif iid.endswith(".moves"):
                    expected = float(crit.performance_keys[base]["min_moves"])
                responses.append(
                    criterion_svc.ItemResponse(
                        item_id=iid,
                        raw_response=r["raw_response"],
                        response_latency_ms=r.get("response_latency_ms"),
                        expected_response=expected,
                    )
                )
            planned = sorted(
                iid
                for iid, it in items.items()
                if str(it.get("block")) in ROTATING and str(it.get("block")) != person.block
            )
            yield (
                pid,
                inst_id,
                responses,
                planned,
                person.block if rotating else "X",
                str(rows[0].get("rater_role") or "self"),
            )


def _enrol_and_link(
    settings: Settings, sim: _Simulated, study_id: str, holdout_share: float, seed: int
) -> Counter[str]:
    """Participants, criterion consent, enrolment (randomisation draws are sequential) and session links."""
    pepper = settings.key_bytes("pid_hmac_pepper")
    rng = np.random.default_rng(seed + 7)
    stats: Counter[str] = Counter()
    with session_scope() as db:
        study = db.get(Study, study_id)
        assert study is not None
        for pid, person in sorted(sim.persons.items()):
            participant = db.get(Participant, pid)
            if participant is None:
                participant = Participant(
                    pid=pid,
                    pid_hmac=keyed_hmac(pepper, pid),
                    pepper_version=settings.pid_pepper_version,
                    study_id=study_id,
                    source="generated",
                    status="active",
                    created_by=ACTOR,
                )
                db.add(participant)
                db.flush()
            if not consent_svc.has_consent(db, "criterion", pid=pid):
                now = datetime.now(UTC)
                consent_svc.record_artefact(
                    db,
                    kind="criterion",
                    granted=True,
                    consent_script_id="criterion.synthetic",
                    script_audio_sha256=canonical_sha256("synthetic-consent"),
                    language=person.language,
                    policy_version="1.0.0",
                    presented_at=now,
                    decided_at=now,
                    recorded_by=ACTOR,
                    participant_pid=pid,
                )
            cohort = "holdout" if rng.random() < holdout_share else "main"
            stats[f"cohort_{cohort}"] += 1
            study_svc.enroll(
                db,
                study=study,
                participant=participant,
                cell={
                    "language": person.language,
                    "age_band": "*",
                    "gender": "*",
                    "edu_band": "*",
                    "literacy_band": "*",
                },
                cohort_id=cohort,
                eligibility={},
                actor=ACTOR,
                criterion_blocks=[person.block] if person.block in ROTATING else list(ROTATING),
            )
            for s in person.sessions:
                occasion_id = f"T{s.occasion}"
                row = db.get(GameSession, uuid.UUID(s.session_id))
                if row is None:
                    stats["sessions_missing"] += 1
                    continue
                linked = db.execute(select(ParticipantLink.id).where(ParticipantLink.session_id == row.session_id))
                if linked.first() is None:
                    db.add(
                        ParticipantLink(
                            pid=pid,
                            session_id=row.session_id,
                            study_id=study_id,
                            occasion_id=occasion_id,
                            visit_number=s.occasion,
                            method="manual",
                            linked_by=ACTOR,
                            second_linker=f"{ACTOR}:second",
                            confidence=1.0,
                        )
                    )
                row.participant_pid, row.study_id, row.occasion_id = pid, study_id, occasion_id
                stats["sessions_linked"] += 1
        db.flush()
    return stats


def link_and_administer(
    settings: Settings, sim: _Simulated, study_id: str, holdout_share: float, seed: int, *, processes: int = 1
) -> dict[str, Any]:
    """Enrolment and linkage, then criterion administrations (planned-missing items stored) in parallel."""
    stats = _enrol_and_link(settings, sim, study_id, holdout_share, seed)
    with session_scope() as db:
        occasions = {
            o.occasion_id: list(o.instruments)
            for o in db.execute(select(MeasurementOccasion).where(MeasurementOccasion.study_id == study_id)).scalars()
        }
        all_instruments = sorted(
            {r["instrument_id"] for c in sim.criterion.values() for r in c.responses} | {"bfi2_xs"}
        )
        _approve_for_dev(db, all_instruments, {p.language for p in sim.persons.values()})
        instruments: dict[str, _Instrument] = {}
        for i in all_instruments:
            v = (
                db.execute(
                    select(InstrumentVersion)
                    .where(InstrumentVersion.instrument_id == i)
                    .order_by(InstrumentVersion.created_at.desc())
                )
                .scalars()
                .first()
            )
            if v is not None:
                instruments[i] = _Instrument(v.version, dict(v.definition))
    pids = sorted(sim.persons)
    n = max(1, min(processes, len(pids)))
    payloads = []
    for k in range(n):
        keep = set(pids[k::n])
        payloads.append(
            {
                "study_id": study_id,
                "instruments": instruments,
                "occasions": occasions,
                "all_instruments": all_instruments,
                "persons": {
                    pid: _SimPerson(pid, p.language, p.block, [], p.retest)
                    for pid, p in sim.persons.items()
                    if pid in keep
                },
                "criterion": {
                    occ: replace(c, responses=[r for r in c.responses if r["pid"] in keep])
                    for occ, c in sim.criterion.items()
                },
            }
        )
    for part in _run_shards("administer", payloads):
        stats.update(part)
    return dict(stats)


def _administer_worker(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Criterion administrations for one shard of participants (one transaction per administration)."""
    sim = _Simulated(dict(payload["persons"]), [], dict(payload["criterion"]), set(), "", {})
    instruments: Mapping[str, _Instrument] = payload["instruments"]
    occasions: Mapping[str, list[str]] = payload["occasions"]
    out: Counter[str] = Counter()
    for occasion_id in sorted(occasions):
        # T1 administers the full battery the simulator produced; later occasions their registered list.
        wanted = [i for i in payload["all_instruments"] if occasion_id == "T1" or i in occasions[occasion_id]]
        for pid, inst_id, responses, planned, block, role in _administrations(
            sim, instruments, occasion_id, wanted, sorted(sim.persons)
        ):
            with session_scope() as db:
                criterion_svc.submit_administration(
                    db,
                    criterion_svc.Administration(
                        pid=pid,
                        study_id=str(payload["study_id"]),
                        wave=1,
                        occasion_id=occasion_id,
                        instrument_id=inst_id,
                        instrument_version=instruments[inst_id].version,
                        language=sim.persons[pid].language,
                        block=block,
                        administration_mode="read_aloud",
                        administrator_id="admin-sim-01",
                        device_id="tablet-sim-01",
                        audio_version=None,
                        site_mode="supervised",
                        rater_role=role,
                        rated_pid=None,
                        source="in_app",
                        planned_missing_items=planned,
                        responses=responses,
                    ),
                    ACTOR,
                )
            out["administrations"] += 1
            out["planned_missing_items"] += len(planned)
    return dict(out)


# ---------------------------------------------------------------- worker


def run_worker(settings: Settings, workers: int) -> dict[str, Any]:
    """Drain the queue with ``workers`` worker processes (SKIP LOCKED), then once more in-process.

    Jobs run in their own interpreters so that heavy ones (batch scoring loads a whole partition of raw
    events) never share memory with the pipeline process.
    """
    t0 = time.perf_counter()
    if workers >= 1:
        env = {**os.environ}
        procs = [
            subprocess.Popen(
                [sys.executable, "-m", "shriii_api.cli", "worker", "--once"],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
            for _ in range(workers)
        ]
        for p in procs:
            _, err = p.communicate()
            if p.returncode != 0:
                log.warning("worker process exited with %s: %s", p.returncode, (err or "")[-500:])
    ran = drain(settings=settings, max_jobs=1_000_000)
    return {"in_process_jobs": ran, "seconds": round(time.perf_counter() - t0, 1)}


def _job_summary(db: Session, since: datetime) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = defaultdict(dict)
    for job_type, status, n in db.execute(
        select(Job.job_type, Job.status, func.count()).where(Job.created_at >= since).group_by(Job.job_type, Job.status)
    ):
        out[str(job_type)][str(status)] = int(n)
    return dict(out)


def _failed_jobs(db: Session, since: datetime, limit: int = 10) -> list[dict[str, Any]]:
    rows = db.execute(
        select(Job.job_type, Job.error).where(Job.created_at >= since, Job.status == "failed").limit(limit)
    ).all()
    return [{"job_type": str(t), "error": (e or "")[:300]} for t, e in rows]


# ---------------------------------------------------------------- research steps through the HTTP API


class _Api:
    def __init__(self, client: TestClient, settings: Settings) -> None:
        token, _ = issue_dev_token(settings, "demo-pipeline", ["admin", "researcher", "analyst"])
        self.client = client
        self.headers = {"Authorization": f"Bearer {token}"}

    def post(
        self,
        path: str,
        body: Mapping[str, Any] | None = None,
        *,
        expect: Sequence[int] = (200, 201, 202),
        **params: Any,
    ) -> Any:
        r = self.client.post(
            f"/api/v1{path}", json=dict(body) if body is not None else None, params=params or None, headers=self.headers
        )
        if r.status_code not in expect:
            raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:800]}")
        return r.json()

    def get(self, path: str, **params: Any) -> Any:
        r = self.client.get(f"/api/v1{path}", params=params or None, headers=self.headers)
        if r.status_code != 200:
            raise RuntimeError(f"GET {path} -> {r.status_code}: {r.text[:800]}")
        return r.json()


def _primary_hypotheses(pathway: str) -> list[str]:
    return [
        h["id"]
        for h in content.hypotheses().data.get("hypotheses", [])
        if h.get("family") == "primary" and pathway in h.get("pathways", [])
    ]


def _results(api: _Api, run_id: str) -> dict[str, Any]:
    run: dict[str, Any] = api.get(f"/validation/runs/{run_id}")
    if run["status"] != "succeeded":
        raise RuntimeError(f"validation run {run['analysis']} {run['status']}: {run.get('error')}")
    return run


def _fmt(x: Any, nd: int = 3) -> Any:
    return round(float(x), nd) if isinstance(x, (int, float)) and math.isfinite(float(x)) else x


def _summarise_runs(runs: Mapping[str, Mapping[str, Any]], focal: str, dif_indicator: str) -> dict[str, Any]:
    def rows(analysis: str) -> list[dict[str, Any]]:
        return list(runs.get(analysis, {}).get("results") or [])

    out: dict[str, Any] = {}
    out["retest_icc_a1_construct"] = [
        {
            "construct": r["subject"],
            "language": r["subgroup"].get("language", "pooled"),
            "icc_a1": _fmt(r["estimate"]),
            "ci": [_fmt(r["ci_low"]), _fmt(r["ci_high"])],
            "n_pairs": r["n"],
            "passed_b1": r["passed"],
        }
        for r in rows("reliability")
        if r["metric"] == "icc_a1" and r["subject_kind"] == "construct"
    ]
    out["composite_reliability"] = [
        {
            "construct": r["subject"],
            "language": r["subgroup"].get("language", "pooled"),
            r["metric"]: _fmt(r["estimate"]),
            "ci": [_fmt(r["ci_low"]), _fmt(r["ci_high"])],
            "passed_b2": r["passed"],
        }
        for r in rows("reliability")
        if r["metric"] in ("omega_total", "alpha") and "language" not in r["subgroup"]
    ]
    out["primary_hypotheses_pooled"] = [
        {
            "hypothesis": r["hypothesis_id"],
            "r": _fmt(r["estimate"]),
            "ci": [_fmt(r["ci_low"]), _fmt(r["ci_high"])],
            "n": r["n"],
            "p_holm": _fmt(r["details"].get("p_adjusted"), 4),
            "passed": r["passed"],
            "status": r["details"].get("status"),
            "confirmatory": not r["exploratory"],
        }
        for r in rows("construct_validity")
        if r["subject_kind"] == "hypothesis"
        and r["details"].get("family") == "primary"
        and "language" not in r["subgroup"]
    ]
    dif_rows = [r for r in rows("dif") if r["metric"] == "dif_delta_r2"]
    out["dif_flagged"] = [
        {
            "indicator": r["subject"],
            "class": r["details"].get("class"),
            "delta_r2": _fmt(r["estimate"], 4),
            "uniform_shift_sd": _fmt(r["details"].get("uniform_shift_sd")),
            "focal": r["subgroup"].get("focal"),
            "matching": r["details"].get("matching"),
        }
        for r in dif_rows
        if r["details"].get("class") in ("B", "C")
    ]
    planted = next((r for r in dif_rows if r["subject"] == dif_indicator), None)
    out["planted_dif"] = {
        "indicator": dif_indicator,
        "focal_language": focal,
        "recovered": bool(planted and planted["details"].get("class") in ("B", "C")),
        "class": planted["details"].get("class") if planted else None,
        "delta_r2": _fmt(planted["estimate"], 4) if planted else None,
        "false_positive_large_dif": sorted(
            r["subject"] for r in dif_rows if r["details"].get("class") == "C" and r["subject"] != dif_indicator
        ),
    }
    out["invariance"] = [
        {
            "construct": r["subject"],
            "grouping": r["subgroup"].get("grouping"),
            "level": r["details"].get("level"),
            "freed": r["details"].get("freed_intercepts"),
            "status": r["details"].get("status"),
        }
        for r in rows("measurement_invariance")
        if r["metric"] == "invariance_level"
    ]
    fair = rows("fairness")
    out["fairness"] = {
        "differential_exclusion_pp": next(
            (_fmt(r["estimate"], 2) for r in fair if r["metric"] == "differential_exclusion_pp"), None
        ),
        "tost_equivalent_share": _fmt(
            np.mean(
                [bool(r["passed"]) for r in fair if r["metric"] == "mean_difference_tost" and r["passed"] is not None]
            )
            if any(r["metric"] == "mean_difference_tost" and r["passed"] is not None for r in fair)
            else float("nan"),
            2,
        ),
        "differential_prediction": [
            {"hypothesis": r["hypothesis_id"], "conclusion": r["details"].get("conclusion")}
            for r in fair
            if r["metric"] == "slope_difference"
        ],
    }
    inc = rows("incremental_validity")
    out["prediction"] = {
        "cv_r2": [
            {
                "comparison": r["subject"],
                "model": r["subgroup"].get("model"),
                "cv_r2": _fmt(r["estimate"]),
                "ci": [_fmt(r["ci_low"]), _fmt(r["ci_high"])],
            }
            for r in inc
            if r["metric"] == "cv_r2"
        ],
        "incremental_cv_r2": next(
            (
                {
                    "estimate": _fmt(r["estimate"], 4),
                    "ci": [_fmt(r["ci_low"], 4), _fmt(r["ci_high"], 4)],
                    "primary_model": r["details"].get("primary_model"),
                }
                for r in inc
                if r["metric"] == "incremental_cv_r2"
            ),
            None,
        ),
        "holdout_r2": [
            {"comparison": r["subject"], "r2": _fmt(r["estimate"]), "n": r["n"]}
            for r in inc
            if r["metric"] == "holdout_r2"
        ],
    }
    st = rows("factor_structure")
    out["structure"] = {
        "parallel_analysis_factors": next(
            (r["estimate"] for r in st if r["metric"] == "parallel_analysis_n_factors"), None
        ),
        "cfa": [
            {"subject": r["subject"], "cfi": _fmt(r["estimate"]), "model": r["details"].get("model")}
            for r in st
            if r["metric"] == "cfa_cfi"
        ],
        "redundant_pairs": [r["subject"] for r in st if r["metric"] == "redundancy_r"],
    }
    out["mtmm_campbell_fiske"] = {
        r["subject"]: r["passed"] for r in rows("mtmm") if r["metric"] == "validity_diagonal_r" and not r["subgroup"]
    }
    return out


def run_research(api: _Api, settings: Settings, study_id: str, config: DemoConfig, focal: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    job = api.post("/features/batch-scoring", study_id=study_id, pathway=config.pathway)
    out["batch_scoring_worker"] = run_worker(settings, 1)
    finished = api.get(f"/admin/jobs/{job['job_id']}")
    if finished["status"] != "succeeded":
        raise RuntimeError(f"batch scoring {finished['status']}: {finished.get('error')}")
    out["batch_scoring"] = {"job_id": job["job_id"], "result": finished.get("result")}
    out["group_indicators"] = [
        {
            "indicator": g["indicator_id"],
            "partition": {k: v for k, v in g["partition"].items() if k != "pathway"},
            "estimate": _fmt(g["estimate"]),
            "ci": [_fmt(g["ci_low"]), _fmt(g["ci_high"])],
            "n_participants": g["n_participants"],
            "suppressed": g["suppressed"],
        }
        for g in api.get("/features/group-indicators", study_id=study_id)
    ]
    job = api.post("/validation/matching", study_id=study_id)
    out["matching_job"] = job["job_id"]
    snap = api.post(
        "/validation/datasets",
        {
            "study_id": study_id,
            "name": "demo pipeline snapshot",
            "spec": {"pathway": config.pathway, "include_synthetic": True, "holdout_cohorts": ["holdout"]},
        },
    )
    run_worker(settings, 1)
    snap = api.get(f"/validation/datasets/{snap['snapshot_id']}")
    if snap["status"] != "ready":
        raise RuntimeError(f"snapshot is {snap['status']}: {snap.get('error')}")
    snap = api.post(f"/validation/datasets/{snap['snapshot_id']}/freeze")
    out["snapshot"] = {
        "snapshot_id": snap["snapshot_id"],
        "sha256": snap["sha256"],
        "rows": snap["row_count"],
        "participants": snap["n_participants"],
        "exclusions": snap["exclusions"],
        "columns": len(snap["manifest"].get("columns", [])),
    }
    sid = snap["snapshot_id"]
    n_boot = config.n_boot
    plan: list[tuple[str, dict[str, Any], bool, list[str]]] = [
        ("descriptives", {}, False, []),
        ("reliability", {"n_boot": n_boot}, False, []),
        ("construct_validity", {"n_boot": n_boot}, True, _primary_hypotheses(config.pathway)),
        ("mtmm", {}, False, []),
        ("factor_structure", {}, False, []),
        ("measurement_invariance", {"groupings": ["language"]}, False, []),
        ("dif", {"groupings": ["language"]}, False, []),
        ("fairness", {"groupings": ["language"]}, False, []),
        (
            "incremental_validity",
            {"outcome": config.outcome, "models": list(config.models), "n_boot": n_boot},
            False,
            [],
        ),
    ]
    run_ids: dict[str, str] = {}
    for analysis, params, confirmatory, hyps in plan:
        body = {
            "snapshot_id": sid,
            "analysis": analysis,
            "params": params,
            "confirmatory": confirmatory,
            "hypothesis_ids": hyps,
        }
        run_ids[analysis] = api.post("/validation/runs", body)["run_id"]
    # Predictive model registry: participant-grouped CV + untouched holdout cohort.
    columns = set(snap["manifest"].get("columns", []))
    features = sorted(
        c for c in columns if c.startswith("ind__self_control.") and c != "ind__self_control.choice_consistency"
    )
    model = api.post(
        "/models",
        {
            "name": f"demo-bscs-from-game-{sid[:8]}",
            "version": "0.1.0",
            "comparison": "game_to_criterion",
            "target": "crit__bscs.total",
            "features": features,
            "algorithm": "ridge",
            "params": {"n_boot": n_boot},
            "snapshot_id": sid,
            "holdout_cohort": "holdout",
        },
    )
    out["worker_analyses"] = run_worker(settings, config.workers)
    runs = {a: _results(api, r) for a, r in run_ids.items()}
    out["validation_runs"] = {
        a: {"run_id": r["run_id"], "status": r["status"], "results": len(r["results"] or []), "engine": r["engine"]}
        for a, r in runs.items()
    }
    training = api.get(f"/models/{model['model_id']}/training-runs")[0]
    out["model"] = {
        "status": training["status"],
        "cv_r2": training["metrics"].get("cv", {}).get("r2"),
        "holdout": training["metrics"].get("holdout"),
        "n_train": training["metrics"].get("n_train"),
        "n_holdout": training["metrics"].get("n_holdout"),
        "error": training.get("error"),
    }
    # Provisional norms per language from the composite retest reliability of the same language.
    rel = {
        (r["subject"], r["subgroup"].get("language")): r["estimate"]
        for r in runs["reliability"]["results"]
        if r["metric"] == "icc_a1" and r["subject_kind"] == "construct" and r["estimate"] is not None
    }
    norm_jobs = []
    for language in config.languages:
        for trait in ("self_control", "risk_preference"):
            reliability = rel.get((trait, language)) or rel.get((trait, None))
            if reliability is None or not 0 <= reliability < 1:
                continue
            norm_jobs.append(
                api.post(
                    "/norms/tables",
                    {
                        "snapshot_id": sid,
                        "trait": trait,
                        "pathway": config.pathway,
                        "language": language,
                        "norm_table_version": f"demo-{sid[:8]}",
                        "reliability": float(reliability),
                    },
                )["job_id"]
            )
    run_worker(settings, 1)
    tables = [t for t in api.get("/norms/tables", pathway=config.pathway) if t["data_snapshot_id"] == sid]
    out["norms"] = [
        {
            "trait": t["trait"],
            "language": t["language"],
            "cut_points": [_fmt(c) for c in t["cut_points"]],
            "sem": _fmt(t["sem"]),
            "effective_n": t["effective_n"],
            "provisional": t["provisional"],
            "status": t["status"],
        }
        for t in tables
    ]
    out["results"] = _summarise_runs(runs, focal, config.dif_indicator)
    gate = api.post(
        f"/validation/datasets/{sid}/gate-evaluation", {"pathway": config.pathway, "languages": list(config.languages)}
    )
    trait_rows = [r for r in gate["results"] if r["metric"] == "trait_gate_status"]
    battery_rows = [r for r in gate["results"] if r["metric"] == "battery_gate_status"]
    out["gates"] = {
        "evaluation_run_id": gate["run_id"],
        "evaluate_only": True,
        "trait_status_counts": dict(Counter(f"{r['details']['evaluated_status']}" for r in trait_rows)),
        "trait_rules_passed": {
            rule: sum(1 for r in trait_rows if r["details"]["rules"].get(rule) == "pass")
            for rule in ("B1", "B2", "B3", "B4", "B5", "B6")
        },
        "examples": [
            {
                "trait": r["subject"],
                "language": r["subgroup"]["language"],
                "status": r["details"]["evaluated_status"],
                "rules": r["details"]["rules"],
            }
            for r in trait_rows
            if r["subject"] in ("self_control", "risk_preference", "decisiveness")
        ],
        "battery": [
            {
                "language": r["subgroup"]["language"],
                "site_mode": r["subgroup"]["site_mode"],
                "status": r["details"]["status"],
                "rules": r["details"]["rules"],
                "qualifying_languages": r["details"]["qualifying_languages"],
            }
            for r in battery_rows
        ],
    }
    out["provenance"] = runs["reliability"]["manifest"].get("provenance", {})
    return out


def run_operations(api: _Api, settings: Settings, study_id: str) -> dict[str, Any]:
    """Release pack (fail closed), report preparation + a report, kiosk health and a retention dry run."""
    out: dict[str, Any] = {}
    pack = api.post("/admin/gates/release-pack", {}, expect=(200, 201))
    out["release_pack"] = {
        "version": pack.get("release_pack_version"),
        "battery_gates": len(pack.get("pack", {}).get("battery_gates", [])),
    }
    with session_scope() as db:
        session_row = db.execute(
            select(GameSession).where(GameSession.study_id == study_id, GameSession.status == "completed").limit(1)
        ).scalar_one()
        session_id = session_row.session_id
        enqueue(
            db,
            "report_preparation",
            {"session_id": str(session_id)},
            created_by=ACTOR,
            settings=settings,
            force_new=True,
        )
        enqueue(db, "kiosk_health", {}, created_by=ACTOR, settings=settings, force_new=True)
        enqueue(db, "retention", {"dry_run": True}, created_by=ACTOR, settings=settings, force_new=True)
        enqueue(db, "consent_parking_expiry", {}, created_by=ACTOR, settings=settings, force_new=True)
    run_worker(settings, 1)
    report = api.post("/reports", {"session_id": str(session_id), "report_mode": "player_report"}, expect=(201,))
    artefact = report["artefact"]
    out["report"] = {
        "requested": "player_report",
        "report_mode": artefact["report_mode"],
        "traits_shown": len(artefact["traits_shown"]),
        "note": "fail closed: no open battery gate, so the session gets a thank-you screen",
    }
    return out


# ---------------------------------------------------------------- entry point


def _stored_counts(study_id: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Simulation / ingestion / linkage figures of an already ingested study (resume mode)."""
    from shriii_api.db.models.criterion import Response  # noqa: PLC0415

    with session_scope() as db:
        sessions = list(db.execute(select(GameSession).where(GameSession.study_id == study_id)).scalars())
        pids = {s.participant_pid for s in sessions if s.participant_pid}
        retests = {s.participant_pid for s in sessions if s.occasion_id == "T2"}
        events = sum(int(s.event_count or 0) for s in sessions)
        responses = db.execute(
            select(func.count()).select_from(Response).where(Response.study_id == study_id)
        ).scalar_one()
        by_language = Counter(s.language for s in sessions if s.occasion_id == "T1")
    simulated = {
        "participants": len(pids),
        "sessions": len(sessions),
        "retest_participants": len(retests),
        "events": events,
        "by_language": dict(by_language),
        "resumed": True,
    }
    return (
        simulated,
        {"batches": "resumed", "events": {"stored": events}},
        {"criterion_responses_stored": int(responses)},
    )


def run_demo_pipeline(settings: Settings, config: DemoConfig, *, migrate_first: bool = True) -> dict[str, Any]:
    if not settings.is_dev:
        raise RuntimeError("the demo pipeline only runs when ENV is dev or test (it creates synthetic data)")
    clock = _Clock()
    seed = config.seed if config.seed is not None else int(time.time()) % 1_000_000
    study_id = config.study_id or f"demo-pipeline-{seed}"
    focal = config.dif_language or config.languages[-1]
    started_at = datetime.now(UTC)
    summary: dict[str, Any] = {"study_id": study_id, "seed": seed}
    summary["config"] = {
        "participants_per_language": config.participants_per_language,
        "languages": list(config.languages),
        "retests": config.retests,
        "pathway": config.pathway,
        "planted_dif": {"trial": config.dif_trial, "language": focal, "logit_shift": config.dif_logit_shift},
        "careless_share": config.careless_share,
        "holdout_share": config.holdout_share,
        "outcome": config.outcome,
        "models": list(config.models),
        "workers": config.workers,
    }
    if migrate_first:
        with clock.step("migrate"):
            from shriii_api.cli import migrate  # noqa: PLC0415

            migrate(settings)
    with clock.step("seed"), session_scope() as db:
        summary["seed_reference"] = seed_svc.seed_reference(db, ACTOR)
        summary["demo_study"] = seed_svc.seed_demo_study(db, ACTOR, study_id)
        token = _device_token(db)
        plans = db.execute(
            select(func.count()).select_from(AnalysisPlan).where(AnalysisPlan.study_id == study_id)
        ).scalar_one()
        summary["analysis_plans"] = int(plans)
    from shriii_api.main import create_app  # noqa: PLC0415

    if config.skip_ingestion:
        # Resume an earlier run: the study's raw events, links and criterion scores are already stored.
        summary["simulated"], summary["ingestion"], summary["linkage"] = _stored_counts(study_id)
    else:
        with clock.step("simulate"):
            sim = simulate(config, seed, study_id)
            summary["simulated"] = {
                "participants": len(sim.persons),
                "sessions": len(sim.sessions),
                "retest_participants": sum(1 for p in sim.persons.values() if p.retest),
                "events": sum(len(s.events) for s in sim.sessions),
                "criterion_responses": {k: len(v.responses) for k, v in sim.criterion.items()},
                "careless_participants": len(sim.careless),
                "simulator_params_sha256": sim.params_sha256,
                "planted_dif": sim.dif,
                "by_language": dict(Counter(p.language for p in sim.persons.values())),
            }
        with clock.step("upload events via POST /api/v1/events/batch"):
            summary["ingestion"] = upload_events(token, sim.sessions, processes=config.workers)
        # The raw events are in the database now; keep only what linkage needs (memory).
        sim = _without_events(sim)
        gc.collect()
        with clock.step("participants, linkage and criterion administrations"):
            summary["linkage"] = link_and_administer(
                settings, sim, study_id, config.holdout_share, seed, processes=config.workers
            )
        del sim
        gc.collect()
        with clock.step("worker: event validation, trials, features"):
            summary["worker_scoring"] = run_worker(settings, config.workers)
    with TestClient(create_app()) as client:
        api = _Api(client, settings)
        with clock.step("matching, snapshot, analyses, models, norms, gates"):
            summary["research"] = run_research(api, settings, study_id, config, focal)
        with clock.step("release pack, report, kiosk health, retention"):
            summary["operations"] = run_operations(api, settings, study_id)
    with session_scope() as db:
        summary["jobs"] = _job_summary(db, started_at)
        summary["failed_jobs"] = _failed_jobs(db, started_at)
    summary["timings_s"] = clock.steps
    summary["total_s"] = round(time.perf_counter() - clock.started, 1)
    out_dir = Path(settings.data_dir) / "demo"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{study_id}.json"
    path.write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    summary["summary_file"] = str(path)
    return summary


def _verdict(passed: Any, status: Any) -> str:
    if passed is True:
        return "pass"
    if passed is False:
        return "fail"
    return str(status)


def render_summary(summary: Mapping[str, Any]) -> str:
    """A short human-readable digest of :func:`run_demo_pipeline`'s summary."""
    r = summary.get("research", {})
    res = r.get("results", {})
    sim = summary["simulated"]
    snap = r.get("snapshot", {})
    gates = r.get("gates", {})
    hyps = ", ".join(
        f"{h['hypothesis']} r={h['r']} {_verdict(h['passed'], h['status'])}"
        for h in res.get("primary_hypotheses_pooled", [])
    )
    battery = ", ".join(f"{b['language']}={b['status']}" for b in gates.get("battery", []))
    norms = [
        (n["trait"], n["language"], n["cut_points"], "provisional" if n["provisional"] else "final")
        for n in r.get("norms", [])
    ]
    lines = [
        f"SHRIII demo pipeline - study {summary['study_id']} (seed {summary['seed']})",
        f"  simulated: {sim['participants']} participants {sim['by_language']}, {sim['sessions']} sessions "
        f"({sim['retest_participants']} with a T2 retest), {sim['events']} raw events",
        f"  ingestion (POST /api/v1/events/batch): {summary['ingestion']['batches']} batches -> "
        f"{summary['ingestion']['events']}",
        f"  criterion: {summary['linkage'].get('administrations')} administrations, "
        f"{summary['linkage'].get('planned_missing_items')} planned-missing items stored with the responses",
        f"  batch scoring: {r.get('batch_scoring', {}).get('result')}",
        f"  group-level private reports (never individual): {r.get('group_indicators')}",
        f"  snapshot {snap.get('snapshot_id')}: {snap.get('rows')} rows / {snap.get('participants')} participants, "
        f"exclusions {snap.get('exclusions', {}).get('by_reason')}",
        f"  retest ICC(A,1), construct composites: {res.get('retest_icc_a1_construct', [])[:6]}",
        f"  primary hypotheses (pooled, Holm, confirmatory): {hyps}",
        f"  planted DIF: {res.get('planted_dif')}",
        f"  invariance: {[(i['construct'], i['grouping'], i['level']) for i in res.get('invariance', [])]}",
        f"  fairness: {res.get('fairness')}",
        f"  incremental CV R^2 (game + battery over battery): {res.get('prediction', {}).get('incremental_cv_r2')}",
        f"  holdout R^2: {res.get('prediction', {}).get('holdout_r2')}",
        f"  registered model (BSCS from game, participant-grouped CV + holdout): {r.get('model')}",
        f"  norms: {norms}",
        f"  gates (evaluate-only): trait statuses {gates.get('trait_status_counts')}, rules passed "
        f"{gates.get('trait_rules_passed')}; battery {battery}",
        f"  report for a played session: {summary.get('operations', {}).get('report')}",
        f"  jobs: {summary.get('jobs', {})}",
        f"  failed jobs: {summary.get('failed_jobs', [])}",
        f"  provenance: git {r.get('provenance', {}).get('git_sha')}, snapshot sha256 {snap.get('sha256')}, "
        f"dictionary {r.get('provenance', {}).get('dictionary_sha256')}",
        f"  timings {summary.get('timings_s')}; total {summary.get('total_s')}s",
        f"  full summary: {summary.get('summary_file')}",
    ]
    return "\n".join(lines)


__all__ = ["DemoConfig", "render_summary", "run_demo_pipeline", "simulate", "upload_events"]


def _shard_main(path: str) -> int:
    """Entry point of a shard interpreter (``python -m shriii_api.services.demo_pipeline <payload.pkl>``)."""
    from shriii_api.observability import configure_logging  # noqa: PLC0415
    from shriii_api.settings import get_settings  # noqa: PLC0415

    configure_logging(get_settings())
    # The payload file is written by this module's parent process into a private temp directory.
    payload = pickle.loads(Path(path).read_bytes())
    kind = payload.pop("kind")
    workers: dict[str, Callable[[Mapping[str, Any]], dict[str, Any]]] = {
        "upload": _upload_worker,
        "administer": _administer_worker,
    }
    result = workers[kind](payload)
    sys.stdout.write(RESULT_PREFIX + json.dumps(result) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(_shard_main(sys.argv[1]))
