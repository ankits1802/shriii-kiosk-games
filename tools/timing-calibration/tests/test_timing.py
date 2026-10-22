"""Synthetic-truth tests for the timing calibration analysis (ENG-01 / ENG-02)."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from shriii_timing.analysis import align_and_match, fit_clock_sync, frame_stats
from shriii_timing.cli import main
from shriii_timing.profile import Inputs, SensorFile, build_profile, compare_profiles, profile_version
from shriii_timing.resources import TOOL_ROOT, Thresholds, load_thresholds, schema_errors, sha256_json
from shriii_timing.synth import SynthRun, SynthSpec, generate

FIXED = datetime(2026, 10, 22, tzinfo=UTC)


@pytest.fixture(scope="module")
def th() -> Thresholds:
    return load_thresholds()


@pytest.fixture(scope="module")
def run() -> SynthRun:
    return generate(SynthSpec())


def _sensor(name: str, cols: dict[str, list[float]]) -> SensorFile:
    return SensorFile(name=name, sha256=sha256_json(cols), columns=cols)


def _inputs(run: SynthRun, *, sync: bool = True, camera: bool = False, **kw: Any) -> Inputs:
    cap = run.capture
    return Inputs(
        capture=cap,
        capture_name="capture.json",
        capture_sha256=sha256_json(cap),
        photodiode=_sensor("pd.csv", {"t_ms": run.photodiode}),
        tapper=None if camera else _sensor("tap.csv", {"t_ms": run.tapper}),
        camera=_sensor(
            "cam.csv",
            {
                "tap_index": [float(c[0]) for c in run.camera],
                "contact_ms": [c[1] for c in run.camera],
                "photon_ms": [c[2] for c in run.camera],
            },
        )
        if camera
        else None,
        audio_rig=_sensor("mic.csv", {"t_ms": run.audio_rig}),
        sync=_sensor(
            "sync.csv",
            {
                "host_send_ms": [s[0] for s in run.sync],
                "host_recv_ms": [s[1] for s in run.sync],
                "device_ms": [s[2] for s in run.sync],
            },
        )
        if sync
        else None,
        **kw,
    )


@pytest.fixture(scope="module")
def profile(run: SynthRun, th: Thresholds) -> dict[str, Any]:
    return build_profile(_inputs(run), th, created_at=FIXED)


# ------------------------------------------------------------------------------------------ building blocks


def test_clock_sync_recovers_offset_and_drift(run: SynthRun, th: Thresholds) -> None:
    send, recv, dev = (np.array([s[i] for s in run.sync]) for i in range(3))
    cmap = fit_clock_sync(send, recv, dev, th.f("sync.keep_rtt_quantile"))
    assert cmap.drift_ppm == pytest.approx(run.spec.drift_ppm, abs=2.0)
    host = np.array([1000.0, 50_000.0, 400_000.0])
    expected = run.spec.clock_offset_ms + host * (1 + run.spec.drift_ppm * 1e-6)
    np.testing.assert_allclose(cmap.to_host(expected), host, atol=0.5)
    assert cmap.uncertainty_ms < th.f("sync.max_uncertainty_ms")


def test_clock_sync_needs_samples() -> None:
    with pytest.raises(ValueError, match="at least 3"):
        fit_clock_sync(np.array([1.0]), np.array([2.0]), np.array([3.0]), 0.25)


def test_matching_handles_misses_and_spurious(th: Thresholds) -> None:
    rng = np.random.default_rng(1)
    ref = np.cumsum(rng.uniform(250, 450, 500))
    obs = ref + 20 + rng.normal(0, 2, ref.size)
    obs = np.delete(obs, [3, 77, 300])
    obs = np.sort(np.concatenate([obs, [ref[10] + 150, ref[200] + 170]]))
    m, used = align_and_match(ref, obs, anchored=True, th=th)
    assert m.n_matched == 497
    assert m.missed_rate == pytest.approx(3 / 500)
    assert m.spurious_rate == pytest.approx(2 / 500)
    assert float(np.mean(used[m.obs_idx] - ref[m.ref_idx])) == pytest.approx(20, abs=0.5)


def test_unanchored_matching_absorbs_clock_offset_and_drift(th: Thresholds) -> None:
    rng = np.random.default_rng(2)
    ref = np.cumsum(rng.uniform(250, 450, 800))
    obs = 5e6 + (ref + 15 + rng.normal(0, 1.5, ref.size)) * (1 + 80e-6)
    m, _ = align_and_match(ref, obs, anchored=False, th=th)
    assert m.n_matched == 800


def test_frame_stats_counts_dropped_frames(th: Thresholds) -> None:
    period = 1000 / 60
    intervals = np.full(5000, period)
    intervals[[100, 2000]] = 2 * period  # one dropped frame each
    intervals[3000] = 4 * period  # three dropped frames
    raf = np.concatenate([[0.0], np.cumsum(intervals)])
    fr = frame_stats(raf, 60.0, th)
    assert fr is not None
    assert fr["dropped_frames"] == 5
    assert fr["long_frames"] == 3
    assert fr["refresh_hz"] == pytest.approx(60.0, abs=1e-6)
    assert fr["interval_sd_ms"] == pytest.approx(0.0, abs=1e-9)


# ------------------------------------------------------------------------------------------ profile


def test_profile_recovers_planted_offsets(profile: dict[str, Any], run: SynthRun) -> None:
    s = run.spec
    assert profile["visual"]["offset_ms"] == pytest.approx(s.display_offset_ms, abs=0.6)
    assert profile["visual"]["sd_ms"] == pytest.approx(s.display_sd_ms, rel=0.15)
    assert profile["touch"]["offset_ms"] == pytest.approx(s.touch_offset_ms, abs=1.5)
    assert profile["touch"]["sd_ms"] == pytest.approx(s.touch_sd_ms, rel=0.2)
    assert profile["audio"]["offset_ms"] == pytest.approx(s.audio_offset_ms, abs=0.8)
    assert profile["audio"]["sd_ms"] == pytest.approx(s.audio_sd_ms, rel=0.2)
    for ch in ("visual", "touch", "audio"):
        lo, hi = profile[ch]["offset_ci95_ms"]
        assert lo <= profile[ch]["offset_ms"] <= hi
        assert profile[ch]["anchored"] is True
        assert profile[ch]["confidence"] in {"high", "medium"}


def test_profile_is_certified_and_schema_valid(profile: dict[str, Any]) -> None:
    assert schema_errors("timing-profile.v1.schema.json", profile) == []
    assert profile["certified"] is True
    assert profile["acceptance"]["passed"] is True
    assert profile["timing_profile_version"].startswith("tp-kiosk-sku-a-")


def test_version_matches_contract_identifier_pattern(profile: dict[str, Any]) -> None:
    """The version goes into versions.timing_profile_version of every event (common.v1 identifier)."""
    common = TOOL_ROOT.parents[1] / "contracts" / "schemas" / "common.v1.schema.json"
    pattern = json.loads(common.read_text(encoding="utf-8"))["$defs"]["identifier"]["pattern"]
    assert re.fullmatch(pattern, profile["timing_profile_version"])
    assert re.fullmatch(pattern, profile_version("a" * 64, "f" * 64, "e" * 64, certified=False))


def test_profile_is_deterministic(run: SynthRun, th: Thresholds, profile: dict[str, Any]) -> None:
    again = build_profile(_inputs(run), th, created_at=FIXED)
    assert again == profile


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("firmware",), "fw-1.4.3"),
        (("os_build",), "os-2.0.1"),
        (("shell",), "electron-99"),
        (("screen", "width"), 1280),
        (("audio", "output_device"), "usb-dac"),
    ],
)
def test_device_change_creates_new_version(
    run: SynthRun, th: Thresholds, profile: dict[str, Any], path: tuple[str, ...], value: Any
) -> None:
    cap = json.loads(json.dumps(run.capture))
    node = cap["device"]
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    other = build_profile(replace(_inputs(run), capture=cap), th, created_at=FIXED)
    assert other["fingerprint_sha256"] != profile["fingerprint_sha256"]
    assert other["timing_profile_version"] != profile["timing_profile_version"]


def test_unanchored_run_is_not_certified(run: SynthRun, th: Thresholds) -> None:
    p = build_profile(_inputs(run, sync=False), th, created_at=FIXED)
    assert p["visual"]["anchored"] is False
    assert p["visual"]["offset_ms"] is None
    # Jitter is still measured without a sync.
    assert p["visual"]["sd_ms"] == pytest.approx(run.spec.display_sd_ms, rel=0.15)
    assert p["certified"] is False
    assert p["timing_profile_version"].startswith("uncertified-")
    failed = {c["id"] for c in p["acceptance"]["checks"] if not c["passed"]}
    assert {"visual.anchored", "touch.anchored", "audio.anchored"} <= failed


def test_host_clock_rig_is_anchored_without_sync(th: Thresholds) -> None:
    run = generate(SynthSpec(clock_offset_ms=0.0, drift_ppm=0.0, seed=3))
    p = build_profile(_inputs(run, sync=False, rig_clock="host"), th, created_at=FIXED)
    assert p["visual"]["anchored"] is True
    assert p["visual"]["offset_ms"] == pytest.approx(run.spec.display_offset_ms, abs=0.6)


def test_excess_jitter_fails_acceptance(th: Thresholds) -> None:
    run = generate(SynthSpec(display_sd_ms=25.0, touch_sd_ms=30.0, seed=4))
    p = build_profile(_inputs(run), th, created_at=FIXED)
    failed = {c["id"] for c in p["acceptance"]["checks"] if not c["passed"]}
    assert "visual.sd_frames" in failed
    assert "touch.sd_ms" in failed
    assert p["certified"] is False


def test_camera_protocol_uses_display_offset(run: SynthRun, th: Thresholds) -> None:
    p = build_profile(_inputs(run, camera=True), th, created_at=FIXED)
    t = p["touch"]
    assert t["method"] == "high_speed_camera"
    assert t["anchored"] is True
    # Camera quantisation (1 ms) and display jitter widen the SD; the offset is still recovered.
    assert t["offset_ms"] == pytest.approx(run.spec.touch_offset_ms, abs=2.5)
    assert t["n_matched"] == run.spec.n_camera


def test_audio_loopback_without_rig(run: SynthRun, th: Thresholds) -> None:
    inp = replace(_inputs(run), audio_rig=None)
    a = build_profile(inp, th, created_at=FIXED)["audio"]
    assert a["method"] == "audio_loopback"
    assert a["offset_ms"] == pytest.approx(run.spec.audio_offset_ms, abs=0.8)


@pytest.mark.parametrize("output_timestamp", [False, True])
def test_audio_rig_and_loopback_share_one_reference(th: Thresholds, output_timestamp: bool) -> None:
    """Rig and loopback offsets must agree whichever AudioContext -> page clock mapping the page used."""
    spec = SynthSpec(output_timestamp_mapping=output_timestamp, n_visual=50, n_taps=30, n_camera=10)
    r = generate(spec)
    inp = _inputs(r)
    rig = build_profile(inp, th, created_at=FIXED)["audio"]
    loop = build_profile(replace(inp, audio_rig=None), th, created_at=FIXED)["audio"]
    assert rig["method"] == "audio_rig" and loop["method"] == "audio_loopback"
    assert loop["anchored"] is True
    expected = spec.audio_offset_ms - (spec.reported_output_latency_ms if output_timestamp else 0.0)
    assert rig["offset_ms"] == pytest.approx(expected, abs=0.8)
    assert loop["offset_ms"] == pytest.approx(expected, abs=0.8)


def test_mixed_audio_mapping_is_unanchored(run: SynthRun, th: Thresholds) -> None:
    cap = json.loads(json.dumps(run.capture))
    cap["audio"]["clock_mapping"] = "mixed"
    a = build_profile(replace(_inputs(run), capture=cap, audio_rig=None), th, created_at=FIXED)["audio"]
    assert a["anchored"] is False
    assert a["offset_ms"] is None


def test_missing_channels_fail_presence(run: SynthRun, th: Thresholds) -> None:
    cap = json.loads(json.dumps(run.capture))
    cap["audio"] = None
    cap["frames"] = None
    p = build_profile(replace(_inputs(run), capture=cap), th, created_at=FIXED)
    failed = {c["id"] for c in p["acceptance"]["checks"] if not c["passed"]}
    assert {"audio.present", "frames.present"} <= failed


# ------------------------------------------------------------------------------------------ regression


def test_emulator_regression_detects_injected_50ms_delay(profile: dict[str, Any], th: Thresholds) -> None:
    delayed = generate(SynthSpec(inject_delay_ms=50.0))
    cand = build_profile(_inputs(delayed), th, created_at=FIXED)
    result = compare_profiles(profile, cand, th)
    assert result["regressed"] is True
    shifts = {f["id"]: f for f in result["findings"]}
    assert shifts["visual.offset_shift_ms"]["value"] == pytest.approx(50, abs=1.5)
    assert shifts["visual.offset_shift_ms"]["regression"] is True


def test_rerun_on_same_device_is_not_a_regression(profile: dict[str, Any], th: Thresholds) -> None:
    rerun = build_profile(_inputs(generate(SynthSpec(seed=99))), th, created_at=FIXED)
    result = compare_profiles(profile, rerun, th)
    assert result["regressed"] is False
    assert result["same_device_fingerprint"] is True


# ------------------------------------------------------------------------------------------ CLI


def test_cli_end_to_end(tmp_path: Path) -> None:
    demo = tmp_path / "demo"
    assert main(["synth", "--out", str(demo)]) == 0
    files = {k: str(demo / f"{k}.csv") for k in ("photodiode", "tapper", "audio_rig", "sync")}
    out = tmp_path / "profile.json"
    rc = main(
        [
            "analyse",
            "--capture",
            str(demo / "capture.json"),
            "--photodiode",
            files["photodiode"],
            "--tapper",
            files["tapper"],
            "--audio-rig",
            files["audio_rig"],
            "--sync",
            files["sync"],
            "--out",
            str(out),
        ]
    )
    assert rc == 0
    assert main(["validate", str(out)]) == 0
    assert main(["compare", str(out), str(out)]) == 0

    delayed = tmp_path / "delayed"
    assert main(["synth", "--out", str(delayed), "--inject-delay-ms", "50"]) == 0
    out2 = tmp_path / "delayed.json"
    args = ["analyse", "--capture", str(delayed / "capture.json"), "--out", str(out2)]
    for k in ("photodiode", "tapper", "audio_rig", "sync"):
        args += [f"--{k.replace('_', '-')}", str(delayed / f"{k}.csv")]
    assert main(args) == 0
    assert main(["compare", str(out), str(out2)]) == 4


def test_cli_rejects_bad_capture(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"format": "nope"}), encoding="utf-8")
    assert main(["analyse", "--capture", str(bad)]) == 1


def test_cli_rejects_csv_without_columns(tmp_path: Path, run: SynthRun) -> None:
    cap = tmp_path / "capture.json"
    cap.write_text(json.dumps(run.capture), encoding="utf-8")
    pd = tmp_path / "pd.csv"
    pd.write_text("# rig v2\ntime\n1.0\n", encoding="utf-8")
    assert main(["analyse", "--capture", str(cap), "--photodiode", str(pd)]) == 1


def test_thresholds_file_holds_plan_acceptance_values(th: Thresholds) -> None:
    assert th.f("visual.max_sd_frames") == 1.0
    assert th.f("touch.max_sd_ms") == 15.0
    assert th.f("audio.max_sd_ms") == 10.0
    assert th.i("min_samples.visual") == 1000
