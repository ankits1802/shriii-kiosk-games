"""Score exported Stall sessions with the Python indicator engine (layer 2) and check every indicator.

Usage (from the repository root, after the vitest export):

    python -m uv run python frontend/packages/kiosk-game/src/episodes/stall/dev/score_events.py <export dir>
        [--assume-certified-device]

Reads ``stall_events.ndjson`` (raw events, layer 1) and ``stall_trial_params.json`` (session -> trial ->
``GameTrialSpec.params`` as the module used them), validates every event against the contract
(``shriii_contracts``), runs :class:`shriii_scoring.engine.IndicatorEngine` for Pathway A and asserts that
each Stall indicator of ``dictionary.A.yaml`` is computable from the module's events:

* session-level indicators: status ``ok`` with a value for every session;
* model-based (batch) indicators: status ``ok`` for every session once the partition has enough persons;
* cross-episode indicators that need Weighing Post / Road Home trials are reported, not failed.

Exit code 1 when any Stall-only indicator cannot be computed.

``--assume-certified-device`` (browser playthroughs only): headless Chromium renders in software on an
uncertified dev profile, so every event honestly carries ``uncertified_timing_profile`` or ``late_onset``
and the session-quality gate excludes the session. The switch rewrites only those two device-timing flags
to ``ok`` (in memory) to check that the module's indicator inputs are complete; it says nothing about data
quality, which only a certified kiosk can give.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from shriii_contracts import parse_event
from shriii_scoring.engine import IndicatorEngine
from shriii_scoring.formulas.base import REGISTRY

# Indicators whose task pools other episodes (they need weighing_post / road_home trials or the
# cross-episode probe set to reach their minimum); reported for information only.
CROSS_EPISODE_TASK_PREFIXES = ("cross_episode.",)

# Indicators the module's events support but the frozen-draft dictionary blocks (reported to the
# scoring-dictionary owner; verified computable with the proposed amendment).
KNOWN_DICTIONARY_ISSUES = {
    "expressive_restraint.iti_rvi": (
        "phases [main] select only the 20 service trials, below min_valid_trials 30 (basis val02_pending); "
        "add `pressure` to the phases or lower the minimum"
    ),
    "stability.shift_slope_rude_run": (
        "phases [shift_pre, shift_post] drop the pre-shift tone_calm block (config phase main), so the slope "
        "has no pre-shift contrast; add `main` to the phases (computable then: status ok for every session)"
    ),
}


def load(export_dir: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    events = [json.loads(line) for line in (export_dir / "stall_events.ndjson").read_text("utf8").splitlines() if line]
    params = json.loads((export_dir / "stall_trial_params.json").read_text("utf8"))
    return events, params


def validate_contract(events: list[dict[str, Any]]) -> list[str]:
    """Validate every event with the Pydantic contract models (same JSON Schema as the kiosk's Ajv)."""
    problems: list[str] = []
    for e in events:
        try:
            parse_event(e, strict=True)
        except Exception as exc:
            problems.append(f"{e.get('event_type')} seq={e.get('seq')}: {str(exc).splitlines()[0]}")
    return problems


DEVICE_TIMING_FLAGS = ("uncertified_timing_profile", "late_onset")


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    assume_certified = "--assume-certified-device" in argv
    if len(args) != 1:
        print(__doc__)
        return 2
    events, params = load(Path(args[0]))
    if assume_certified:
        n = 0
        for e in events:
            timing = e.get("timing") or {}
            if timing.get("timing_flag") in DEVICE_TIMING_FLAGS:
                timing["timing_flag"] = "ok"
                n += 1
        print(f"--assume-certified-device: {n} device-timing flags set to ok (input completeness check only)")
    sessions = {e["session_id"] for e in events}
    print(f"{len(events)} events, {len(sessions)} sessions")
    problems = validate_contract(events)
    if problems:
        print(f"CONTRACT: {len(problems)} invalid events, e.g. {problems[:5]}")
        return 1
    print("CONTRACT: every event validates against EventEnvelope")

    engine = IndicatorEngine(pathways=("A",), allow_synthetic=True, on_missing_params="raise")
    for w in engine.consistency_warnings:
        if "stall" in w:
            print("consistency:", w)
    result = engine.score(events, params)
    # Session quality (SCR-12): an excluded session explains every `session_excluded` row below.
    grades = Counter(q.grade for q in result.quality.values())
    print("session quality:", dict(grades))
    for q in result.quality.values():
        if q.flags:
            print(f"  {q.session_id}: grade {q.grade}, flags {list(q.flags)}, details {dict(q.details)}")
    dictionary = engine.dictionaries["A"]
    stall_ids = sorted(i.id for i in dictionary.indicators.values() if i.module_id == "stall" or "stall" in i.task)
    batch_ids = {i for i in stall_ids if REGISTRY[dictionary.indicators[i].formula_ref].kind == "batch"}
    rows = defaultdict(list)
    for r in result.rows:
        if r.indicator_id in stall_ids:
            rows[r.indicator_id].append(r)

    failed: list[str] = []
    print(f"\n{'indicator':52s} {'task':30s} status (n sessions)        mean value   mean n_valid")
    for ind in stall_ids:
        spec = dictionary.indicators[ind]
        rs = rows.get(ind, [])
        statuses = Counter(r.status for r in rs)
        vals = [r.value for r in rs if r.value is not None]
        nvalid = [r.n_valid for r in rs]
        mean_v = f"{sum(vals) / len(vals):10.4f}" if vals else "      none"
        mean_n = f"{sum(nvalid) / len(nvalid):8.1f}" if nvalid else "    none"
        status_txt = ", ".join(f"{k}:{v}" for k, v in sorted(statuses.items()))
        cross = spec.task.startswith(CROSS_EPISODE_TASK_PREFIXES)
        ok = statuses.get("ok", 0) == len(sessions) and len(vals) == len(sessions)
        batch_single = len(sessions) < 20 and statuses.get("model_failed", 0) == len(sessions) and ind in batch_ids
        if ok:
            flag = ""
        elif batch_single:
            flag = "  (model-based: needs >= models.min_persons sessions; events are complete)"
        elif ind in KNOWN_DICTIONARY_ISSUES:
            flag = f"  (dictionary: {KNOWN_DICTIONARY_ISSUES[ind]})"
        elif cross:
            flag = "  (cross-episode: needs other episodes)"
        else:
            flag = "  <-- NOT COMPUTABLE"
        print(f"{ind:52s} {spec.task:30s} {status_txt:26s} {mean_v}   {mean_n}{flag}")
        if flag.endswith("NOT COMPUTABLE"):
            flags = Counter(f for r in rs for f in r.flags)
            print(f"    flags: {dict(flags)}")
            failed.append(ind)
    if failed:
        print(f"\nFAILED: {len(failed)} Stall indicators not computable: {failed}")
        return 1
    print("\nOK: every Stall-only indicator is computable from the module's events")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
