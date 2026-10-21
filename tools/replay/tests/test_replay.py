"""Replay tests on simulator fixture sessions (QA-02 data, real contracts and scoring engine)."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

import pytest
from shriii_contracts.schema_validation import Mode, is_valid
from shriii_replay.cli import main
from shriii_replay.fixtures import Fixture, make_fixture, upload_batches, write_fixture
from shriii_replay.html import render_html
from shriii_replay.jcs import canonical, canonical_sha256
from shriii_replay.load import InputKind, LoadedInput
from shriii_replay.replay import ReplayInputError, replay_session
from shriii_replay.validate import _event_errors
from shriii_scoring import IndicatorEngine


@pytest.fixture(scope="module")
def engine() -> IndicatorEngine:
    return IndicatorEngine(allow_synthetic=True, on_missing_params="flag")


@pytest.fixture(scope="module")
def fx_b(engine: IndicatorEngine) -> Fixture:
    return make_fixture("B", seed=11, n_sessions=3, engine=engine)


@pytest.fixture(scope="module")
def fx_a(engine: IndicatorEngine) -> Fixture:
    return make_fixture("A", seed=5, n_sessions=3, engine=engine)


def _loaded(events: list[dict[str, Any]], batches: list[dict[str, Any]] | None = None) -> LoadedInput:
    kind: InputKind = "upload_batches" if batches else "json_events"
    return LoadedInput(path="<memory>", kind=kind, events=events, batches=batches or [])


def _replay(fx: Fixture, engine: IndicatorEngine, events: list[dict[str, Any]] | None = None, **kw: Any) -> Any:
    kw.setdefault("stored", fx.stored_rows)
    return replay_session(
        _loaded(events if events is not None else copy.deepcopy(fx.events)),
        trial_params=fx.trial_params,
        engine=engine,
        **kw,
    )


@pytest.mark.parametrize("which", ["fx_b", "fx_a"])
def test_simulated_session_is_valid_and_reproducible(which: str, request: pytest.FixtureRequest) -> None:
    fx: Fixture = request.getfixturevalue(which)
    engine: IndicatorEngine = request.getfixturevalue("engine")
    r = _replay(fx, engine)
    assert r.valid, [i.as_dict() for i in r.errors]
    assert r.reproducible is True
    assert r.reproducibility is not None
    assert r.reproducibility.dictionary_sha_match is True
    counts = r.reproducibility.counts
    assert counts.get("match", 0) > 0
    assert "mismatch" not in counts
    assert r.exit_code == 0
    assert len(r.timeline.trials) > 50
    assert all(t.end_ms is not None for t in r.timeline.trials)


def test_partition_events_make_batch_indicators_comparable(fx_a: Fixture, engine: IndicatorEngine) -> None:
    r = _replay(fx_a, engine, partition_events=fx_a.partition_events)
    assert r.reproducibility is not None
    assert r.reproducibility.partition_complete is True
    assert r.reproducibility.counts.get("partition_dependent", 0) == 0
    assert r.reproducible is True


def test_self_consistency_without_stored_values(fx_b: Fixture, engine: IndicatorEngine) -> None:
    r = _replay(fx_b, engine, stored=None)
    assert r.reproducibility is not None
    assert r.reproducibility.mode == "self"
    assert r.reproducible is True


def test_tampered_latency_breaks_reproducibility(fx_b: Fixture, engine: IndicatorEngine) -> None:
    events = copy.deepcopy(fx_b.events)
    for ev in events:
        p = ev["payload"]
        if (
            ev["event_type"] == "response"
            and ev["timing"]["scorable"]
            and isinstance(p.get("latency_ms"), float)
            and ev["task"]["module_id"] == "dont_tap"
        ):
            p["latency_ms"] = round(p["latency_ms"] * 0.5, 3)
    r = _replay(fx_b, engine, events=events)
    assert r.valid  # still contract-valid
    assert r.reproducible is False
    assert r.exit_code == 3
    # The engine's event_stream_sha256 covers ids and seq only, so it cannot see payload edits; the
    # replay's own content hash does.
    clean = _replay(fx_b, engine, rescore=False)
    assert r.raw_events_sha256 and r.raw_events_sha256 != clean.raw_events_sha256
    assert r.reproducibility is not None
    assert r.reproducibility.counts.get("mismatch", 0) > 0


def test_stored_dictionary_sha_mismatch_is_reported(fx_b: Fixture, engine: IndicatorEngine) -> None:
    stored = copy.deepcopy(fx_b.stored_rows)
    for row in stored:
        row["dictionary_sha256"] = "0" * 64
    r = _replay(fx_b, engine, stored=stored)
    assert r.reproducibility is not None
    assert r.reproducibility.dictionary_sha_match is False
    assert "dictionary_sha256_mismatch" in {i.code for i in r.all_issues}
    assert r.reproducible is False


def test_changed_stored_value_is_a_mismatch(fx_b: Fixture, engine: IndicatorEngine) -> None:
    stored = copy.deepcopy(fx_b.stored_rows)
    target = next(r for r in stored if r["status"] == "ok" and r["value"] is not None)
    target["value"] = target["value"] + 1e-6 * max(1.0, abs(target["value"])) + 1e-6
    r = _replay(fx_b, engine, stored=stored)
    assert r.reproducibility is not None
    bad = [c for c in r.reproducibility.comparisons if c.outcome == "mismatch"]
    assert [c.indicator_id for c in bad] == [target["indicator_id"]]


def test_seq_gap_is_an_error(fx_b: Fixture, engine: IndicatorEngine) -> None:
    events = [e for e in copy.deepcopy(fx_b.events) if e["seq"] not in (40, 41, 42)]
    r = _replay(fx_b, engine, events=events, rescore=False)
    gaps = [i for i in r.issues if i.code == "seq_gap"]
    assert len(gaps) == 1
    assert gaps[0].where == "seq 40..42"
    assert not r.valid
    assert r.exit_code == 2


def test_exact_resend_is_deduplicated(fx_b: Fixture, engine: IndicatorEngine) -> None:
    events = copy.deepcopy(fx_b.events)
    events.insert(100, copy.deepcopy(events[50]))
    r = _replay(fx_b, engine, events=events)
    assert r.valid
    assert "duplicate_event" in {i.code for i in r.issues if i.severity == "info"}
    assert r.reproducible is True


def test_conflicting_seq_and_schema_violation(fx_b: Fixture, engine: IndicatorEngine) -> None:
    events = copy.deepcopy(fx_b.events)
    clash = copy.deepcopy(events[60])
    clash["event_id"] = events[61]["event_id"][:-4] + "abcd"
    events.append(clash)
    events[70]["payload"]["unexpected_field"] = 1
    r = _replay(fx_b, engine, events=events, rescore=False)
    codes = {i.code for i in r.issues}
    assert "seq_conflict" in codes
    assert "event_schema" in codes
    # The tolerant reader profile accepts the unknown field.
    r2 = _replay(fx_b, engine, events=events, rescore=False, mode="reader")
    assert "event_schema" not in {i.code for i in r2.issues if i.where.startswith("seq 70")}


def test_invariant_violation_is_reported(fx_b: Fixture, engine: IndicatorEngine) -> None:
    events = copy.deepcopy(fx_b.events)
    resp = next(e for e in events if e["event_type"] == "response" and e["payload"]["latency_ms"] is not None)
    resp["payload"]["barge_in"] = True  # positive latency with barge_in breaks the sign invariant
    r = _replay(fx_b, engine, events=events, rescore=False)
    assert "invariant.barge_in_sign" in {i.code for i in r.issues}


def test_upload_batches_are_verified(fx_b: Fixture, engine: IndicatorEngine) -> None:
    batches = upload_batches(fx_b.events)
    assert len(batches) >= 2
    events = [e for b in batches for c in b["session_chunks"] for e in c["events"]]
    r = replay_session(_loaded(events, batches), trial_params=fx_b.trial_params, engine=engine, stored=fx_b.stored_rows)
    assert r.valid, [i.as_dict() for i in r.errors]
    assert r.reproducible is True

    bad = copy.deepcopy(batches)
    bad[0]["sha256"] = "f" * 64
    bad[1]["session_chunks"][0]["last_seq"] += 1
    events = [e for b in bad for c in b["session_chunks"] for e in c["events"]]
    r = replay_session(_loaded(events, bad), engine=engine, rescore=False)
    codes = {i.code for i in r.issues}
    assert {"batch_sha256_mismatch", "chunk_seq_range"} <= codes


def test_multi_session_input_requires_a_session(fx_b: Fixture, engine: IndicatorEngine) -> None:
    with pytest.raises(ReplayInputError, match="--session"):
        replay_session(_loaded(fx_b.partition_events), engine=engine, rescore=False)
    r = replay_session(_loaded(fx_b.partition_events), session_id=fx_b.session_id, engine=engine, rescore=False)
    assert r.valid


def test_timeline_reconstruction(fx_b: Fixture, engine: IndicatorEngine) -> None:
    r = _replay(fx_b, engine, rescore=False)
    tl = r.timeline
    assert tl.pathway == "B"
    assert tl.end_reason is not None
    module_ids = [m.module_id for m in tl.modules]
    assert "dont_tap" in module_ids
    shifts = [m for m in tl.markers if m.kind == "shift"]
    assert shifts, "context shifts must appear on the timeline"
    responses = [x for t in tl.trials for x in t.responses]
    assert sum(tl.input_modes.values()) == len(responses)
    timed = [x for x in responses if x.recomputed_latency_ms is not None and x.latency_ms is not None]
    assert timed
    # The simulator logs each response at (or after) anchor + latency.
    assert all(x.recomputed_latency_ms >= x.latency_ms - 1.0 for x in timed)
    seqs = sorted(s for t in tl.trials for s in (t.seq_min, t.seq_max))
    assert seqs == sorted(seqs)


def test_html_is_self_contained(fx_b: Fixture, engine: IndicatorEngine) -> None:
    html = render_html(_replay(fx_b, engine))
    assert html.startswith("<!doctype html>")
    assert "<script" not in html
    assert not re.search(r'(src|href)="(https?:)?//', html)
    assert "@import" not in html
    assert fx_b.session_id in html
    assert "dont_tap" in html
    # Indicator rows link to trial rows.
    anchors = set(re.findall(r'id="(t-[^"]+)"', html))
    links = set(re.findall(r'href="#(t-[^"]+)"', html))
    assert links
    assert links <= anchors


def test_html_escapes_untrusted_ids(fx_b: Fixture, engine: IndicatorEngine) -> None:
    # Replay renders streams that fail validation, so ids from the input are untrusted text.
    events = copy.deepcopy(fx_b.events)
    hostile = 'x"><img src=x onerror=alert(1)>'
    for ev in events:
        if (ev.get("task") or {}).get("trial_id"):
            ev["task"]["trial_id"] = hostile
            break
    html = render_html(_replay(fx_b, engine, events=events, rescore=False))
    assert "<img" not in html
    assert "Content-Security-Policy" in html


def test_partition_copy_cannot_mask_a_tampered_session(fx_a: Fixture, engine: IndicatorEngine) -> None:
    # The replayed session is scored from the validated input, not from its copy inside the partition.
    events = copy.deepcopy(fx_a.events)
    for ev in events:
        p = ev["payload"]
        if ev["event_type"] == "response" and ev["timing"]["scorable"] and isinstance(p.get("latency_ms"), float):
            p["latency_ms"] = round(p["latency_ms"] * 0.5, 3)
    r = _replay(fx_a, engine, events=events, partition_events=fx_a.partition_events)
    assert r.reproducible is False


@pytest.mark.parametrize("mode", ["strict", "reader"])
def test_narrowed_validator_agrees_with_full_envelope_schema(fx_b: Fixture, mode: Mode) -> None:
    samples = copy.deepcopy(fx_b.events[:120])
    mutated = copy.deepcopy(samples)
    for i, ev in enumerate(mutated):
        if i % 3 == 0:
            ev["payload"]["zzz"] = 1
        elif i % 3 == 1:
            ev["timing"]["t_mono_ms"] = -1
        else:
            ev["context"]["kiosk_id"] = "BAD ID"
    for ev in samples + mutated:
        assert (not _event_errors(ev, mode)) == is_valid("event-envelope", ev, mode)


def test_jcs_matches_known_vectors() -> None:
    assert canonical({"b": 1, "a": [True, None, 1.5, 1e21, 0.000001, 1e-7, -0.0]}) == (
        '{"a":[true,null,1.5,1e+21,0.000001,1e-7,0],"b":1}'
    )
    # UTF-16 code-unit order: "a" (0x61) < euro (0x20AC) < emoji (high surrogate 0xD83D).
    assert canonical({"\U0001f600": 2, "€": 1, "a": 3}) == '{"a":3,"€":1,"\U0001f600":2}'
    assert canonical_sha256([]) == "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"


def test_cli_fixture_check_and_score(tmp_path: Path) -> None:
    out = tmp_path / "fx"
    assert main(["fixture", "--pathway", "B", "--seed", "3", "--sessions", "2", "--out", str(out)]) == 0
    html = tmp_path / "replay.html"
    report = tmp_path / "report.json"
    args = [
        "check",
        str(out / "upload_batches.json"),
        "--trial-params",
        str(out / "trial_params.json"),
        "--stored",
        str(out / "stored_indicators.json"),
        "--html",
        str(html),
        "--json",
        str(report),
    ]
    assert main(args) == 0
    doc = json.loads(report.read_text(encoding="utf-8"))
    assert doc["verdict"]["valid"] is True
    assert doc["verdict"]["reproducible"] is True
    assert doc["verdict"]["dictionary_sha_match"] is True
    assert html.read_text(encoding="utf-8").count("<svg") >= 2

    scored = tmp_path / "scored.json"
    assert (
        main(
            [
                "score",
                str(out / "events.ndjson"),
                "--trial-params",
                str(out / "trial_params.json"),
                "--out",
                str(scored),
            ]
        )
        == 0
    )
    assert json.loads(scored.read_text(encoding="utf-8"))["rows"]

    assert main(["check", str(out / "partition_events.ndjson"), "--no-rescore"]) == 1  # two sessions, no --session


def test_write_fixture_files(fx_b: Fixture, tmp_path: Path) -> None:
    paths = write_fixture(fx_b, tmp_path / "w")
    assert all(p.exists() for p in paths.values())
    manifest = json.loads(paths["manifest"].read_text(encoding="utf-8"))
    assert manifest["session_id"] == fx_b.session_id
