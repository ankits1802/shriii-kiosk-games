"""Unit tests: mixing, Wilson intervals, calibration, CTC scoring, tokenisation, matching, configs."""

from __future__ import annotations

import itertools
import math
from pathlib import Path

import numpy as np
import pytest

from shriii_asr_bakeoff.audio import RATE, active_level, mix_at_snr, noise_window, read_wav, resample, rms, write_wav
from shriii_asr_bakeoff.config import load_conditions, load_engines, load_policy, load_vocab
from shriii_asr_bakeoff.engines.ctc_constrained import constrained_decode, log_softmax
from shriii_asr_bakeoff.engines.sherpa_whisper import match, normalise, similarity
from shriii_asr_bakeoff.features import ctc_best_path, ctc_log_likelihood, dtw_distance, mfcc
from shriii_asr_bakeoff.metrics import Scored, calibration, monotone_precision, operating_threshold, wilson
from shriii_asr_bakeoff.synth import market_noise, word_pattern
from shriii_asr_bakeoff.tokenize import GreedyTokenizer


def test_configs_load() -> None:
    pol = load_policy()
    assert pol.min_accuracy == 0.90
    assert pol.reference_snr_db == 10
    assert pol.max_gap_pp == 5.0
    assert pol.min_heldout_speakers == 30
    assert pol.max_false_accept_rate == 0.03
    cond = load_conditions()
    assert cond.snr_db == ("clean", 10.0, 5.0, 0.0)
    kinds = {e.kind for e in load_engines()}
    assert kinds == {"dtw_mfcc", "sherpa_kws", "sherpa_whisper", "ctc_constrained"}
    vocab = load_vocab()
    assert set(vocab.languages) == {"en-IN", "hi-IN", "mr-IN", "ta-IN"}
    assert vocab.prompts["generic.yes_no"] == ("yes", "no")


@pytest.mark.parametrize("snr", [0.0, 5.0, 10.0])
def test_mix_hits_requested_snr(snr: float) -> None:
    rng = np.random.default_rng(1)
    t = np.arange(RATE) / RATE
    speech = (0.1 * np.sin(2 * math.pi * 220 * t) * (t > 0.2) * (t < 0.8)).astype(np.float32)
    noise = market_noise(5.0, rng)
    mix = mix_at_snr(speech, noise, snr, np.random.default_rng(2))
    added = mix.audio - speech
    achieved = 20 * math.log10(active_level(speech) / rms(added))
    assert abs(achieved - snr) < 0.05
    again = mix_at_snr(speech, noise, snr, np.random.default_rng(2))
    assert np.array_equal(again.audio, mix.audio), "same seed must give identical mixtures"


def test_noise_window_level() -> None:
    x = noise_window(market_noise(3.0, np.random.default_rng(0)), 2.0, -30.0, np.random.default_rng(1))
    assert x.size == 2 * RATE
    assert abs(20 * math.log10(rms(x)) + 30.0) < 0.01


def test_wav_roundtrip_and_resample(tmp_path: Path) -> None:
    t = np.arange(RATE) / RATE
    x = (0.3 * np.sin(2 * math.pi * 440 * t)).astype(np.float32)
    write_wav(tmp_path / "a.wav", x)
    y, rate = read_wav(tmp_path / "a.wav")
    assert rate == RATE
    assert np.max(np.abs(y - x)) < 1e-4
    up = resample(x, RATE, 48000)
    assert up.size == 48000
    assert abs(rms(up) - rms(x)) < 1e-3


def test_wilson_reference_values() -> None:
    # Wilson 95% CI for 81/100: [0.7222, 0.8749] (standard reference values)
    p, lo, hi = wilson(81, 100)
    assert p == 0.81
    assert lo == pytest.approx(0.7222, abs=1e-4)
    assert hi == pytest.approx(0.8749, abs=1e-4)
    assert wilson(0, 0) == (None, None, None)
    _, lo0, _ = wilson(0, 30)
    assert lo0 == 0.0


def test_calibration_and_operating_points() -> None:
    trials = [
        Scored("yes", 0.9, "yes"),
        Scored("yes", 0.9, "yes"),
        Scored("no", 0.5, "yes"),
        Scored("yes", 0.3, "yes"),
        Scored("no", 0.3, None),
        Scored(None, None, "no"),
    ]
    rows = calibration(trials)
    assert [r["threshold"] for r in rows] == [0.3, 0.5, 0.9]
    assert rows[0]["precision"] == pytest.approx(3 / 5)
    assert rows[-1]["precision"] == 1.0
    assert rows[-1]["recall"] == pytest.approx(2 / 5)
    assert operating_threshold(rows, 0.95) == 0.9
    assert operating_threshold(rows, 0.5) == 0.3
    assert operating_threshold(rows, 1.01) is None
    mono = monotone_precision(
        [
            {"threshold": 0.1, "precision": 0.9, "recall": 1, "n": 5},
            {"threshold": 0.2, "precision": 0.8, "recall": 1, "n": 4},
        ]
    )
    assert [r["precision"] for r in mono] == [0.8, 0.8]


def _brute_ctc(logprobs: np.ndarray, labels: list[int], blank: int) -> float:
    t, v = logprobs.shape
    total = -math.inf
    for path in itertools.product(range(v), repeat=t):
        collapsed = []
        prev = None
        for k in path:
            if k not in (prev, blank):
                collapsed.append(k)
            prev = k
        if collapsed == labels:
            s = sum(logprobs[i, k] for i, k in enumerate(path))
            total = np.logaddexp(total, s)
    return float(total)


@pytest.mark.parametrize("labels", [[1], [1, 2], [1, 1], [2, 1, 2]])
def test_ctc_forward_matches_brute_force(labels: list[int]) -> None:
    rng = np.random.default_rng(len(labels))
    lp = log_softmax(rng.standard_normal((5, 3)))
    assert ctc_log_likelihood(lp, labels, blank=0) == pytest.approx(_brute_ctc(lp, labels, 0), abs=1e-9)


def test_ctc_best_path_collapses() -> None:
    lp = np.log(np.array([[0.1, 0.8, 0.1], [0.1, 0.8, 0.1], [0.8, 0.1, 0.1], [0.1, 0.1, 0.8]]))
    labels, score = ctc_best_path(lp, blank=0)
    assert labels == [1, 2]
    assert score == pytest.approx(4 * math.log(0.8))


def test_constrained_decode_picks_phrase_and_rejects_garbage() -> None:
    v, blank = 6, 5
    frames = []
    for tok in [5, 0, 0, 5, 1, 1, 5, 5]:  # "0 1" spoken
        row = np.full(v, -6.0)
        row[tok] = 0.0
        frames.append(row)
    lp = log_softmax(np.array(frames))
    cands = {"yes": [[0, 1]], "no": [[2, 3]], "wait": [[4]]}
    label, conf, scores = constrained_decode(lp, cands, blank)
    assert label == "yes"
    assert conf > 0.4
    assert scores["yes"] > scores["no"]
    # audio that is clearly "2 4" (not a phrase) loses to the garbage path
    frames = []
    for tok in [2, 2, 5, 4, 4, 5, 2, 4]:
        row = np.full(v, -8.0)
        row[tok] = 0.0
        frames.append(row)
    label, _, _ = constrained_decode(log_softmax(np.array(frames)), {"yes": [[0, 1]], "wait": [[3]]}, blank)
    assert label is None


def test_greedy_tokenizer() -> None:
    vocab = {"▁ha": 0, "an": 1, "▁na": 2, "h": 3, "i": 4, "▁": 5, "a": 6, "n": 7}
    tok = GreedyTokenizer(vocab)
    assert tok.encode("haan") == ["▁ha", "an"]
    assert tok.encode("na hi") == ["▁na", "▁", "h", "i"]
    with pytest.raises(ValueError, match="cannot tokenize"):
        tok.encode("xyz")


def test_whisper_matching_keeps_indic_marks() -> None:
    assert normalise("नहीं!") == "नहीं"
    assert similarity("जी हाँ, ठीक है", "हाँ") == 1.0
    phrases = {"yes": ("हाँ", "हाँ जी"), "no": ("नहीं",)}
    assert match("नहीं।", phrases, ["yes", "no"], 0.55).label == "no"
    assert match("बिल्कुल अलग बात", phrases, ["yes", "no"], 0.55).label is None


def test_mfcc_dtw_separates_words() -> None:
    from shriii_asr_bakeoff.synth import make_speakers, render_word  # noqa: PLC0415

    rng = np.random.default_rng(5)
    spk_a, spk_b = make_speakers("hi-IN", 2, 1, rng)
    w1a = mfcc(render_word(word_pattern("yes"), spk_a, rng))
    w1b = mfcc(render_word(word_pattern("yes"), spk_b, rng))
    w2b = mfcc(render_word(word_pattern("no"), spk_b, rng))
    assert word_pattern("yes") != word_pattern("no")
    assert dtw_distance(w1a, w1b) < dtw_distance(w1a, w2b)
    assert dtw_distance(w1a, w1a) == pytest.approx(0.0, abs=1e-9)


def test_contract_fixture_is_valid() -> None:
    """fixtures/asr-config.sample.json is also parsed by packages/asr-sherpa's tests (shared contract)."""
    import json  # noqa: PLC0415

    from shriii_asr_bakeoff.config import TOOL_ROOT  # noqa: PLC0415
    from shriii_asr_bakeoff.schema import validate  # noqa: PLC0415

    fixture = json.loads((TOOL_ROOT / "fixtures" / "asr-config.sample.json").read_text(encoding="utf-8"))
    validate(fixture, "asr-config.schema.json")
