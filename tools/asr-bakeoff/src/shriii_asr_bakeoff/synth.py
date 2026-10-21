"""TTS-free placeholder material: synthetic "words" per vocabulary code and synthetic market noise.

Placeholder words are vowel-like formant sequences (no speech synthesis, no linguistic content): each
code gets a distinct formant trajectory; speakers differ in f0, vocal-tract length (formant scaling),
tempo and jitter by age band and gender, so a real engine-agnostic pipeline (enrolment, held-out
speakers, SNR conditions, subgroup gaps) can be exercised end to end before real asr_eval recordings
exist. Results on this material say nothing about real-speech accuracy; the report flags it.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from shriii_asr_bakeoff.audio import RATE, Audio, write_wav

AGE_BANDS = ("18-29", "30-44", "45-59", "60+")
GENDERS = ("female", "male")

# Vowel formant targets (F1, F2) in Hz for an adult male vocal tract.
VOWELS: dict[str, tuple[float, float]] = {
    "a": (730, 1090),
    "i": (270, 2290),
    "u": (300, 870),
    "e": (530, 1840),
    "o": (570, 840),
    "ae": (660, 1720),
    "er": (490, 1350),
}


@dataclass(frozen=True, slots=True)
class Speaker:
    speaker_id: str
    language: str
    age_band: str
    gender: str
    split: str
    f0: float
    tract: float
    tempo: float
    jitter: float


def word_pattern(code: str, phrase_index: int = 0) -> list[str]:
    """Deterministic vowel sequence for a code (distinct per code and phrase variant)."""
    names = sorted(VOWELS)
    h = 2166136261
    for ch in f"{code}#{phrase_index}":
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    length = 2 + h % 2
    seq = []
    for i in range(length):
        seq.append(names[(h >> (5 * i + 3)) % len(names)])
        if i > 0 and seq[-1] == seq[-2]:
            seq[-1] = names[(names.index(seq[-1]) + 3) % len(names)]
    return seq


def render_word(pattern: list[str], spk: Speaker, rng: np.random.Generator) -> Audio:
    """Glottal pulse train shaped by two time-varying formant resonances (parallel resonators)."""
    seg_s = 0.16 / spk.tempo
    trans_s = 0.05 / spk.tempo
    n_seg = len(pattern)
    total = n_seg * seg_s
    n = round(total * RATE)
    t = np.arange(n) / RATE
    # piecewise formant trajectories with smooth transitions
    f1 = np.empty(n)
    f2 = np.empty(n)
    for i, v in enumerate(pattern):
        a, b = round(i * seg_s * RATE), round((i + 1) * seg_s * RATE)
        f1[a:b], f2[a:b] = VOWELS[v][0] * spk.tract, VOWELS[v][1] * spk.tract
    k = max(1, round(trans_s * RATE))
    kernel = np.ones(k) / k
    f1 = np.convolve(f1, kernel, mode="same")
    f2 = np.convolve(f2, kernel, mode="same")
    # f0 contour: slight declination + jitter
    f0 = (
        spk.f0 * (1.05 - 0.1 * t / max(total, 1e-6)) * (1 + spk.jitter * rng.standard_normal(n).cumsum() / math.sqrt(n))
    )
    phase = 2 * math.pi * np.cumsum(f0) / RATE
    source = np.zeros(n)
    harmonics = int(3800 / spk.f0)
    for h in range(1, harmonics + 1):
        source += np.sin(h * phase) / h
    out = np.zeros(n)
    for fc, bw, gain in ((f1, 90.0, 1.0), (f2, 120.0, 0.6)):
        # time-varying 2-pole resonator
        r = math.exp(-math.pi * bw / RATE)
        y1 = y2 = 0.0
        theta = 2 * math.pi * fc / RATE
        c1 = 2 * r * np.cos(theta)
        c2 = -r * r
        y = np.empty(n)
        for i in range(n):
            v = source[i] + c1[i] * y1 + c2 * y2
            y[i] = v
            y2, y1 = y1, v
        out += gain * y / (np.max(np.abs(y)) + 1e-9)
    env = np.minimum(1, np.minimum(t, total - t) / 0.03)
    out *= np.clip(env, 0, 1)
    return np.asarray(out / (np.max(np.abs(out)) + 1e-9) * 0.5, dtype=np.float32)


def make_speakers(language: str, n_speakers: int, n_enroll: int, rng: np.random.Generator) -> list[Speaker]:
    speakers = []
    for i in range(n_speakers):
        gender = GENDERS[i % 2]
        age = AGE_BANDS[(i // 2) % len(AGE_BANDS)]
        base_f0 = 210.0 if gender == "female" else 115.0
        age_shift = {"18-29": 1.04, "30-44": 1.0, "45-59": 0.96, "60+": 0.93}[age]
        tract = (1.17 if gender == "female" else 1.0) * float(rng.uniform(0.94, 1.06))
        speakers.append(
            Speaker(
                speaker_id=f"{language.lower().replace('-', '')}s{i:03d}",
                language=language,
                age_band=age,
                gender=gender,
                split="enroll" if i < n_enroll else "heldout",
                f0=base_f0 * age_shift * float(rng.uniform(0.9, 1.1)),
                tract=tract,
                tempo=float(rng.uniform(0.85, 1.15)) * (0.92 if age == "60+" else 1.0),
                jitter=0.02 if age != "60+" else 0.035,
            )
        )
    return speakers


def market_noise(seconds: float, rng: np.random.Generator) -> Audio:
    """Synthetic market ambience: babble of formant voices, pink noise, mains hum and clatter transients."""
    n = round(seconds * RATE)
    white = rng.standard_normal(n)
    # pink-ish noise via 1/f spectral shaping
    spec = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n, 1 / RATE)
    spec[1:] /= np.sqrt(freqs[1:])
    spec[0] = 0
    pink = np.fft.irfft(spec, n=n)
    pink /= np.std(pink) + 1e-12
    babble = np.zeros(n)
    t = np.arange(n) / RATE
    for _ in range(12):
        f0 = rng.uniform(100, 240)
        am = 0.5 + 0.5 * np.sin(2 * math.pi * rng.uniform(2.5, 5.5) * t + rng.uniform(0, 6.28))
        voice = sum(np.sin(2 * math.pi * k * f0 * t + rng.uniform(0, 6.28)) / k for k in range(1, 12))
        babble += voice * am
    babble /= np.std(babble) + 1e-12
    hum = 0.2 * np.sin(2 * math.pi * 50 * t) + 0.1 * np.sin(2 * math.pi * 150 * t)
    clatter = np.zeros(n)
    for _ in range(int(seconds * 1.5)):
        at = int(rng.integers(0, max(1, n - 800)))
        decay = np.exp(-np.arange(800) / 120.0)
        clatter[at : at + 800] += rng.standard_normal(800) * decay * rng.uniform(1, 4)
    x = 0.6 * babble + 0.5 * pink + hum + 0.4 * clatter
    return np.asarray(x / (np.max(np.abs(x)) + 1e-9) * 0.5, dtype=np.float32)


def build_placeholder_dataset(
    out_dir: Path,
    languages: dict[str, list[str]],
    *,
    n_speakers: int = 40,
    n_enroll: int = 8,
    reps: int = 2,
    oov_words: int = 4,
    seed: int = 7,
    phrases_per_code: dict[str, dict[str, int]] | None = None,
) -> Path:
    """Write WAVs + ``dataset.json``. ``languages`` maps language -> codes."""
    rng = np.random.default_rng(seed)
    speakers_out: list[dict[str, Any]] = []
    utterances: list[dict[str, Any]] = []
    for language, codes in sorted(languages.items()):
        speakers = make_speakers(language, n_speakers, n_enroll, rng)
        for spk in speakers:
            speakers_out.append(
                {
                    "speaker_id": spk.speaker_id,
                    "language": language,
                    "age_band": spk.age_band,
                    "gender": spk.gender,
                    "split": spk.split,
                }
            )
            items: list[tuple[str, str | None, int]] = []
            for kw_code in codes:
                n_phr = (phrases_per_code or {}).get(language, {}).get(kw_code, 1)
                for r in range(reps):
                    items.append(("keyword", kw_code, r % n_phr))
            items.extend(("oov", None, 100 + w) for w in range(oov_words))
            for idx, (kind, code, phrase_index) in enumerate(items):
                pattern = word_pattern(code if code else f"oov{phrase_index}", phrase_index if code else 0)
                pad = np.zeros(round(0.25 * RATE), dtype=np.float32)
                audio = np.concatenate([pad, render_word(pattern, spk, rng), pad])
                rel = f"{language}/{spk.speaker_id}/{idx:03d}.wav"
                write_wav(out_dir / rel, audio)
                utt: dict[str, Any] = {
                    "utterance_id": f"{spk.speaker_id}.{idx:03d}",
                    "speaker_id": spk.speaker_id,
                    "language": language,
                    "kind": kind,
                    "code": code,
                    "file": rel,
                    "duration_ms": round(1000 * audio.size / RATE, 1),
                }
                if code:
                    utt["phrase_index"] = phrase_index
                utterances.append(utt)
    manifest = {
        "schema_version": "1.0",
        "dataset_id": f"synthetic.placeholder.{seed}",
        "kind": "synthetic_placeholder",
        "created_at": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "sample_rate_hz": RATE,
        "consent": {"kind": "synthetic"},
        "speakers": speakers_out,
        "utterances": utterances,
    }
    path = out_dir / "dataset.json"
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path
