"""Sample-level QC: peak, DC offset, clipping, noise floor, SNR estimate, silence trim and waveform envelope."""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from shriii_audio.config import ClippingConfig, NoiseConfig, TrimConfig

FloatArray = npt.NDArray[np.float32]
SILENCE_DB = -120.0


def to_db(value: float) -> float:
    return 20.0 * math.log10(value) if value > 0 else SILENCE_DB


def mono(samples: FloatArray) -> FloatArray:
    if samples.ndim == 1:
        return samples
    return np.asarray(samples.mean(axis=1), dtype=np.float32)


def frame_rms_db(x: FloatArray, sample_rate: int, frame_ms: int) -> npt.NDArray[np.float64]:
    """RMS level (dBFS) of consecutive non-overlapping frames; a trailing partial frame is included."""
    hop = max(1, round(sample_rate * frame_ms / 1000))
    n = math.ceil(x.size / hop)
    if n == 0:
        return np.zeros(0)
    padded = np.zeros(n * hop, dtype=np.float64)
    padded[: x.size] = x
    frames = padded.reshape(n, hop)
    counts = np.full(n, hop, dtype=np.float64)
    counts[-1] = x.size - (n - 1) * hop
    rms = np.sqrt((frames**2).sum(axis=1) / counts)
    with np.errstate(divide="ignore"):
        db = 20.0 * np.log10(np.maximum(rms, 1e-12))
    return np.asarray(np.maximum(db, SILENCE_DB), dtype=np.float64)


@dataclass(frozen=True, slots=True)
class ClippingReport:
    events: int
    clipped_samples: int
    longest_run: int


def detect_clipping(samples: FloatArray, cfg: ClippingConfig) -> ClippingReport:
    """Count runs of >= ``min_run_samples`` consecutive samples at or above the clipping threshold (any channel)."""
    data = samples if samples.ndim == 2 else samples[:, None]
    events = clipped = longest = 0
    for ch in range(data.shape[1]):
        hot = np.abs(data[:, ch]) >= cfg.sample_threshold
        if not hot.any():
            continue
        # run-length encode the boolean mask
        edges = np.diff(np.concatenate(([0], hot.view(np.int8), [0])))
        starts = np.flatnonzero(edges == 1)
        ends = np.flatnonzero(edges == -1)
        runs = ends - starts
        long_runs = runs[runs >= cfg.min_run_samples]
        events += int(long_runs.size)
        clipped += int(long_runs.sum())
        longest = max(longest, int(runs.max()))
    return ClippingReport(events=events, clipped_samples=clipped, longest_run=longest)


@dataclass(frozen=True, slots=True)
class LevelReport:
    peak_dbfs: float
    rms_dbfs: float
    dc_offset: float
    noise_floor_dbfs: float
    speech_level_dbfs: float
    snr_db: float


def levels(samples: FloatArray, sample_rate: int, noise: NoiseConfig, frame_ms: int) -> LevelReport:
    """Peak, RMS, DC offset and a percentile-based SNR estimate (speech level minus noise floor)."""
    x = mono(samples)
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if x.size else 0.0
    dc = float(np.mean(x, dtype=np.float64)) if x.size else 0.0
    frames = frame_rms_db(x - dc, sample_rate, frame_ms)
    if frames.size == 0:
        floor = speech = SILENCE_DB
    else:
        floor = float(np.percentile(frames, noise.noise_floor_percentile))
        speech = float(np.percentile(frames, noise.speech_level_percentile))
    return LevelReport(
        peak_dbfs=to_db(peak),
        rms_dbfs=to_db(rms),
        dc_offset=dc,
        noise_floor_dbfs=floor,
        speech_level_dbfs=speech,
        snr_db=speech - floor,
    )


@dataclass(frozen=True, slots=True)
class TrimResult:
    start_sample: int
    end_sample: int
    speech_found: bool

    @property
    def length(self) -> int:
        return max(0, self.end_sample - self.start_sample)


def trim_bounds(samples: FloatArray, sample_rate: int, cfg: TrimConfig, noise_floor_dbfs: float) -> TrimResult:
    """Locate the first and last speech frames and keep the configured lead/tail pad around them.

    A frame is speech when it is ``threshold_above_floor_db`` above the noise floor and above
    ``absolute_min_dbfs``. Isolated speech runs shorter than ``min_speech_run_ms`` (clicks) are ignored.
    Silence *inside* the utterance is never removed.
    """
    x = mono(samples)
    hop = max(1, round(sample_rate * cfg.frame_ms / 1000))
    db = frame_rms_db(x - float(np.mean(x, dtype=np.float64)) if x.size else x, sample_rate, cfg.frame_ms)
    threshold = max(noise_floor_dbfs + cfg.threshold_above_floor_db, cfg.absolute_min_dbfs)
    active = db > threshold
    min_run = max(1, math.ceil(cfg.min_speech_run_ms / cfg.frame_ms))
    if active.any():
        edges = np.diff(np.concatenate(([0], active.view(np.int8), [0])))
        starts = np.flatnonzero(edges == 1)
        ends = np.flatnonzero(edges == -1)
        keep = (ends - starts) >= min_run
        starts, ends = starts[keep], ends[keep]
    else:
        starts = ends = np.zeros(0, dtype=np.int64)
    if starts.size == 0:
        return TrimResult(0, x.size, speech_found=False)
    first = int(starts[0]) * hop
    last = min(x.size, int(ends[-1]) * hop)
    lead = round(sample_rate * cfg.lead_pad_ms / 1000)
    tail = round(sample_rate * cfg.tail_pad_ms / 1000)
    return TrimResult(max(0, first - lead), min(x.size, last + tail), speech_found=True)


def apply_fades(x: FloatArray, sample_rate: int, fade_ms: float = 5.0) -> FloatArray:
    """Short raised-cosine fade in/out so a trim point never produces a click."""
    out = np.array(x, dtype=np.float32, copy=True)
    n = min(out.shape[0] // 2, max(1, round(sample_rate * fade_ms / 1000)))
    if n <= 1:
        return out
    ramp = (0.5 - 0.5 * np.cos(np.linspace(0, math.pi, n))).astype(np.float32)
    if out.ndim == 2:
        ramp = ramp[:, None]
    out[:n] *= ramp
    out[-n:] *= ramp[::-1]
    return out


def envelope(samples: FloatArray, buckets: int = 120) -> list[tuple[float, float]]:
    """Min/max per bucket of the mono signal (for the QC report waveform)."""
    x = mono(samples)
    if x.size == 0:
        return []
    edges = np.linspace(0, x.size, num=min(buckets, x.size) + 1, dtype=np.int64)
    return [(float(x[a:b].min()), float(x[a:b].max())) for a, b in itertools.pairwise(edges) if b > a]
