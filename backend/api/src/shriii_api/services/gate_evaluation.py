"""Evaluate trait and battery gates from a snapshot's persisted validation results (evaluate-only).

The evaluation reads the latest succeeded run of every analysis on the snapshot, the approved norm tables
and the named sign-offs recorded with the current trait gates, and runs the ``gates.yaml`` rules through
``shriii_validation.evaluate_gates``. It never promotes anything: it records the would-be status and the
reasons as a ``gate_evaluation`` validation run. Promotions stay a separate, signed admin action.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from shriii_api import content
from shriii_api.adapters import validation as validation_adapter
from shriii_api.db.models.validation import DatasetSnapshot, NormTableRecord, StatisticalResult, ValidationRun
from shriii_api.services import gates as gate_svc
from shriii_api.services import provenance as provenance_svc
from shriii_api.settings import Settings

GATE_EVALUATION = "gate_evaluation"


def latest_results(db: Session, snapshot_id: uuid.UUID) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Result rows of the latest succeeded run per analysis on the snapshot, and the run ids used."""
    runs = db.execute(
        select(ValidationRun)
        .where(
            ValidationRun.snapshot_id == snapshot_id,
            ValidationRun.status == "succeeded",
            ValidationRun.analysis != GATE_EVALUATION,
        )
        .order_by(ValidationRun.finished_at)
    ).scalars()
    latest: dict[str, ValidationRun] = {}
    for run in runs:
        latest[run.analysis] = run
    rows: list[dict[str, Any]] = []
    for analysis, run in sorted(latest.items()):
        for r in db.execute(select(StatisticalResult).where(StatisticalResult.run_id == run.run_id)).scalars():
            rows.append(
                {
                    "analysis": analysis,
                    "subject": r.subject,
                    "subject_kind": r.subject_kind,
                    "metric": r.metric,
                    "estimate": r.estimate,
                    "ci_low": r.ci_low,
                    "ci_high": r.ci_high,
                    "ci_level": r.ci_level,
                    "n": r.n,
                    "passed": r.passed,
                    "hypothesis_id": r.hypothesis_id,
                    "exploratory": r.exploratory,
                    "subgroup": r.subgroup,
                    "details": r.details,
                }
            )
    return rows, {a: str(r.run_id) for a, r in latest.items()}


def evaluate_snapshot_gates(
    db: Session,
    settings: Settings,
    snapshot: DatasetSnapshot,
    *,
    pathway: str,
    actor: str,
    languages: list[str] | None = None,
    site_modes: list[str] | None = None,
) -> ValidationRun:
    rows, run_ids = latest_results(db, snapshot.snapshot_id)
    langs = languages or sorted({str(r["subgroup"]["language"]) for r in rows if (r["subgroup"] or {}).get("language")})
    constructs = {c["id"]: dict(c) for c in content.dictionary_shared().data.get("constructs", [])}
    norms: dict[tuple[str, str], str] = {}
    for n in db.execute(
        select(NormTableRecord).where(NormTableRecord.status == "approved", NormTableRecord.pathway == pathway)
    ).scalars():
        norms[(n.trait, n.language)] = "provisional" if n.provisional else "final"
    signoffs: dict[tuple[str, str], list[str]] = {}
    for trait in constructs:
        for lang in langs:
            row = gate_svc.current_trait_gate(db, trait, lang, pathway)
            if row is not None and row.approvers:
                signoffs[(trait, lang)] = list(row.approvers)
    gates_doc = content.gates()
    evaluation = validation_adapter.evaluate_gates(
        rows,
        gates=gates_doc.data,
        constructs=constructs,
        hypotheses=content.hypotheses().data,
        pathway=pathway,
        languages=langs,
        site_modes=site_modes or ["supervised"],
        norms=norms,
        signoffs=signoffs,
        evaluate_only=True,
        gates_sha256=gates_doc.sha256,
    )
    prov = provenance_svc.base_provenance(settings, snapshot)
    run = ValidationRun(
        snapshot_id=snapshot.snapshot_id,
        analysis=GATE_EVALUATION,
        params={"pathway": pathway, "languages": langs, "site_modes": site_modes or ["supervised"]},
        hypothesis_ids=[],
        confirmatory=False,
        status="succeeded",
        engine=validation_adapter.engine_version(),
        created_by=actor,
        finished_at=datetime.now(UTC),
        manifest={
            "evaluate_only": True,
            "source_runs": run_ids,
            "norms_used": {f"{k[0]}|{k[1]}": v for k, v in norms.items()},
            "provenance": prov,
            "tier1_constructs": evaluation.get("tier1_constructs", []),
            "battery_evidence": evaluation.get("battery_evidence", {}),
        },
    )
    db.add(run)
    db.flush()
    for d in evaluation["trait_gates"]:
        db.add(
            StatisticalResult(
                run_id=run.run_id,
                subject=d["trait"],
                subject_kind="trait_gate",
                metric="trait_gate_status",
                estimate=None,
                ci_low=None,
                ci_high=None,
                ci_level=None,
                n=None,
                threshold=None,
                passed=d["evaluated_status"] in gate_svc.DISPLAYABLE,
                hypothesis_id=None,
                exploratory=False,
                method="gates.yaml trait gate B1-B6 (evaluate-only)",
                subgroup={"language": d["language"], "pathway": d["pathway"]},
                details=d,
                exclusions={},
                provenance=prov,
            )
        )
    for b in evaluation["battery_gates"]:
        db.add(
            StatisticalResult(
                run_id=run.run_id,
                subject="battery",
                subject_kind="battery_gate",
                metric="battery_gate_status",
                estimate=None,
                ci_low=None,
                ci_high=None,
                ci_level=None,
                n=None,
                threshold=None,
                passed=b["status"] == "open",
                hypothesis_id=None,
                exploratory=False,
                method="gates.yaml battery gate A1-A5 (evaluate-only)",
                subgroup={"language": b["language"], "pathway": b["pathway"], "site_mode": b["site_mode"]},
                details=b,
                exclusions={},
                provenance=prov,
            )
        )
    db.flush()
    return run
