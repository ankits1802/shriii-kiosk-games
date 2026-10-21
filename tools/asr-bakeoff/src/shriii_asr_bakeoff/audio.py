"""16 kHz mono WAV I/O, level measurement and SNR mixing (numpy only)."""

from __future__ import annotations

import math
import struct
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import numpy.typing as npt

RATE = 16_000
Audio = npt.NDArray[np.float32]


def read_wav(path: Path) -> tuple[Audio, int]:
    """Read PCM16/PCM24/PCM32/float32 WAV (mono-mixed) as float32 in [-1, 1]."""
    data = path.read_bytes()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError(f"{path}: not a WAV file")
    pos = 12
    fmt: tuple[int, int, int, int] | None = None
    while pos + 8 <= len(data):
        cid = data[pos : pos + 4]
        size = struct.unpack("<I", data[pos + 4 : pos + 8])[0]
        body = data[pos + 8 : pos + 8 + size]
        if cid == b"fmt ":
            tag, ch, rate, _br, _al, bits = struct.unpack("<HHIIHH", body[:16])
            if tag == 0xFFFE and len(body) >= 26:
                tag = struct.unpack("<H", body[24:26])[0]
            fmt = (tag, ch, rate, bits)
        elif cid == b"data":
            if fmt is None:
                raise ValueError(f"{path}: data before fmt")
            tag, ch, rate, bits = fmt
            if tag == 3 and bits == 32:
                x = np.frombuffer(body, dtype="<f4").astype(np.float32)
            elif tag == 1 and bits == 16:
                x = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768.0
            elif tag == 1 and bits == 24:
                b = np.frombuffer(body[: len(body) // 3 * 3], dtype=np.uint8).reshape(-1, 3)
                ints = b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16)
                ints = np.where(ints & 0x800000, ints - (1 << 24), ints)
                x = ints.astype(np.float32) / 8388608.0
            elif tag == 1 and bits == 32:
                x = np.frombuffer(body, dtype="<i4").astype(np.float32) / 2147483648.0
            else:
                raise ValueError(f"{path}: unsupported WAV format tag={tag} bits={bits}")
            x = x[: (x.size // ch) * ch].reshape(-1, ch).mean(axis=1).astype(np.float32)
            return x, rate
        pos += 8 + size + (size & 1)
    raise ValueError(f"{path}: no data chunk")


def write_wav(path: Path, x: Audio, rate: int = RATE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.round(np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def resample(x: Audio, src_rate: int, dst_rate: int = RATE) -> Audio:
    """Band-limited resampling by FFT (adequate for evaluation material)."""
    if src_rate == dst_rate or x.size == 0:
        return x.astype(np.float32)
    n_out = round(x.size * dst_rate / src_rate)
    spec = np.fft.rfft(x.astype(np.float64))
    keep = min(spec.size, n_out // 2 + 1)
    out_spec = np.zeros(n_out // 2 + 1, dtype=np.complex128)
    out_spec[:keep] = spec[:keep]
    y = np.fft.irfft(out_spec, n=n_out) * (n_out / x.size)
    return y.astype(np.float32)


def load_16k(path: Path) -> Audio:
    x, rate = read_wav(path)
    return resample(x, rate, RATE)


def rms(x: Audio) -> float:
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if x.size else 0.0


def active_level(x: Audio, rate: int = RATE, frame_ms: float = 20.0, dynamic_db: float = 40.0) -> float:
    """RMS over 'active' frames (within ``dynamic_db`` of the loudest frame), a simplified P.56 speech level."""
    hop = max(1, round(rate * frame_ms / 1000))
    n = x.size // hop
    if n == 0:
        return rms(x)
    frames = x[: n * hop].astype(np.float64).reshape(n, hop)
    e = np.mean(frames**2, axis=1)
    peak = float(e.max())
    if peak <= 0:
        return 0.0
    active = e >= peak * 10 ** (-dynamic_db / 10)
    return math.sqrt(float(e[active].mean()))


@dataclass(frozen=True, slots=True)
class Mixture:
    audio: Audio
    snr_db: float
    noise_offset: int
    scaled_for_clipping: bool


def mix_at_snr(speech: Audio, noise: Audio, snr_db: float, rng: np.random.Generator) -> Mixture:
    """Add ``noise`` (looped, random offset) to ``speech`` so that active speech level / noise RMS = snr_db."""
    if noise.size == 0:
        raise ValueError("empty noise")
    offset = int(rng.integers(0, noise.size))
    reps = math.ceil((offset + speech.size) / noise.size) + 1
    segment = np.tile(noise, reps)[offset : offset + speech.size].astype(np.float64)
    s_level = active_level(speech)
    n_level = rms(segment.astype(np.float32))
    if s_level <= 0 or n_level <= 0:
        raise ValueError("speech or noise is silent")
    gain = s_level / (n_level * 10 ** (snr_db / 20))
    mixed = speech.astype(np.float64) + gain * segment
    peak = float(np.max(np.abs(mixed)))
    scaled = peak > 0.99
    if scaled:
        mixed *= 0.99 / peak
    return Mixture(mixed.astype(np.float32), snr_db, offset, scaled)


def noise_window(noise: Audio, seconds: float, level_dbfs: float, rng: np.random.Generator) -> Audio:
    """A keyword-free noise window at a given RMS level (for false-accept trials)."""
    n = round(seconds * RATE)
    offset = int(rng.integers(0, noise.size))
    reps = math.ceil((offset + n) / noise.size) + 1
    seg = np.tile(noise, reps)[offset : offset + n].astype(np.float64)
    r = rms(seg.astype(np.float32))
    return (seg * (10 ** (level_dbfs / 20) / r if r > 0 else 0)).astype(np.float32)
