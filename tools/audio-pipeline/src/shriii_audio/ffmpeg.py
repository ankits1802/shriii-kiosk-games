"""Thin, typed wrapper around the ffmpeg CLI (decode, EBU R128 measurement, two-pass loudnorm, Opus).

The binary is resolved from ``$SHRIII_FFMPEG``, then ``ffmpeg`` on ``PATH``, then the static build that
ships with the ``imageio-ffmpeg`` wheel, so the pipeline works on a machine without a system ffmpeg.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from functools import cache
from pathlib import Path

import numpy as np
import numpy.typing as npt

from shriii_audio.config import EncodeConfig, LoudnessConfig

FloatArray = npt.NDArray[np.float32]


class FfmpegError(RuntimeError):
    """ffmpeg failed or produced unparseable output."""


@cache
def find_ffmpeg() -> str:
    env = os.environ.get("SHRIII_FFMPEG")
    if env:
        if not Path(env).is_file():
            raise FfmpegError(f"SHRIII_FFMPEG={env} does not exist")
        return env
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    try:
        import imageio_ffmpeg  # noqa: PLC0415 - optional fallback

        return str(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception as exc:  # pragma: no cover - depends on the environment
        raise FfmpegError("ffmpeg not found: set SHRIII_FFMPEG, install ffmpeg, or install imageio-ffmpeg") from exc


def _run(args: list[str]) -> subprocess.CompletedProcess[bytes]:
    cmd = [find_ffmpeg(), "-hide_banner", "-nostdin", *args]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace")[-2000:]
        raise FfmpegError(f"ffmpeg failed ({proc.returncode}): {' '.join(args[:6])}...\n{tail}")
    return proc


@cache
def has_libopus() -> bool:
    proc = _run(["-encoders"])
    return b"libopus" in proc.stdout


def decode_f32(path: Path, *, sample_rate: int | None = None, channels: int | None = None) -> FloatArray:
    """Decode any audio file to float32 samples, shape ``(n_samples, n_channels)``.

    Without ``sample_rate``/``channels`` the native rate and channel count are kept (no resampling), so
    clipping and peak analysis see the original sample values.
    """
    args = ["-i", str(path), "-map", "0:a:0", "-vn"]
    if sample_rate is not None:
        args += ["-ar", str(sample_rate)]
    if channels is not None:
        args += ["-ac", str(channels)]
    args += ["-f", "f32le", "-acodec", "pcm_f32le", "-"]
    proc = _run(args)
    data = np.frombuffer(proc.stdout, dtype="<f4").astype(np.float32)
    n_ch = channels if channels is not None else _probe_channels(proc.stderr.decode("utf-8", "replace"))
    if n_ch <= 0:
        raise FfmpegError(f"could not determine channel count of {path}")
    usable = (data.size // n_ch) * n_ch
    return data[:usable].reshape(-1, n_ch)


_CHANNEL_WORDS = {"mono": 1, "stereo": 2, "2.1": 3, "quad": 4, "5.0": 5, "5.1": 6, "7.1": 8}


def _probe_channels(stderr: str) -> int:
    # Output stream line, e.g. "Stream #0:0: Audio: pcm_f32le, 48000 Hz, mono, flt, 1536 kb/s"
    matches = re.findall(r"Stream #\d+:\d+.*?Audio: pcm_f32le[^,]*, \d+ Hz, ([^,]+),", stderr)
    if not matches:
        return -1
    word = matches[-1].strip()
    if word in _CHANNEL_WORDS:
        return _CHANNEL_WORDS[word]
    m = re.match(r"(\d+) channels", word)
    return int(m.group(1)) if m else -1


@dataclass(frozen=True, slots=True)
class LoudnessMeasurement:
    integrated_lufs: float
    true_peak_dbtp: float
    lra_lu: float
    threshold_lufs: float


def measure_loudness(path: Path) -> LoudnessMeasurement:
    """Independent EBU R128 re-measure with the ``ebur128`` filter (true peak with 4x oversampling)."""
    proc = _run(["-i", str(path), "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"])
    text = proc.stderr.decode("utf-8", "replace")
    summary = text[text.rfind("Summary:") :]
    if "Summary:" not in summary:
        raise FfmpegError(f"ebur128 produced no summary for {path}")

    def grab(pattern: str) -> float:
        m = re.search(pattern, summary)
        if not m:
            raise FfmpegError(f"ebur128 summary missing {pattern!r} for {path}")
        value = m.group(1)
        return float("-inf") if value in {"-inf", "-nan", "nan"} else float(value)

    return LoudnessMeasurement(
        integrated_lufs=grab(r"I:\s+(-?[\d.]+|-inf|-?nan)\s+LUFS"),
        threshold_lufs=grab(r"Threshold:\s+(-?[\d.]+|-inf|-?nan)\s+LUFS"),
        lra_lu=grab(r"LRA:\s+(-?[\d.]+|-inf|-?nan)\s+LU"),
        true_peak_dbtp=grab(r"True peak:\s+Peak:\s+(-?[\d.]+|-inf|-?nan)\s+dBFS"),
    )


def _loudnorm_json(stderr: bytes) -> dict[str, str]:
    text = stderr.decode("utf-8", "replace")
    start = text.rfind("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise FfmpegError("loudnorm printed no JSON block")
    parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise FfmpegError("loudnorm JSON is not an object")
    return {str(k): str(v) for k, v in parsed.items()}


@dataclass(frozen=True, slots=True)
class LoudnormFirstPass:
    input_i: float
    input_tp: float
    input_lra: float
    input_thresh: float
    target_offset: float


def loudnorm_measure(path: Path, cfg: LoudnessConfig, target_i: float | None = None) -> LoudnormFirstPass:
    target = cfg.target_lufs if target_i is None else target_i
    af = (
        f"loudnorm=I={target}:TP={cfg.encode_true_peak_target_dbtp}:LRA={cfg.loudness_range_target_lu}"
        ":print_format=json"
    )
    proc = _run(["-i", str(path), "-map", "0:a:0", "-af", af, "-f", "null", "-"])
    j = _loudnorm_json(proc.stderr)
    return LoudnormFirstPass(
        input_i=float(j["input_i"]),
        input_tp=float(j["input_tp"]),
        input_lra=float(j["input_lra"]),
        input_thresh=float(j["input_thresh"]),
        target_offset=float(j["target_offset"]),
    )


@dataclass(frozen=True, slots=True)
class LoudnormSecondPass:
    output_i: float
    output_tp: float
    normalization_type: str


def loudnorm_encode(
    src: Path,
    dst: Path,
    first: LoudnormFirstPass,
    loud: LoudnessConfig,
    enc: EncodeConfig,
    target_i: float | None = None,
) -> LoudnormSecondPass:
    """Second loudnorm pass (linear when possible) straight into a deterministic Ogg Opus file.

    The LRA target is raised to at least the measured LRA so loudnorm stays in linear (pure gain) mode
    whenever the true-peak ceiling allows it; otherwise it falls back to its dynamic mode, which the QC
    report records.
    """
    target = loud.target_lufs if target_i is None else target_i
    lra_target = min(50.0, max(loud.loudness_range_target_lu, first.input_lra + 1.0))
    af = (
        f"loudnorm=I={target}:TP={loud.encode_true_peak_target_dbtp}:LRA={lra_target}"
        f":measured_I={first.input_i}:measured_TP={first.input_tp}:measured_LRA={first.input_lra}"
        f":measured_thresh={first.input_thresh}:offset={first.target_offset}:linear=true:print_format=json"
    )
    dst.parent.mkdir(parents=True, exist_ok=True)
    proc = _run(
        [
            "-y",
            "-fflags",
            "+bitexact",
            "-i",
            str(src),
            "-map",
            "0:a:0",
            "-map_metadata",
            "-1",
            "-af",
            af,
            "-ar",
            str(enc.sample_rate_hz),
            "-ac",
            str(enc.channels),
            "-c:a",
            enc.codec,
            "-b:a",
            f"{enc.bitrate_kbps}k",
            "-vbr",
            "on",
            "-frame_duration",
            str(enc.frame_duration_ms),
            "-application",
            enc.application,
            "-flags:a",
            "+bitexact",
            "-fflags",
            "+bitexact",
            "-f",
            "ogg",
            str(dst),
        ]
    )
    j = _loudnorm_json(proc.stderr)
    return LoudnormSecondPass(
        output_i=float(j["output_i"]),
        output_tp=float(j["output_tp"]),
        normalization_type=j.get("normalization_type", "unknown"),
    )


def write_wav_f32(path: Path, samples: FloatArray, sample_rate: int) -> None:
    """Write IEEE-float WAV (format 3) without any external dependency."""
    if samples.ndim == 1:
        samples = samples[:, None]
    n_ch = samples.shape[1]
    data = np.ascontiguousarray(samples, dtype="<f4").tobytes()
    block_align = 4 * n_ch
    header = b"".join(
        [
            b"RIFF",
            (36 + len(data)).to_bytes(4, "little"),
            b"WAVE",
            b"fmt ",
            (16).to_bytes(4, "little"),
            (3).to_bytes(2, "little"),
            n_ch.to_bytes(2, "little"),
            sample_rate.to_bytes(4, "little"),
            (sample_rate * block_align).to_bytes(4, "little"),
            block_align.to_bytes(2, "little"),
            (32).to_bytes(2, "little"),
            b"data",
            len(data).to_bytes(4, "little"),
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + data)
