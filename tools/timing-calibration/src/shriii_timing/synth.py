"""Synthetic calibration runs with known ground truth (tests, demos, emulator regression).

The generator simulates a vsync-locked display, a rig whose clock runs at an offset and drift from the
page clock, USB ping-pong sync with asymmetric jitter, photodiode / tapper / microphone detections with
misses and spurious edges, a 1 kHz high-speed camera and an AudioContext loopback.
"""

from __future__ import annotations

import csv
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np

from shriii_timing.resources import CAPTURE_FORMAT


@dataclass(frozen=True, slots=True)
class SynthSpec:
    seed: int = 7
    hardware_sku: str = "kiosk-sku-a"
    os_build: str = "ubuntu-core-24.20261001"
    firmware: str = "fw-1.4.2"
    shell: str = "electron-44.9.1"
    output_device: str = "hdmi-0"
    refresh_hz: float = 60.0
    n_visual: int = 1200
    display_offset_ms: float = 18.0
    display_sd_ms: float = 3.0
    n_taps: int = 300
    touch_offset_ms: float = 35.0
    touch_sd_ms: float = 6.0
    n_camera: int = 120
    camera_fps: float = 1000.0
    n_clicks: int = 300
    audio_offset_ms: float = 42.0
    audio_sd_ms: float = 2.5
    input_latency_ms: float = 12.0
    clock_offset_ms: float = 987_654.321
    drift_ppm: float = 40.0
    n_pings: int = 300
    miss_rate: float = 0.002
    spurious_rate: float = 0.002
    n_frames: int = 4000
    frame_drop_rate: float = 0.001
    frame_jitter_sd_ms: float = 0.25
    inject_delay_ms: float = 0.0


@dataclass(slots=True)
class SynthRun:
    spec: SynthSpec
    capture: dict[str, Any]
    photodiode: list[float]
    tapper: list[float]
    camera: list[tuple[int, float, float]]
    audio_rig: list[float]
    sync: list[tuple[float, float, float]]

    def write(self, out: Path) -> dict[str, Path]:
        out.mkdir(parents=True, exist_ok=True)
        paths = {
            "capture": out / "capture.json",
            "photodiode": out / "photodiode.csv",
            "tapper": out / "tapper.csv",
            "camera": out / "camera.csv",
            "audio_rig": out / "audio_rig.csv",
            "sync": out / "sync.csv",
            "truth": out / "truth.json",
        }
        paths["capture"].write_text(json.dumps(self.capture, indent=1) + "\n", encoding="utf-8")
        _write_csv(paths["photodiode"], ["t_ms"], [(round(t, 4),) for t in self.photodiode])
        _write_csv(paths["tapper"], ["t_ms"], [(round(t, 4),) for t in self.tapper])
        _write_csv(
            paths["camera"],
            ["tap_index", "contact_ms", "photon_ms"],
            [(i, round(c, 3), round(p, 3)) for i, c, p in self.camera],
        )
        _write_csv(paths["audio_rig"], ["t_ms"], [(round(t, 4),) for t in self.audio_rig])
        _write_csv(
            paths["sync"],
            ["host_send_ms", "host_recv_ms", "device_ms"],
            [(round(a, 4), round(b, 4), round(c, 4)) for a, b, c in self.sync],
        )
        paths["truth"].write_text(json.dumps(asdict(self.spec), indent=1) + "\n", encoding="utf-8")
        return paths


def _write_csv(path: Path, header: list[str], rows: list[tuple[Any, ...]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


def generate(spec: SynthSpec | None = None) -> SynthRun:
    s = spec or SynthSpec()
    rng = np.random.default_rng(s.seed)
    period = 1000.0 / s.refresh_hz
    phase = float(rng.uniform(0, period))

    def next_frame(t: float) -> float:
        return float(phase + np.ceil((t - phase) / period) * period)

    def to_device(host: float) -> float:
        return s.clock_offset_ms + host * (1.0 + s.drift_ppm * 1e-6)

    def detections(truth_host: list[float]) -> list[float]:
        keep = [to_device(t) for t in truth_host if rng.random() >= s.miss_rate]
        lo, hi = min(truth_host), max(truth_host)
        n_spur = round(s.spurious_rate * len(truth_host))
        keep.extend(to_device(float(rng.uniform(lo, hi))) for _ in range(n_spur))
        return sorted(keep)

    delay = s.inject_delay_ms

    # Visual: flash patch at jittered ISIs; presented = rAF after commit (next vsync).
    t = 1000.0
    trials: list[dict[str, Any]] = []
    pd_truth: list[float] = []
    for i in range(s.n_visual):
        t += float(rng.uniform(250, 450))
        presented = next_frame(t)
        trials.append({"i": i, "requested_ms": round(t, 4), "presented_ms": round(float(presented), 4)})
        pd_truth.append(float(presented) + s.display_offset_ms + delay + float(rng.normal(0, s.display_sd_ms)))
    t_end_visual = t

    # Touch: solenoid contacts; the page flashes the patch on each pointerdown (camera protocol).
    t = t_end_visual + 2000.0
    taps: list[dict[str, Any]] = []
    contacts: list[float] = []
    camera: list[tuple[int, float, float]] = []
    cam_offset = float(rng.uniform(1e5, 2e5))
    cam_q = 1000.0 / s.camera_fps
    for i in range(s.n_taps):
        t += float(rng.uniform(400, 700))
        contact = t
        ev = contact + s.touch_offset_ms + delay + float(rng.normal(0, s.touch_sd_ms))
        handler = ev + float(rng.uniform(0.5, 3.0))
        flash = float(next_frame(handler + 1.0))
        taps.append(
            {
                "i": i,
                "event_ts_ms": round(ev, 4),
                "handler_ms": round(handler, 4),
                "flash_presented_ms": round(flash, 4),
                "x": round(float(rng.uniform(0.4, 0.6)), 4),
                "y": round(float(rng.uniform(0.4, 0.6)), 4),
            }
        )
        contacts.append(contact)
        if i < s.n_camera:
            photon = flash + s.display_offset_ms + delay + float(rng.normal(0, s.display_sd_ms))
            c_cam = np.round((contact + cam_offset) / cam_q) * cam_q
            p_cam = np.round((photon + cam_offset) / cam_q) * cam_q
            camera.append((i, float(c_cam), float(p_cam)))
    t_end_touch = t

    # Audio: clicks scheduled on the AudioContext; rig mic and in-page loopback.
    t = t_end_touch + 2000.0
    ctx_origin = t - 500.0
    clicks: list[dict[str, Any]] = []
    mic_truth: list[float] = []
    for i in range(s.n_clicks):
        t += float(rng.uniform(300, 600))
        out_lat = s.audio_offset_ms + delay + float(rng.normal(0, s.audio_sd_ms))
        mic_truth.append(t + out_lat)
        detected = (t - ctx_origin + out_lat + s.input_latency_ms + float(rng.normal(0, 0.3))) / 1000.0
        clicks.append(
            {
                "i": i,
                "scheduled_ctx_s": round((t - ctx_origin) / 1000.0, 7),
                "scheduled_perf_ms": round(t, 4),
                "detected_ctx_s": round(detected, 7),
            }
        )

    # Frames: rAF timestamps with jitter and occasional dropped frames.
    raf: list[float] = []
    ft = phase + 50 * period
    for _ in range(s.n_frames):
        raf.append(round(ft + float(rng.normal(0, s.frame_jitter_sd_ms)), 4))
        ft += 2 * period if rng.random() < s.frame_drop_rate else period

    # Clock sync: ping-pong over USB with asymmetric one-way delays.
    sync: list[tuple[float, float, float]] = []
    ts = 500.0
    span = t + 1000.0
    for _ in range(s.n_pings):
        ts += span / s.n_pings
        up = 0.4 + float(rng.exponential(0.6))
        down = 0.4 + float(rng.exponential(0.6))
        sync.append((ts, ts + up + down, to_device(ts + up)))

    capture: dict[str, Any] = {
        "format": CAPTURE_FORMAT,
        "tool_version": "synth-0.1.0",
        "created_at": "2026-10-22T00:00:00Z",
        "device": {
            "hardware_sku": s.hardware_sku,
            "os_build": s.os_build,
            "firmware": s.firmware,
            "shell": s.shell,
            "user_agent": "synthetic",
            "refresh_hz_nominal": s.refresh_hz,
            "screen": {"width": 1920, "height": 1080, "dpr": 1},
            "audio": {
                "sample_rate": 48000,
                "base_latency_ms": 5.3,
                "output_latency_ms": 30.0,
                "output_device": s.output_device,
            },
        },
        "visual": {"patch": {"x": 0, "y": 0, "size": 120}, "flash_frames": 3, "trials": trials},
        "touch": {"taps": taps},
        "audio": {"input_latency_ms": s.input_latency_ms, "clicks": clicks},
        "frames": {"raf_ms": raf},
        "sync": None,
    }
    return SynthRun(
        spec=s,
        capture=capture,
        photodiode=detections(pd_truth),
        tapper=detections(contacts),
        camera=camera,
        audio_rig=detections(mic_truth),
        sync=sync,
    )
