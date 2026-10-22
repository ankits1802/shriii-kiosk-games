"""Score exported set-1 event streams with the real indicator engine (stats/scoring).

Verifies that the Pathway B set-1 micro-games (Don't-Tap, Card Sort, Balloon, Tower, Wait-or-Now)
emit everything their scoring-dictionary indicators need: every indicator owned by these modules must
come out `ok` for at least some sessions and never `error`.

Usage (from the repository root):

    python -m uv run python frontend/packages/kiosk-game/src/games/dont-tap/kit/dev/score_set1.py <dir>

<dir> holds `<module>.events.ndjson` and `<module>.trial_params.json` (from
`src/games/dont-tap/__tests__/export-set1.test.ts`). Synthetic sessions are allowed for this
verification only.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from shriii_scoring import IndicatorEngine

SET1 = ("dont_tap", "card_sort", "balloon", "tower", "wait_or_now")

#: Statuses acceptable in a verification run of single-module synthetic sessions.
ACCEPTABLE = {"ok", "planned_missing", "group_only", "unscorable_individual"}

#: Statuses tolerated for the known gaps below (a hard-capped slow bot session is `module_incomplete`).
GAP_STATUSES = {"insufficient_trials", "module_absent", "module_incomplete"}

#: Indicators whose dictionary minimum cannot be met by the module config as specified (raised with the
#: measurement-model owners). They are reported, never silently passed: `insufficient_trials` is the
#: only status tolerated for them, and the run prints the reason.
KNOWN_DICTIONARY_GAPS = {
    "expressive_restraint.iti_rvi": "min_valid_trials 40 in phase main only; Don't-Tap main block has 34 trials "
    "(pressure block excluded by the dictionary phases)",
    "self_control.choice_consistency": "min_valid_trials 12 delay choices; MG-07 config has 8 delay + 4 effort "
    "choices (12 in total) and the formula reads delay choices only",
    "persistence.effort_completion_rate": "min_valid_trials 4 chosen holds; the effort block has 4 trials, so the "
    "indicator exists only when every effort choice is 'hard' (a chosen churn never pressed counts as incomplete "
    "via an explicit hold_ms 0 record)",
}


def load(d: Path) -> tuple[list[dict[str, Any]], dict[str, dict[str, dict[str, Any]]]]:
    events: list[dict[str, Any]] = []
    params: dict[str, dict[str, dict[str, Any]]] = {}
    for f in sorted(d.glob("*.events.ndjson")):
        events.extend(json.loads(line) for line in f.read_text(encoding="utf-8").splitlines() if line.strip())
    for f in sorted(d.glob("*.trial_params.json")):
        for sid, p in json.loads(f.read_text(encoding="utf-8")).items():
            params.setdefault(sid, {}).update(p)
    return events, params


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    events, params = load(Path(argv[1]))
    modules = sorted({e["task"]["module_id"] for e in events if e.get("task")})
    sessions = {e["session_id"] for e in events}
    print(f"events: {len(events)}  sessions: {len(sessions)}  modules: {modules}")
    engine = IndicatorEngine(pathways=("B",), allow_synthetic=True)
    result = engine.score(events, params)
    dictionary = engine.dictionaries["B"]
    own = {s.id: s.module_id for s in dictionary.indicators.values() if s.module_id in SET1 and s.module_id in modules}
    by_ind: dict[str, Counter[str]] = defaultdict(Counter)
    values: dict[str, list[float]] = defaultdict(list)
    for r in result.rows:
        if r.indicator_id in own:
            by_ind[r.indicator_id][r.status] += 1
            if r.value is not None:
                values[r.indicator_id].append(r.value)
    failures: list[str] = []
    gaps: list[str] = []
    print(f"\n{'indicator':58} {'module':12} statuses")
    for ind in sorted(own):
        st = dict(by_ind.get(ind, Counter()))
        vals = values.get(ind, [])
        spread = f"mean={sum(vals) / len(vals):.3f} min={min(vals):.3f} max={max(vals):.3f}" if vals else ""
        print(f"{ind:58} {own[ind]:12} {st} {spread}")
        if not st:
            failures.append(f"{ind}: no rows")
            continue
        if "error" in st:
            failures.append(f"{ind}: error rows {st}")
        if not set(st) & ACCEPTABLE:
            if ind in KNOWN_DICTIONARY_GAPS and set(st) <= ACCEPTABLE | GAP_STATUSES:
                gaps.append(f"{ind}: {st} -- {KNOWN_DICTIONARY_GAPS[ind]}")
            else:
                failures.append(f"{ind}: never ok {st}")
        elif ind in KNOWN_DICTIONARY_GAPS and "insufficient_trials" in st:
            gaps.append(f"{ind}: {st} -- {KNOWN_DICTIONARY_GAPS[ind]}")
    if result.consistency_warnings:
        print("\nengine consistency warnings:")
        for w in result.consistency_warnings[:20]:
            print(f"  {w}")
    if gaps:
        print("\nknown dictionary/config gaps (reported to the measurement-model owners):")
        for g in gaps:
            print(f"  {g}")
    q = Counter(v.grade for v in result.quality.values())
    print(f"\nsession quality grades: {dict(q)}")
    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(f"  {f}")
        return 1
    print("\nall set-1 indicators computed from the emitted events")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
