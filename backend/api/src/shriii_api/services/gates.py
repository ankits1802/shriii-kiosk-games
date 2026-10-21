"""Gate service records and release packs (VAL-14, REP-03).

Thresholds come from ``stats/measurement-model/gates.yaml``.

Gate history is append-only; the current status per key is the latest row whose ``effective_from`` is
not in the future. Missing rows mean ``closed`` / ``unvalidated`` (fail closed). Promotions need
evidence ids and the number of distinct named approvers required by ``gates.yaml``; caps and
permanent withholds from ``gates.yaml`` are enforced on write.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from shriii_contracts import ReleasePack
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from shriii_api import content
from shriii_api.canonical import canonical_bytes
from shriii_api.db.models.validation import (
    BatteryGate,
    NormTableRecord,
    ReleasePackRecord,
    ScoreInterpretation,
    TraitGate,
)
from shriii_api.errors import DomainError
from shriii_api.security import ed25519_public_key, sign_ed25519, verify_ed25519
from shriii_api.services import report_policy
from shriii_api.settings import Settings

TRAIT_STATUS_ORDER = ("withheld", "unvalidated", "research_only", "validated_broad_style", "validated_banded")
DISPLAYABLE = frozenset({"validated_banded", "validated_broad_style"})
DISCLAIMER_KEY = "report.disclaimer.session_snapshot"


class GateError(DomainError):
    """Gate error."""


def gates_config() -> dict[str, Any]:
    return content.gates().data


def _now() -> datetime:
    return datetime.now(UTC)


def record_battery_gate(
    db: Session,
    *,
    language: str,
    pathway: str,
    site_mode: str,
    status: str,
    evidence_ids: list[str],
    approvers: list[str],
    note: str | None,
    actor: str,
    effective_from: datetime | None = None,
) -> BatteryGate:
    cfg = gates_config()
    if status not in ("open", "closed"):
        raise GateError(422, "invalid_status", "battery gate status must be open or closed")
    if status == "open":
        required = len(cfg["battery_gate"].get("signoff_roles", [])) or 2
        if len(set(approvers)) < required:
            raise GateError(422, "insufficient_signoff", f"opening needs {required} distinct approvers")
        if not evidence_ids:
            raise GateError(422, "evidence_required", "opening a battery gate needs evidence ids")
    row = BatteryGate(
        language=language,
        pathway=pathway,
        site_mode=site_mode,
        status=status,
        evidence_ids=evidence_ids,
        approvers=sorted(set(approvers)),
        effective_from=effective_from or _now(),
        gates_version=str(cfg["version"]),
        note=note,
        recorded_by=actor,
    )
    db.add(row)
    db.flush()
    return row


def record_trait_gate(
    db: Session,
    *,
    trait: str,
    language: str,
    pathway: str,
    status: str,
    evidence_ids: list[str],
    approvers: list[str],
    note: str | None,
    actor: str,
    effective_from: datetime | None = None,
) -> TraitGate:
    cfg = gates_config()
    if status not in TRAIT_STATUS_ORDER:
        raise GateError(422, "invalid_status", f"unknown trait status {status}")
    for rule in cfg.get("permanent_withhold", []):
        if rule["construct"] == trait and rule["pathway"] == pathway and status != "withheld":
            raise GateError(422, "permanently_withheld", f"{trait} is permanently withheld for pathway {pathway}")
    for cap in cfg.get("caps", []):
        if cap["construct"] == trait and TRAIT_STATUS_ORDER.index(status) > TRAIT_STATUS_ORDER.index(cap["max_status"]):
            raise GateError(422, "status_capped", f"{trait} is capped at {cap['max_status']}")
    if status in DISPLAYABLE:
        signers = int(cfg["trait_gate"].get("min_named_signers", 2))
        if len(set(approvers)) < signers:
            raise GateError(422, "insufficient_signoff", f"promotion needs {signers} distinct named approvers")
        if not evidence_ids:
            raise GateError(422, "evidence_required", "promotion needs ValidationEvidence ids")
    row = TraitGate(
        trait=trait,
        language=language,
        pathway=pathway,
        status=status,
        evidence_ids=evidence_ids,
        approvers=sorted(set(approvers)),
        effective_from=effective_from or _now(),
        gates_version=str(cfg["version"]),
        note=note,
        recorded_by=actor,
    )
    db.add(row)
    db.flush()
    return row


def current_battery_gate(db: Session, language: str, pathway: str, site_mode: str) -> BatteryGate | None:
    return db.execute(
        select(BatteryGate)
        .where(
            BatteryGate.language == language,
            BatteryGate.pathway == pathway,
            BatteryGate.site_mode == site_mode,
            BatteryGate.effective_from <= _now(),
        )
        .order_by(BatteryGate.effective_from.desc(), BatteryGate.id.desc())
        .limit(1)
    ).scalar_one_or_none()


def current_trait_gate(db: Session, trait: str, language: str, pathway: str) -> TraitGate | None:
    return db.execute(
        select(TraitGate)
        .where(
            TraitGate.trait == trait,
            TraitGate.language == language,
            TraitGate.pathway == pathway,
            TraitGate.effective_from <= _now(),
        )
        .order_by(TraitGate.effective_from.desc(), TraitGate.id.desc())
        .limit(1)
    ).scalar_one_or_none()


def battery_gate_open(db: Session, language: str, pathway: str, site_mode: str) -> tuple[bool, dict[str, Any]]:
    """Battery gate is open for this cell AND >= min_language_groups languages are open (defence in depth)."""
    cfg = gates_config()["battery_gate"]
    row = current_battery_gate(db, language, pathway, site_mode)
    required = len(cfg.get("signoff_roles", [])) or 2
    cell_open = row is not None and row.status == "open" and len(set(row.approvers)) >= required
    open_languages: set[str] = set()
    for (lang,) in db.execute(
        select(BatteryGate.language)
        .where(BatteryGate.pathway == pathway, BatteryGate.site_mode == site_mode)
        .distinct()
    ):
        current = current_battery_gate(db, lang, pathway, site_mode)
        if current is not None and current.status == "open":
            open_languages.add(lang)
    min_groups = int(cfg.get("min_language_groups", 2))
    ok = cell_open and len(open_languages) >= min_groups
    return ok, {"cell_open": cell_open, "open_languages": sorted(open_languages), "min_language_groups": min_groups}


def all_gate_keys(db: Session) -> tuple[list[tuple[str, str, str]], list[tuple[str, str, str]]]:
    battery = [
        tuple(r)
        for r in db.execute(select(BatteryGate.language, BatteryGate.pathway, BatteryGate.site_mode).distinct()).all()
    ]
    traits = [
        tuple(r) for r in db.execute(select(TraitGate.trait, TraitGate.language, TraitGate.pathway).distinct()).all()
    ]
    return sorted(battery), sorted(traits)  # type: ignore[arg-type]


# ---------------------------------------------------------------- release packs


def _next_version(db: Session) -> str:
    count = db.execute(select(func.count()).select_from(ReleasePackRecord)).scalar_one()
    return f"0.{int(count) + 1}.0"


def build_release_pack(
    db: Session, settings: Settings, actor: str, expiry_days: int | None = None
) -> ReleasePackRecord:
    cfg = gates_config()
    now = _now()
    expires = now + timedelta(days=expiry_days or int(cfg.get("release_pack", {}).get("default_expiry_days", 14)))
    battery_keys, trait_keys = all_gate_keys(db)
    battery = []
    for lang, pathway, site_mode in battery_keys:
        row = current_battery_gate(db, lang, pathway, site_mode)
        if row is None:
            continue
        battery.append(
            {
                "language": lang,
                "pathway": pathway,
                "site_mode": site_mode,
                "status": row.status,
                "evidence_ids": sorted(set(row.evidence_ids)),
                "approvers": row.approvers,
                "effective_from": row.effective_from.isoformat(),
            }
        )
    traits = []
    for trait, lang, pathway in trait_keys:
        trow = current_trait_gate(db, trait, lang, pathway)
        if trow is None:
            continue
        traits.append(
            {
                "trait": trait,
                "language": lang,
                "pathway": pathway,
                "status": trow.status,
                "evidence_ids": sorted(set(trow.evidence_ids)),
                "approvers": trow.approvers,
                "effective_from": trow.effective_from.isoformat(),
            }
        )
    norms = list(db.execute(select(NormTableRecord).where(NormTableRecord.status == "approved")).scalars())
    latest: dict[tuple[str, str, str], NormTableRecord] = {}
    for n in norms:
        key = (n.trait, n.pathway, n.language)
        if key not in latest or n.computed_at > latest[key].computed_at:
            latest[key] = n
    norm_tables, composites = [], []
    for n in latest.values():
        norm_tables.append(
            {
                "norm_table_version": n.norm_table_version,
                "trait": n.trait,
                "pathway": n.pathway,
                "language": n.language,
                "cut_points": [float(c) for c in n.cut_points],
                "sem": float(n.sem),
                "ci_level": float(n.ci_level),
                "provisional": n.provisional,
                "effective_n": n.effective_n,
            }
        )
        comp = n.coefficients.get("composite")
        if comp and comp.get("indicators"):
            composites.append(
                {
                    "trait": n.trait,
                    "pathway": n.pathway,
                    "language": n.language,
                    "method": comp.get("method", "unit_weighted_z"),
                    "indicators": comp["indicators"],
                }
            )
    withheld = set(report_policy.withheld_constructs())
    allow = [
        {"trait": s.trait, "band": s.band, "phrase_key": s.phrase_key}
        for s in db.execute(select(ScoreInterpretation).where(ScoreInterpretation.approved.is_(True))).scalars()
        if s.trait not in withheld  # config/report_policy.yaml: never renderable in a player report
    ]
    pack: dict[str, Any] = {
        "schema_version": "1.0",
        "release_pack_version": _next_version(db),
        "issued_at": now.isoformat(),
        "expires_at": expires.isoformat(),
        "dictionary_versions": {p: str(content.dictionary_pathway(p).data["version"]) for p in ("A", "B")},
        "dictionary_sha256": {p: content.dictionary_pathway(p).sha256 for p in ("A", "B")},
        "battery_gates": battery,
        "trait_gates": traits,
        "composites": composites,
        "norm_tables": norm_tables,
        "phrase_allowlist": allow,
        "disclaimer_key": DISCLAIMER_KEY,
    }
    seed = settings.key_bytes("release_pack_signing_key")
    pack["signature"] = {
        "algorithm": "ed25519",
        "key_id": settings.release_pack_key_id,
        "value": sign_ed25519(seed, canonical_bytes(pack)),
    }
    ReleasePack.model_validate(pack)
    record = ReleasePackRecord(
        release_pack_version=pack["release_pack_version"],
        issued_at=now,
        expires_at=expires,
        pack=pack,
        key_id=settings.release_pack_key_id,
        created_by=actor,
    )
    db.add(record)
    db.flush()
    return record


def verify_release_pack(settings: Settings, pack: dict[str, Any], *, now: datetime | None = None) -> list[str]:
    """Fail-closed checks: signature, expiry, dictionary versions. Empty list = valid."""
    problems: list[str] = []
    body = {k: v for k, v in pack.items() if k != "signature"}
    sig = pack.get("signature") or {}
    if sig.get("algorithm") != "ed25519" or not verify_ed25519(
        ed25519_public_key(settings.key_bytes("release_pack_signing_key")), canonical_bytes(body), sig.get("value", "")
    ):
        problems.append("invalid_signature")
    try:
        if datetime.fromisoformat(str(pack["expires_at"])) <= (now or _now()):
            problems.append("expired")
    except (KeyError, ValueError):
        problems.append("expiry_unreadable")
    for p in ("A", "B"):
        if pack.get("dictionary_sha256", {}).get(p) != content.dictionary_pathway(p).sha256:
            problems.append(f"dictionary_mismatch_{p}")
    return problems


def current_release_pack(db: Session) -> ReleasePackRecord | None:
    return db.execute(
        select(ReleasePackRecord)
        .where(ReleasePackRecord.revoked_at.is_(None))
        .order_by(ReleasePackRecord.issued_at.desc(), ReleasePackRecord.id.desc())
        .limit(1)
    ).scalar_one_or_none()
