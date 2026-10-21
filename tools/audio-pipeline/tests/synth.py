"""Synthetic test material: speech-like harmonic tone bursts, room tone, clipping and noise (no TTS)."""

from __future__ import annotations

import math
import wave
from pathlib import Path
from typing import Any

import numpy as np

RATE = 48000


def speechlike(duration_s: float, level_dbfs: float = -20.0, f0: float = 140.0, seed: int = 1) -> np.ndarray:
    """Harmonic complex (f0 + 7 harmonics with slight vibrato) gated by ~4 Hz syllable envelopes."""
    rng = np.random.default_rng(seed)
    t = np.arange(round(duration_s * RATE)) / RATE
    vib = 1 + 0.02 * np.sin(2 * math.pi * 5.5 * t)
    phase = 2 * math.pi * np.cumsum(f0 * vib) / RATE
    sig = sum((1 / k) * np.sin(k * phase + rng.uniform(0, 2 * math.pi)) for k in range(1, 9))
    syll = np.clip(np.sin(2 * math.pi * 4.0 * t) * 1.4, 0, 1) ** 0.7  # syllables with short gaps
    edge = np.minimum(1, np.minimum(t, t[-1] - t) / 0.02)
    x = sig * syll * edge
    rms = math.sqrt(float(np.mean(x[syll > 0.5] ** 2)))
    return (x / rms * 10 ** (level_dbfs / 20)).astype(np.float32)


def noise(duration_s: float, level_dbfs: float, seed: int = 2) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (rng.standard_normal(round(duration_s * RATE)) * 10 ** (level_dbfs / 20)).astype(np.float32)


def recording(
    speech_s: float = 2.0,
    *,
    level_dbfs: float = -22.0,
    floor_dbfs: float = -72.0,
    lead_s: float = 0.8,
    tail_s: float = 0.8,
    clip_gain: float | None = None,
    seed: int = 1,
) -> np.ndarray:
    body = speechlike(speech_s, level_dbfs, seed=seed)
    if clip_gain is not None:
        body = np.clip(body * clip_gain, -1.0, 1.0)
    x = np.concatenate([np.zeros(round(lead_s * RATE)), body, np.zeros(round(tail_s * RATE))]).astype(np.float32)
    return x + noise(x.size / RATE, floor_dbfs, seed=seed + 100)


def write_pcm16(path: Path, x: np.ndarray, rate: int = RATE, channels: int = 1) -> Path:
    data = np.clip(x, -1, 1)
    if channels > 1 and data.ndim == 1:
        data = np.repeat(data[:, None], channels, axis=1)
    pcm = np.round(data * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return path


def line(line_id: str, ms: int, *, forbidden: bool = False, statuses: dict[str, Any] | None = None) -> dict[str, Any]:
    rec = statuses or {
        "en-IN": {"status": "scripted", "itc_state": "draft"},
        "hi-IN": {"status": "not_scripted", "itc_state": "draft"},
    }
    return {
        "id": line_id,
        "category": "guide",
        "module_id": None,
        "speaker_role": "guide",
        "context": f"Test line {line_id}.",
        "reference_text": f"Reference text for {line_id}.",
        "target_duration_ms": ms,
        "tone": "warm",
        "voice_forbidden": forbidden,
        "recording": rec,
    }
