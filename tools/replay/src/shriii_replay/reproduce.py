"""Re-run the indicator engine on one session and compare with stored indicator values (SCR-13).

Session-level formulas depend only on the session's own events, so they must reproduce within the
plan's numeric tolerance (1e-8, plan section 7.10). Batch-model formulas (person random slopes,
hierarchical discounting, ...) and the ``z_within_level_language`` transformation depend on the other
sessions of the scoring partition; they are compared only when the input holds the whole partition
(``partition_complete``), otherwise reported as ``partition_dependent``.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from shriii_scoring import IndicatorEngine, ScoringResult
from shriii_scoring.formulas.base import REGISTRY

from shriii_replay.load import Issue

DEFAULT_TOLERANCE = 1e-8
PROVENANCE_FIELDS = (
    "dictionary_version",
    "dictionary_sha256",
    "shared_sha256",
    "params_sha256",
    "algorithm_version",
    "event_stream_sha256",
)
Outcome = Literal["match", "mismatch", "partition_dependent", "stored_only", "computed_only"]


@dataclass(slots=True)
class Comparison:
    indicator_id: str
    construct: str
    formula_kind: str
    partition_dependent: bool
    computed_status: str
    computed_value: float | None
    computed_transformed: float | None
    stored_status: str | None
    stored_value: float | None
    stored_transformed: float | None
    outcome: Outcome
    abs_delta: float | None
    source_seq_min: int | None
    source_seq_max: int | None
    n_valid: int


@dataclass(slots=True)
class Reproducibility:
    mode: Literal["stored", "self"]
    tolerance: float
    partition_complete: bool
    scoring_run_id: str
    dictionary: dict[str, Any]
    provenance: list[dict[str, Any]]
    comparisons: list[Comparison]
    quality: dict[str, Any]
    consistency_warnings: list[str]
    issues: list[Issue] = field(default_factory=list)

    @property
    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for c in self.comparisons:
            out[c.outcome] = out.get(c.outcome, 0) + 1
        return out

    @property
    def dictionary_sha_match(self) -> bool | None:
        checks = [p for p in self.provenance if p["field"] in ("dictionary_sha256", "shared_sha256")]
        return None if not checks else all(p["match"] for p in checks)

    @property
    def reproducible(self) -> bool:
        return not any(c.outcome in ("mismatch", "stored_only") for c in self.comparisons) and not any(
            i.severity == "error" for i in self.issues
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "tolerance": self.tolerance,
            "partition_complete": self.partition_complete,
            "scoring_run_id": self.scoring_run_id,
            "dictionary": self.dictionary,
            "dictionary_sha_match": self.dictionary_sha_match,
            "provenance": self.provenance,
            "counts": self.counts,
            "reproducible": self.reproducible,
            "quality": self.quality,
            "consistency_warnings": self.consistency_warnings,
            "comparisons": [asdict(c) for c in self.comparisons],
            "issues": [i.as_dict() for i in self.issues],
        }


def _close(a: float | None, b: float | None, tol: float) -> tuple[bool, float | None]:
    if a is None or b is None:
        return a is None and b is None, None
    if math.isnan(a) or math.isnan(b):
        return math.isnan(a) and math.isnan(b), None
    d = abs(a - b)
    return d <= tol * max(1.0, abs(a), abs(b)), d


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def score_session(
    events: Sequence[Mapping[str, Any]],
    trial_params: Mapping[str, Mapping[str, Mapping[str, Any]]] | None,
    *,
    allow_synthetic: bool,
    engine: IndicatorEngine | None = None,
) -> tuple[IndicatorEngine, ScoringResult]:
    eng = engine or IndicatorEngine(allow_synthetic=allow_synthetic, on_missing_params="flag")
    return eng, eng.score(list(events), trial_params)


def reproduce(
    events: Sequence[Mapping[str, Any]],
    trial_params: Mapping[str, Mapping[str, Mapping[str, Any]]] | None,
    stored: Sequence[Mapping[str, Any]] | None,
    *,
    session_id: str,
    allow_synthetic: bool,
    tolerance: float = DEFAULT_TOLERANCE,
    partition_complete: bool = False,
    partition_events: Sequence[Mapping[str, Any]] | None = None,
    engine: IndicatorEngine | None = None,
) -> Reproducibility:
    """Score the session and compare with ``stored`` rows (or with a second run when ``stored`` is None).

    ``partition_events`` (the whole scoring partition) makes batch-model indicators comparable too."""
    issues: list[Issue] = []
    # The replayed session is always scored from the validated, deduplicated stream; the partition only
    # contributes the *other* sessions (otherwise a tampered session file could be masked by a clean copy
    # of the same session inside the partition file).
    scored_events = (
        [e for e in partition_events if e.get("session_id") != session_id] + list(events)
        if partition_events is not None
        else list(events)
    )
    complete = partition_complete or partition_events is not None
    eng, result = score_session(scored_events, trial_params, allow_synthetic=allow_synthetic, engine=engine)
    rows = [r for r in result.rows if r.session_id == session_id]
    if not rows:
        issues.append(
            Issue("error", "not_scored", session_id, "the engine produced no rows (pathway unknown or no modules)")
        )
    pathway = rows[0].pathway if rows else None
    d = eng.dictionaries.get(pathway) if pathway else None
    dictionary = (
        {
            "pathway": d.pathway,
            "version": d.version,
            "sha256": d.sha256,
            "shared_version": d.shared_version,
            "shared_sha256": d.shared_sha256,
            "frozen": d.frozen,
            "status": d.status,
        }
        if d
        else {}
    )
    first_versions = (events[0].get("versions") or {}) if events else {}
    if d and first_versions.get("scoring_dict_version") not in (None, d.version):
        issues.append(
            Issue(
                "warning",
                "scoring_dict_version_differs",
                session_id,
                f"session declares scoring_dict_version {first_versions.get('scoring_dict_version')}, "
                f"engine dictionary is {d.version}",
            )
        )

    mode: Literal["stored", "self"] = "stored" if stored is not None else "self"
    if stored is None:
        # Determinism check: a fresh engine on the same input must give identical rows.
        _, again = score_session(scored_events, trial_params, allow_synthetic=allow_synthetic)
        stored_rows: list[Mapping[str, Any]] = [asdict(r) for r in again.rows if r.session_id == session_id]
    else:
        stored_rows = [r for r in stored if r.get("session_id") in (None, session_id)]
        if not stored_rows:
            issues.append(Issue("error", "no_stored_rows", session_id, "stored file has no rows for this session"))

    by_id = {str(r.get("indicator_id")): r for r in stored_rows}
    provenance: list[dict[str, Any]] = []
    if rows:
        cur = rows[0]
        for fld in PROVENANCE_FIELDS:
            vals = sorted({str(r[fld]) for r in stored_rows if r.get(fld) is not None})
            if not vals:
                continue
            current = str(getattr(cur, fld))
            match = vals == [current]
            provenance.append({"field": fld, "stored": vals, "current": current, "match": match})
            if not match:
                sev: Literal["error", "warning"] = (
                    "error" if fld in ("dictionary_sha256", "shared_sha256") else "warning"
                )
                if fld == "event_stream_sha256":
                    sev = "error"
                issues.append(
                    Issue(sev, f"{fld}_mismatch", session_id, f"stored {', '.join(vals)} != current {current}")
                )

    comparisons: list[Comparison] = []
    for r in rows:
        kind = REGISTRY[r.formula_ref].kind if r.formula_ref in REGISTRY else "unknown"
        partition_dep = kind in ("batch", "group") or r.transformation == "z_within_level_language"
        s = by_id.pop(r.indicator_id, None)
        if s is None:
            outcome: Outcome = "computed_only"
            delta = None
            sv = st = None
            sstat = None
        else:
            sv, st, sstat = _num(s.get("value")), _num(s.get("value_transformed")), s.get("status")
            ok_v, delta = _close(r.value, sv, tolerance)
            ok_t, _ = _close(r.value_transformed, st, tolerance)
            same = ok_v and (sstat is None or sstat == r.status)
            if r.transformation != "z_within_level_language":
                same = same and ok_t
            if partition_dep and not complete and mode == "stored":
                outcome = "match" if same else "partition_dependent"
            else:
                outcome = "match" if same else "mismatch"
        comparisons.append(
            Comparison(
                indicator_id=r.indicator_id,
                construct=r.construct,
                formula_kind=kind,
                partition_dependent=partition_dep,
                computed_status=r.status,
                computed_value=r.value,
                computed_transformed=r.value_transformed,
                stored_status=sstat,
                stored_value=sv,
                stored_transformed=st,
                outcome=outcome,
                abs_delta=delta,
                source_seq_min=r.source_seq_min,
                source_seq_max=r.source_seq_max,
                n_valid=r.n_valid,
            )
        )
    for ind_id, s in sorted(by_id.items()):
        comparisons.append(
            Comparison(
                indicator_id=ind_id,
                construct=str(s.get("construct", "")),
                formula_kind="unknown",
                partition_dependent=False,
                computed_status="absent",
                computed_value=None,
                computed_transformed=None,
                stored_status=s.get("status"),
                stored_value=_num(s.get("value")),
                stored_transformed=_num(s.get("value_transformed")),
                outcome="stored_only",
                abs_delta=None,
                source_seq_min=None,
                source_seq_max=None,
                n_valid=0,
            )
        )
    q = result.quality.get(session_id)
    quality = (
        {
            "grade": q.grade,
            "flags": list(q.flags),
            "valid_for_validation": q.valid_for_validation,
            "valid_for_report": q.valid_for_report,
        }
        if q
        else {}
    )
    return Reproducibility(
        mode=mode,
        tolerance=tolerance,
        partition_complete=complete,
        scoring_run_id=result.manifest.scoring_run_id,
        dictionary=dictionary,
        provenance=provenance,
        comparisons=comparisons,
        quality=quality,
        consistency_warnings=list(result.consistency_warnings),
        issues=issues,
    )
