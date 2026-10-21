"""Job handlers (spec section 14). Each runs in one transaction with the job's completion record."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd
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
from shriii_api.db.models.scored import (
    GroupIndicatorValue,
    IndicatorValue,
    ScoringRun,
    TraitEstimate,
    TrialCanonical,
)
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
from shriii_api.services import provenance as provenance_svc
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


def batch_scoring(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    """Score every completed session of a study x pathway in one batch per language.

    Needed for model-based indicators (partial pooling within language x calibration level) and for the
    group-level private-report estimators, which per-session extraction leaves null. The batch rows become
    the current indicator values; group estimates go to ``scored.group_indicators`` (no person key).
    """
    study_id, pathway = str(ctx.inputs["study_id"]), str(ctx.inputs["pathway"])
    sessions = list(
        db.execute(
            select(GameSession).where(
                GameSession.study_id == study_id, GameSession.pathway == pathway, GameSession.status == "completed"
            )
        ).scalars()
    )
    if not sessions:
        return {"sessions": 0}
    by_language: dict[str, list[GameSession]] = {}
    for s in sessions:
        by_language.setdefault(s.language or "unknown", []).append(s)
    doc = content.dictionary_pathway(pathway)
    run = ScoringRun(
        kind="indicators_batch",
        algorithm_version="pending",
        engine="pending",
        dictionary_versions={pathway: str(doc.data["version"])},
        dictionary_sha256={pathway: doc.sha256},
        inputs={"study_id": study_id, "pathway": pathway, "sessions": len(sessions), "languages": sorted(by_language)},
        status="running",
        job_id=ctx.job_id,
    )
    db.add(run)
    db.flush()
    stats = {"sessions": 0, "indicator_rows": 0, "group_rows": 0, "suppressed_groups": 0}
    manifests: dict[str, Any] = {}
    algorithm = "unknown"
    for k, (language, group) in enumerate(sorted(by_language.items())):
        ctx.progress(0.05 + 0.9 * k / len(by_language), f"batch scoring {language} ({len(group)} sessions)")
        events: list[dict[str, Any]] = []
        for s in group:
            events += _session_events(db, s.session_id)
        try:
            out = scoring_adapter.score_batch(events, pathway, allow_synthetic=settings.is_dev)
        except AdapterUnavailableError as exc:
            raise PermanentJobError(str(exc)) from exc
        algorithm = out.algorithm
        manifests[language] = out.manifest
        rows_by_session = {s.session_id: s for s in group}
        for sid_text, rows in out.rows.items():
            row = rows_by_session.get(uuid.UUID(sid_text))
            if row is None:
                continue
            db.execute(
                update(IndicatorValue)
                .where(IndicatorValue.session_id == row.session_id, IndicatorValue.is_current.is_(True))
                .values(is_current=False)
            )
            for ind in rows:
                db.add(
                    IndicatorValue(
                        session_id=row.session_id,
                        participant_pid=row.participant_pid,
                        study_id=row.study_id,
                        occasion_id=row.occasion_id,
                        indicator_id=ind.indicator_id,
                        construct_id=ind.construct_id,
                        pathway=pathway,
                        value=ind.value,
                        n_valid_trials=ind.n_valid_trials,
                        status=ind.status,
                        quality_flags=ind.flags,
                        scoring_run_id=run.run_id,
                        is_current=True,
                        algorithm_version=out.algorithm,
                        dictionary_version=str(doc.data["version"]),
                        source_refs={"session_id": str(row.session_id), "batch_partition_language": language},
                        job_id=ctx.job_id,
                    )
                )
            stats["sessions"] += 1
            stats["indicator_rows"] += len(rows)
        db.flush()
        for g in out.group_rows:
            db.execute(
                update(GroupIndicatorValue)
                .where(
                    GroupIndicatorValue.study_id == study_id,
                    GroupIndicatorValue.pathway == pathway,
                    GroupIndicatorValue.indicator_id == g.indicator_id,
                    GroupIndicatorValue.partition == g.partition,
                    GroupIndicatorValue.is_current.is_(True),
                )
                .values(is_current=False)
            )
            suppressed = bool(g.details.get("suppressed_small_group")) or g.estimate is None
            db.add(
                GroupIndicatorValue(
                    study_id=study_id,
                    pathway=pathway,
                    partition=g.partition,
                    indicator_id=g.indicator_id,
                    construct_id=g.construct_id,
                    estimate=None if suppressed else g.estimate,
                    ci_low=None if suppressed else g.ci_low,
                    ci_high=None if suppressed else g.ci_high,
                    n_participants=g.n_participants,
                    n_reports=g.n_reports,
                    suppressed=suppressed,
                    details=g.details,
                    scoring_run_id=run.run_id,
                    is_current=True,
                    algorithm_version=out.algorithm,
                    dictionary_version=str(doc.data["version"]),
                    source_refs={"study_id": study_id, "sessions_in_partition_language": len(group)},
                    job_id=ctx.job_id,
                )
            )
            stats["group_rows"] += 1
            stats["suppressed_groups"] += int(suppressed)
        db.flush()
    run.algorithm_version = run.engine = algorithm
    run.status, run.finished_at = "succeeded", datetime.now(UTC)
    run.manifest = {"stats": stats, "engine_manifests": manifests}
    db.flush()
    return {**stats, "scoring_run_id": str(run.run_id)}


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


def _hypothesis_ids(run: ValidationRun) -> list[str]:
    return list(run.hypothesis_ids) if run.confirmatory else []


def validation_analysis(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    """Run one validation analysis on a ready/frozen snapshot and persist every row with N, CI,
    exclusions and provenance (snapshot id/sha256, dictionary sha256, algorithm version, git sha)."""
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
    ctx.progress(0.1, f"running {run.analysis}")
    context = provenance_svc.analysis_context(settings, snap, hypothesis_ids=_hypothesis_ids(run))
    params = dict(run.params)
    if snap.spec.get("holdout_cohorts") and "holdout_cohorts" not in params:
        params["holdout_cohorts"] = list(snap.spec["holdout_cohorts"])
    try:
        output = validation_adapter.run_analysis(run.analysis, frame, params=params, context=context)
    except (AdapterUnavailableError, ValueError, KeyError, ArithmeticError, np.linalg.LinAlgError) as exc:
        # Analyses are deterministic on a fixed snapshot: retrying cannot change the outcome.
        run.status = "failed"
        run.error = f"{type(exc).__name__}: {exc}"
        run.finished_at = datetime.now(UTC)
        db.flush()
        raise PermanentJobError(run.error) from exc
    run_prov = {**context["provenance"], "validation_run_id": str(run.run_id), "job_id": str(ctx.job_id)}
    db.query(StatisticalResult).filter(StatisticalResult.run_id == run.run_id).delete()
    for r in output.results:
        db.add(
            StatisticalResult(
                run_id=run.run_id,
                subject=r.subject[:256],
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
                method=r.method[:128],
                subgroup=r.subgroup,
                details=r.details,
                exclusions={**r.exclusions, "frame": output.exclusions.get("by_reason", {})},
                provenance={**run_prov, **r.provenance},
            )
        )
    run.status = "succeeded"
    run.engine = output.engine
    run.finished_at = datetime.now(UTC)
    run.manifest = {
        "snapshot_id": str(snap.snapshot_id),
        "snapshot_sha256": snap.sha256,
        "snapshot_manifest": snap.manifest.get("parquet_sha256"),
        "rows": len(frame),
        "results": len(output.results),
        "notes": output.notes,
        "exclusions": output.exclusions,
        "snapshot_exclusions": snap.exclusions,
        "provenance": {**output.provenance, **run_prov},
        "gates_sha256": content.gates().sha256,
        "hypotheses_sha256": content.hypotheses().sha256,
        "dictionary_sha256": provenance_svc.dictionary_hashes(),
        "git_sha": run_prov["git_sha"],
    }
    db.flush()
    return {"results": len(output.results), "engine": output.engine}


def model_training(db: Session, settings: Settings, ctx: JobContext) -> dict[str, Any]:
    tr = db.get(TrainingRun, uuid.UUID(ctx.inputs["training_run_id"]), with_for_update=True)
    if tr is None:
        raise PermanentJobError("training run not found")
    model = db.get(ModelVersion, tr.model_id)
    if model is None:
        raise PermanentJobError("model version not found")
    snap = db.get(DatasetSnapshot, model.snapshot_id)
    if snap is None:
        raise PermanentJobError("snapshot not found")
    tr.status = "running"
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
    except (AdapterUnavailableError, ValueError, KeyError, FileNotFoundError) as exc:
        tr.status, tr.error, tr.finished_at = "failed", f"{type(exc).__name__}: {exc}", datetime.now(UTC)
        model.status = "failed"
        db.flush()
        raise PermanentJobError(tr.error) from exc
    prov = {**provenance_svc.base_provenance(settings, snap), "training_run_id": str(tr.run_id)}
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
                details={
                    "ci_low": stats.get("ci_low"),
                    "ci_high": stats.get("ci_high"),
                    "ci_level": 0.95,
                    "fold_mean": stats.get("fold_mean"),
                    "ci_method": "participant-clustered bootstrap of out-of-fold predictions",
                },
            )
        )
    holdout_ci = (out.details.get("holdout") or {}).get("ci", {})
    for metric, value in out.holdout_metrics.items():
        ci = holdout_ci.get(metric) or [None, None]
        db.add(
            ModelEvaluation(
                model_id=model.model_id,
                training_run_id=tr.run_id,
                split="holdout",
                metric=metric,
                value=value,
                sd=None,
                n=out.n_holdout,
                details={"ci_low": ci[0], "ci_high": ci[1], "ci_level": 0.95, "holdout_cohort": model.holdout_cohort},
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
    tr.cv_scheme = {**tr.cv_scheme, **(out.details.get("cv_scheme") or {})}
    tr.metrics = {
        "cv": out.cv_metrics,
        "holdout": out.holdout_metrics,
        "n_train": out.n_train,
        "n_holdout": out.n_holdout,
        "grouping": "research_id (participant)",
        "details": out.details,
        "provenance": prov,
    }
    model.status = "trained"
    db.flush()
    return {"cv": out.cv_metrics, "holdout": out.holdout_metrics}


def _norm_frame(frame: pd.DataFrame, inputs: dict[str, Any], pathway: str) -> pd.DataFrame:
    """One language x pathway x occasion slice of the snapshot without the untouched holdout cohort."""
    if inputs.get("language"):
        frame = frame[frame["language"] == inputs["language"]]
    if "pathway" in frame.columns:
        frame = frame[frame["pathway"].astype(str) == pathway]
    if "occasion_id" in frame.columns:
        occasions = sorted(str(o) for o in frame["occasion_id"].dropna().unique())
        if occasions:
            frame = frame[frame["occasion_id"].astype(str) == str(inputs.get("occasion_id") or occasions[0])]
    if "holdout" in frame.columns:
        frame = frame[~frame["holdout"].fillna(False).astype(bool)]
    return frame


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
    if not indicators:
        raise PermanentJobError(f"no gate-eligible individual indicators for {trait} in pathway {pathway}")
    directions = {ind["id"]: str(ind.get("direction", "")) for ind in indicators}
    ci_level = float(i.get("ci_level", 0.90))
    try:
        frame = _norm_frame(snapshot_svc.load_snapshot_frame(settings, snap), i, pathway)
        out = validation_adapter.generate_norms(
            frame,
            indicator_ids=list(directions),
            directions=directions,
            reliability=float(i["reliability"]),
            quantiles=list(i.get("quantiles", [1 / 3, 2 / 3])),
            ci_level=ci_level,
            gates=gate_svc.gates_config(),
            trait=trait,
            norm_table_version=str(i["norm_table_version"]),
            weights=i.get("weights_column"),
        )
    except (AdapterUnavailableError, ValueError, FileNotFoundError, KeyError) as exc:
        raise PermanentJobError(f"{type(exc).__name__}: {exc}") from exc
    standardisation = out.details.get("standardisation", {})
    used = list(out.details.get("indicators", list(directions)))
    comp_inds = [
        {
            "indicator_id": ind_id,
            "weight": 1.0 / max(1, len(used)),
            "mean": float(standardisation[ind_id]["mean"]),
            "sd": float(standardisation[ind_id]["sd"]),
            "direction": "negative" if directions.get(ind_id, "").endswith("less") else "positive",
        }
        for ind_id in used
        if ind_id in standardisation
    ]
    record = NormTableRecord(
        norm_table_version=i["norm_table_version"],
        trait=trait,
        pathway=pathway,
        language=i["language"],
        reference_population_id=uuid.UUID(i["reference_population_id"]) if i.get("reference_population_id") else None,
        cut_points=out.cut_points,
        sem=out.sem,
        ci_level=ci_level,
        provisional=True,
        effective_n=out.effective_n,
        method=out.method,
        coefficients={
            **out.details,
            "composite": {"method": "unit_weighted_z", "indicators": comp_inds},
            "engine_provisional": out.provisional,
            "provenance": {**out.details.get("provenance", {}), **provenance_svc.base_provenance(settings, snap)},
        },
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
    return {
        "norm_table_id": str(record.id),
        "cut_points": out.cut_points,
        "sem": out.sem,
        "effective_n": out.effective_n,
    }


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
    "batch_scoring": batch_scoring,
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

__all__ = ["FAILURE_HOOKS", "HANDLERS", "JobContext"]
