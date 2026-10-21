"""Scenario plans: which kiosk sends which batch, when, and what the server must end up storing.

A plan is built completely before the timed phase (bodies are pre-serialised bytes), so client-side
JSON, hashing and encryption never distort the measured latency.

Scenarios (``SCENARIOS``):

``steady``      Each kiosk uploads its sessions in order with an exponential think time between batches
                (an open-ish fleet at a configurable rate).
``saturate``    The ING-02 acceptance case: 50 kiosks upload 500-event batches back to back with no
                think time (closed loop, the worst case for one API instance).
``retry``       Like ``steady``, but after a successful upload a share of batches is re-sent with the
                same ``batch_id`` (lost response) and a share is re-packed under a new ``batch_id``
                (outbox crash before the ack). Every resend must store nothing new.
``dup_storm``   Each storm batch is fired ``copies`` times at once with the same ``batch_id`` and
                ``copies`` times re-packed under new ids. Exactly one copy of each event may be stored.
``out_of_order``Batches of each session arrive in reverse, so scorable events arrive before the consent
                batch and are parked, then released. Some kiosks have clocks at 1970 or +3 days (ING-02 AC).
``reconnect``   ``kiosks`` kiosks were offline and each holds a backlog of sessions. They all reconnect
                within ``jitter_s`` and drain their outboxes as fast as the server answers.
"""

from __future__ import annotations

import json
import random
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from shriii_loadtest.batches import (
    MAX_EVENTS_PER_BATCH,
    Encryption,
    KioskIdentity,
    OutboxSession,
    PreparedBatch,
    build_batch,
    pack_outbox,
)
from shriii_loadtest.corpus import Corpus, retarget
from shriii_loadtest.ids import uuid7

__all__ = ["SCENARIOS", "KioskScript", "Plan", "PlanOptions", "Step", "build_plan", "repack"]


@dataclass(slots=True)
class Step:
    """Send ``batch`` after waiting ``delay_s``. ``copies`` > 1 fires identical requests concurrently;
    ``siblings`` are different bodies (re-packed copies) fired at the same moment."""

    batch: PreparedBatch
    delay_s: float = 0.0
    copies: int = 1
    siblings: list[PreparedBatch] = field(default_factory=list)


@dataclass(slots=True)
class KioskScript:
    kiosk: KioskIdentity
    start_offset_s: float
    steps: list[Step] = field(default_factory=list)


@dataclass(slots=True)
class Plan:
    scenario: str
    options: PlanOptions
    scripts: list[KioskScript]
    expected_sessions: dict[str, int]
    """session_id -> number of distinct events the server must hold once the plan has run."""
    corpus: dict[str, Any]

    @property
    def requests(self) -> int:
        return sum(s.copies + len(s.siblings) for k in self.scripts for s in k.steps)

    @property
    def unique_events(self) -> int:
        return sum(self.expected_sessions.values())

    def describe(self) -> dict[str, Any]:
        sizes = [s.batch.size_bytes for k in self.scripts for s in k.steps]
        counts = [s.batch.event_count for k in self.scripts for s in k.steps]
        return {
            "scenario": self.scenario,
            "kiosks": len(self.scripts),
            "sessions": len(self.expected_sessions),
            "unique_events": self.unique_events,
            "requests": self.requests,
            "full_batches": sum(1 for c in counts if c == MAX_EVENTS_PER_BATCH),
            "batch_bytes": {
                "min": min(sizes) if sizes else 0,
                "max": max(sizes) if sizes else 0,
                "mean": round(sum(sizes) / len(sizes)) if sizes else 0,
            },
        }


@dataclass(slots=True)
class PlanOptions:
    kiosks: int = 50
    sessions_per_kiosk: int = 2
    max_events: int = MAX_EVENTS_PER_BATCH
    max_body_bytes: int | None = None
    """Split a batch (keeping order) until its body fits; mirrors a kiosk that respects the server limit."""
    encryption: Encryption = "none_dev"
    public_key: bytes | None = None
    think_s: float = 5.0
    retry_same_id_p: float = 0.2
    repack_p: float = 0.1
    storm_batches: int = 10
    copies: int = 10
    jitter_s: float = 2.0
    clock_skew_share: float = 0.2
    seed: int = 1
    kiosk_prefix: str = "lt"


def _fit(
    kiosk: KioskIdentity,
    slices: list[tuple[OutboxSession, list[dict[str, Any]]]],
    wall: datetime,
    opts: PlanOptions,
    kind: str = "fresh",
) -> list[PreparedBatch]:
    """Build one batch, or halve it (order kept) until each body is within ``max_body_bytes``."""
    batch = build_batch(kiosk, slices, kiosk_t_wall=wall, encryption=opts.encryption, public_key=opts.public_key, kind=kind)
    if opts.max_body_bytes is None or batch.size_bytes <= opts.max_body_bytes or batch.event_count == 1:
        return [batch]
    flat = [(s, [e]) for s, events in slices for e in events]
    half = len(flat) // 2

    def regroup(part: list[tuple[OutboxSession, list[dict[str, Any]]]]) -> list[tuple[OutboxSession, list[dict[str, Any]]]]:
        out: list[tuple[OutboxSession, list[dict[str, Any]]]] = []
        for s, evs in part:
            if out and out[-1][0] is s:
                out[-1][1].extend(evs)
            else:
                out.append((s, list(evs)))
        return out

    return _fit(kiosk, regroup(flat[:half]), wall, opts, kind) + _fit(kiosk, regroup(flat[half:]), wall, opts, kind)


def _kiosks(kiosks: list[KioskIdentity], n: int) -> list[KioskIdentity]:
    if len(kiosks) < n:
        raise ValueError(f"plan needs {n} provisioned kiosks, only {len(kiosks)} available")
    return kiosks[:n]


def _outbox(
    corpus: Corpus, kiosk: KioskIdentity, n_sessions: int, rng: random.Random, started: datetime
) -> list[OutboxSession]:
    sessions: list[OutboxSession] = []
    t = started
    for _ in range(n_sessions):
        template = rng.choice(corpus.sessions)
        sid, events = retarget(template.events, kiosk_id=kiosk.kiosk_id, site_id=kiosk.site_id, started_at=t, rng=rng)
        sessions.append(OutboxSession(session_id=sid, events=events))
        t += timedelta(minutes=25)
    return sessions


def _batches_for(kiosk: KioskIdentity, outbox: list[OutboxSession], opts: PlanOptions, wall: datetime) -> list[PreparedBatch]:
    out: list[PreparedBatch] = []
    for slices in pack_outbox(outbox, opts.max_events):
        out.extend(_fit(kiosk, slices, wall, opts))
    return out


def _expected(outboxes: list[list[OutboxSession]]) -> dict[str, int]:
    return {s.session_id: len(s.events) for box in outboxes for s in box}


def _now() -> datetime:
    return datetime.now(UTC)


def _plan_sequential(name: str, corpus: Corpus, kiosks: list[KioskIdentity], opts: PlanOptions, think: bool) -> Plan:
    rng = random.Random(opts.seed)
    scripts: list[KioskScript] = []
    boxes: list[list[OutboxSession]] = []
    for kiosk in _kiosks(kiosks, opts.kiosks):
        box = _outbox(corpus, kiosk, opts.sessions_per_kiosk, rng, _now() - timedelta(hours=1))
        boxes.append(box)
        steps = [
            Step(batch=b, delay_s=rng.expovariate(1.0 / opts.think_s) if think and opts.think_s > 0 else 0.0)
            for b in _batches_for(kiosk, box, opts, _now())
        ]
        start = rng.uniform(0, opts.think_s) if think else rng.uniform(0, 0.25)
        scripts.append(KioskScript(kiosk=kiosk, start_offset_s=start, steps=steps))
    return Plan(name, opts, scripts, _expected(boxes), corpus.describe())


def plan_steady(corpus: Corpus, kiosks: list[KioskIdentity], opts: PlanOptions) -> Plan:
    return _plan_sequential("steady", corpus, kiosks, opts, think=True)


def plan_saturate(corpus: Corpus, kiosks: list[KioskIdentity], opts: PlanOptions) -> Plan:
    return _plan_sequential("saturate", corpus, kiosks, opts, think=False)


def plan_retry(corpus: Corpus, kiosks: list[KioskIdentity], opts: PlanOptions) -> Plan:
    plan = _plan_sequential("retry", corpus, kiosks, opts, think=True)
    rng = random.Random(opts.seed + 1)
    for script in plan.scripts:
        steps: list[Step] = []
        for step in script.steps:
            steps.append(step)
            original = step.batch
            if rng.random() < opts.retry_same_id_p:
                resend = PreparedBatch(**{**_fields(original), "kind": "retry_same_id"})
                steps.append(Step(batch=resend, delay_s=rng.uniform(0.05, 1.0)))
            if rng.random() < opts.repack_p:
                steps.append(Step(batch=repack(original, "repacked"), delay_s=rng.uniform(0.05, 1.0)))
        script.steps = steps
    return plan


def _fields(batch: PreparedBatch) -> dict[str, Any]:
    return {
        "batch_id": batch.batch_id,
        "kiosk_id": batch.kiosk_id,
        "body": batch.body,
        "event_count": batch.event_count,
        "event_ids": batch.event_ids,
        "session_ids": batch.session_ids,
        "kind": batch.kind,
        "contains_consent": batch.contains_consent,
    }


def repack(batch: PreparedBatch, kind: str) -> PreparedBatch:
    """Same events (same event ids and seq) under a fresh ``batch_id``, as an outbox re-batches after a crash.

    Chunks (including any ciphertext) are reused verbatim, so ``sha256`` stays valid.
    """
    doc = json.loads(batch.body)
    doc["batch_id"] = uuid7()
    body = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode()
    return PreparedBatch(**{**_fields(batch), "batch_id": doc["batch_id"], "body": body, "kind": kind})


def plan_dup_storm(corpus: Corpus, kiosks: list[KioskIdentity], opts: PlanOptions) -> Plan:
    rng = random.Random(opts.seed)
    n_kiosks = min(opts.kiosks, opts.storm_batches)
    scripts: list[KioskScript] = []
    boxes: list[list[OutboxSession]] = []
    for i, kiosk in enumerate(_kiosks(kiosks, n_kiosks)):
        box = _outbox(corpus, kiosk, 1, rng, _now() - timedelta(hours=1))
        boxes.append(box)
        batches = _batches_for(kiosk, box, opts, _now())
        steps: list[Step] = []
        for j, batch in enumerate(batches):
            # The first batch of each session is the storm target; the rest drain normally afterwards.
            if j == 0:
                batch.kind = "storm"
                siblings = [repack(batch, "storm_repacked") for _ in range(opts.copies)]
                steps.append(Step(batch=batch, copies=opts.copies, siblings=siblings))
            else:
                steps.append(Step(batch=batch))
        scripts.append(KioskScript(kiosk=kiosk, start_offset_s=0.05 * i, steps=steps))
    return Plan("dup_storm", opts, scripts, _expected(boxes), corpus.describe())


def plan_out_of_order(corpus: Corpus, kiosks: list[KioskIdentity], opts: PlanOptions) -> Plan:
    rng = random.Random(opts.seed)
    scripts: list[KioskScript] = []
    boxes: list[list[OutboxSession]] = []
    for kiosk in _kiosks(kiosks, opts.kiosks):
        r = rng.random()
        if r < opts.clock_skew_share / 2:
            clock = datetime(1970, 1, 1, 0, 5, tzinfo=UTC)  # RTC battery dead
        elif r < opts.clock_skew_share:
            clock = _now() + timedelta(days=3)  # drifted forward
        else:
            clock = _now() - timedelta(hours=1)
        box = _outbox(corpus, kiosk, opts.sessions_per_kiosk, rng, clock)
        boxes.append(box)
        steps: list[Step] = []
        for session in box:
            batches = [b for slices in pack_outbox([session], opts.max_events) for b in _fit(kiosk, slices, clock, opts)]
            batches.reverse()  # consent (seq 3) is in the first batch, which now arrives last
            for b in batches:
                b.kind = "out_of_order"
                steps.append(Step(batch=b, delay_s=rng.uniform(0, 0.5)))
        scripts.append(KioskScript(kiosk=kiosk, start_offset_s=rng.uniform(0, 1.0), steps=steps))
    return Plan("out_of_order", opts, scripts, _expected(boxes), corpus.describe())


def plan_reconnect(corpus: Corpus, kiosks: list[KioskIdentity], opts: PlanOptions) -> Plan:
    rng = random.Random(opts.seed)
    scripts: list[KioskScript] = []
    boxes: list[list[OutboxSession]] = []
    offline_since = _now() - timedelta(hours=26)
    for kiosk in _kiosks(kiosks, opts.kiosks):
        box = _outbox(corpus, kiosk, opts.sessions_per_kiosk, rng, offline_since + timedelta(minutes=rng.uniform(0, 600)))
        boxes.append(box)
        steps = [Step(batch=b) for b in _batches_for(kiosk, box, opts, _now())]
        for s in steps:
            s.batch.kind = "reconnect"
        scripts.append(KioskScript(kiosk=kiosk, start_offset_s=rng.uniform(0, opts.jitter_s), steps=steps))
    return Plan("reconnect", opts, scripts, _expected(boxes), corpus.describe())


SCENARIOS: dict[str, Callable[[Corpus, list[KioskIdentity], PlanOptions], Plan]] = {
    "steady": plan_steady,
    "saturate": plan_saturate,
    "retry": plan_retry,
    "dup_storm": plan_dup_storm,
    "out_of_order": plan_out_of_order,
    "reconnect": plan_reconnect,
}


def build_plan(name: str, corpus: Corpus, kiosks: list[KioskIdentity], opts: PlanOptions) -> Plan:
    try:
        factory = SCENARIOS[name]
    except KeyError as exc:
        raise ValueError(f"unknown scenario {name!r}; choose from {sorted(SCENARIOS)}") from exc
    return factory(corpus, kiosks, opts)
