"""End-to-end bake-off on synthetic placeholder data, plus a real sherpa-onnx KWS check when models exist."""

from __future__ import annotations

import dataclasses
import json
from datetime import date
from pathlib import Path

import pytest
from conftest import SMALL_VOCAB

from shriii_asr_bakeoff.asr_config import build_asr_config, write_asr_configs
from shriii_asr_bakeoff.audio import load_16k
from shriii_asr_bakeoff.cli import main
from shriii_asr_bakeoff.config import TOOL_ROOT, Conditions, EngineSpec, load_engines, load_policy
from shriii_asr_bakeoff.dataset import DatasetError, load_dataset
from shriii_asr_bakeoff.engines import create_engine
from shriii_asr_bakeoff.report import render
from shriii_asr_bakeoff.runner import EngineLanguageArtifacts, run_bakeoff
from shriii_asr_bakeoff.schema import SchemaError, validate

KWS_DIR = (
    TOOL_ROOT.parent.parent
    / "packages"
    / "asr-sherpa"
    / "models"
    / "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
)


def _conditions(tmp_path: Path) -> Conditions:
    return Conditions(
        seed=11,
        snr_db=("clean", 10.0, 0.0),
        noise_dir=tmp_path / "no-noise-here",
        synthetic_fallback=True,
        noise_only_per_prompt=6,
        oov_per_prompt=0,
        window_s=1.0,
    )


@pytest.fixture(scope="module")
def run(small_dataset: Path, tmp_path_factory: pytest.TempPathFactory):  # type: ignore[no-untyped-def]
    tmp = tmp_path_factory.mktemp("run")
    policy = dataclasses.replace(
        load_policy(), min_heldout_speakers=10, min_trials_per_code=4, min_speakers_per_subgroup=2
    )
    specs = [
        EngineSpec("dtw_mfcc", "dtw_mfcc", "baseline", None, {"templates_per_code": 4}),
        # configured but without models: must be reported as unavailable, not crash the run
        EngineSpec("whisper_missing", "sherpa_whisper", "absent", None, {"model_dir": str(tmp / "nope")}),
        EngineSpec(
            "ctc_missing", "ctc_constrained", "absent", ("hi-IN",), {"model": str(tmp / "m.onnx"), "vocab": "x"}
        ),
    ]
    out = run_bakeoff(load_dataset(small_dataset), SMALL_VOCAB, specs, policy, _conditions(tmp), tmp)
    return out, policy, tmp


def test_results_are_schema_valid_and_complete(run) -> None:  # type: ignore[no-untyped-def]
    out, _, tmp = run
    results = out.results
    validate(results, "results.schema.json")
    assert results["dataset"]["kind"] == "synthetic_placeholder"
    assert results["conditions"]["noise_source"] == "synthetic"
    engines = {e["engine_id"]: e for e in results["engines"]}
    assert engines["dtw_mfcc"]["available"] is True
    assert engines["whisper_missing"]["available"] is False
    assert "not found" in engines["whisper_missing"]["unavailable_reason"]
    assert "ONNX model not found" in engines["ctc_missing"]["unavailable_reason"]
    lr = engines["dtw_mfcc"]["languages"][0]
    assert lr["language"] == "hi-IN"
    assert lr["heldout_speakers"] == 16
    assert {a["snr_db"] for a in lr["accuracy"]} == {"clean", 10.0, 0.0}
    assert {(f["snr_db"], f["source"]) for f in lr["false_accepts"]} >= {(10.0, "noise_only"), (0.0, "oov")}
    assert {s["field"] for s in lr["subgroups"]} == {"age_band", "gender"}
    assert lr["latency_ms"]["p95"] > 0
    assert lr["cpu"]["peak_rss_mb"] > 0
    assert {p["prompt_id"] for p in lr["prompts"]} == set(SMALL_VOCAB.prompts)
    assert (tmp / f"results-{results['run_id']}.json").is_file()
    lines = out.trials_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) > 100
    first = json.loads(lines[0])
    assert {"engine_id", "snr_db", "label", "score", "latency_ms"} <= set(first)


def test_accuracy_degrades_with_noise(run) -> None:  # type: ignore[no-untyped-def]
    out, _, _ = run
    lr = out.results["engines"][0]["languages"][0]
    acc = {a["snr_db"]: a["accuracy"]["p"] for a in lr["accuracy"]}
    assert acc["clean"] is not None
    assert acc["clean"] >= acc[0.0]
    assert acc["clean"] > 0.5, f"baseline should separate synthetic words in clean audio: {acc}"


def test_policy_verdicts_carry_reasons(run) -> None:  # type: ignore[no-untyped-def]
    out, _policy, _ = run
    lr = out.results["engines"][0]["languages"][0]
    for p in lr["prompts"]:
        assert p["voice_enabled"] == (not p["reasons"])
    winner = out.results["winners"]["hi-IN"]
    enabled = [p["prompt_id"] for p in lr["prompts"] if p["voice_enabled"]]
    if enabled:
        assert winner["engine_id"] == "dtw_mfcc"
        assert winner["voice_enabled_prompts"] == enabled
    else:
        assert winner["engine_id"] is None
        assert "touch only" in winner["reason"]
    # the real policy (30 held-out speakers) can never pass on 16 speakers
    strict = load_policy()
    assert strict.min_heldout_speakers > lr["heldout_speakers"]


def test_report_renders(run) -> None:  # type: ignore[no-untyped-def]
    out, _, _ = run
    html = render(out.results)
    assert "<title>ASR Bake-off Report</title>" in html
    assert "Synthetic placeholder data" in html
    assert "Synthetic market noise" in html
    assert "dtw_mfcc" in html and "whisper_missing" in html
    assert "prefers-color-scheme: dark" in html


def test_touch_only_config_when_no_kws_engine_wins(run, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    out, policy, _ = run
    paths = write_asr_configs(tmp_path, out.results, out.artifacts, SMALL_VOCAB, policy)
    cfg = json.loads(paths[0].read_text(encoding="utf-8"))
    validate(cfg, "asr-config.schema.json")
    assert cfg["engine"] == "none"
    assert all(not p["voice_enabled"] for p in cfg["prompts"].values())
    assert cfg["provenance"]["dataset_kind"] == "synthetic_placeholder"


def test_kws_config_tiers_from_calibration(run) -> None:  # type: ignore[no-untyped-def]
    out, policy, _ = run
    results = json.loads(json.dumps(out.results))
    # Pretend a KWS engine won with calibrated tiers, to check the emitted grammar shape.
    results["winners"]["hi-IN"] = {"engine_id": "kws", "voice_enabled_prompts": ["generic.yes_no"], "reason": "test"}
    lr = json.loads(json.dumps(results["engines"][0]["languages"][0]))
    for p in lr["prompts"]:
        p["voice_enabled"] = p["prompt_id"] == "generic.yes_no"
    results["engines"].append({"engine_id": "kws", "kind": "sherpa_kws", "available": True, "languages": [lr]})
    cal = [
        {"threshold": 0.1, "precision": 0.8, "recall": 0.9, "n": 50},
        {"threshold": 0.2, "precision": 0.9, "recall": 0.8, "n": 40},
        {"threshold": 0.35, "precision": 0.98, "recall": 0.6, "n": 30},
    ]
    tokens = {"yes": ["▁HAA N"], "no": ["▁NA HII N"], "wait": ["▁RU KO"], "share": ["▁BAA N TO"]}
    art = EngineLanguageArtifacts("kws", "sherpa_kws", "hi-IN", "kws-model", 0.2, 0.35, cal, tokens)
    cfg = build_asr_config("hi-IN", results, [art], SMALL_VOCAB, policy, "0.2.0")
    assert cfg["engine"] == "sherpa-onnx-kws"
    assert cfg["tiers"] == [
        {"keywords_threshold": 0.2, "confidence": 0.9},
        {"keywords_threshold": 0.35, "confidence": 0.98},
    ]
    assert cfg["prompts"]["generic.yes_no"]["voice_enabled"] is True
    assert cfg["prompts"]["generic.wait"]["voice_enabled"] is False
    assert cfg["keywords"]["yes"]["phrases"][0] == {"tokens": "▁HAA N", "text": "हाँ"}
    assert cfg["policy"]["min_propose_confidence"] == policy.propose_min_precision
    # write a fixture the TypeScript adapter's tests parse (contract between the two packages)
    fixture = TOOL_ROOT / "fixtures" / "asr-config.sample.json"
    if fixture.is_file():
        committed = json.loads(fixture.read_text(encoding="utf-8"))
        assert set(committed) == set(cfg)


def test_dataset_validation_rules(small_dataset: Path, tmp_path: Path) -> None:
    raw = json.loads(small_dataset.read_text(encoding="utf-8"))
    bad = dict(raw, kind="asr_eval")
    with pytest.raises(SchemaError):
        validate(bad, "dataset.schema.json")  # asr_eval needs consent protocol, deletion date, consent ids
    ok = dict(
        raw,
        kind="asr_eval",
        consent={"kind": "asr_eval", "protocol_id": "P-1", "retention_days": 30, "deletion_due": "2026-11-20"},
        speakers=[dict(s, consent_id=f"c-{s['speaker_id']}") for s in raw["speakers"]],
    )
    validate(ok, "dataset.schema.json")
    path = small_dataset.parent / "asr_eval.json"
    path.write_text(json.dumps(ok), encoding="utf-8")
    load_dataset(path, today=date(2026, 11, 1))
    with pytest.raises(DatasetError, match="deletion date"):
        load_dataset(path, today=date(2026, 12, 1))
    wrong = dict(raw, utterances=[dict(raw["utterances"][0], kind="keyword", code=None)])
    with pytest.raises(SchemaError):
        validate(wrong, "dataset.schema.json")


def test_cli_synth_validate(tmp_path: Path) -> None:
    out = tmp_path / "syn"
    assert (
        main(["synth", "--out", str(out), "--language", "en-IN", "--speakers", "4", "--enroll", "2", "--reps", "1"])
        == 0
    )
    assert main(["validate", str(out / "dataset.json")]) == 0


@pytest.mark.real_model
@pytest.mark.skipif(not (KWS_DIR / "tokens.txt").is_file(), reason="sherpa KWS model not fetched")
def test_real_sherpa_kws_engine_spots_keyword() -> None:
    spec = next(s for s in load_engines() if s.kind == "sherpa_kws")
    spec = dataclasses.replace(spec, params=dict(spec.params, model_dir=str(KWS_DIR), tiers=[0.15, 0.3]))
    engine = create_engine(spec)
    assert engine.unavailable_reason("en-IN") is None
    assert engine.unavailable_reason("hi-IN") is not None
    engine.prepare("en-IN", {"light_up": ("light up",), "forever": ("forever",)}, [])
    tokens = engine.keyword_tokens()  # type: ignore[attr-defined]
    assert tokens["light_up"] == ["▁ L IGHT ▁UP"]
    audio = load_16k(KWS_DIR / "test_wavs" / "0.wav")
    rec = engine.recognize(audio, ["light_up", "forever"])
    assert rec.label == "light_up"
    assert rec.score is not None and rec.score >= 0.15
    assert engine.recognize(audio, ["forever"]).label is None
    engine.close()
