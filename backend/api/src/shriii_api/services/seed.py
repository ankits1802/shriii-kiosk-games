"""Seed reference content (instruments, trait registry, games, content versions) and a demo study."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from shriii_api import content
from shriii_api.auth.tokens import DEVICE_TOKEN_PREFIX
from shriii_api.canonical import sha256_hex
from shriii_api.db.models.ops import Kiosk
from shriii_api.db.models.study import Arm, Cohort, MeasurementOccasion, ProtocolVersion, Quota, Study
from shriii_api.db.models.validation import AnalysisPlan
from shriii_api.security import new_opaque_token, token_digest
from shriii_api.services import content_sync, criterion
from shriii_api.services.studies import cell_key

DEMO_STUDY_ID = "demo-s2-pilot"


def seed_reference(db: Session, actor: str) -> dict[str, Any]:
    return {
        "instruments": criterion.sync_instruments(db, actor),
        "dictionary": content_sync.sync_dictionary(db),
        "games": content_sync.sync_games(db),
        "content_versions": len(content_sync.record_content_versions(db, actor)),
    }


def seed_demo_study(db: Session, actor: str, study_id: str = DEMO_STUDY_ID) -> dict[str, Any]:
    """An S2-style pilot study with two arms, T1/T2 occasions (retest 14-28 days), quotas and a plan."""
    study = db.get(Study, study_id)
    if study is not None:
        return {"study_id": study_id, "created": False}
    study = Study(
        study_id=study_id,
        code="S2",
        name="Demo criterion pilot (synthetic)",
        stage="criterion_pilot",
        status="active",
        requires_prereg=True,
        prereg_id="demo-prereg",
        current_protocol_version="S2-pilot-v1",
        description="Demo study seeded for development; contains synthetic data only.",
        config={"pathways": ["B", "A"], "criterion_blocks": ["A", "B", "C"]},
        target_sample=400,
        power_record={"source": "VAL-02 pending", "note": "demo only"},
        created_by=actor,
    )
    db.add(study)
    db.flush()
    db.add(
        ProtocolVersion(
            study_id=study_id,
            version="S2-pilot-v1",
            document_sha256=sha256_hex("demo protocol"),
            summary="Demo protocol",
            effective_from=datetime.now(UTC),
            approved_by=[],
            created_by=actor,
        )
    )
    db.add(Cohort(study_id=study_id, cohort_id="main", name="Main pilot cohort", criteria={}, holdout=False))
    db.add(Cohort(study_id=study_id, cohort_id="holdout", name="Untouched holdout cohort", criteria={}, holdout=True))
    db.add(Arm(study_id=study_id, arm_id="B_fixed", ratio=1, description="Pathway B micro-game carousel"))
    db.add(Arm(study_id=study_id, arm_id="A_narrative", ratio=1, description="Pathway A linked episodes"))
    db.add(
        MeasurementOccasion(
            study_id=study_id,
            occasion_id="T1",
            wave=1,
            label="Baseline",
            sequence=1,
            instruments=["bscs", "bfi2_xs", "grit_s", "ders16", "hexaco_hh", "gdms"],
            game_required=True,
        )
    )
    db.add(
        MeasurementOccasion(
            study_id=study_id,
            occasion_id="T2",
            wave=1,
            label="Retest",
            sequence=2,
            offset_days_min=14,
            offset_days_max=28,
            instruments=["bfi2_xs", "bscs", "grit_s"],
            game_required=True,
        )
    )
    for language in ("hi-IN", "mr-IN", "ta-IN", "en-IN"):
        cell = {"language": language, "age_band": "*", "gender": "*", "edu_band": "*", "literacy_band": "*"}
        db.add(Quota(study_id=study_id, cell_key=cell_key(cell), cell=cell, target=100))
    hyp, gates = content.hypotheses(), content.gates()
    db.add(
        AnalysisPlan(
            study_id=study_id,
            version="0.1.0",
            prereg_id="demo-prereg",
            hypotheses_version=str(hyp.data["version"]),
            hypotheses_sha256=hyp.sha256,
            gates_version=str(gates.data["version"]),
            gates_sha256=gates.sha256,
            dictionary_sha256={p: content.dictionary_pathway(p).sha256 for p in ("A", "B")},
            document={"note": "demo registration of the draft hypotheses"},
            registered_by=actor,
        )
    )
    db.flush()
    return {"study_id": study_id, "created": True}


def ensure_kiosk(db: Session, kiosk_id: str, site_id: str) -> str | None:
    """Register a kiosk if missing; returns the new device token (None when it already existed)."""
    if db.execute(select(Kiosk.kiosk_id).where(Kiosk.kiosk_id == kiosk_id)).first() is not None:
        return None
    token = DEVICE_TOKEN_PREFIX + new_opaque_token(32)
    db.add(
        Kiosk(
            kiosk_id=kiosk_id,
            site_id=site_id,
            label=f"{kiosk_id} (seeded)",
            token_digest=token_digest(token),
            status="active",
            last_heartbeat={},
            health_status="unknown",
        )
    )
    db.flush()
    return token
