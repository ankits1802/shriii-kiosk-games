"""Batch construction and scenario plans follow the UploadBatch contract and the outbox rules."""

from __future__ import annotations

import base64
import json
import random
from datetime import UTC, datetime

import pytest
from nacl.public import PrivateKey
from shriii_api.canonical import canonical_sha256 as server_sha256
from shriii_api.security import decrypt_chunk, unseal_dek
from shriii_contracts import EVENT_ADAPTER, UploadBatch
from shriii_loadtest.batches import KioskIdentity, OutboxSession, build_batch, pack_outbox
from shriii_loadtest.corpus import Corpus, retarget
from shriii_loadtest.scenarios import PlanOptions, build_plan

KIOSK = KioskIdentity("lt-0001", "site-load-01", "kdt_x")
NOW = datetime(2026, 10, 21, 6, 0, tzinfo=UTC)


def _session(corpus: Corpus, seed: int = 1) -> OutboxSession:
    sid, events = retarget(
        corpus.sessions[0].events,
        kiosk_id=KIOSK.kiosk_id,
        site_id=KIOSK.site_id,
        started_at=NOW,
        rng=random.Random(seed),
    )
    return OutboxSession(session_id=sid, events=events)


def test_retarget_gives_fresh_valid_events(corpus: Corpus) -> None:
    template = corpus.sessions[0].events
    s1, s2 = _session(corpus, 1), _session(corpus, 2)
    assert s1.session_id != s2.session_id
    assert not {e["event_id"] for e in s1.events} & {e["event_id"] for e in s2.events}
    assert [e["seq"] for e in s1.events] == sorted(e["seq"] for e in template)
    first = s1.events[0]
    assert first["context"]["kiosk_id"] == "lt-0001" and first["session_id"] == s1.session_id
    assert datetime.fromisoformat(first["timing"]["kiosk_t_wall"]) == NOW
    pids = {e["context"]["participant_pid"] for e in s1.events} - {None}
    assert len(pids) <= 1
    for event in s1.events[:200]:
        EVENT_ADAPTER.validate_python(event)
    # the template itself is untouched
    assert template[0]["session_id"] != s1.session_id


def test_pack_outbox_respects_limit_and_order(corpus: Corpus) -> None:
    sessions = [_session(corpus, i) for i in range(3)]
    batches = pack_outbox(sessions, 500)
    flat = [(s.session_id, e["seq"]) for b in batches for s, evs in b for e in evs]
    assert flat == [(s.session_id, e["seq"]) for s in sessions for e in s.events]
    assert all(sum(len(evs) for _, evs in b) <= 500 for b in batches)
    assert all(sum(len(evs) for _, evs in b) == 500 for b in batches[:-1])
    with pytest.raises(ValueError, match="max_events"):
        pack_outbox(sessions, 501)


def test_plain_batch_validates_against_contract_and_server_checksum(corpus: Corpus) -> None:
    session = _session(corpus)
    batch = build_batch(KIOSK, [(session, session.events[:500])], kiosk_t_wall=NOW)
    doc = json.loads(batch.body)
    UploadBatch.model_validate(doc)
    assert doc["sha256"] == server_sha256(doc["session_chunks"])
    assert batch.event_count == 500 and batch.contains_consent
    assert batch.event_ids == tuple(e["event_id"] for e in session.events[:500])


def test_sealed_batch_round_trips_with_server_crypto(corpus: Corpus) -> None:
    private = PrivateKey.generate()
    session = _session(corpus)
    batch = build_batch(
        KIOSK,
        [(session, session.events[:50])],
        kiosk_t_wall=NOW,
        encryption="sealed",
        public_key=bytes(private.public_key),
    )
    doc = json.loads(batch.body)
    UploadBatch.model_validate(doc)
    chunk = doc["session_chunks"][0]
    assert chunk["encryption"] == "x25519_sealed_aes256gcm" and "events" not in chunk
    dek = unseal_dek(bytes(private), chunk["sealed_dek"])
    assert dek == session.dek
    lines = decrypt_chunk(dek, chunk["nonce"], chunk["ciphertext"]).decode().splitlines()
    assert [json.loads(line)["event_id"] for line in lines] == [e["event_id"] for e in session.events[:50]]
    assert doc["sha256"] == server_sha256(doc["session_chunks"])
    assert len(base64.b64decode(chunk["nonce"])) == 12


def test_sealed_requires_public_key(corpus: Corpus) -> None:
    session = _session(corpus)
    with pytest.raises(ValueError, match="public key"):
        build_batch(KIOSK, [(session, session.events[:5])], kiosk_t_wall=NOW, encryption="sealed")


def test_saturate_plan_accounts_for_every_event(corpus: Corpus, kiosks: list[KioskIdentity]) -> None:
    plan = build_plan("saturate", corpus, kiosks, PlanOptions(kiosks=5, sessions_per_kiosk=2))
    assert len(plan.scripts) == 5 and len(plan.expected_sessions) == 10
    sent = [eid for k in plan.scripts for s in k.steps for eid in s.batch.event_ids]
    assert len(sent) == len(set(sent)) == plan.unique_events
    assert all(s.delay_s == 0 for k in plan.scripts for s in k.steps)


def test_body_limit_splits_without_losing_order(corpus: Corpus, kiosks: list[KioskIdentity]) -> None:
    opts = PlanOptions(kiosks=1, sessions_per_kiosk=1, encryption="none_dev", max_body_bytes=200_000)
    plan = build_plan("saturate", corpus, kiosks, opts)
    batches = [s.batch for s in plan.scripts[0].steps]
    assert all(b.size_bytes <= 200_000 for b in batches)
    sent = [eid for b in batches for eid in b.event_ids]
    assert len(sent) == plan.unique_events and len(set(sent)) == len(sent)


def test_retry_plan_resends_same_batch_ids_and_repacks(corpus: Corpus, kiosks: list[KioskIdentity]) -> None:
    opts = PlanOptions(kiosks=4, sessions_per_kiosk=2, retry_same_id_p=1.0, repack_p=1.0, think_s=0.1)
    plan = build_plan("retry", corpus, kiosks, opts)
    steps = plan.scripts[0].steps
    fresh = [s.batch for s in steps if s.batch.kind == "fresh"]
    retries = [s.batch for s in steps if s.batch.kind == "retry_same_id"]
    repacks = [s.batch for s in steps if s.batch.kind == "repacked"]
    assert len(fresh) == len(retries) == len(repacks)
    assert [b.batch_id for b in retries] == [b.batch_id for b in fresh]
    assert all(r.body == f.body for r, f in zip(retries, fresh, strict=True))
    for r, f in zip(repacks, fresh, strict=True):
        assert r.batch_id != f.batch_id and r.event_ids == f.event_ids
        rd, fd = json.loads(r.body), json.loads(f.body)
        assert rd["sha256"] == fd["sha256"] == server_sha256(rd["session_chunks"])


def test_dup_storm_fires_copies_and_siblings(corpus: Corpus, kiosks: list[KioskIdentity]) -> None:
    plan = build_plan("dup_storm", corpus, kiosks, PlanOptions(kiosks=3, storm_batches=3, copies=7))
    first = plan.scripts[0].steps[0]
    assert first.copies == 7 and len(first.siblings) == 7
    assert len({s.batch_id for s in first.siblings} | {first.batch.batch_id}) == 8
    assert plan.requests == sum(14 + len(k.steps) - 1 for k in plan.scripts)


def test_out_of_order_sends_consent_last_and_skews_clocks(corpus: Corpus, kiosks: list[KioskIdentity]) -> None:
    plan = build_plan(
        "out_of_order", corpus, kiosks, PlanOptions(kiosks=20, sessions_per_kiosk=1, clock_skew_share=0.5)
    )
    years = set()
    for script in plan.scripts:
        batches = [s.batch for s in script.steps]
        assert batches[-1].contains_consent
        assert not any(b.contains_consent for b in batches[:-1])
        years.add(json.loads(batches[0].body)["session_chunks"][0]["events"][0]["timing"]["kiosk_t_wall"][:4])
    assert "1970" in years and len(years) >= 2


def test_reconnect_jitter_window(corpus: Corpus, kiosks: list[KioskIdentity]) -> None:
    plan = build_plan("reconnect", corpus, kiosks, PlanOptions(kiosks=10, sessions_per_kiosk=2, jitter_s=1.5))
    assert all(0 <= k.start_offset_s <= 1.5 for k in plan.scripts)
    assert all(s.delay_s == 0 for k in plan.scripts for s in k.steps)


def test_unknown_scenario_and_short_fleet(corpus: Corpus, kiosks: list[KioskIdentity]) -> None:
    with pytest.raises(ValueError, match="unknown scenario"):
        build_plan("nope", corpus, kiosks, PlanOptions())
    with pytest.raises(ValueError, match="provisioned kiosks"):
        build_plan("saturate", corpus, kiosks[:2], PlanOptions(kiosks=3))
