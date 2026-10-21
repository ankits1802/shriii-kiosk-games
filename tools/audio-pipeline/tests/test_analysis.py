from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from synth import RATE, noise, recording, speechlike, write_pcm16

from shriii_audio import analysis
from shriii_audio.config import ConfigError, QcConfig, load_qc_config
from shriii_audio.ffmpeg import write_wav_f32
from shriii_audio.process import parse_filename
from shriii_audio.wavinfo import WavError, read_wav_info


def test_config_loads_and_matches_vox02(qc: QcConfig) -> None:
    assert qc.loudness.target_lufs == -16.0
    assert qc.loudness.true_peak_ceiling_dbtp == -1.0
    assert qc.loudness.tolerance_lu == 0.5
    assert qc.encode.sample_rate_hz == 48000
    assert qc.encode.channels == 1


def test_config_rejects_unknown_keys(tmp_path: Path) -> None:
    src = Path(load_qc_config().source_path).read_text(encoding="utf-8")
    bad = tmp_path / "qc.yaml"
    bad.write_text(src.replace("tolerance_lu: 0.5", "tolerance_lu: 0.5\n  surprise: 1"), encoding="utf-8")
    with pytest.raises(ConfigError, match="unknown keys"):
        load_qc_config(bad)


@pytest.mark.parametrize("snr", [20.0, 30.0, 45.0])
def test_snr_estimate_tracks_true_snr(qc: QcConfig, snr: float) -> None:
    speech_db = -20.0
    x = recording(2.0, level_dbfs=speech_db, floor_dbfs=speech_db - snr, lead_s=1.0, tail_s=1.0)
    lv = analysis.levels(x[:, None], RATE, qc.noise, qc.trim.frame_ms)
    assert abs(lv.noise_floor_dbfs - (speech_db - snr)) < 2.0
    assert abs(lv.snr_db - snr) < 4.0


def test_clipping_detected_only_on_runs(qc: QcConfig) -> None:
    clean = speechlike(1.0, -14.0)
    assert float(np.max(np.abs(clean))) < 0.99
    assert analysis.detect_clipping(clean[:, None], qc.clipping).events == 0
    clipped = np.clip(speechlike(1.0, -6.0) * 4, -1, 1)
    rep = analysis.detect_clipping(clipped[:, None], qc.clipping)
    assert rep.events > 10
    assert rep.longest_run >= qc.clipping.min_run_samples
    single = np.zeros(1000, dtype=np.float32)
    single[500] = 1.0
    assert analysis.detect_clipping(single[:, None], qc.clipping).events == 0


def test_clipping_checks_every_channel(qc: QcConfig) -> None:
    left = speechlike(0.5, -12.0)
    right = np.clip(left * 10, -1, 1)
    assert analysis.detect_clipping(np.stack([left, right], axis=1), qc.clipping).events > 0


def test_trim_keeps_pads_around_speech(qc: QcConfig) -> None:
    lead, speech, tail = 0.8, 1.5, 0.9
    x = recording(speech, lead_s=lead, tail_s=tail)
    lv = analysis.levels(x[:, None], RATE, qc.noise, qc.trim.frame_ms)
    tr = analysis.trim_bounds(x[:, None], RATE, qc.trim, lv.noise_floor_dbfs)
    assert tr.speech_found
    frame = qc.trim.frame_ms / 1000
    expected_start = lead - qc.trim.lead_pad_ms / 1000
    expected_end = lead + speech + qc.trim.tail_pad_ms / 1000
    assert abs(tr.start_sample / RATE - expected_start) <= 3 * frame
    # the synthetic utterance ends in a syllable gap of up to 1/8 s, so the end may come slightly early
    assert expected_end - 0.15 <= tr.end_sample / RATE <= expected_end + 3 * frame


def test_trim_never_cuts_inside_speech(qc: QcConfig) -> None:
    gap = np.zeros(round(0.4 * RATE), dtype=np.float32)
    x = np.concatenate([np.zeros(RATE // 2), speechlike(0.8), gap, speechlike(0.8, seed=3), np.zeros(RATE // 2)])
    x = (x + noise(x.size / RATE, -75)).astype(np.float32)
    lv = analysis.levels(x[:, None], RATE, qc.noise, qc.trim.frame_ms)
    tr = analysis.trim_bounds(x[:, None], RATE, qc.trim, lv.noise_floor_dbfs)
    assert tr.start_sample < RATE // 2
    assert tr.end_sample > RATE // 2 + round(2.0 * RATE)


def test_trim_reports_no_speech_on_noise(qc: QcConfig) -> None:
    x = noise(2.0, -50.0)
    lv = analysis.levels(x[:, None], RATE, qc.noise, qc.trim.frame_ms)
    assert not analysis.trim_bounds(x[:, None], RATE, qc.trim, lv.noise_floor_dbfs).speech_found


def test_fades_and_envelope() -> None:
    x = np.ones(4800, dtype=np.float32)
    faded = analysis.apply_fades(x, RATE, 5.0)
    assert faded[0] == pytest.approx(0.0, abs=1e-6)
    assert faded[-1] == pytest.approx(0.0, abs=1e-6)
    assert faded[2400] == 1.0
    env = analysis.envelope(speechlike(1.0), buckets=50)
    assert len(env) == 50
    assert all(lo <= hi for lo, hi in env)


def test_wavinfo_pcm16_float_and_stereo(tmp_path: Path) -> None:
    p16 = write_pcm16(tmp_path / "a.wav", speechlike(0.5), channels=2)
    info = read_wav_info(p16)
    assert (info.format_name, info.channels, info.sample_rate_hz, info.bits_per_sample) == ("pcm", 2, RATE, 16)
    assert info.duration_ms == pytest.approx(500, abs=1)
    pf = tmp_path / "b.wav"
    write_wav_f32(pf, speechlike(0.25), 44100)
    info = read_wav_info(pf)
    assert (info.format_name, info.channels, info.sample_rate_hz, info.bits_per_sample) == ("float", 1, 44100, 32)
    bad = tmp_path / "c.wav"
    bad.write_bytes(b"not a wav file at all")
    with pytest.raises(WavError):
        read_wav_info(bad)


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("attract.greeting.hi-IN.wav", ("attract.greeting", "hi-IN", None)),
        ("onboarding.language_face.hi_in.ta-IN.take3.wav", ("onboarding.language_face.hi_in", "ta-IN", 3)),
        ("dont_tap.intro.en-IN.wav", ("dont_tap.intro", "en-IN", None)),
    ],
)
def test_parse_filename(name: str, expected: tuple[str, str, int | None]) -> None:
    parsed = parse_filename(name)
    assert parsed is not None
    assert (parsed.line_id, parsed.language, parsed.take) == expected


@pytest.mark.parametrize(
    "name", ["Attract.greeting.hi-IN.wav", "greeting.hi.wav", "greeting.hi-IN.mp3", "greeting.hi-IN.take0.wav"]
)
def test_parse_filename_rejects(name: str) -> None:
    assert parse_filename(name) is None
