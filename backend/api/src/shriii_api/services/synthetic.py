"""End-to-end synthetic ingestion (dev/test only): simulator -> UploadBatch ingestion -> linkage ->
criterion battery -> jobs (trials, features, scoring) -> matched snapshot -> validation runs.

Synthetic events carry ``context.synthetic = true``; ingestion refuses them outside dev/test, and
snapshots include them only when ``include_synthetic`` is requested in a dev/test environment.
"""

from __future__ import annotations

import json
import logging
import random
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select

from shriii_api import content
from shriii_api.adapters import simulator
from shriii_api.auth.rbac import Principal, Role
from shriii_api.canonical import canonical_sha256
from shriii_api.db.models.criterion import InstrumentVersion, LanguageVersion, Permission
from shriii_api.db.models.kiosk_raw import GameSession
from shriii_api.db.models.participants import Participant, ParticipantLink
from shriii_api.db.models.study import Study
from shriii_api.db.models.validation import DatasetSnapshot, ValidationRun
from shriii_api.db.session import session_scope
from shriii_api.security import keyed_hmac, new_uuid7
from shriii_api.services import consent as consent_svc
from shriii_api.services import criterion as criterion_svc
from shriii_api.services import seed as seed_svc
from shriii_api.services import studies as study_svc
from shriii_api.services.ingestion import ingest_batch
from shriii_api.settings import Settings
from shriii_api.worker.queue import enqueue
from shriii_api.worker.runner import drain

log = logging.getLogger(__name__)
ACTOR = "system:synthetic-loader"
MAX_EVENTS_PER_BATCH = 400


def _uuid7() -> str:
    return str(new_uuid7())


def _construct_for_criterion() -> dict[str, tuple[str, int]]:
    """criterion ref (instrument.scale) -> (construct, expected sign) from the shared dictionary."""
    out: dict[str, tuple[str, int]] = {}
    for c in content.dictionary_shared().data["constructs"]:
        for rel in (c.get("criterion_relations") or {}).get("convergent", []):
            sign = -1 if rel.get("expected_sign") == "negative" else 1
            out.setdefault(rel["criterion"], (c["id"], sign))
    return out


def _approve_for_dev(db: Any, instrument_ids: list[str], languages: set[str]) -> None:
    """Dev-only: mark instruments administrable for synthetic data (clearly labelled, never in prod)."""
    for instrument_id in instrument_ids:
        version = criterion_svc.get_version(db, instrument_id)
        perm = criterion_svc.current_permission(db, instrument_id)
        if perm is None or perm.permission_status not in criterion_svc.PERMITTED_STATUSES:
            db.add(
                Permission(
                    instrument_id=instrument_id,
                    language=None,
                    holder="synthetic",
                    licence="dev-only",
                    permission_status="granted",
                    permission_document="DEV-SYNTHETIC-ONLY",
                    allowed_use="Synthetic development data only; not a licence.",
                    expiry=None,
                    commercial_use=False,
                    notes="Created by ingest-synthetic in a dev/test environment.",
                    recorded_by=ACTOR,
                )
            )
        for language in languages:
            lv = db.execute(
                select(LanguageVersion).where(
                    LanguageVersion.instrument_version_id == version.id, LanguageVersion.language == language
                )
            ).scalar_one_or_none()
            if lv is None:
                lv = LanguageVersion(
                    instrument_version_id=version.id,
                    language=language,
                    itc_state="draft",
                    approved=False,
                    translation_permission="not_requested",
                )
                db.add(lv)
            if not lv.approved:
                lv.approved, lv.itc_state, lv.approved_by = True, "approved", ["dev-synthetic-a", "dev-synthetic-b"]
                lv.approved_at = datetime.now(UTC)
    db.flush()


def _simulated_responses(
    definition: dict[str, Any], latent: dict[str, float], rng: random.Random, mapping: dict[str, tuple[str, int]]
) -> list[criterion_svc.ItemResponse]:
    scale = definition["response_scale"]
    lo, hi = float(scale.get("min") or 1), float(scale.get("max") or 5)
    mid, spread = (lo + hi) / 2, (hi - lo) / 4
    item_scale: dict[str, str] = {}
    for sc in definition["subscales"]:
        for item_id in sc["items"]:
            item_scale.setdefault(item_id, sc["scale_id"])
    out: list[criterion_svc.ItemResponse] = []
    for item in definition["items"]:
        if item.get("attention_check"):
            continue
        ref = f"{definition['instrument_id']}.{item_scale.get(item['item_id'], '')}"
        construct, sign = mapping.get(ref, ("", 1))
        z = latent.get(construct, 0.0) * sign
        value = mid + spread * (0.8 * z + rng.gauss(0, 0.8))
        if item.get("reverse_keyed"):
            value = lo + hi - value
        out.append(
            criterion_svc.ItemResponse(item_id=item["item_id"], raw_response=float(min(hi, max(lo, round(value)))))
        )
    return out


def ingest_synthetic(
    settings: Settings,
    *,
    participants: int,
    seed: int,
    occasions: int = 1,
    study_id: str = seed_svc.DEMO_STUDY_ID,
    instruments: tuple[str, ...] = ("bscs", "bfi2_xs"),
    run_jobs: bool = True,
    build_snapshot: bool = True,
) -> dict[str, Any]:
    if not settings.is_dev:
        raise RuntimeError("synthetic ingestion is only allowed when ENV is dev or test")
    dataset = simulator.generate(participants, seed=seed, occasions=occasions)
    rng = random.Random(seed)
    summary: dict[str, Any] = {
        "engine": dataset.engine,
        "sessions": len(dataset.sessions),
        "batches": 0,
        "events": defaultdict(int),
    }
    languages = {s.language for s in dataset.sessions}
    with session_scope() as db:
        seed_svc.seed_reference(db, ACTOR)
        seed_svc.seed_demo_study(db, ACTOR, study_id)
        _approve_for_dev(db, list(instruments), languages)
        for kiosk_id in sorted({s.events[0]["context"]["kiosk_id"] for s in dataset.sessions if s.events}):
            seed_svc.ensure_kiosk(db, kiosk_id, "site-sim-01")

    # 1. kiosk uploads
    for s in dataset.sessions:
        kiosk_id = s.events[0]["context"]["kiosk_id"]
        principal = Principal(
            sub=f"kiosk:{kiosk_id}", roles=frozenset({Role.KIOSK_DEVICE}), kind="device", kiosk_id=kiosk_id
        )
        events = sorted(s.events, key=lambda e: e["seq"])
        for start in range(0, len(events), MAX_EVENTS_PER_BATCH):
            part = events[start : start + MAX_EVENTS_PER_BATCH]
            chunks = [
                {
                    "encryption": "none_dev",
                    "session_id": s.session_id,
                    "first_seq": part[0]["seq"],
                    "last_seq": part[-1]["seq"],
                    "event_count": len(part),
                    "events": part,
                }
            ]
            body = {
                "schema_version": "1.0",
                "batch_id": _uuid7(),
                "kiosk_id": kiosk_id,
                "kiosk_t_wall": part[-1]["timing"]["kiosk_t_wall"],
                "sha256": canonical_sha256(chunks),
                "event_count": len(part),
                "session_chunks": chunks,
            }
            with session_scope() as db:
                result = ingest_batch(db, json.dumps(body).encode(), principal, settings)
            summary["batches"] += 1
            for status, count in result["summary"].items():
                summary["events"][status] += count

    # 2. participants, consent, enrollment, linkage, criterion battery
    mapping = _construct_for_criterion()
    pepper = settings.key_bytes("pid_hmac_pepper")
    by_pid: dict[str, list[simulator.SyntheticSession]] = defaultdict(list)
    for s in dataset.sessions:
        by_pid[s.pid].append(s)
    scored = 0
    with session_scope() as db:
        study = db.get(Study, study_id)
        assert study is not None
        for pid, sessions in sorted(by_pid.items()):
            participant = db.get(Participant, pid)
            if participant is None:
                participant = Participant(
                    pid=pid,
                    pid_hmac=keyed_hmac(pepper, pid),
                    pepper_version=settings.pid_pepper_version,
                    study_id=study_id,
                    source="generated",
                    status="active",
                    created_by=ACTOR,
                )
                db.add(participant)
                db.flush()
            if not consent_svc.has_consent(db, "criterion", pid=pid):
                now = datetime.now(UTC)
                consent_svc.record_artefact(
                    db,
                    kind="criterion",
                    granted=True,
                    consent_script_id="criterion.synthetic",
                    script_audio_sha256=canonical_sha256("synthetic-consent"),
                    language=sessions[0].language,
                    policy_version="1.0.0",
                    presented_at=now,
                    decided_at=now,
                    recorded_by=ACTOR,
                    participant_pid=pid,
                )
            cell = {
                "language": sessions[0].language,
                "age_band": "*",
                "gender": "*",
                "edu_band": "*",
                "literacy_band": "*",
            }
            study_svc.enroll(
                db,
                study=study,
                participant=participant,
                cell=cell,
                cohort_id="holdout" if rng.random() < 0.15 else "main",
                eligibility={},
                actor=ACTOR,
                criterion_blocks=["A", "B", "C"],
            )
            for s in sessions:
                occasion_id = f"T{s.occasion}"
                session_row = db.get(GameSession, uuid.UUID(s.session_id))
                if session_row is None:
                    continue
                if (
                    db.execute(
                        select(ParticipantLink.id).where(ParticipantLink.session_id == session_row.session_id)
                    ).first()
                    is None
                ):
                    db.add(
                        ParticipantLink(
                            pid=pid,
                            session_id=session_row.session_id,
                            study_id=study_id,
                            occasion_id=occasion_id,
                            visit_number=s.occasion,
                            method="manual",
                            linked_by=ACTOR,
                            second_linker=f"{ACTOR}:second",
                            confidence=1.0,
                        )
                    )
                session_row.participant_pid = pid
                session_row.study_id = study_id
                session_row.occasion_id = occasion_id
                for instrument_id in instruments:
                    version = (
                        db.execute(
                            select(InstrumentVersion)
                            .where(InstrumentVersion.instrument_id == instrument_id)
                            .order_by(InstrumentVersion.created_at.desc())
                        )
                        .scalars()
                        .first()
                    )
                    assert version is not None
                    if criterion_svc.current_responses(
                        db, pid=pid, study_id=study_id, occasion_id=occasion_id, instrument_id=instrument_id
                    ):
                        continue
                    adm = criterion_svc.Administration(
                        pid=pid,
                        study_id=study_id,
                        wave=1,
                        occasion_id=occasion_id,
                        instrument_id=instrument_id,
                        instrument_version=version.version,
                        language=s.language,
                        block="X",
                        administration_mode="read_aloud",
                        administrator_id="synthetic-admin",
                        device_id="synthetic-tablet",
                        audio_version=None,
                        site_mode="supervised",
                        rater_role="self",
                        rated_pid=None,
                        source="in_app",
                        planned_missing_items=[],
                        responses=_simulated_responses(version.definition, s.latent, rng, mapping),
                    )
                    criterion_svc.submit_administration(db, adm, ACTOR)
                    scored += 1
            db.flush()
    summary["administrations"] = scored
    summary["participants"] = len(by_pid)

    if run_jobs:
        summary["jobs_run"] = drain(settings=settings, max_jobs=10_000)
    if build_snapshot:
        with session_scope() as db:
            snap = DatasetSnapshot(
                study_id=study_id,
                name=f"synthetic seed={seed}",
                status="building",
                spec={
                    "include_synthetic": True,
                    "require_game": True,
                    "require_criterion": True,
                    "holdout_cohorts": ["holdout"],
                    "pathway": None,
                    "occasion_ids": None,
                },
                created_by=ACTOR,
            )
            db.add(snap)
            db.flush()
            enqueue(db, "dataset_snapshot", {"snapshot_id": str(snap.snapshot_id)}, created_by=ACTOR, settings=settings)
            snapshot_id = snap.snapshot_id
        drain(settings=settings)
        runs: list[str] = []
        with session_scope() as db:
            snap_row = db.get(DatasetSnapshot, snapshot_id)
            summary["snapshot"] = {
                "snapshot_id": str(snapshot_id),
                "status": snap_row.status if snap_row else None,
                "rows": snap_row.row_count if snap_row else None,
            }
            if snap_row is not None and snap_row.status == "ready":
                for analysis in ("descriptives", "construct_validity"):
                    run = ValidationRun(
                        snapshot_id=snapshot_id, analysis=analysis, params={}, status="queued", created_by=ACTOR
                    )
                    db.add(run)
                    db.flush()
                    job_type = "construct_validity" if analysis == "construct_validity" else "validation_analysis"
                    enqueue(db, job_type, {"run_id": str(run.run_id)}, created_by=ACTOR, settings=settings)
                    runs.append(str(run.run_id))
        drain(settings=settings)
        with session_scope() as db:
            statuses: dict[str, str | None] = {}
            for r in runs:
                run_row = db.get(ValidationRun, uuid.UUID(r))
                statuses[r] = run_row.status if run_row is not None else None
            summary["validation_runs"] = statuses
    summary["events"] = dict(summary["events"])
    summary["generated_at"] = datetime.now(UTC).isoformat()
    return summary
