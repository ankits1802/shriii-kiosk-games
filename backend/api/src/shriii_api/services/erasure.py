"""Erasure workflow (PRV-06a/PRV-06): request -> cascade delete -> snapshot tombstones -> signed receipt.

The cascade runs in one transaction that declares ``shriii.mutation_purpose = erasure`` (the only
path allowed to DELETE from the append-only tables). Session DEKs are deleted (crypto-shredding of
every stored raw chunk); ``event_dedup`` rows and tombstones are kept as the replay guard, so a
re-uploaded or restored event is refused. Snapshots referencing the pid are tombstoned, their
Parquet files deleted, and a rebuild is enqueued as an explicit pipeline step.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import delete, or_, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from shriii_api.audit import record_audit
from shriii_api.auth.rbac import SYSTEM_PRINCIPAL
from shriii_api.canonical import canonical_bytes
from shriii_api.db.models.criterion import Response, ScaleScore
from shriii_api.db.models.identity import ContactRecord, RelinkAudit
from shriii_api.db.models.kiosk_raw import BatchChunk, ConsentParking, DeadLetter, Event, GameSession
from shriii_api.db.models.ops import LegalHold
from shriii_api.db.models.participants import (
    ConsentArtefact,
    ErasureReceipt,
    ErasureRequest,
    PairingCode,
    Participant,
    ParticipantLink,
    SessionKey,
    Tombstone,
)
from shriii_api.db.models.scored import IndicatorValue, SessionQualityFlag, TraitEstimate, TrialCanonical
from shriii_api.db.models.study import Enrollment, RetestSchedule
from shriii_api.db.models.validation import (
    DatasetSnapshot,
    MatchedRecord,
    ModelVersion,
    Prediction,
    SnapshotMember,
)
from shriii_api.db.session import identity_session_scope, set_mutation_purpose
from shriii_api.security import keyed_hmac, sign_ed25519
from shriii_api.services.snapshots import research_id
from shriii_api.settings import Settings
from shriii_api.worker.queue import enqueue

log = logging.getLogger(__name__)


class ErasureBlockedError(Exception):
    """A legal hold blocks the erasure (recorded on the request)."""


def _holds(db: Session, *, pid: str | None, session_ids: list[uuid.UUID], study_ids: set[str]) -> list[LegalHold]:
    clauses = []
    if pid:
        clauses.append((LegalHold.scope_kind == "participant") & (LegalHold.scope_value == pid))
    if session_ids:
        clauses.append((LegalHold.scope_kind == "session") & (LegalHold.scope_value.in_([str(s) for s in session_ids])))
    if study_ids:
        clauses.append((LegalHold.scope_kind == "study") & (LegalHold.scope_value.in_(sorted(study_ids))))
    if not clauses:
        return []
    return list(db.execute(select(LegalHold).where(LegalHold.released_at.is_(None), or_(*clauses))).scalars())


def _sessions_for_pid(db: Session, pid: str) -> list[uuid.UUID]:
    ids: set[uuid.UUID] = set(
        db.execute(select(ParticipantLink.session_id).where(ParticipantLink.pid == pid)).scalars()
    )
    ids |= set(db.execute(select(GameSession.session_id).where(GameSession.participant_pid == pid)).scalars())
    ids |= set(db.execute(select(Event.session_id).where(Event.participant_pid == pid).distinct()).scalars())
    return sorted(ids)


def _count(result: Any) -> int:
    return int(getattr(result, "rowcount", 0) or 0)


def tombstone_snapshot(db: Session, settings: Settings, snapshot: DatasetSnapshot, reason: str) -> None:
    if snapshot.parquet_path:
        path = Path(settings.data_dir) / snapshot.parquet_path
        path.unlink(missing_ok=True)
        path.with_suffix(".manifest.json").unlink(missing_ok=True)
    snapshot.status = "tombstoned"
    snapshot.tombstoned_at = datetime.now(UTC)
    snapshot.tombstone_reason = reason


def execute_erasure(db: Session, settings: Settings, request_id: uuid.UUID, actor: str) -> ErasureReceipt:
    req = db.get(ErasureRequest, request_id, with_for_update=True)
    if req is None:
        raise ValueError(f"unknown erasure request {request_id}")
    if req.status == "completed":
        receipt = db.execute(select(ErasureReceipt).where(ErasureReceipt.request_id == request_id)).scalar_one()
        return receipt

    pid = req.pid
    pid_h = req.pid_hmac or (keyed_hmac(settings.key_bytes("pid_hmac_pepper"), pid) if pid else None)
    req.pid_hmac = pid_h
    if req.scope == "participant" and pid:
        session_ids = _sessions_for_pid(db, pid)
    elif req.session_id is not None:
        session_ids = [req.session_id]
    else:
        session_ids = []
    study_ids = {
        s
        for s in db.execute(select(GameSession.study_id).where(GameSession.session_id.in_(session_ids))).scalars()
        if s
    }
    if pid:
        participant = db.get(Participant, pid)
        if participant is not None and participant.study_id:
            study_ids.add(participant.study_id)
    holds = _holds(db, pid=pid, session_ids=session_ids, study_ids=study_ids)
    if holds:
        req.status = "blocked_legal_hold"
        req.error = f"blocked by legal hold(s) {[h.id for h in holds]}"
        db.flush()
        raise ErasureBlockedError(req.error)

    req.status = "running"
    # Serialise with ingestion of the same sessions (ingest uses pg_try_advisory_xact_lock on the same
    # key and answers ``retryable`` while the erasure runs; afterwards the tombstone refuses re-uploads).
    for sid in session_ids:
        db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"session:{sid}"})
    affected_pids: set[str] = set()
    if session_ids:
        affected_pids |= {
            p
            for p in db.execute(
                select(GameSession.participant_pid).where(GameSession.session_id.in_(session_ids))
            ).scalars()
            if p
        }
        affected_pids |= set(
            db.execute(select(ParticipantLink.pid).where(ParticipantLink.session_id.in_(session_ids))).scalars()
        )
    tombstone_reason = req.channel if req.channel in ("consent_declined", "under_age") else "erasure_request"
    set_mutation_purpose(db, "erasure")
    counts: dict[str, int] = {}

    def run(name: str, stmt: Any) -> None:
        counts[name] = counts.get(name, 0) + _count(db.execute(stmt))

    if session_ids:
        run("raw_events", delete(Event).where(Event.session_id.in_(session_ids)))
        run("consent_parking", delete(ConsentParking).where(ConsentParking.session_id.in_(session_ids)))
        run("dead_letters", delete(DeadLetter).where(DeadLetter.session_id.in_(session_ids)))
        run("raw_chunks", delete(BatchChunk).where(BatchChunk.session_id.in_(session_ids)))
        run("session_keys_shredded", delete(SessionKey).where(SessionKey.session_id.in_(session_ids)))
        run("trials", delete(TrialCanonical).where(TrialCanonical.session_id.in_(session_ids)))
        run("indicators", delete(IndicatorValue).where(IndicatorValue.session_id.in_(session_ids)))
        run("trait_estimates", delete(TraitEstimate).where(TraitEstimate.session_id.in_(session_ids)))
        run("quality_flags", delete(SessionQualityFlag).where(SessionQualityFlag.session_id.in_(session_ids)))
        run("reports", text("DELETE FROM reporting.reports WHERE session_id = ANY(:s)").bindparams(s=session_ids))
        run("consent_artefacts", delete(ConsentArtefact).where(ConsentArtefact.session_id.in_(session_ids)))
        run("links", delete(ParticipantLink).where(ParticipantLink.session_id.in_(session_ids)))
        run("sessions", delete(GameSession).where(GameSession.session_id.in_(session_ids)))
        for sid in session_ids:
            db.execute(
                insert(Tombstone)
                .values(session_id=sid, pid_hmac=pid_h, reason=tombstone_reason, request_id=request_id)
                .on_conflict_do_nothing(index_elements=[Tombstone.session_id])
            )

    tombstoned: list[str] = []
    rebuilds: list[str] = []
    # Snapshots built from the erased data: every snapshot holding the pid (participant scope) or a pid
    # linked to an erased session (session scope; conservative, since membership is per participant).
    snapshot_pids: set[str] = set(affected_pids)
    if pid:
        snapshot_pids.add(pid)
    if session_ids:
        run(
            "matched_records",
            delete(MatchedRecord).where(or_(*(MatchedRecord.session_ids.contains([str(s)]) for s in session_ids))),
        )
    for member_pid in sorted(snapshot_pids):
        snapshot_ids = list(
            db.execute(select(SnapshotMember.snapshot_id).where(SnapshotMember.pid == member_pid)).scalars()
        )
        for snap_id in snapshot_ids:
            snap = db.get(DatasetSnapshot, snap_id, with_for_update=True)
            if snap is None:
                continue
            rid = research_id(settings, snap_id, member_pid)
            model_ids = select(ModelVersion.model_id).where(ModelVersion.snapshot_id == snap_id)
            run(
                "predictions",
                delete(Prediction).where(Prediction.research_id == rid, Prediction.model_id.in_(model_ids)),
            )
            if snap.status == "tombstoned" or str(snap_id) in tombstoned:
                continue
            tombstone_snapshot(db, settings, snap, f"erasure {request_id}")
            tombstoned.append(str(snap_id))
            job = enqueue(
                db,
                "dataset_snapshot",
                {
                    "rebuild_of": str(snap_id),
                    "study_id": snap.study_id,
                    "spec": snap.spec,
                    "erasure_request_id": str(request_id),
                },
                created_by=actor,
                settings=settings,
                priority=30,
            )
            rebuilds.append(str(job.job_id))
    if req.scope == "participant" and pid:
        run(
            "criterion_responses",
            delete(Response).where(or_(Response.pid == pid, Response.rated_pid == pid, Response.subject_pid == pid)),
        )
        run("criterion_scores", delete(ScaleScore).where(ScaleScore.pid == pid))
        run("indicators", delete(IndicatorValue).where(IndicatorValue.participant_pid == pid))
        run("trait_estimates", delete(TraitEstimate).where(TraitEstimate.participant_pid == pid))
        run("matched_records", delete(MatchedRecord).where(MatchedRecord.pid == pid))
        run("snapshot_memberships", delete(SnapshotMember).where(SnapshotMember.pid == pid))
        run("pairing_codes", delete(PairingCode).where(PairingCode.pid == pid))
        run("enrollments", delete(Enrollment).where(Enrollment.pid == pid))
        run("retest_schedules", delete(RetestSchedule).where(RetestSchedule.pid == pid))
        run("consent_artefacts", delete(ConsentArtefact).where(ConsentArtefact.participant_pid == pid))
        run("links", delete(ParticipantLink).where(ParticipantLink.pid == pid))
        run("participants", delete(Participant).where(Participant.pid == pid))
        db.add(Tombstone(session_id=None, pid_hmac=pid_h, reason="erasure_request", request_id=request_id))
        if pid_h:
            with identity_session_scope() as vault:
                counts["vault_contacts"] = _count(
                    vault.execute(delete(ContactRecord).where(ContactRecord.pid_hmac == pid_h))
                )
                vault.add(
                    RelinkAudit(
                        pid_hmac=pid_h, actor=actor, action="erasure", justification=f"erasure request {request_id}"
                    )
                )

    completed_at = datetime.now(UTC)
    body = {
        "request_id": str(request_id),
        "scope": req.scope,
        "pid_hmac": pid_h,
        "session_ids": [str(s) for s in session_ids],
        "counts": dict(sorted(counts.items())),
        "snapshots_tombstoned": tombstoned,
        "snapshot_rebuild_jobs": rebuilds,
        "completed_at": completed_at.isoformat(),
        "statement": "Primary stores cleared; raw chunks crypto-shredded; replay guard tombstones recorded.",
    }
    signature = sign_ed25519(settings.key_bytes("release_pack_signing_key"), canonical_bytes(body))
    receipt = ErasureReceipt(request_id=request_id, body=body, signature=signature, key_id=settings.release_pack_key_id)
    db.add(receipt)
    req.status = "completed"
    req.completed_at = completed_at
    req.pid = None
    record_audit(
        db,
        action="erasure.completed",
        actor=SYSTEM_PRINCIPAL,
        resource_type="erasure_request",
        resource_id=str(request_id),
        details={"counts": counts, "actor": actor},
    )
    db.flush()
    log.info("erasure completed", extra={"request_id": str(request_id), "counts": counts})
    return receipt


def residual_rows(db: Session, *, pid: str | None, session_ids: list[uuid.UUID]) -> dict[str, int]:
    """Sweep query (PRV-06a AC): rows still referencing the pid/sessions in primary stores."""
    out: dict[str, int] = {}
    checks: list[tuple[str, Any]] = []
    if session_ids:
        checks += [
            ("raw_events", select(Event.event_id).where(Event.session_id.in_(session_ids))),
            ("raw_chunks", select(BatchChunk.id).where(BatchChunk.session_id.in_(session_ids))),
            ("session_keys", select(SessionKey.session_id).where(SessionKey.session_id.in_(session_ids))),
            ("indicators", select(IndicatorValue.id).where(IndicatorValue.session_id.in_(session_ids))),
            (
                "consent_artefacts",
                select(ConsentArtefact.consent_id).where(ConsentArtefact.session_id.in_(session_ids)),
            ),
        ]
    if pid:
        checks += [
            ("participants", select(Participant.pid).where(Participant.pid == pid)),
            (
                "criterion_responses",
                select(Response.response_id).where(
                    or_(Response.pid == pid, Response.subject_pid == pid, Response.rated_pid == pid)
                ),
            ),
            ("criterion_scores", select(ScaleScore.score_id).where(ScaleScore.pid == pid)),
            ("snapshot_members", select(SnapshotMember.pid).where(SnapshotMember.pid == pid)),
            ("links", select(ParticipantLink.id).where(ParticipantLink.pid == pid)),
        ]
    for name, stmt in checks:
        out[name] = len(list(db.execute(stmt).scalars()))
    return out
