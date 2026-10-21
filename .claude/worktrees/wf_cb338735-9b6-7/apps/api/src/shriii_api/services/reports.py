"""Participant report generation (layer 5; REP-01..03). Fails closed.

Display rule (plan section 7.7 C): a trait is shown iff battery gate (DB, language x pathway x
site_mode) is open with >= the required language groups AND the trait gate is validated_banded or
validated_broad_style (in the DB and in the release pack) AND the session is valid for report AND the
estimate is not "not enough to say" AND the release pack is valid, unexpired and matches the
dictionary AND ``report_mode = player_report``. Any failure or exception yields ``thank_you`` with no
traits. Demo reports are produced on the kiosk from fictional profiles and are refused here.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from shriii_contracts import ReportArtefact
from sqlalchemy import select
from sqlalchemy.orm import Session

from shriii_api.db.models.kiosk_raw import GameSession
from shriii_api.db.models.ops import Report
from shriii_api.db.models.scored import TraitEstimate
from shriii_api.errors import DomainError
from shriii_api.security import new_report_token, token_digest
from shriii_api.services import gates as gate_svc
from shriii_api.services import sessions as session_svc
from shriii_api.settings import Settings

log = logging.getLogger(__name__)
REPORT_ALGORITHM_VERSION = "api-report-gate-0.1.0"


class ReportError(DomainError):
    """Report error."""


@dataclass(slots=True)
class GeneratedReport:
    report: Report
    token: str
    qr_url: str


def _evaluate(db: Session, settings: Settings, session_row: GameSession, requested_mode: str) -> dict[str, Any]:
    """Return {'mode', 'traits', 'checks', 'pack'}; raises nothing the caller must handle (fail closed)."""
    checks: dict[str, Any] = {"requested_mode": requested_mode}
    traits: list[dict[str, Any]] = []
    pack_record = None
    if requested_mode != "player_report":
        checks["reason"] = "thank_you_requested"
        return {"mode": "thank_you", "traits": traits, "checks": checks, "pack": None}
    language, pathway, site_mode = session_row.language, session_row.pathway, session_row.site_mode
    checks["cell"] = {"language": language, "pathway": pathway, "site_mode": site_mode}
    failures: list[str] = []
    if not (language and pathway and site_mode):
        failures.append("session_cell_unknown")
    session_svc.update_validity(db, session_row)
    if not session_row.valid_for_report:
        failures.append("session_not_valid_for_report")
    pack_record = gate_svc.current_release_pack(db)
    pack: dict[str, Any] | None = pack_record.pack if pack_record else None
    if pack is None:
        failures.append("no_release_pack")
    else:
        problems = gate_svc.verify_release_pack(settings, pack)
        failures += [f"release_pack_{p}" for p in problems]
        session_dict = session_row.versions.get("scoring_dict_version")
        if pathway and session_dict and pack["dictionary_versions"].get(pathway) != session_dict:
            failures.append("release_pack_dictionary_version_mismatch")
    if not failures and language and pathway and site_mode and pack is not None:
        is_open, detail = gate_svc.battery_gate_open(db, language, pathway, site_mode)
        checks["battery_gate"] = detail
        pack_battery = next(
            (
                b
                for b in pack["battery_gates"]
                if (b["language"], b["pathway"], b["site_mode"]) == (language, pathway, site_mode)
            ),
            None,
        )
        if not is_open or pack_battery is None or pack_battery["status"] != "open":
            failures.append("battery_gate_closed")
    checks["failures"] = failures
    if failures or pack is None:
        return {"mode": "thank_you", "traits": [], "checks": checks, "pack": pack_record}

    cfg = gate_svc.gates_config()
    max_shown = int(cfg.get("report", {}).get("max_traits_shown", 5))
    allow = {(a["trait"], a["band"]): a["phrase_key"] for a in pack["phrase_allowlist"]}
    pack_traits = {(t["trait"], t["language"], t["pathway"]): t["status"] for t in pack["trait_gates"]}
    estimates = list(
        db.execute(
            select(TraitEstimate).where(TraitEstimate.session_id == session_row.session_id, TraitEstimate.is_current)
        ).scalars()
    )
    suppressed: dict[str, str] = {}
    candidates: list[tuple[float, dict[str, Any]]] = []
    for est in estimates:
        db_gate = gate_svc.current_trait_gate(db, est.trait, language or "", pathway or "")
        if db_gate is None or db_gate.status not in gate_svc.DISPLAYABLE:
            suppressed[est.trait] = "trait_gate_not_validated"
            continue
        if pack_traits.get((est.trait, language, pathway)) not in gate_svc.DISPLAYABLE:
            suppressed[est.trait] = "release_pack_trait_not_validated"
            continue
        if est.not_enough_to_say or est.band is None:
            suppressed[est.trait] = "not_enough_to_say"
            continue
        phrase = allow.get((est.trait, est.band))
        if phrase is None:
            suppressed[est.trait] = "phrase_not_allowlisted"
            continue
        candidates.append(
            (
                est.sem if est.sem is not None else float("inf"),
                {"trait": est.trait, "band": est.band, "phrase_key": phrase},
            )
        )
    candidates.sort(key=lambda c: (c[0], c[1]["trait"]))
    traits = [c[1] for c in candidates[:max_shown]]
    checks["suppressed"] = suppressed
    mode = "player_report" if traits else "thank_you"
    if not traits:
        checks.setdefault("failures", []).append("no_displayable_traits")
    return {"mode": mode, "traits": traits, "checks": checks, "pack": pack_record}


def generate_report(
    db: Session,
    settings: Settings,
    *,
    session_id: uuid.UUID,
    requested_mode: str,
    delivery_modes: list[str],
    ttl_hours: int | None,
    actor: str,
    template_id: str | None = None,
) -> GeneratedReport:
    if requested_mode == "demo":
        raise ReportError(
            422, "demo_not_server_side", "demo reports use fictional profiles on the kiosk and never session data"
        )
    session_row = db.get(GameSession, session_id)
    if session_row is None:
        raise ReportError(404, "unknown_session", "session not found")
    try:
        with db.begin_nested():
            outcome = _evaluate(db, settings, session_row, requested_mode)
    except Exception as exc:  # fail closed on anything unexpected
        log.exception("report gate evaluation failed; falling back to thank_you")
        outcome = {"mode": "thank_you", "traits": [], "checks": {"error": type(exc).__name__}, "pack": None}
    ttl = max(
        settings.report_token_ttl_hours,
        min(ttl_hours or settings.report_token_ttl_hours, settings.report_token_max_ttl_hours),
    )
    now = datetime.now(UTC)
    token = new_report_token()
    pack_record = outcome["pack"]
    norm_version: str | None = None
    provisional = True
    if outcome["traits"] and pack_record is not None:
        tables = [
            n
            for n in pack_record.pack["norm_tables"]
            if n["language"] == session_row.language
            and n["pathway"] == session_row.pathway
            and n["trait"] in {t["trait"] for t in outcome["traits"]}
        ]
        if tables:
            norm_version = max(n["norm_table_version"] for n in tables)
            provisional = any(n["provisional"] for n in tables)
    artefact = {
        "schema_version": "1.0",
        "report_id": str(uuid.uuid4()),
        "token": token,
        "session_id": str(session_id),
        "language": session_row.language or "en-IN",
        "report_mode": outcome["mode"],
        "demo_profile_id": None,
        "traits_shown": outcome["traits"],
        "disclaimer_key": gate_svc.DISCLAIMER_KEY,
        "norm_table_version": norm_version,
        "norm_provisional": provisional,
        "release_pack_version": pack_record.release_pack_version if (pack_record and outcome["traits"]) else None,
        "bundle_hash": session_row.versions.get("bundle_hash") or "0" * 64,
        "delivery_modes": sorted(set(delivery_modes)) or ["screen"],
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(hours=ttl)).isoformat(),
    }
    ReportArtefact.model_validate(artefact)
    stored = {k: v for k, v in artefact.items() if k != "token"}
    report = Report(
        report_id=uuid.UUID(artefact["report_id"]),
        token_digest=token_digest(token),
        session_id=session_id,
        language=artefact["language"],
        report_mode=outcome["mode"],
        requested_mode=requested_mode,
        traits_shown=outcome["traits"],
        artefact=stored,
        gate_evaluation={**outcome["checks"], "algorithm_version": REPORT_ALGORITHM_VERSION},
        template_id=template_id,
        expires_at=now + timedelta(hours=ttl),
        created_by=actor,
    )
    db.add(report)
    db.flush()
    return GeneratedReport(report=report, token=token, qr_url=f"{settings.public_base_url.rstrip('/')}/r/{token}")


def find_by_token(db: Session, token: str) -> Report | None:
    report = db.execute(select(Report).where(Report.token_digest == token_digest(token))).scalar_one_or_none()
    if report is None or report.withdrawn_at is not None or report.expires_at <= datetime.now(UTC):
        return None
    return report
