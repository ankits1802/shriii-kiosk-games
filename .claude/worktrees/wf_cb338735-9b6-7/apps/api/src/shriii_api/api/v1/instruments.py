"""/api/v1/instruments: criterion instrument registry, versions, licensing, language approvals."""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from shriii_api.api.deps import DbSession, raise_error, require, set_audit
from shriii_api.api.schemas import ApiModel
from shriii_api.auth.rbac import Perm, Principal
from shriii_api.db.models.criterion import Instrument, InstrumentVersion, LanguageVersion, Permission
from shriii_api.services import criterion as criterion_svc

router = APIRouter(prefix="/instruments", tags=["instruments"])


class PermissionOut(ApiModel):
    id: int
    instrument_id: str
    language: str | None
    holder: str
    licence: str
    permission_status: str
    permission_document: str | None
    allowed_use: str
    expiry: date | None
    commercial_use: bool
    notes: str | None
    recorded_by: str
    created_at: datetime


class LanguageVersionOut(ApiModel):
    language: str
    itc_state: str
    approved: bool
    translation_permission: str
    approved_by: list[str]
    approved_at: datetime | None


class InstrumentOut(ApiModel):
    instrument_id: str
    name: str
    short_name: str
    kind: str
    citation: str
    constructs_measured: list[str]
    current_version: str
    licensing: PermissionOut | None = None
    licensing_warnings: list[str] = Field(default_factory=list)


class InstrumentVersionOut(ApiModel):
    instrument_id: str
    version: str
    key_version: str
    sha256: str
    status: str
    source_path: str | None
    created_at: datetime


class InstrumentVersionDetail(InstrumentVersionOut):
    definition: dict[str, Any]
    language_versions: list[LanguageVersionOut] = Field(default_factory=list)


class LicensingUpdate(BaseModel):
    holder: str
    licence: str
    permission_status: Literal["not_requested", "requested", "granted", "denied", "not_required"]
    permission_document: str | None = None
    allowed_use: str
    expiry: date | None = None
    commercial_use: bool = False
    notes: str | None = None
    language: str | None = Field(default=None, pattern=r"^[a-z]{2,3}-[A-Z]{2}$")


class LanguageApproval(BaseModel):
    itc_state: Literal[
        "draft",
        "forward_translated",
        "back_translated",
        "expert_reviewed",
        "recorded",
        "audio_qc",
        "think_aloud_tested",
        "approved",
        "flagged_for_revision",
    ]
    approvers: list[str] = Field(default_factory=list)


def _out(db: DbSession, inst: Instrument) -> InstrumentOut:
    out = InstrumentOut.model_validate(inst)
    perm = criterion_svc.current_permission(db, inst.instrument_id)
    out.licensing = PermissionOut.model_validate(perm) if perm else None
    out.licensing_warnings = criterion_svc.permission_warnings(perm)
    return out


@router.get("", response_model=list[InstrumentOut], summary="Instrument registry with licensing status")
def list_instruments(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.INSTRUMENTS_READ))]
) -> list[InstrumentOut]:
    return [_out(db, i) for i in db.execute(select(Instrument).order_by(Instrument.instrument_id)).scalars()]


@router.post("/sync", summary="Load content/instruments/*.yaml into the registry")
def sync(
    request: Request, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.INSTRUMENTS_WRITE))]
) -> dict[str, int]:
    stats = criterion_svc.sync_instruments(db, principal.sub)
    set_audit(request, action="instruments.sync", stats=stats)
    return stats


@router.get("/{instrument_id}", response_model=InstrumentOut, summary="One instrument")
def get_instrument(
    instrument_id: str, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.INSTRUMENTS_READ))]
) -> InstrumentOut:
    inst = db.get(Instrument, instrument_id)
    if inst is None:
        raise_error(404, "unknown_instrument", "instrument not found")
    return _out(db, inst)


@router.get("/{instrument_id}/versions", response_model=list[InstrumentVersionOut], summary="Versions")
def versions(
    instrument_id: str, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.INSTRUMENTS_READ))]
) -> list[InstrumentVersionOut]:
    rows = db.execute(
        select(InstrumentVersion)
        .where(InstrumentVersion.instrument_id == instrument_id)
        .order_by(InstrumentVersion.created_at)
    ).scalars()
    return [InstrumentVersionOut.model_validate(r) for r in rows]


@router.get(
    "/{instrument_id}/versions/{version}",
    response_model=InstrumentVersionDetail,
    summary="Version with item structure, scoring key and language versions (no licensed wording)",
)
def version_detail(
    instrument_id: str,
    version: str,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.INSTRUMENTS_READ))],
) -> InstrumentVersionDetail:
    row = criterion_svc.get_version(db, instrument_id, version)
    out = InstrumentVersionDetail.model_validate(row)
    out.language_versions = [
        LanguageVersionOut.model_validate(lv)
        for lv in db.execute(
            select(LanguageVersion)
            .where(LanguageVersion.instrument_version_id == row.id)
            .order_by(LanguageVersion.language)
        ).scalars()
    ]
    return out


@router.get("/{instrument_id}/licensing", response_model=list[PermissionOut], summary="Licensing history")
def licensing_history(
    instrument_id: str, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.INSTRUMENTS_READ))]
) -> list[PermissionOut]:
    rows = db.execute(
        select(Permission)
        .where(Permission.instrument_id == instrument_id)
        .order_by(Permission.created_at, Permission.id)
    ).scalars()
    return [PermissionOut.model_validate(r) for r in rows]


@router.post(
    "/{instrument_id}/licensing",
    response_model=PermissionOut,
    status_code=201,
    summary="Record a licensing/permission update (append-only)",
)
def update_licensing(
    instrument_id: str,
    body: LicensingUpdate,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.INSTRUMENTS_WRITE))],
) -> PermissionOut:
    if db.get(Instrument, instrument_id) is None:
        raise_error(404, "unknown_instrument", "instrument not found")
    if body.permission_status == "granted" and not body.permission_document:
        raise_error(422, "permission_document_required", "a granted permission needs its document reference")
    row = Permission(instrument_id=instrument_id, recorded_by=principal.sub, **body.model_dump())
    db.add(row)
    db.flush()
    set_audit(
        request,
        action="instruments.licensing",
        resource_type="instrument",
        resource_id=instrument_id,
        permission_status=body.permission_status,
    )
    return PermissionOut.model_validate(row)


@router.post(
    "/{instrument_id}/versions/{version}/languages/{language}",
    response_model=LanguageVersionOut,
    summary="Advance a language version through the ITC workflow (approval needs two approvers)",
)
def update_language(
    instrument_id: str,
    version: str,
    language: str,
    body: LanguageApproval,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.INSTRUMENTS_WRITE))],
) -> LanguageVersionOut:
    row = criterion_svc.get_version(db, instrument_id, version)
    lv = db.execute(
        select(LanguageVersion).where(
            LanguageVersion.instrument_version_id == row.id, LanguageVersion.language == language
        )
    ).scalar_one_or_none()
    if lv is None:
        lv = LanguageVersion(
            instrument_version_id=row.id,
            language=language,
            itc_state="draft",
            approved=False,
            translation_permission="not_requested",
        )
        db.add(lv)
    lv.itc_state = body.itc_state
    if body.itc_state == "approved":
        if len(set(body.approvers)) < 2:
            raise_error(422, "two_person_rule", "language approval needs two distinct approvers")
        lv.approved = True
        lv.approved_by = sorted(set(body.approvers))
        lv.approved_at = datetime.now(UTC)
    else:
        lv.approved = False
    db.flush()
    set_audit(
        request,
        action="instruments.language",
        resource_type="instrument",
        resource_id=f"{instrument_id}@{version}/{language}",
        itc_state=body.itc_state,
    )
    return LanguageVersionOut.model_validate(lv)
