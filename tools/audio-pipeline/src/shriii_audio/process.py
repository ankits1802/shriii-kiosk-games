"""Ingest -> QC -> trim -> two-pass loudnorm -> Opus -> re-measure, for a folder of recordings.

Recordings are named ``<line_id>.<lang>.wav`` (the selected take) or ``<line_id>.<lang>.take<N>.wav``.
When no plain file exists, the highest-numbered take that passes QC is selected; the others are kept in
the report as ``superseded``. Nothing is written back into ``content/i18n/lines.yaml``.
"""

from __future__ import annotations

import re
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np

from shriii_audio import analysis, ffmpeg
from shriii_audio.catalogue import Catalogue, Line
from shriii_audio.config import QcConfig
from shriii_audio.signing import sha256_file
from shriii_audio.wavinfo import WavError, read_wav_info

Severity = Literal["error", "warning", "info"]
Status = Literal["pass", "warn", "fail"]

FILENAME_RE = re.compile(
    r"^(?P<line>[a-z0-9][a-z0-9_.:-]{0,127}?)\.(?P<lang>[a-z]{2,3}-[A-Z]{2})(?:\.take(?P<take>[1-9]\d{0,3}))?\.wav$"
)


@dataclass(frozen=True, slots=True)
class Issue:
    code: str
    severity: Severity
    message: str


@dataclass(slots=True)
class ClipResult:
    line_id: str
    language: str
    take: int | None
    source_file: str
    source_sha256: str
    issues: list[Issue] = field(default_factory=list)
    selected: bool = False
    superseded: bool = False
    # input
    input_format: str | None = None
    input_sample_rate_hz: int | None = None
    input_channels: int | None = None
    input_bits: int | None = None
    input_duration_ms: float | None = None
    # raw levels
    peak_dbfs: float | None = None
    rms_dbfs: float | None = None
    dc_offset: float | None = None
    noise_floor_dbfs: float | None = None
    speech_level_dbfs: float | None = None
    snr_db: float | None = None
    clipping_events: int | None = None
    clipped_samples: int | None = None
    lead_trim_ms: float | None = None
    tail_trim_ms: float | None = None
    # loudness
    input_lufs: float | None = None
    input_true_peak_dbtp: float | None = None
    normalization_type: str | None = None
    encode_attempts: int = 0
    # output
    output_file: str | None = None
    output_sha256: str | None = None
    duration_ms: int | None = None
    output_lufs: float | None = None
    output_true_peak_dbtp: float | None = None
    output_peak_dbfs: float | None = None
    target_duration_ms: int | None = None
    source_duration_ms: float | None = None
    ratio_to_source: float | None = None
    envelope: list[tuple[float, float]] = field(default_factory=list)

    def add(self, code: str, severity: Severity, message: str) -> None:
        self.issues.append(Issue(code, severity, message))

    @property
    def status(self) -> Status:
        if any(i.severity == "error" for i in self.issues):
            return "fail"
        if any(i.severity == "warning" for i in self.issues):
            return "warn"
        return "pass"

    @property
    def deliverable(self) -> bool:
        return self.output_file is not None and self.status != "fail"


@dataclass(slots=True)
class BatchResult:
    catalogue: Catalogue
    clips: list[ClipResult]
    rejected_files: list[tuple[str, str]]
    """(file name, reason) for files that could not be attributed to a catalogue line."""
    languages: list[str]

    def selected(self, language: str | None = None) -> list[ClipResult]:
        return [c for c in self.clips if c.selected and (language is None or c.language == language)]

    def missing(self, language: str) -> list[str]:
        have = {c.line_id for c in self.selected(language) if c.deliverable}
        return [line.id for line in self.catalogue.lines if line.id not in have]


@dataclass(frozen=True, slots=True)
class ParsedName:
    line_id: str
    language: str
    take: int | None


def parse_filename(name: str) -> ParsedName | None:
    m = FILENAME_RE.match(name)
    if not m:
        return None
    return ParsedName(m.group("line"), m.group("lang"), int(m.group("take")) if m.group("take") else None)


def _failed(result: ClipResult) -> bool:
    return any(i.severity == "error" for i in result.issues)


def _ms(samples: int, rate: int) -> float:
    return 1000.0 * samples / rate


def process_one(
    path: Path,
    parsed: ParsedName,
    line: Line,
    cfg: QcConfig,
    pack_dir: Path,
    work_dir: Path,
) -> ClipResult:
    result = ClipResult(
        line_id=parsed.line_id,
        language=parsed.language,
        take=parsed.take,
        source_file=path.name,
        source_sha256=sha256_file(path),
        target_duration_ms=line.target_duration_ms,
    )
    try:
        info = read_wav_info(path)
    except WavError as exc:
        result.add("unreadable", "error", str(exc))
        return result
    result.input_format = info.format_name
    result.input_sample_rate_hz = info.sample_rate_hz
    result.input_channels = info.channels
    result.input_bits = info.bits_per_sample
    if info.sample_rate_hz < cfg.input.min_sample_rate_hz:
        result.add(
            "sample_rate_too_low",
            "error",
            f"{info.sample_rate_hz} Hz < {cfg.input.min_sample_rate_hz} Hz minimum",
        )
    if info.channels > cfg.input.max_channels or info.channels < 1:
        result.add("too_many_channels", "error", f"{info.channels} channels (max {cfg.input.max_channels})")
    if _failed(result):
        return result
    if info.channels > 1:
        result.add("stereo_input", "warning", "multi-channel recording mixed down to mono; record mono")

    try:
        samples = ffmpeg.decode_f32(path)
    except ffmpeg.FfmpegError as exc:
        result.add("decode_failed", "error", str(exc).splitlines()[0])
        return result
    rate = info.sample_rate_hz
    result.input_duration_ms = _ms(samples.shape[0], rate)
    if result.input_duration_ms < cfg.input.min_duration_ms:
        result.add("too_short", "error", f"{result.input_duration_ms:.0f} ms < {cfg.input.min_duration_ms} ms")
    if result.input_duration_ms > cfg.input.max_duration_ms:
        result.add("too_long", "error", f"{result.input_duration_ms:.0f} ms > {cfg.input.max_duration_ms} ms")
    if _failed(result):
        return result

    clip = analysis.detect_clipping(samples, cfg.clipping)
    result.clipping_events = clip.events
    result.clipped_samples = clip.clipped_samples
    if clip.events > cfg.clipping.max_events_reject:
        result.add("clipping", "error", f"{clip.events} clipping event(s), {clip.clipped_samples} samples")
    elif clip.longest_run > 0 and clip.events == 0:
        result.add("near_full_scale", "info", "isolated full-scale samples (no clipping run)")

    lv = analysis.levels(samples, rate, cfg.noise, cfg.trim.frame_ms)
    result.peak_dbfs = lv.peak_dbfs
    result.rms_dbfs = lv.rms_dbfs
    result.dc_offset = lv.dc_offset
    result.noise_floor_dbfs = lv.noise_floor_dbfs
    result.speech_level_dbfs = lv.speech_level_dbfs
    result.snr_db = lv.snr_db
    if lv.snr_db < cfg.noise.min_snr_db_reject:
        result.add("low_snr", "error", f"estimated SNR {lv.snr_db:.1f} dB < {cfg.noise.min_snr_db_reject} dB")
    elif lv.snr_db < cfg.noise.min_snr_db_warn:
        result.add("marginal_snr", "warning", f"estimated SNR {lv.snr_db:.1f} dB < {cfg.noise.min_snr_db_warn} dB")
    if lv.noise_floor_dbfs > cfg.noise.max_noise_floor_dbfs_warn:
        result.add(
            "noisy_room",
            "warning",
            f"noise floor {lv.noise_floor_dbfs:.1f} dBFS > {cfg.noise.max_noise_floor_dbfs_warn} dBFS",
        )
    if abs(lv.dc_offset) > cfg.noise.max_dc_offset_warn:
        result.add("dc_offset", "warning", f"DC offset {lv.dc_offset:+.4f} of full scale")

    trim = analysis.trim_bounds(samples, rate, cfg.trim, lv.noise_floor_dbfs)
    if not trim.speech_found:
        result.add("no_speech", "error", "no speech detected above the noise floor")
        return result
    result.lead_trim_ms = _ms(trim.start_sample, rate)
    result.tail_trim_ms = _ms(samples.shape[0] - trim.end_sample, rate)
    body = analysis.mono(samples[trim.start_sample : trim.end_sample])
    body = body - np.float32(lv.dc_offset)
    body = analysis.apply_fades(body, rate)
    result.envelope = analysis.envelope(body)
    if _failed(result):
        return result

    trimmed = work_dir / f"{parsed.line_id}.{parsed.language}.{parsed.take or 0}.trim.wav"
    ffmpeg.write_wav_f32(trimmed, body, rate)
    _encode(result, trimmed, cfg, pack_dir)
    return result


def _encode(result: ClipResult, trimmed: Path, cfg: QcConfig, pack_dir: Path) -> None:
    loud = cfg.loudness
    first = ffmpeg.loudnorm_measure(trimmed, loud)
    result.input_lufs = first.input_i
    result.input_true_peak_dbtp = first.input_tp
    if first.input_i == float("-inf") or first.input_i < -70:
        result.add("silent", "error", "integrated loudness below the -70 LUFS absolute gate")
        return
    rel = f"{result.language}/{result.line_id}.opus"
    dst = pack_dir / rel
    target = loud.target_lufs
    measured: ffmpeg.LoudnessMeasurement | None = None
    for attempt in (1, 2):
        result.encode_attempts = attempt
        if attempt > 1:
            first = ffmpeg.loudnorm_measure(trimmed, loud, target_i=target)
        second = ffmpeg.loudnorm_encode(trimmed, dst, first, loud, cfg.encode, target_i=target)
        result.normalization_type = second.normalization_type
        measured = ffmpeg.measure_loudness(dst)
        error = loud.target_lufs - measured.integrated_lufs
        if abs(error) <= loud.tolerance_lu and measured.true_peak_dbtp <= loud.true_peak_ceiling_dbtp:
            break
        # Correct the target by the residual error (bounded) and try once more.
        target = max(loud.target_lufs - 3.0, min(loud.target_lufs + 3.0, target + error))
    assert measured is not None
    result.output_lufs = measured.integrated_lufs
    result.output_true_peak_dbtp = measured.true_peak_dbtp
    if abs(measured.integrated_lufs - loud.target_lufs) > loud.tolerance_lu:
        result.add(
            "loudness_out_of_tolerance",
            "error",
            f"re-measured {measured.integrated_lufs:.2f} LUFS, target {loud.target_lufs} +- {loud.tolerance_lu}",
        )
    if measured.true_peak_dbtp > loud.true_peak_ceiling_dbtp:
        result.add(
            "true_peak_over_ceiling",
            "error",
            f"re-measured true peak {measured.true_peak_dbtp:.2f} dBTP > {loud.true_peak_ceiling_dbtp} dBTP",
        )
    if result.normalization_type not in (None, "linear"):
        result.add("dynamic_loudnorm", "info", "loudnorm fell back to dynamic mode (peak-to-loudness ratio too high)")
    decoded = ffmpeg.decode_f32(dst, sample_rate=cfg.encode.sample_rate_hz, channels=1)
    result.output_file = rel
    result.output_sha256 = sha256_file(dst)
    result.duration_ms = round(_ms(decoded.shape[0], cfg.encode.sample_rate_hz))
    result.output_peak_dbfs = analysis.to_db(float(np.max(np.abs(decoded))) if decoded.size else 0.0)


def _apply_duration_checks(clips: Iterable[ClipResult], catalogue: Catalogue, cfg: QcConfig) -> None:
    ref = catalogue.reference_language
    ref_durations = {
        c.line_id: float(c.duration_ms) for c in clips if c.selected and c.language == ref and c.duration_ms
    }
    for c in clips:
        if not c.selected or c.duration_ms is None or c.target_duration_ms is None:
            continue
        tol = cfg.duration.target_tolerance_fraction
        lo, hi = c.target_duration_ms * (1 - tol), c.target_duration_ms * (1 + tol)
        if not lo <= c.duration_ms <= hi:
            c.add(
                "off_target_duration",
                "warning",
                f"{c.duration_ms} ms outside target {c.target_duration_ms} ms +- {round(tol * 100)}%",
            )
        source = ref_durations.get(c.line_id) if c.language != ref else None
        c.source_duration_ms = source if source is not None else float(c.target_duration_ms)
        c.ratio_to_source = c.duration_ms / c.source_duration_ms if c.source_duration_ms else None
        if c.ratio_to_source is not None and c.ratio_to_source > cfg.duration.max_ratio_to_source:
            basis = f"{ref} clip" if source is not None else "source target duration"
            c.add(
                "long_clip",
                "error" if cfg.duration.long_clip_is_error else "warning",
                f"{c.ratio_to_source:.2f}x the {basis} (> {cfg.duration.max_ratio_to_source}x)",
            )


def process_directory(
    input_dir: Path,
    catalogue: Catalogue,
    cfg: QcConfig,
    out_dir: Path,
    languages: Iterable[str] | None = None,
) -> BatchResult:
    if not ffmpeg.has_libopus():
        raise ffmpeg.FfmpegError("the ffmpeg build has no libopus encoder")
    wanted = set(languages) if languages else None
    lines = catalogue.by_id()
    rejected: list[tuple[str, str]] = []
    candidates: dict[tuple[str, str], list[tuple[Path, ParsedName]]] = {}
    for path in sorted(p for p in input_dir.iterdir() if p.is_file()):
        if path.name.startswith(".") or path.suffix.lower() not in {".wav"}:
            if path.suffix.lower() in {".wav", ".mp3", ".flac", ".m4a", ".aif", ".aiff", ".ogg", ".opus"}:
                rejected.append((path.name, "only .wav recordings are accepted"))
            continue
        parsed = parse_filename(path.name)
        if parsed is None:
            rejected.append((path.name, "name does not match <line_id>.<lang>[.take<N>].wav"))
            continue
        if parsed.language not in catalogue.languages:
            rejected.append((path.name, f"language {parsed.language} is not in the catalogue languages"))
            continue
        if parsed.line_id not in lines:
            rejected.append((path.name, f"line id {parsed.line_id!r} is not in the catalogue"))
            continue
        if wanted is not None and parsed.language not in wanted:
            continue
        candidates.setdefault((parsed.line_id, parsed.language), []).append((path, parsed))

    pack_dir = out_dir / "packs"
    clips: list[ClipResult] = []
    with tempfile.TemporaryDirectory(prefix="shriii-audio-") as tmp:
        work = Path(tmp)
        for (line_id, _lang), group in sorted(candidates.items()):
            # Plain file first (the director's pick), then takes from highest to lowest.
            group.sort(key=lambda item: (item[1].take is not None, -(item[1].take or 0)))
            chosen: ClipResult | None = None
            for path, parsed in group:
                staging = work / "staging"
                res = process_one(path, parsed, lines[line_id], cfg, staging, work)
                clips.append(res)
                if chosen is None and (parsed.take is None or res.deliverable):
                    chosen = res
                    res.selected = True
                    if res.output_file:
                        final = pack_dir / res.output_file
                        final.parent.mkdir(parents=True, exist_ok=True)
                        (staging / res.output_file).replace(final)
                else:
                    res.superseded = True
                if res.output_file and not res.selected:
                    (staging / res.output_file).unlink(missing_ok=True)
                    res.output_file = None
            if chosen is None:
                # No take passed: report the highest take as the selected (failed) one.
                group_results = clips[-len(group) :]
                group_results[0].selected = True
                group_results[0].superseded = False
    _apply_duration_checks(clips, catalogue, cfg)
    # Clips that failed after the duration checks lose their deliverable file.
    for c in clips:
        if c.selected and c.output_file and c.status == "fail":
            (pack_dir / c.output_file).unlink(missing_ok=True)
            c.output_file = None
    langs = sorted({c.language for c in clips} | (wanted or set()))
    return BatchResult(catalogue=catalogue, clips=clips, rejected_files=rejected, languages=langs)
