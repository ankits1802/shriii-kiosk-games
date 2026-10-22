"""Score exported Weighing Post events with the layer-2 indicator engine (stats/scoring).

Usage (from the repository root):

    python -m uv run python frontend/packages/kiosk-game/src/episodes/weighing-post/dev/score_events.py \
        <events.ndjson> [<events.params.json>] [--sessions N]

``events.params.json`` maps ``session_id -> trial_id -> GameTrialSpec.params`` (written next to the
NDJSON by the vitest playthrough and the browser bot). With ``--sessions N`` the single exported session
is cloned N times under new session ids (all synthetic) so batch indicators (person slopes) and the
group-level luck-token estimator have enough units to run; per-session indicators are reported for the
original session only.

Exit status 1 when any weighing_post per-session indicator that one complete episode must be able to
compute is not ``ok``, or when the engine raises (e.g. missing trial params).
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from shriii_scoring import IndicatorEngine

#: Indicators one complete Weighing Post episode must compute on its own (per session).
MUST_BE_OK = (
    "decisiveness.time_to_commit",
    "decisiveness.reversals_before_confirm",
    "decisiveness.info_gathered",
    "decisiveness.commit_rvi",
    "adaptability.rule_compliance_post_shift",
    "judgement.credit_taking",
    "judgement.blame_shifting",
    "judgement.consistency_across_dilemmas",
    "integrity.bribe_acceptance",
    "integrity.overpayment_return",
    "risk_preference.gamble_rate",
)

#: Indicators that pool across episodes or sessions; reported, but not required from one episode.
CROSS = (
    "response_consistency.loc_scale_sigma",
    "response_consistency.choice_entropy_repeats",
    "persistence_of_style.cross_segment_style_r",
    "persistence_of_style.lag1_autocorr",
    "stability.shift_slope",
    "stability.shift_slope_new_rule",
)


def load(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def clone(events: list[dict[str, Any]], params: Mapping[str, Any], n: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    out = list(events)
    out_params: dict[str, Any] = dict(params)
    base_sid = events[0]["session_id"]
    for k in range(1, n):
        sid = str(uuid.UUID(int=uuid.UUID(base_sid).int ^ k))
        for e in events:
            c = json.loads(json.dumps(e))
            c["session_id"] = sid
            c["event_id"] = str(uuid.UUID(int=uuid.UUID(e["event_id"]).int ^ (k << 64)))
            out.append(c)
        out_params[sid] = params.get(base_sid, {})
    return out, out_params


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("events", type=Path)
    ap.add_argument("params", type=Path, nargs="?")
    ap.add_argument("--sessions", type=int, default=1)
    ap.add_argument(
        "--dev-timing",
        action="store_true",
        help="dev browser runs only: treat the uncertified dev timing profile (and late onsets caused by a "
        "shared, software-loaded machine) as ok so timing-sensitive indicators are exercised",
    )
    args = ap.parse_args()
    events = load(args.events)
    if args.dev_timing:
        for e in events:
            if e.get("timing", {}).get("timing_flag") in ("uncertified_timing_profile", "late_onset"):
                e["timing"]["timing_flag"] = "ok"
    params_path = args.params or args.events.with_suffix("").with_suffix(".params.json")
    params = json.loads(params_path.read_text(encoding="utf-8"))
    sid = events[0]["session_id"]
    if args.sessions > 1:
        events, params = clone(events, params, args.sessions)
    engine = IndicatorEngine(pathways=("A",), allow_synthetic=True, on_missing_params="raise")
    result = engine.score(events, params)
    rows = {r.indicator_id: r for r in result.rows if r.session_id == sid}
    wp = [r for r in rows.values() if r.indicator_id in MUST_BE_OK + CROSS]
    print(f"session {sid}: quality={result.quality[sid].grade}")
    failed: list[str] = []
    for r in sorted(wp, key=lambda r: r.indicator_id):
        tag = "MUST" if r.indicator_id in MUST_BE_OK else "pool"
        print(
            f"  [{tag}] {r.indicator_id:48s} status={r.status:22s} value={r.value!s:24s} "
            f"n={r.n_valid}/{r.min_valid} flags={','.join(r.flags)}"
        )
        if r.indicator_id in MUST_BE_OK and r.status != "ok":
            failed.append(r.indicator_id)
    missing = [i for i in MUST_BE_OK if i not in rows]
    for g in result.group_rows:
        if g.indicator_id.startswith("integrity.luck_token"):
            print(
                f"  [group] {g.indicator_id:47s} estimate={g.estimate!s:24s} "
                f"participants={g.n_participants} reports={g.n_reports} details={json.dumps(g.details, default=str)}"
            )
    for w in result.consistency_warnings:
        if "weighing" in w:
            print(f"  warning: {w}")
    if failed or missing:
        print(f"FAILED: not ok {failed}, missing {missing}", file=sys.stderr)
        return 1
    print("OK: every per-session Weighing Post indicator computed from the exported events")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
