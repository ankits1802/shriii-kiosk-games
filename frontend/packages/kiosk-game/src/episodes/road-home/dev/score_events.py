"""Score a Road Home bot run with the layer-2 indicator engine (``stats/scoring``).

Usage (from the repository root)::

    python -m uv run python frontend/packages/kiosk-game/src/episodes/road-home/dev/score_events.py <export_dir>

Add ``--software-gl`` for a headless-browser capture (see ``relabel_software_gl``).

``<export_dir>`` holds ``events.ndjson`` (one EventEnvelope per line) and ``trial_params.json``
(``session_id -> trial_id -> GameTrialSpec.params``), as written by the headless test
(``ROAD_HOME_EXPORT_DIR``) or the browser bot run (``dev/bot-run.mjs``).

Exit status 0 only when every indicator sourced from ``road_home`` in ``dictionary.A.yaml`` is
computable from the events: status ``ok`` with a finite value (the single-event partner-error
indicator may legitimately be ``unscorable_individual``; model-based ones are produced by the batch
step and need a cohort, so a single session reports them without a value).
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

from shriii_scoring.dictionary import load_dictionary
from shriii_scoring.engine import IndicatorEngine

# Indicators whose value is produced by the cohort-level batch model (partial pooling) or that are
# single scripted events: a lone session cannot yield a finite value for them by design.
COHORT_OR_SINGLE = {
    "stability.shift_slope",
    "stability.shift_slope_reversal",
    "response_consistency.loc_scale_sigma",
}


SOFTWARE_GL_FLAGS = {"late_onset", "uncertified_timing_profile"}


def relabel_software_gl(events: list[dict[str, Any]]) -> int:
    """Dev-only: a headless Chromium capture renders through SwiftShader, so every onset is flagged
    ``late_onset`` / ``uncertified_timing_profile`` and the session-quality gate (correctly) excludes
    it. To check *computability* of the indicators from a browser capture, relabel exactly those two
    renderer flags as ``ok``; nothing else (latencies, payloads, order) is touched."""
    n = 0
    for e in events:
        timing = e.get("timing") or {}
        if timing.get("timing_flag") in SOFTWARE_GL_FLAGS:
            timing["timing_flag"] = "ok"
            n += 1
    return n


def main(export_dir: str, software_gl: bool = False) -> int:
    base = Path(export_dir)
    events: list[dict[str, Any]] = [
        json.loads(line) for line in (base / "events.ndjson").read_text(encoding="utf-8").splitlines() if line
    ]
    if software_gl:
        print(f"[software-gl] relabelled {relabel_software_gl(events)} renderer timing flags as ok")
    params = json.loads((base / "trial_params.json").read_text(encoding="utf-8"))
    engine = IndicatorEngine(pathways=("A",), allow_synthetic=True)
    result = engine.score(events, params)
    dictionary = load_dictionary("A")
    road = {
        i.id: i
        for i in dictionary.indicators.values()
        if i.module_id in ("road_home", "cross_episode")
    }
    rows = {r.indicator_id: r for r in result.rows}
    failures: list[str] = []
    print(f"{'indicator':52s} {'status':22s} {'n':>4s}  value")
    for ind_id in sorted(road):
        r = rows.get(ind_id)
        if r is None:
            failures.append(f"{ind_id}: no row")
            print(f"{ind_id:52s} {'(missing)':22s}")
            continue
        val = r.value
        shown = "-" if val is None else f"{val:.4f}"
        print(f"{ind_id:52s} {r.status:22s} {r.n_valid:>4}  {shown}  {','.join(r.flags)}")
        spec = road[ind_id]
        if spec.module_id != "road_home":
            continue  # cross-episode pools need the other episodes
        if ind_id in COHORT_OR_SINGLE:
            if r.status in ("error",):
                failures.append(f"{ind_id}: {r.status}")
            continue
        if ind_id == "teamwork.response_to_partner_error":
            if r.status not in ("ok", "unscorable_individual") or (r.status == "ok" and (val is None or not math.isfinite(val))):
                failures.append(f"{ind_id}: {r.status} {val}")
            continue
        if r.status != "ok" or val is None or not math.isfinite(val):
            failures.append(f"{ind_id}: {r.status} value={val} flags={r.flags}")
    print()
    if engine.consistency_warnings:
        print("consistency warnings (dictionary/content, informational):")
        for w in engine.consistency_warnings:
            if "road_home" in w:
                print("  ", w)
    if failures:
        print("\nNOT COMPUTABLE:")
        for f in failures:
            print("  ", f)
        return 1
    print("\nAll road_home indicators are computable from the emitted events.")
    return 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    sys.exit(main(args[0] if args else ".", software_gl="--software-gl" in sys.argv[1:]))
