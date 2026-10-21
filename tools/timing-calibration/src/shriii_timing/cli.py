"""``shriii-timing`` command line.

    shriii-timing analyse --capture cap.json --photodiode pd.csv --tapper tap.csv --audio-rig mic.csv \
        --sync sync.csv --out profile.json
    shriii-timing compare baseline.json candidate.json
    shriii-timing validate profile.json
    shriii-timing synth --out demo/ [--inject-delay-ms 50]

Exit codes: 0 ok / certified / no regression; 1 input error; 3 not certified; 4 regression detected.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

from shriii_timing.profile import Inputs, SensorFile, build_profile, compare_profiles
from shriii_timing.resources import InputError, load_capture, load_thresholds, read_csv_columns, schema_errors
from shriii_timing.synth import SynthSpec, generate

SENSOR_COLUMNS: dict[str, tuple[str, ...]] = {
    "photodiode": ("t_ms",),
    "tapper": ("t_ms",),
    "camera": ("tap_index",),
    "audio_rig": ("t_ms",),
    "sync": ("host_send_ms", "host_recv_ms", "device_ms"),
}


def _sensor(path: str | None, kind: str) -> SensorFile | None:
    if path is None:
        return None
    p = Path(path)
    cols, sha = read_csv_columns(p, SENSOR_COLUMNS[kind])
    if kind == "camera":
        has_ms = {"contact_ms", "photon_ms"} <= cols.keys()
        has_frames = {"contact_frame", "photon_frame"} <= cols.keys()
        if not (has_ms or has_frames):
            raise InputError(f"{p}: camera CSV needs contact_ms/photon_ms or contact_frame/photon_frame")
    return SensorFile(name=p.name, sha256=sha, columns=cols)


def _fmt(v: Any) -> str:
    return "-" if v is None else f"{v:g}" if isinstance(v, float) else str(v)


def _summary(profile: dict[str, Any]) -> str:
    lines = [f"timing_profile_version: {profile['timing_profile_version']}", f"certified: {profile['certified']}"]
    for ch in ("visual", "touch", "audio"):
        c = profile[ch]
        if c is None:
            lines.append(f"  {ch:<7} (not measured)")
            continue
        lines.append(
            f"  {ch:<7} {c['method']:<18} n={c['n_matched']:<5} anchored={c['anchored']!s:<5} "
            f"offset={_fmt(c['offset_ms'])} ms  sd={_fmt(c['sd_ms'])} ms  missed={c['missed_rate']:.3%}  "
            f"confidence={c['confidence']}"
        )
    fr = profile["frames"]
    if fr:
        lines.append(
            f"  frames  {fr['refresh_hz']:g} Hz  n={fr['n_frames']}  interval sd={fr['interval_sd_ms']:g} ms  "
            f"dropped={fr['dropped_frames']} ({fr['dropped_rate']:.3%})"
        )
    failed = [c for c in profile["acceptance"]["checks"] if not c["passed"]]
    for c in failed:
        lines.append(f"  FAIL {c['id']}: {_fmt(c['value'])} {c['op']} {_fmt(c['threshold'])}")
    return "\n".join(lines)


def cmd_analyse(a: argparse.Namespace) -> int:
    capture, cap_sha = load_capture(Path(a.capture))
    th = load_thresholds(Path(a.thresholds) if a.thresholds else None)
    inp = Inputs(
        capture=capture,
        capture_name=Path(a.capture).name,
        capture_sha256=cap_sha,
        photodiode=_sensor(a.photodiode, "photodiode"),
        tapper=_sensor(a.tapper, "tapper"),
        camera=_sensor(a.camera, "camera"),
        audio_rig=_sensor(a.audio_rig, "audio_rig"),
        sync=_sensor(a.sync, "sync"),
        rig_clock=a.rig_clock,
        display_offset_ms=a.display_offset_ms,
        camera_fps=a.camera_fps,
    )
    profile = build_profile(inp, th)
    text = json.dumps(profile, indent=2) + "\n"
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    print(_summary(profile), file=sys.stderr)
    return 0 if profile["certified"] else 3


def _load_profile(path: str) -> dict[str, Any]:
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    errs = schema_errors("timing-profile.v1.schema.json", doc)
    if errs:
        raise InputError(f"{path}: not a timing-profile.v1 document:\n  " + "\n  ".join(errs[:20]))
    if not isinstance(doc, dict):
        raise InputError(f"{path}: not an object")
    return doc


def cmd_compare(a: argparse.Namespace) -> int:
    th = load_thresholds(Path(a.thresholds) if a.thresholds else None)
    result = compare_profiles(_load_profile(a.baseline), _load_profile(a.candidate), th)
    print(json.dumps(result, indent=2))
    return 4 if result["regressed"] else 0


def cmd_validate(a: argparse.Namespace) -> int:
    profile = _load_profile(a.profile)
    print(_summary(profile))
    return 0


def cmd_synth(a: argparse.Namespace) -> int:
    spec = replace(SynthSpec(), seed=a.seed, inject_delay_ms=a.inject_delay_ms, firmware=a.firmware)
    paths = generate(spec).write(Path(a.out))
    for k, p in paths.items():
        print(f"{k}: {p}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="shriii-timing", description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    an = sub.add_parser("analyse", help="build a timing profile from a page capture and sensor CSVs")
    an.add_argument("--capture", required=True, help="capture JSON exported by the calibration page")
    an.add_argument("--photodiode", help="CSV t_ms: photodiode rising edges (rig clock)")
    an.add_argument("--tapper", help="CSV t_ms: solenoid contact times (rig clock)")
    an.add_argument("--camera", help="CSV tap_index + contact_ms/photon_ms (or *_frame with --camera-fps)")
    an.add_argument("--camera-fps", type=float, default=None)
    an.add_argument("--audio-rig", help="CSV t_ms: microphone onset times (rig clock)")
    an.add_argument("--sync", help="CSV host_send_ms,host_recv_ms,device_ms ping-pong pairs (else capture.sync)")
    an.add_argument(
        "--rig-clock",
        choices=("device", "host"),
        default="device",
        help="'host' when the rig CSVs are already on the page clock",
    )
    an.add_argument("--display-offset-ms", type=float, default=None, help="known display offset (camera protocol)")
    an.add_argument("--thresholds", help="acceptance thresholds YAML (default config/thresholds.yaml)")
    an.add_argument("--out", help="write the profile here (default stdout)")
    an.set_defaults(fn=cmd_analyse)

    cp = sub.add_parser("compare", help="regression check of a candidate profile against a baseline")
    cp.add_argument("baseline")
    cp.add_argument("candidate")
    cp.add_argument("--thresholds")
    cp.set_defaults(fn=cmd_compare)

    va = sub.add_parser("validate", help="schema-check a profile and print its summary")
    va.add_argument("profile")
    va.set_defaults(fn=cmd_validate)

    sy = sub.add_parser("synth", help="write a synthetic calibration run with known truth")
    sy.add_argument("--out", required=True)
    sy.add_argument("--seed", type=int, default=7)
    sy.add_argument("--inject-delay-ms", type=float, default=0.0)
    sy.add_argument("--firmware", default=SynthSpec().firmware)
    sy.set_defaults(fn=cmd_synth)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        rc: int = args.fn(args)
    except (InputError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return rc


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
