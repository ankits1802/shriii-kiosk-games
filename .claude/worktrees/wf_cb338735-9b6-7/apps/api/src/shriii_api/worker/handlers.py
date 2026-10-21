"""Job handlers (spec section 14). Each runs in one transaction with the job's completion record."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pandas as pd  # type: ignore[import-untyped]
from pydantic import ValidationError
from shriii_contracts import EVENT_ADAPTER, check_event_invariants, check_session_sequence
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from shriii_api import content
from shriii_api.adapters import scoring as scoring_adapter
from shriii_api.adapters import validation as validation_adapter
from shriii_api.adapters.scoring import AdapterUnavailableError
from shriii_api.db.models.kiosk_raw import Event, GameSession
from shriii_api.db.models.ops import Kiosk, SystemEvent
from shriii_api.db.models.scored import IndicatorValue, ScoringRun, TraitEstimate, TrialCanonical
from shriii_api.db.models.validation import (
    DatasetSnapshot,
    ModelEvaluation,
    ModelVersion,
    NormTableRecord,
    Prediction,
    StatisticalResult,
    TrainingRun,
    ValidationRun,
)
from shriii_api.db.partitions import ensure_upcoming_partitions
from shriii_api.services import criterion as criterion_svc
from shriii_api.services import erasure as erasure_svc
from shriii_api.services import gates as gate_svc
from shriii_api.services import retention as retention_svc
from shriii_api.services import sessions as session_svc
from shriii_api.services import snapshots as snapshot_svc
from shriii_api.settings import Settings
from shriii_api.worker.queue import PermanentJobError, enqueue, requeue_stale


@dataclass(slots=True)
class JobContext:
    job_id: uuid.UUID
    job_type: str
    inputs: dict[str, Any]
    created_by: str
    attempt: int
    progress: Callable[[float, str | None], None]


Handler = Callable[[Session, Settings, JobContext], dict[str, Any]]


def _session_events(db: Session, session_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = db.execute(select(Event.envelope).where(Event.session_id == session_id).order_by(Event.seq)).scalars()
    return [dict(r) for r in rows]


def _session(db: Session, ctx: JobContext) -> GameSession:
    sid = uuid.UUID(str(ctx.inputs["session_id"]))
    row = db.get(GameSession, sid)
    if row is None:
        raise PermanentJobError(f"session {sid} not found (erased?)")
    return row


# ---------------------------------------------------------------- layer 1 -> trials -> layer 2


def event_validation(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    row = _session(db, ctx)
    events = _session_events(db, row.session_id)
    parsed = []
    violations: list[dict[str, str]] = []
    for e in events:
        try:
            ev = EVENT_ADAPTER.validate_python(e)
        except ValidationError as exc:
            violations.append(
                {"event_id": e.get("event_id", ""), "code": "schema_violation", "message": str(exc)[:200]}
            )
            continue
        parsed.append(ev)
        violations += [
            {"event_id": ev.event_id, "code": v.code, "message": v.message}
            for v in check_event_invariants(ev, origin="server")
        ]
    seq_issues = [v for v in check_session_sequence(parsed) if v.code != "seq_gap"]
    for v in seq_issues:
        violations.append({"event_id": "", "code": v.code, "message": v.message})
    if any(v["code"] == "missing_session_start" for v in violations):
        session_svc.raise_flag(db, row.session_id, "missing_session_start", "blocking", {})
    session_svc.refresh_integrity(db, row)
    session_svc.update_validity(db, row)
    return {"checked": len(events), "violations": violations[:100], "violation_count": len(violations)}


def trial_eligibility(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    row = _session(db, ctx)
    events = _session_events(db, row.session_id)
    trials, algorithm = scoring_adapter.canonical_trials(events)
    dictionary_version = row.versions.get("scoring_dict_version")
    db.query(TrialCanonical).filter(TrialCanonical.session_id == row.session_id).delete()
    for t in trials:
        db.add(
            TrialCanonical(
                session_id=row.session_id,
                participant_pid=row.participant_pid,
                episode_id=t.episode_id,
                module_id=t.module_id,
                block_id=t.block_id,
                trial_id=t.trial_id,
                trial_index=t.trial_index,
                phase=t.phase,
                condition_id=t.condition_id,
                scorable=t.scorable,
                start_seq=t.start_seq,
                end_seq=t.end_seq,
                outcome=t.outcome,
                correctness=t.correctness,
                latency_ms=t.latency_ms,
                input_mode=t.input_mode,
                timing_flag=t.timing_flag,
                interrupted=t.interrupted,
                complete=t.complete,
                eligible=t.eligible,
                exclusion_reasons=t.exclusion_reasons,
                algorithm_version=algorithm,
                dictionary_version=dictionary_version,
                source_refs={"session_id": str(row.session_id), "seq_range": [t.start_seq, t.end_seq]},
                job_id=ctx.job_id,
            )
        )
    incomplete = sum(1 for t in trials if not t.complete)
    if incomplete:
        session_svc.raise_flag(db, row.session_id, "missing_trial_end", "warn", {"trials": incomplete})
    session_svc.update_validity(db, row)
    db.flush()
    next_job = None
    if row.pathway is not None and row.status == "completed":
        next_job = enqueue(
            db,
            "feature_extraction",
            dict(ctx.inputs),
            created_by=ctx.created_by,
            settings=settings,
            parent_job_id=ctx.job_id,
            priority=60,
        )
    return {
        "trials": len(trials),
        "eligible": sum(1 for t in trials if t.eligible),
        "algorithm": algorithm,
        "next_job_id": str(next_job.job_id) if next_job else None,
    }


def feature_extraction(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    row = _session(db, ctx)
    if row.pathway is None:
        raise PermanentJobError("session has no pathway (battery arm unknown)")
    events = _session_events(db, row.session_id)
    try:
        indicators, algorithm = scoring_adapter.extract_indicators(
            events, row.pathway, allow_synthetic=settings.is_dev and row.synthetic
        )
    except AdapterUnavailableError as exc:
        raise PermanentJobError(str(exc)) from exc
    doc = content.dictionary_pathway(row.pathway)
    run = ScoringRun(
        kind="indicators",
        algorithm_version=algorithm,
        engine=algorithm,
        dictionary_versions={row.pathway: str(doc.data["version"])},
        dictionary_sha256={row.pathway: doc.sha256},
        inputs={"session_id": str(row.session_id), "events": len(events)},
        status="succeeded",
        job_id=ctx.job_id,
        finished_at=datetime.now(UTC),
    )
    db.add(run)
    db.flush()
    db.execute(
        update(IndicatorValue)
        .where(IndicatorValue.session_id == row.session_id, IndicatorValue.is_current.is_(True))
        .values(is_current=False)
    )
    event_ids = [e["event_id"] for e in events]
    for ind in indicators:
        db.add(
            IndicatorValue(
                session_id=row.session_id,
                participant_pid=row.participant_pid,
                study_id=row.study_id,
                occasion_id=row.occasion_id,
                indicator_id=ind.indicator_id,
                construct_id=ind.construct_id,
                pathway=row.pathway,
                value=ind.value,
                n_valid_trials=ind.n_valid_trials,
                status=ind.status,
                quality_flags=ind.flags,
                scoring_run_id=run.run_id,
                is_current=True,
                algorithm_version=algorithm,
                dictionary_version=str(doc.data["version"]),
                source_refs={
                    "session_id": str(row.session_id),
                    "event_count": len(event_ids),
                    "first_event_id": event_ids[0] if event_ids else None,
                    "last_event_id": event_ids[-1] if event_ids else None,
                },
                job_id=ctx.job_id,
            )
        )
    db.flush()
    return {"indicators": len(indicators), "scoring_run_id": str(run.run_id), "algorithm": algorithm}


def questionnaire_scoring(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    i = ctx.inputs
    try:
        run = criterion_svc.rescore(
            db,
            pid=i["pid"],
            study_id=i["study_id"],
            occasion_id=i["occasion_id"],
            instrument_id=i["instrument_id"],
            actor=ctx.created_by,
            job_id=ctx.job_id,
        )
    except criterion_svc.CriterionError as exc:
        raise PermanentJobError(exc.message) from exc
    return {"scoring_run_id": str(run.run_id)}


def participant_matching(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    return snapshot_svc.refresh_matched_records(db, str(ctx.inputs["study_id"]), ctx.job_id)


def dataset_snapshot(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    i = ctx.inputs
    if "snapshot_id" in i:
        snap = db.get(DatasetSnapshot, uuid.UUID(i["snapshot_id"]), with_for_update=True)
        if snap is None:
            raise PermanentJobError("snapshot not found")
        if snap.status in ("frozen", "tombstoned"):
            raise PermanentJobError(f"snapshot is {snap.status}; build a new one")
    else:
        old = db.get(DatasetSnapshot, uuid.UUID(i["rebuild_of"]))
        name = f"{old.name} (rebuilt)" if old else "rebuilt snapshot"
        snap = DatasetSnapshot(
            study_id=i["study_id"],
            name=name,
            version=(old.version + 1) if old else 1,
            status="building",
            spec=dict(i.get("spec") or {}),
            created_by=ctx.created_by,
            supersedes_id=old.snapshot_id if old else None,
        )
        db.add(snap)
        db.flush()
    ctx.progress(0.1, "collecting matched records")
    snapshot_svc.build_snapshot(db, settings, snap, ctx.job_id)
    return {"snapshot_id": str(snap.snapshot_id), "rows": snap.row_count, "sha256": snap.sha256}


def _dictionary_context(pathway: str | None, hypothesis_ids: list[str]) -> dict[str, Any]:
    pathways = [pathway] if pathway in ("A", "B") else ["A", "B"]
    indicators: list[dict[str, Any]] = []
    seen: set[str] = set()
    for p in pathways:
        for ind in content.dictionary_pathway(p).data.get("indicators", []):
            if ind["id"] not in seen:
                seen.add(ind["id"])
                indicators.append(ind)
    constructs = {c["id"]: c for c in content.dictionary_shared().data.get("constructs", [])}
    return {"indicators": indicators, "constructs": constructs, "hypothesis_ids": hypothesis_ids}


def validation_analysis(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    run = db.get(ValidationRun, uuid.UUID(ctx.inputs["run_id"]), with_for_update=True)
    if run is None:
        raise PermanentJobError("validation run not found")
    snap = db.get(DatasetSnapshot, run.snapshot_id)
    if snap is None:
        raise PermanentJobError("snapshot not found")
    try:
        frame = snapshot_svc.load_snapshot_frame(settings, snap)
    except (ValueError, FileNotFoundError) as exc:
        raise PermanentJobError(str(exc)) from exc
    run.status = "running"
    try:
        output = validation_adapter.run_analysis(
            run.analysis,
            frame,
            params=run.params,
            context=_dictionary_context(snap.spec.get("pathway"), run.hypothesis_ids if run.confirmatory else []),
            gates=gate_svc.gates_config(),
        )
    except (AdapterUnavailableError, ValueError, KeyError) as exc:
        run.status = "failed"
        run.error = str(exc)
        run.finished_at = datetime.now(UTC)
        db.flush()
        raise PermanentJobError(str(exc)) from exc
    db.query(StatisticalResult).filter(StatisticalResult.run_id == run.run_id).delete()
    for r in output.results:
        db.add(
            StatisticalResult(
                run_id=run.run_id,
                subject=r.subject,
                subject_kind=r.subject_kind,
                metric=r.metric,
                estimate=r.estimate,
                ci_low=r.ci_low,
                ci_high=r.ci_high,
                ci_level=r.ci_level,
                n=r.n,
                threshold=r.threshold,
                passed=r.passed,
                hypothesis_id=r.hypothesis_id,
                exploratory=r.exploratory or not run.confirmatory,
                method=r.method,
                subgroup=r.subgroup,
                details=r.details,
            )
        )
    run.status = "succeeded"
    run.engine = output.engine
    run.finished_at = datetime.now(UTC)
    run.manifest = {
        "snapshot_sha256": snap.sha256,
        "snapshot_manifest": snap.manifest.get("parquet_sha256"),
        "rows": len(frame),
        "results": len(output.results),
        "notes": output.notes,
        "gates_sha256": content.gates().sha256,
        "hypotheses_sha256": content.hypotheses().sha256,
    }
    db.flush()
    return {"results": len(output.results), "engine": output.engine}


def model_training(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    tr = db.get(TrainingRun, uuid.UUID(ctx.inputs["training_run_id"]), with_for_update=True)
    if tr is None:
        raise PermanentJobError("training run not found")
    model = db.get(ModelVersion, tr.model_id)
    assert model is not None
    snap = db.get(DatasetSnapshot, model.snapshot_id)
    if snap is None:
        raise PermanentJobError("snapshot not found")
    try:
        frame = snapshot_svc.load_snapshot_frame(settings, snap)
        out = validation_adapter.train_model(
            frame,
            features=model.features,
            target=model.target,
            algorithm=model.algorithm,
            params=model.params,
            holdout_cohort=model.holdout_cohort,
        )
    except (AdapterUnavailableError, ValueError, FileNotFoundError) as exc:
        tr.status, tr.error, tr.finished_at = "failed", str(exc), datetime.now(UTC)
        model.status = "failed"
        db.flush()
        raise PermanentJobError(str(exc)) from exc
    for metric, stats in out.cv_metrics.items():
        db.add(
            ModelEvaluation(
                model_id=model.model_id,
                training_run_id=tr.run_id,
                split="cv",
                metric=metric,
                value=stats.get("mean"),
                sd=stats.get("sd"),
                n=out.n_train,
            )
        )
    for metric, value in out.holdout_metrics.items():
        db.add(
            ModelEvaluation(
                model_id=model.model_id,
                training_run_id=tr.run_id,
                split="holdout",
                metric=metric,
                value=value,
                sd=None,
                n=out.n_holdout,
            )
        )
    for p in out.predictions:
        db.add(
            Prediction(
                model_id=model.model_id,
                training_run_id=tr.run_id,
                research_id=p["research_id"],
                occasion_id=p.get("occasion_id"),
                fold=p.get("fold"),
                split=p["split"],
                predicted=p["predicted"],
                observed=p.get("observed"),
            )
        )
    tr.status, tr.engine, tr.finished_at = "succeeded", out.engine, datetime.now(UTC)
    tr.metrics = {
        "cv": out.cv_metrics,
        "holdout": out.holdout_metrics,
        "n_train": out.n_train,
        "n_holdout": out.n_holdout,
        "grouping": "research_id (participant)",
    }
    model.status = "trained"
    db.flush()
    return {"cv": out.cv_metrics, "holdout": out.holdout_metrics}


def norm_generation(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    i = ctx.inputs
    snap = db.get(DatasetSnapshot, uuid.UUID(i["snapshot_id"]))
    if snap is None:
        raise PermanentJobError("snapshot not found")
    pathway, trait = i["pathway"], i["trait"]
    indicators = [
        ind
        for ind in content.dictionary_pathway(pathway).data.get("indicators", [])
        if ind["construct"] == trait and ind.get("gate_eligible") and not ind.get("group_only")
    ]
    directions = {ind["id"]: str(ind.get("direction", "")) for ind in indicators}
    try:
        frame = snapshot_svc.load_snapshot_frame(settings, snap)
        if i.get("language"):
            frame = frame[frame["language"] == i["language"]]
        out = validation_adapter.generate_norms(
            frame,
            indicator_ids=list(directions),
            directions=directions,
            reliability=float(i["reliability"]),
            quantiles=list(i.get("quantiles", [1 / 3, 2 / 3])),
            ci_level=float(i.get("ci_level", 0.90)),
        )
    except (AdapterUnavailableError, ValueError, FileNotFoundError, KeyError) as exc:
        raise PermanentJobError(str(exc)) from exc
    used = out.details.get("indicators", list(directions))
    comp_inds = []
    for ind_id in used:
        col = frame[f"ind__{ind_id}"].astype(float)
        comp_inds.append(
            {
                "indicator_id": ind_id,
                "weight": 1.0 / max(1, len(used)),
                "mean": float(col.mean()),
                "sd": float(col.std(ddof=1)) if col.notna().sum() > 1 else 0.0,
                "direction": "negative" if directions.get(ind_id, "").endswith("less") else "positive",
            }
        )
    record = NormTableRecord(
        norm_table_version=i["norm_table_version"],
        trait=trait,
        pathway=pathway,
        language=i["language"],
        reference_population_id=uuid.UUID(i["reference_population_id"]) if i.get("reference_population_id") else None,
        cut_points=out.cut_points,
        sem=out.sem,
        ci_level=float(i.get("ci_level", 0.90)),
        provisional=True,
        effective_n=out.effective_n,
        method=out.method,
        coefficients={"composite": {"method": "unit_weighted_z", "indicators": comp_inds}, **out.details},
        status="draft",
        created_by=ctx.created_by,
        algorithm_version=out.engine,
        dictionary_version=str(content.dictionary_pathway(pathway).data["version"]),
        source_refs={"snapshot_id": str(snap.snapshot_id), "snapshot_sha256": snap.sha256},
        data_snapshot_id=snap.snapshot_id,
        job_id=ctx.job_id,
    )
    db.add(record)
    db.flush()
    return {"norm_table_id": str(record.id), "cut_points": out.cut_points, "sem": out.sem}


def report_preparation(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    row = _session(db, ctx)
    pack = gate_svc.current_release_pack(db)
    if pack is None or row.pathway is None or row.language is None:
        return {"skipped": "no release pack or session cell unknown"}
    values = {
        iv.indicator_id: iv.value
        for iv in db.execute(
            select(IndicatorValue).where(IndicatorValue.session_id == row.session_id, IndicatorValue.is_current)
        ).scalars()
    }
    try:
        estimates, algorithm = scoring_adapter.estimate_traits(
            values,
            pack.pack,
            pathway=row.pathway,
            language=row.language,
            sem_rule=gate_svc.gates_config()["trait_gate"]["norms"]["sem_rule"],
        )
    except AdapterUnavailableError as exc:
        raise PermanentJobError(str(exc)) from exc
    db.execute(
        update(TraitEstimate)
        .where(TraitEstimate.session_id == row.session_id, TraitEstimate.is_current.is_(True))
        .values(is_current=False)
    )
    for e in estimates:
        db.add(
            TraitEstimate(
                session_id=row.session_id,
                participant_pid=row.participant_pid,
                trait=e.trait,
                pathway=row.pathway,
                language=row.language,
                composite=e.composite,
                sem=e.sem,
                band=e.band,
                not_enough_to_say=e.not_enough_to_say,
                release_pack_version=pack.release_pack_version,
                is_current=True,
                algorithm_version=algorithm,
                dictionary_version=row.versions.get("scoring_dict_version"),
                source_refs={"indicator_ids": sorted(values)},
                job_id=ctx.job_id,
            )
        )
    db.flush()
    return {"estimates": len(estimates)}


def kiosk_health(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    now = datetime.now(UTC)
    stale_before = now - timedelta(minutes=settings.kiosk_heartbeat_stale_minutes)
    stale = 0
    for kiosk in db.execute(select(Kiosk).where(Kiosk.status == "active")).scalars():
        healthy = kiosk.last_heartbeat_at is not None and kiosk.last_heartbeat_at >= stale_before
        new_status = "healthy" if healthy else "stale"
        if new_status != kiosk.health_status and new_status == "stale":
            db.add(
                SystemEvent(
                    kind="kiosk_stale",
                    severity="warn",
                    kiosk_id=kiosk.kiosk_id,
                    details={"last_heartbeat_at": str(kiosk.last_heartbeat_at)},
                )
            )
        stale += int(not healthy)
        kiosk.health_status = new_status
    ensure_upcoming_partitions(db, now.date(), days=7)
    requeued = requeue_stale(db, settings.job_lease_s)
    return {"stale_kiosks": stale, "requeued_jobs": requeued}


def consent_parking_expiry(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    from shriii_api.db.session import set_mutation_purpose  # noqa: PLC0415

    set_mutation_purpose(db, "retention")
    count = retention_svc._HANDLERS["consent_parking_expired"](
        db, settings, datetime.now(UTC), datetime.now(UTC), False
    )
    return {"dead_lettered": count}


def erasure(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    try:
        receipt = erasure_svc.execute_erasure(db, settings, uuid.UUID(ctx.inputs["request_id"]), ctx.created_by)
    except erasure_svc.ErasureBlockedError as exc:
        raise PermanentJobError(str(exc)) from exc
    return {"receipt_id": str(receipt.receipt_id), "counts": receipt.body.get("counts", {})}


def retention(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    run = retention_svc.run_retention(
        db, settings, dry_run=bool(ctx.inputs.get("dry_run", False)), triggered_by=ctx.created_by
    )
    return {"retention_run_id": str(run.id), "report": run.report}


# ---------------------------------------------------------------- terminal-failure hooks


def _fail_validation_run(db: Session, inputs: dict[str, Any], error: str) -> None:
    run = db.get(ValidationRun, uuid.UUID(inputs["run_id"]))
    if run is not None and run.status not in ("succeeded",):
        run.status, run.error, run.finished_at = "failed", error[:4000], datetime.now(UTC)


def _fail_training(db: Session, inputs: dict[str, Any], error: str) -> None:
    tr = db.get(TrainingRun, uuid.UUID(inputs["training_run_id"]))
    if tr is not None:
        tr.status, tr.error, tr.finished_at = "failed", error[:4000], datetime.now(UTC)
        model = db.get(ModelVersion, tr.model_id)
        if model is not None:
            model.status = "failed"


def _fail_snapshot(db: Session, inputs: dict[str, Any], error: str) -> None:
    if "snapshot_id" in inputs:
        snap = db.get(DatasetSnapshot, uuid.UUID(inputs["snapshot_id"]))
        if snap is not None and snap.status == "building":
            snap.status, snap.error = "failed", error[:4000]


def _fail_erasure(db: Session, inputs: dict[str, Any], error: str) -> None:
    from shriii_api.db.models.participants import ErasureRequest  # noqa: PLC0415

    req = db.get(ErasureRequest, uuid.UUID(inputs["request_id"]))
    if req is not None and req.status != "completed":
        req.status = "blocked_legal_hold" if "legal hold" in error else "failed"
        req.error = error[:4000]


FAILURE_HOOKS: dict[str, Callable[[Session, dict[str, Any], str], None]] = {
    "reliability": _fail_validation_run,
    "construct_validity": _fail_validation_run,
    "fairness": _fail_validation_run,
    "validation_analysis": _fail_validation_run,
    "model_training": _fail_training,
    "dataset_snapshot": _fail_snapshot,
    "erasure": _fail_erasure,
}


HANDLERS: dict[str, Handler] = {
    "event_validation": event_validation,
    "trial_eligibility": trial_eligibility,
    "feature_extraction": feature_extraction,
    "questionnaire_scoring": questionnaire_scoring,
    "participant_matching": participant_matching,
    "dataset_snapshot": dataset_snapshot,
    "reliability": validation_analysis,
    "construct_validity": validation_analysis,
    "fairness": validation_analysis,
    "validation_analysis": validation_analysis,
    "model_training": model_training,
    "norm_generation": norm_generation,
    "report_preparation": report_preparation,
    "kiosk_health": kiosk_health,
    "consent_parking_expiry": consent_parking_expiry,
    "erasure": erasure,
    "retention": retention,
}

__all__ = ["FAILURE_HOOKS", "HANDLERS", "JobContext", "pd"]
