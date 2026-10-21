"""Typed view of ``config/qc.yaml`` (all QC and mastering thresholds)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from shriii_audio.paths import default_qc_config


class ConfigError(ValueError):
    """The QC configuration is missing a key or has an invalid value."""


@dataclass(frozen=True, slots=True)
class LoudnessConfig:
    target_lufs: float
    true_peak_ceiling_dbtp: float
    encode_true_peak_target_dbtp: float
    loudness_range_target_lu: float
    tolerance_lu: float


@dataclass(frozen=True, slots=True)
class EncodeConfig:
    codec: str
    sample_rate_hz: int
    channels: int
    bitrate_kbps: int
    frame_duration_ms: int
    application: str


@dataclass(frozen=True, slots=True)
class TrimConfig:
    frame_ms: int
    threshold_above_floor_db: float
    absolute_min_dbfs: float
    lead_pad_ms: int
    tail_pad_ms: int
    min_speech_run_ms: int


@dataclass(frozen=True, slots=True)
class InputConfig:
    min_sample_rate_hz: int
    max_channels: int
    min_duration_ms: int
    max_duration_ms: int


@dataclass(frozen=True, slots=True)
class ClippingConfig:
    sample_threshold: float
    min_run_samples: int
    max_events_reject: int


@dataclass(frozen=True, slots=True)
class NoiseConfig:
    noise_floor_percentile: float
    speech_level_percentile: float
    min_snr_db_reject: float
    min_snr_db_warn: float
    max_noise_floor_dbfs_warn: float
    max_dc_offset_warn: float


@dataclass(frozen=True, slots=True)
class DurationConfig:
    target_tolerance_fraction: float
    max_ratio_to_source: float
    long_clip_is_error: bool


@dataclass(frozen=True, slots=True)
class QcConfig:
    loudness: LoudnessConfig
    encode: EncodeConfig
    trim: TrimConfig
    input: InputConfig
    clipping: ClippingConfig
    noise: NoiseConfig
    duration: DurationConfig
    source_path: str


def _section(raw: dict[str, Any], name: str, cls: type[Any]) -> Any:
    data = raw.get(name)
    if not isinstance(data, dict):
        raise ConfigError(f"qc config: missing section '{name}'")
    fields = cls.__dataclass_fields__
    missing = [f for f in fields if f not in data]
    if missing:
        raise ConfigError(f"qc config: section '{name}' is missing {missing}")
    unknown = [k for k in data if k not in fields]
    if unknown:
        raise ConfigError(f"qc config: section '{name}' has unknown keys {unknown}")
    return cls(**{k: data[k] for k in fields})


def load_qc_config(path: Path | None = None) -> QcConfig:
    path = path or default_qc_config()
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ConfigError(f"qc config {path}: not a mapping")
    cfg = QcConfig(
        loudness=_section(raw, "loudness", LoudnessConfig),
        encode=_section(raw, "encode", EncodeConfig),
        trim=_section(raw, "trim", TrimConfig),
        input=_section(raw, "input", InputConfig),
        clipping=_section(raw, "clipping", ClippingConfig),
        noise=_section(raw, "noise", NoiseConfig),
        duration=_section(raw, "duration", DurationConfig),
        source_path=str(path),
    )
    if cfg.loudness.encode_true_peak_target_dbtp > cfg.loudness.true_peak_ceiling_dbtp:
        raise ConfigError("encode_true_peak_target_dbtp must not exceed true_peak_ceiling_dbtp")
    if cfg.encode.channels != 1:
        raise ConfigError("voice clips are mono (encode.channels must be 1)")
    if not 0 < cfg.clipping.sample_threshold <= 1:
        raise ConfigError("clipping.sample_threshold must be in (0, 1]")
    return cfg
