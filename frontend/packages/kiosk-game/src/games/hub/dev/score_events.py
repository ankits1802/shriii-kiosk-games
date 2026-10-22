"""Score exported set-2 event streams with the real indicator engine (stats/scoring).

Verifies that the Pathway B set-2 modules (Share-the-Pot, Steady Hands, Four Stalls, Private Dice) emit
everything their scoring-dictionary indicators need: every indicator of these modules must come out
`ok` (or a documented non-error status: group-level only, single-event unscorable, model partition too
small), never `error`, `insufficient_trials` or `missing_context_shift`.

Usage (from the repository root):

    python -m uv run python frontend/packages/kiosk-game/src/games/hub/dev/score_events.py <dir> [<dir> ...]

Each <dir> holds `*events.ndjson` and `*trial_params.json` files (from the vitest bot batch export or
from browser bot playthroughs via `shoot.mjs --export`). Synthetic sessions are allowed for this
verification only.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from shriii_scoring import IndicatorEngine

SET2 = ("share_pot", "steady_hands", "four_stalls", "private_dice")

#: Statuses that are legitimate for an indicator of a set-2 module in a verification run.
ACCEPTABLE = {
    "ok",
    "group_only",  # private dice: per-session rows are placeholders; estimates are group rows
    "unscorable_individual",  # single-event indicators (tone after unfair loss, response to error)
    "planned_missing",  # slot modules other than the session's slot form
}


def load(dirs: list[Path]) -> tuple[list[dict[str, Any]], dict[str, dict[str, dict[str, Any]]]]:
    events: list[dict[str, Any]] = []
    params: dict[str, dict[str, dict[str, Any]]] = {}
    for d in dirs:
        for f in sorted(d.glob("*events.ndjson")):
            events.extend(json.loads(line) for line in f.read_text(encoding="utf-8").splitlines() if line.strip())
        for f in sorted(d.glob("*trial_params.json")):
            for sid, p in json.loads(f.read_text(encoding="utf-8")).items():
                params.setdefault(sid, {}).update(p)
    return events, params


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    events, params = load([Path(a) for a in argv[1:]])
    sessions = {e["session_id"] for e in events}
    print(f"events: {len(events)}  sessions: {len(sessions)}")
    engine = IndicatorEngine(pathways=("B",), allow_synthetic=True)
    result = engine.score(events, params)
    dictionary = engine.dictionaries["B"]
    own: dict[str, str] = {}
    for spec in dictionary.indicators.values():
        if spec.module_id in SET2:
            own[spec.id] = spec.module_id
    # Cross-module indicators the set-2 modules feed (probe segments, RT trials).
    cross = {s.id for s in dictionary.indicators.values() if s.module_id == "cross_module"}
    by_ind: dict[str, Counter[str]] = defaultdict(Counter)
    values: dict[str, list[float]] = defaultdict(list)
    for r in result.rows:
        if r.indicator_id in own or r.indicator_id in cross:
            by_ind[r.indicator_id][r.status] += 1
            if r.value is not None:
                values[r.indicator_id].append(r.value)
    failures: list[str] = []
    print(f"\n{'indicator':58} {'module':13} statuses")
    for ind in sorted(set(own) | cross):
        st = dict(by_ind.get(ind, Counter()))
        mod = own.get(ind, "cross_module")
        vals = values.get(ind, [])
        mean = f"mean={sum(vals) / len(vals):.3f}" if vals else ""
        print(f"{ind:58} {mod:13} {st} {mean}")
        if ind in own and not st:
            failures.append(f"{ind}: no rows")
        bad = {k: v for k, v in st.items() if k not in ACCEPTABLE and not (k == "model_failed" and len(sessions) < 20)}
        if ind in own and bad:
            failures.append(f"{ind}: {bad}")
        if ind in own and st and "ok" not in st and not set(st) <= {"group_only", "unscorable_individual"}:
            failures.append(f"{ind}: never ok {st}")
    print("\ngroup-level rows (private reports):")
    for g in result.group_rows:
        if g.indicator_id.startswith("integrity.dice"):
            print(
                f"  {g.indicator_id:40} estimate={g.estimate} n_participants={g.n_participants} "
                f"n_reports={g.n_reports} {g.details.get('flags', '')}"
            )
    dice_groups = [g for g in result.group_rows if g.indicator_id.startswith("integrity.dice")]
    if not dice_groups:
        failures.append("no group-level dice rows")
    if result.consistency_warnings:
        print("\nengine consistency warnings:")
        for w in result.consistency_warnings:
            print(f"  {w}")
    q = Counter(v.grade for v in result.quality.values())
    print(f"\nsession quality grades: {dict(q)}")
    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(f"  {f}")
        return 1
    print("\nall set-2 indicators computed from the emitted events")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
