"""Participant x occasion matching and analysis snapshots (ING-06; spec section 6).

A snapshot joins, per (pid, occasion): the current layer-2 indicators of the participant's completed
game session, the current layer-3 criterion scale scores, coarse demographic bands and study design
fields. It applies the consent, withdrawal, quality and synthetic exclusions (with a report by reason,
language and literacy), writes de-identified Parquet (``research_id`` = keyed HMAC of snapshot id and
pid, never the pid) plus a manifest, and records restricted pid membership for the erasure cascade.
"""

from __future__ import annotations

import json
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd  # type: ignore[import-untyped]
import pyarrow as pa  # type: ignore[import-untyped]
import pyarrow.parquet as pq  # type: ignore[import-untyped]
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from shriii_api import content
from shriii_api.adapters.scoring import engine_versions
from shriii_api.canonical import sha256_hex
from shriii_api.db.models.criterion import ScaleScore
from shriii_api.db.models.kiosk_raw import Event, GameSession
from shriii_api.db.models.participants import Participant, Tombstone
from shriii_api.db.models.scored import IndicatorValue, SessionQualityFlag
from shriii_api.db.models.study import Enrollment, MeasurementOccasion
from shriii_api.db.models.validation import DatasetSnapshot, MatchedRecord, SnapshotMember
from shriii_api.security import keyed_hmac
from shriii_api.services import consent as consent_svc
from shriii_api.settings import Settings

MATCHING_ALGORITHM_VERSION = "api-matching-0.1.0"
SNAPSHOT_ALGORITHM_VERSION = "api-snapshot-0.1.0"
DESIGN_COLUMNS = (
    "research_id",
    "study_id",
    "occasion_id",
    "wave",
    "cohort_id",
    "arm_id",
    "criterion_block",
    "language",
    "pathway",
    "battery_arm",
    "site_mode",
    "age_band",
    "literacy_band",
    "edu_band",
    "gender",
    "device_familiarity",
    "played_before",
    "app_version",
    "scoring_dict_version",
    "criterion_careless",
)


def research_id(settings: Settings, snapshot_id: uuid.UUID | str, pid: str) -> str:
    return keyed_hmac(settings.key_bytes("pid_hmac_pepper"), f"snapshot:{snapshot_id}:{pid}")[:24]


@dataclass(slots=True)
class Match:
    pid: str
    study_id: str
    occasion_id: str
    wave: int
    sessions: list[GameSession] = field(default_factory=list)
    scores: list[ScaleScore] = field(default_factory=list)


def _occasions(db: Session, study_id: str) -> dict[str, MeasurementOccasion]:
    return {
        o.occasion_id: o
        for o in db.execute(select(MeasurementOccasion).where(MeasurementOccasion.study_id == study_id)).scalars()
    }


def collect_matches(db: Session, study_id: str, occasion_ids: list[str] | None = None) -> list[Match]:
    occasions = _occasions(db, study_id)
    matches: dict[tuple[str, str], Match] = {}

    def get(pid: str, occ: str, wave: int) -> Match:
        key = (pid, occ)
        if key not in matches:
            matches[key] = Match(pid=pid, study_id=study_id, occasion_id=occ, wave=wave)
        return matches[key]

    sessions = db.execute(
        select(GameSession).where(GameSession.study_id == study_id, GameSession.participant_pid.is_not(None))
    ).scalars()
    for s in sessions:
        occ = s.occasion_id or "unassigned"
        assert s.participant_pid is not None
        get(s.participant_pid, occ, occasions[occ].wave if occ in occasions else 1).sessions.append(s)
    scores = db.execute(select(ScaleScore).where(ScaleScore.study_id == study_id, ScaleScore.is_current)).scalars()
    for sc in scores:
        get(sc.pid, sc.occasion_id, sc.wave).scores.append(sc)
    out = [m for m in matches.values() if occasion_ids is None or m.occasion_id in occasion_ids]
    return sorted(out, key=lambda m: (m.pid, m.occasion_id))


def refresh_matched_records(db: Session, study_id: str, job_id: uuid.UUID | None) -> dict[str, int]:
    """Participant-record matching job: upsert ``validation.matched_records`` for a study."""
    db.execute(delete(MatchedRecord).where(MatchedRecord.study_id == study_id))
    stats: Counter[str] = Counter()
    for m in collect_matches(db, study_id):
        completed = [s for s in m.sessions if s.status == "completed"]
        issues: list[str] = []
        if len(completed) > 1:
            issues.append("multiple_completed_sessions")
        versions = {s.session_id.hex: s.versions.get("app_version") for s in completed}
        db.add(
            MatchedRecord(
                pid=m.pid,
                study_id=study_id,
                occasion_id=m.occasion_id,
                session_ids=[str(s.session_id) for s in completed],
                instrument_versions={f"{sc.instrument_id}": sc.instrument_version for sc in m.scores},
                game_versions=versions,
                has_game=bool(completed),
                has_criterion=bool(m.scores),
                issues=issues,
                algorithm_version=MATCHING_ALGORITHM_VERSION,
                dictionary_version=None,
                source_refs={
                    "session_ids": [str(s.session_id) for s in completed],
                    "score_ids": [str(sc.score_id) for sc in m.scores],
                },
                job_id=job_id,
            )
        )
        stats["records"] += 1
        stats["complete"] += int(bool(completed) and bool(m.scores))
    db.flush()
    return dict(stats)


def _bands(db: Session, session_id: uuid.UUID) -> dict[str, Any]:
    payload = db.execute(
        select(Event.payload)
        .where(Event.session_id == session_id, Event.event_type == "bands.answered")
        .order_by(Event.seq.desc())
        .limit(1)
    ).scalar_one_or_none()
    return dict(payload or {})


def _blocking_flags(db: Session, session_id: uuid.UUID) -> list[str]:
    return list(
        db.execute(
            select(SessionQualityFlag.flag_code).where(
                SessionQualityFlag.session_id == session_id,
                SessionQualityFlag.resolved_at.is_(None),
                SessionQualityFlag.severity == "blocking",
            )
        ).scalars()
    )


def build_snapshot(db: Session, settings: Settings, snapshot: DatasetSnapshot, job_id: uuid.UUID | None) -> None:
    spec = snapshot.spec
    study_id = snapshot.study_id
    require_game = bool(spec.get("require_game", True))
    require_criterion = bool(spec.get("require_criterion", True))
    include_synthetic = bool(spec.get("include_synthetic", False)) and settings.is_dev
    pathway_filter = spec.get("pathway")
    enrollments = {e.pid: e for e in db.execute(select(Enrollment).where(Enrollment.study_id == study_id)).scalars()}
    withdrawn = set(db.execute(select(Participant.pid).where(Participant.status == "withdrawn")).scalars())
    holdout_cohorts = set(spec.get("holdout_cohorts", []))

    rows: list[dict[str, Any]] = []
    members: set[str] = set()
    exclusions: list[dict[str, Any]] = []
    for m in collect_matches(db, study_id, spec.get("occasion_ids")):
        completed = sorted(
            (s for s in m.sessions if s.status == "completed"), key=lambda s: s.completed_at or s.started_at
        )
        session = completed[-1] if completed else None
        language = session.language if session else None
        bands = _bands(db, session.session_id) if session else {}
        reason: str | None = None
        if m.pid in withdrawn:
            reason = "withdrawn"
        elif session is not None and session.synthetic and not include_synthetic:
            reason = "synthetic"
        elif session is not None and not consent_svc.has_consent(db, "core", session_id=session.session_id):
            reason = "no_core_consent"
        elif session is not None and _blocking_flags(db, session.session_id):
            reason = "session_quality"
        elif session is not None and pathway_filter and session.pathway != pathway_filter:
            reason = "other_pathway"
        elif require_game and session is None:
            reason = "no_game_session"
        elif require_criterion and not m.scores:
            reason = "no_criterion"
        if reason is not None:
            exclusions.append({"reason": reason, "language": language, "literacy": bands.get("literacy")})
            continue
        enrollment = enrollments.get(m.pid)
        rid = research_id(settings, snapshot.snapshot_id, m.pid)
        row: dict[str, Any] = {
            "research_id": rid,
            "study_id": study_id,
            "occasion_id": m.occasion_id,
            "wave": m.wave,
            "cohort_id": enrollment.cohort_id if enrollment else None,
            "arm_id": enrollment.arm_id if enrollment else None,
            "criterion_block": enrollment.criterion_block if enrollment else None,
            "language": language,
            "pathway": session.pathway if session else None,
            "battery_arm": session.battery_arm if session else None,
            "site_mode": session.site_mode if session else None,
            "age_band": bands.get("age"),
            "literacy_band": bands.get("literacy"),
            "edu_band": bands.get("edu"),
            "gender": bands.get("gender"),
            "device_familiarity": bands.get("device_use"),
            "played_before": bands.get("played_before"),
            "app_version": session.versions.get("app_version") if session else None,
            "scoring_dict_version": session.versions.get("scoring_dict_version") if session else None,
            "criterion_careless": any("criterion_careless" in (sc.flags or []) for sc in m.scores),
        }
        if enrollment is not None and enrollment.cohort_id in holdout_cohorts:
            row["holdout"] = True
        if session is not None:
            for iv in db.execute(
                select(IndicatorValue).where(IndicatorValue.session_id == session.session_id, IndicatorValue.is_current)
            ).scalars():
                row[f"ind__{iv.indicator_id}"] = iv.value
        for sc in m.scores:
            row[f"crit__{sc.instrument_id}.{sc.scale_id}"] = sc.score
        rows.append(row)
        members.add(m.pid)

    frame = pd.DataFrame(rows)
    measure_cols = sorted(c for c in frame.columns if c.startswith(("ind__", "crit__")))
    design = [c for c in DESIGN_COLUMNS if c in frame.columns] + (["holdout"] if "holdout" in frame.columns else [])
    frame = (
        frame.reindex(columns=[*DESIGN_COLUMNS, *(["holdout"] if "holdout" in frame.columns else []), *measure_cols])
        if rows
        else pd.DataFrame(columns=list(DESIGN_COLUMNS))
    )
    if rows:
        frame = frame.sort_values(["research_id", "occasion_id"]).reset_index(drop=True)
    rel = Path("snapshots") / study_id / f"{snapshot.snapshot_id}.parquet"
    path = Path(settings.data_dir) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pandas(frame, preserve_index=False)
    pq.write_table(table, path, compression="zstd")
    digest = sha256_hex(path.read_bytes())

    def breakdown(key: str) -> dict[str, dict[str, int]]:
        out: dict[str, Counter[str]] = defaultdict(Counter)
        for e in exclusions:
            out[e["reason"]][str(e[key])] += 1
        return {k: dict(v) for k, v in out.items()}

    erasures = db.execute(select(func.count()).select_from(Tombstone)).scalar_one()
    gates_doc, hyp_doc = content.gates(), content.hypotheses()
    manifest: dict[str, Any] = {
        "snapshot_id": str(snapshot.snapshot_id),
        "study_id": study_id,
        "version": snapshot.version,
        "spec": spec,
        "created_at": datetime.now(UTC).isoformat(),
        "algorithm_version": SNAPSHOT_ALGORITHM_VERSION,
        "engines": engine_versions(),
        "row_count": len(frame),
        "n_participants": len(members),
        "columns": list(frame.columns),
        "design_columns": design,
        "parquet_sha256": digest,
        "dictionary_sha256": {p: content.dictionary_pathway(p).sha256 for p in ("A", "B")},
        "gates_sha256": gates_doc.sha256,
        "hypotheses_sha256": hyp_doc.sha256,
        "erasure_tombstones_at_build": int(erasures),
        "exclusions": {
            "total": len(exclusions),
            "by_reason": dict(Counter(e["reason"] for e in exclusions)),
            "by_reason_language": breakdown("language"),
            "by_reason_literacy": breakdown("literacy"),
        },
        "supersedes": str(snapshot.supersedes_id) if snapshot.supersedes_id else None,
    }
    path.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")
    db.execute(delete(SnapshotMember).where(SnapshotMember.snapshot_id == snapshot.snapshot_id))
    for pid in sorted(members):
        db.add(SnapshotMember(snapshot_id=snapshot.snapshot_id, pid=pid))
    snapshot.status = "ready"
    snapshot.parquet_path = rel.as_posix()
    snapshot.sha256 = digest
    snapshot.row_count = len(frame)
    snapshot.n_participants = len(members)
    snapshot.manifest = manifest
    snapshot.exclusions = dict(manifest["exclusions"])
    snapshot.job_id = job_id
    db.flush()


def load_snapshot_frame(settings: Settings, snapshot: DatasetSnapshot) -> pd.DataFrame:
    if snapshot.status not in ("ready", "frozen") or not snapshot.parquet_path:
        raise ValueError(f"snapshot {snapshot.snapshot_id} is {snapshot.status}")
    path = Path(settings.data_dir) / snapshot.parquet_path
    if snapshot.sha256 and sha256_hex(path.read_bytes()) != snapshot.sha256:
        raise ValueError("snapshot file does not match its recorded sha256")
    return pq.read_table(path).to_pandas()
