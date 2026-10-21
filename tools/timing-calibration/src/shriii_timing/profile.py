"""Build, version and compare timing profiles."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

import numpy as np

from shriii_timing.analysis import (
    ClockMap,
    FloatArray,
    align_and_match,
    channel_stats,
    fit_clock_sync,
    frame_stats,
)
from shriii_timing.resources import PROFILE_SCHEMA, Thresholds, schema_errors, sha256_json

TOOL_VERSION = "0.1.0"


@dataclass(slots=True)
class SensorFile:
    """One imported sensor CSV: its columns and provenance."""

    name: str
    sha256: str
    columns: dict[str, list[float]]

    def col(self, key: str) -> FloatArray:
        return np.asarray(self.columns[key], dtype=float)


@dataclass(slots=True)
class Inputs:
    """Everything the analysis consumes besides the thresholds."""

    capture: dict[str, Any]
    capture_name: str
    capture_sha256: str
    photodiode: SensorFile | None = None
    tapper: SensorFile | None = None
    camera: SensorFile | None = None
    audio_rig: SensorFile | None = None
    sync: SensorFile | None = None
    rig_clock: Literal["device", "host"] = "device"
    display_offset_ms: float | None = None
    camera_fps: float | None = None
    notes: list[str] = field(default_factory=list)


def _clock_map(inp: Inputs, th: Thresholds) -> ClockMap | None:
    pairs: tuple[FloatArray, FloatArray, FloatArray] | None = None
    if inp.sync is not None:
        pairs = (inp.sync.col("host_send_ms"), inp.sync.col("host_recv_ms"), inp.sync.col("device_ms"))
    elif inp.capture.get("sync"):
        rows = inp.capture["sync"]["pairs"]
        pairs = (
            np.array([r["host_send_ms"] for r in rows], dtype=float),
            np.array([r["host_recv_ms"] for r in rows], dtype=float),
            np.array([r["device_ms"] for r in rows], dtype=float),
        )
    if pairs is None:
        return None
    return fit_clock_sync(*pairs, keep_quantile=th.f("sync.keep_rtt_quantile"))


def _to_host(times: FloatArray, inp: Inputs, cmap: ClockMap | None) -> tuple[FloatArray, bool, float | None]:
    """Rig times on the page clock, whether that is anchored, and the sync uncertainty."""
    if inp.rig_clock == "host":
        return times, True, None
    if cmap is None:
        return times, False, None
    return cmap.to_host(times), True, cmap.uncertainty_ms


def _period(capture: dict[str, Any], frames: dict[str, Any] | None) -> float | None:
    hz = capture["device"].get("refresh_hz_nominal")
    if hz:
        return 1000.0 / float(hz)
    return float(frames["period_ms"]) if frames else None


def _matched_channel(
    ref: FloatArray,
    obs: FloatArray,
    *,
    method: Any,
    anchored: bool,
    sync_unc: float | None,
    period: float | None,
    th: Thresholds,
) -> dict[str, Any]:
    m, used = align_and_match(ref, obs, anchored=anchored, th=th)
    lat = used[m.obs_idx] - ref[m.ref_idx]
    return channel_stats(
        lat,
        ref[m.ref_idx],
        method=method,
        anchored=anchored,
        n_reference=m.n_ref,
        missed_rate=m.missed_rate,
        spurious_rate=m.spurious_rate,
        period_ms=period,
        sync_uncertainty_ms=sync_unc,
        th=th,
    )


def analyse_visual(inp: Inputs, cmap: ClockMap | None, period: float | None, th: Thresholds) -> dict[str, Any] | None:
    vis = inp.capture.get("visual")
    if not vis or inp.photodiode is None:
        return None
    ref = np.array([t["presented_ms"] for t in vis["trials"]], dtype=float)
    obs, anchored, unc = _to_host(inp.photodiode.col("t_ms"), inp, cmap)
    return _matched_channel(ref, obs, method="photodiode", anchored=anchored, sync_unc=unc, period=period, th=th)


def analyse_touch(
    inp: Inputs, cmap: ClockMap | None, period: float | None, visual: dict[str, Any] | None, th: Thresholds
) -> dict[str, Any] | None:
    tch = inp.capture.get("touch")
    if not tch:
        return None
    taps = tch["taps"]
    if inp.tapper is not None:
        # Reference = physical contact (rig clock -> page clock); observed = PointerEvent.timeStamp.
        contact, anchored, unc = _to_host(inp.tapper.col("t_ms"), inp, cmap)
        events = np.array([t["event_ts_ms"] for t in taps], dtype=float)
        return _matched_channel(
            contact[np.isfinite(contact)],
            events,
            method="solenoid_tapper",
            anchored=anchored,
            sync_unc=unc,
            period=period,
            th=th,
        )
    if inp.camera is not None:
        return _camera_touch(inp, taps, period, visual, th)
    return None


def _camera_times(inp: Inputs, start: str, end: str) -> tuple[FloatArray, FloatArray]:
    cam = inp.camera
    assert cam is not None
    if f"{start}_ms" in cam.columns:
        return cam.col(f"{start}_ms"), cam.col(f"{end}_ms")
    if inp.camera_fps is None:
        raise ValueError("camera CSV with *_frame columns needs --camera-fps")
    scale = 1000.0 / inp.camera_fps
    return cam.col(f"{start}_frame") * scale, cam.col(f"{end}_frame") * scale


def _camera_touch(
    inp: Inputs, taps: list[dict[str, Any]], period: float | None, visual: dict[str, Any] | None, th: Thresholds
) -> dict[str, Any]:
    """High-speed camera: touch-to-photon on the camera clock minus page processing minus display offset.

    ``photon - contact = touch_latency + (flash_presented - event_ts) + display_offset``."""
    cam = inp.camera
    assert cam is not None
    contact, photon = _camera_times(inp, "contact", "photon")
    idx = cam.col("tap_index")
    by_i = {int(t["i"]): t for t in taps}
    display = inp.display_offset_ms
    if display is None and visual is not None and visual.get("anchored") and visual.get("offset_ms") is not None:
        display = float(visual["offset_ms"])
    anchored = display is not None
    lat: list[float] = []
    ref: list[float] = []
    for k, c, p in zip(idx, contact, photon, strict=True):
        tap = by_i.get(int(k)) if np.isfinite(k) else None
        if tap is None or tap["flash_presented_ms"] is None or not (np.isfinite(c) and np.isfinite(p)):
            continue
        processing = float(tap["flash_presented_ms"]) - float(tap["event_ts_ms"])
        lat.append(float(p - c) - processing - (display or 0.0))
        ref.append(float(tap["event_ts_ms"]))
    n_ref = int(idx.size)
    return channel_stats(
        np.array(lat),
        np.array(ref),
        method="high_speed_camera",
        anchored=anchored,
        n_reference=n_ref,
        missed_rate=0.0 if n_ref == 0 else (n_ref - len(lat)) / n_ref,
        spurious_rate=0.0,
        period_ms=period,
        sync_uncertainty_ms=None,
        th=th,
    )


def analyse_audio(inp: Inputs, cmap: ClockMap | None, period: float | None, th: Thresholds) -> dict[str, Any] | None:
    aud = inp.capture.get("audio")
    if not aud:
        return None
    clicks = aud["clicks"]
    if inp.audio_rig is not None:
        ref = np.array([c["scheduled_perf_ms"] for c in clicks], dtype=float)
        obs, anchored, unc = _to_host(inp.audio_rig.col("t_ms"), inp, cmap)
        return _matched_channel(ref, obs, method="audio_rig", anchored=anchored, sync_unc=unc, period=period, th=th)
    detected = [c for c in clicks if c["detected_ctx_s"] is not None]
    if not detected:
        return None
    input_lat = aud.get("input_latency_ms")
    rtt = np.array([(c["detected_ctx_s"] - c["scheduled_ctx_s"]) * 1000.0 for c in detected], dtype=float)
    ref = np.array([c["scheduled_perf_ms"] for c in detected], dtype=float)
    # The loopback measures the whole output path from render time. The offset must use the same
    # reference as the rig channel (``scheduled_perf_ms``, which the kiosk audio engine also logs): with a
    # getOutputTimestamp mapping that reference already contains the reported output latency, so only the
    # remainder is the offset. A mixed or unknown mapping cannot be anchored.
    mapping = aud.get("clock_mapping")
    reported = inp.capture["device"]["audio"].get("output_latency_ms")
    already_mapped: float | None
    if mapping == "current_time":
        already_mapped = 0.0
    elif mapping == "output_timestamp" and reported is not None:
        already_mapped = float(reported)
    else:
        already_mapped = None
    anchored = input_lat is not None and already_mapped is not None
    lat = rtt - float(input_lat) - float(already_mapped or 0.0) if anchored else rtt
    return channel_stats(
        lat,
        ref,
        method="audio_loopback",
        anchored=anchored,
        n_reference=len(clicks),
        missed_rate=(len(clicks) - len(detected)) / len(clicks),
        spurious_rate=0.0,
        period_ms=period,
        sync_uncertainty_ms=None,
        th=th,
    )


def _check(cid: str, value: float | bool | None, op: str, threshold: float | bool) -> dict[str, Any]:
    if value is None:
        passed = False
    elif op == "<=":
        passed = float(value) <= float(threshold)
    elif op == ">=":
        passed = float(value) >= float(threshold)
    else:
        passed = value == threshold
    return {"id": cid, "value": value, "op": op, "threshold": threshold, "passed": bool(passed)}


def acceptance(profile: dict[str, Any], th: Thresholds) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    need_anchor = bool(th.get("require_anchored"))
    limits = {
        "visual": ("sd_frames", th.f("visual.max_sd_frames")),
        "touch": ("sd_ms", th.f("touch.max_sd_ms")),
        "audio": ("sd_ms", th.f("audio.max_sd_ms")),
    }
    for ch, (metric, limit) in limits.items():
        c = profile[ch]
        checks.append(_check(f"{ch}.present", c is not None, "==", True))
        if c is None:
            continue
        checks.append(_check(f"{ch}.n_matched", c["n_matched"], ">=", th.i(f"min_samples.{ch}")))
        checks.append(_check(f"{ch}.{metric}", c[metric], "<=", limit))
        checks.append(_check(f"{ch}.missed_rate", c["missed_rate"], "<=", th.f(f"{ch}.max_missed_rate")))
        if ch == "visual":
            checks.append(_check("visual.spurious_rate", c["spurious_rate"], "<=", th.f("visual.max_spurious_rate")))
        if need_anchor:
            checks.append(_check(f"{ch}.anchored", c["anchored"], "==", True))
        unc = c.get("sync_uncertainty_ms")
        if unc is not None:
            checks.append(_check(f"{ch}.sync_uncertainty_ms", unc, "<=", th.f("sync.max_uncertainty_ms")))
    fr = profile["frames"]
    checks.append(_check("frames.present", fr is not None, "==", True))
    if fr is not None:
        checks.append(_check("frames.n_frames", fr["n_frames"], ">=", th.i("min_samples.frames")))
        checks.append(_check("frames.dropped_rate", fr["dropped_rate"], "<=", th.f("frames.max_dropped_rate")))
        checks.append(_check("frames.interval_sd_ms", fr["interval_sd_ms"], "<=", th.f("frames.max_interval_sd_ms")))
    return {"passed": all(c["passed"] for c in checks), "checks": checks}


def fingerprint(capture: dict[str, Any]) -> dict[str, Any]:
    """Device identity that pins a profile: any SKU, OS, firmware, shell, display or audio-output change
    yields a different fingerprint and therefore a new ``timing_profile_version`` (ENG-02 AC)."""
    d = capture["device"]
    scr = d["screen"]
    return {
        "hardware_sku": d["hardware_sku"],
        "os_build": d["os_build"],
        "firmware": d["firmware"],
        "shell": d["shell"],
        "refresh_hz_nominal": d["refresh_hz_nominal"],
        # Panel geometry: a display swap on the same SKU changes the resolution or pixel ratio.
        "display": f"{scr['width']:g}x{scr['height']:g}@{scr['dpr']:g}",
        "audio_output_device": d["audio"]["output_device"],
    }


def build_profile(inp: Inputs, th: Thresholds, *, created_at: datetime | None = None) -> dict[str, Any]:
    """Analyse every available channel and return a timing-profile.v1 document."""
    cap = inp.capture
    cmap = _clock_map(inp, th)
    raf = cap.get("frames")
    frames = (
        frame_stats(np.array(raf["raf_ms"], dtype=float), cap["device"].get("refresh_hz_nominal"), th) if raf else None
    )
    period = _period(cap, frames)
    visual = analyse_visual(inp, cmap, period, th)
    touch = analyse_touch(inp, cmap, period, visual, th)
    audio = analyse_audio(inp, cmap, period, th)

    inputs = [{"kind": "capture", "name": inp.capture_name, "sha256": inp.capture_sha256}]
    for kind in ("photodiode", "tapper", "camera", "audio_rig", "sync"):
        f: SensorFile | None = getattr(inp, kind)
        if f is not None:
            inputs.append({"kind": kind, "name": f.name, "sha256": f.sha256})
    fp = fingerprint(cap)
    fp_sha = sha256_json(fp)
    data_sha = sha256_json(
        {
            "inputs": sorted((i["kind"], i["sha256"]) for i in inputs),
            "options": {
                "rig_clock": inp.rig_clock,
                "display_offset_ms": inp.display_offset_ms,
                "camera_fps": inp.camera_fps,
            },
            "thresholds_sha256": th.sha256,
            "tool_version": TOOL_VERSION,
        }
    )
    profile: dict[str, Any] = {
        "schema": PROFILE_SCHEMA,
        "timing_profile_version": "",
        "certified": False,
        "hardware_sku": fp["hardware_sku"],
        "device_fingerprint": fp,
        "fingerprint_sha256": fp_sha,
        "data_sha256": data_sha,
        "thresholds_sha256": th.sha256,
        "tool_version": TOOL_VERSION,
        "created_at": (created_at or datetime.now(UTC)).isoformat().replace("+00:00", "Z"),
        "inputs": inputs,
        "visual": visual,
        "touch": touch,
        "audio": audio,
        "frames": frames,
        "acceptance": {"passed": False, "checks": []},
    }
    profile["acceptance"] = acceptance(profile, th)
    certified = bool(profile["acceptance"]["passed"])
    profile["certified"] = certified
    profile["timing_profile_version"] = profile_version(fp["hardware_sku"], fp_sha, data_sha, certified=certified)
    errs = schema_errors("timing-profile.v1.schema.json", profile)
    if errs:  # pragma: no cover - guards the builder against schema drift
        raise AssertionError("built profile fails timing-profile.v1: " + "; ".join(errs))
    return profile


def profile_version(sku: str, fingerprint_sha: str, data_sha: str, *, certified: bool) -> str:
    """``tp-<sku>-<fp8>-<data8>`` when certified, else ``uncertified-<sku>-<fp8>-<data8>``.

    Matches the envelope's ``common.v1#/$defs/identifier`` pattern; the ``uncertified`` prefix is what
    the scoring engine's quality step treats as an uncertified device."""
    prefix = "tp" if certified else "uncertified"
    return f"{prefix}-{sku}-{fingerprint_sha[:8]}-{data_sha[:8]}"


def compare_profiles(base: dict[str, Any], cand: dict[str, Any], th: Thresholds) -> dict[str, Any]:
    """Re-certification / emulator regression: report offset shifts, jitter growth and frame drops."""
    findings: list[dict[str, Any]] = []
    max_shift = th.f("regression.max_offset_shift_ms")
    max_ratio = th.f("regression.max_sd_ratio")
    for ch in ("visual", "touch", "audio"):
        b, c = base.get(ch), cand.get(ch)
        if b is None or c is None:
            if b is not None or c is not None:
                findings.append(
                    {"id": f"{ch}.presence", "regression": True, "detail": "channel missing in one profile"}
                )
            continue
        if b.get("offset_ms") is not None and c.get("offset_ms") is not None:
            shift = float(c["offset_ms"]) - float(b["offset_ms"])
            findings.append(
                {
                    "id": f"{ch}.offset_shift_ms",
                    "value": round(shift, 4),
                    "threshold": max_shift,
                    "regression": abs(shift) > max_shift,
                }
            )
        if b.get("sd_ms") and c.get("sd_ms") is not None:
            ratio = float(c["sd_ms"]) / float(b["sd_ms"])
            findings.append(
                {
                    "id": f"{ch}.sd_ratio",
                    "value": round(ratio, 4),
                    "threshold": max_ratio,
                    "regression": ratio > max_ratio,
                }
            )
    bf, cf = base.get("frames"), cand.get("frames")
    if bf is not None and cf is not None:
        inc = float(cf["dropped_rate"]) - float(bf["dropped_rate"])
        lim = th.f("regression.max_dropped_rate_increase")
        findings.append(
            {"id": "frames.dropped_rate_increase", "value": round(inc, 6), "threshold": lim, "regression": inc > lim}
        )
    same_device = base.get("fingerprint_sha256") == cand.get("fingerprint_sha256")
    return {
        "base": base.get("timing_profile_version"),
        "candidate": cand.get("timing_profile_version"),
        "same_device_fingerprint": same_device,
        "regressed": any(f["regression"] for f in findings),
        "findings": findings,
    }
