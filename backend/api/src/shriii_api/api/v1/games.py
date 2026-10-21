"""/api/v1/games: game definitions and approved versions (content/games + DB)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from shriii_api import content
from shriii_api.api.deps import DbSession, raise_error, require, set_audit
from shriii_api.api.schemas import ApiModel
from shriii_api.auth.rbac import Perm, Principal
from shriii_api.db.models.games import Game, GameVersion, TrialDefinition
from shriii_api.services.content_sync import sync_games

router = APIRouter(prefix="/games", tags=["games"])


class GameVersionOut(ApiModel):
    id: int
    game_id: str
    version: str
    config_id: str
    sha256: str
    status: str
    approved_by: list[str]
    approved_at: datetime | None
    source_path: str | None


class GameOut(ApiModel):
    game_id: str
    kind: str
    pathways: list[str]
    constructs: list[str]
    slot: bool
    latest_version: GameVersionOut | None = None
    approved_version: GameVersionOut | None = None


class GameVersionDetail(GameVersionOut):
    config: dict[str, Any]
    trial_definitions: list[dict[str, Any]] = Field(default_factory=list)


class ApproveBody(BaseModel):
    approvers: list[str] = Field(min_length=2, description="Two distinct named approvers")


def _versions(db: DbSession, game_id: str) -> list[GameVersion]:
    return list(
        db.execute(
            select(GameVersion).where(GameVersion.game_id == game_id).order_by(GameVersion.created_at, GameVersion.id)
        ).scalars()
    )


def _game_out(db: DbSession, game: Game) -> GameOut:
    versions = _versions(db, game.game_id)
    approved = [v for v in versions if v.status == "approved"]
    out = GameOut.model_validate(game)
    out.latest_version = GameVersionOut.model_validate(versions[-1]) if versions else None
    out.approved_version = GameVersionOut.model_validate(approved[-1]) if approved else None
    return out


@router.get("", response_model=list[GameOut], summary="Game catalogue")
def list_games(db: DbSession, principal: Annotated[Principal, Depends(require(Perm.GAMES_READ))]) -> list[GameOut]:
    return [_game_out(db, g) for g in db.execute(select(Game).order_by(Game.game_id)).scalars()]


@router.get("/session-plan", summary="Session plan and time budgets (content/games/session-plan.json)")
def session_plan(principal: Annotated[Principal, Depends(require(Perm.GAMES_READ))]) -> dict[str, Any]:
    doc = content.session_plan()
    return {"sha256": doc.sha256, "plan": doc.data}


@router.get("/approved", response_model=list[GameVersionDetail], summary="Approved versions (kiosk bundle check)")
def approved_versions(
    db: DbSession, principal: Annotated[Principal, Depends(require(Perm.GAMES_READ))]
) -> list[GameVersionDetail]:
    rows = db.execute(select(GameVersion).where(GameVersion.status == "approved").order_by(GameVersion.game_id))
    return [GameVersionDetail.model_validate(r) for r in rows.scalars()]


@router.post("/sync", summary="Load game configs from content/games as draft versions")
def sync(
    request: Request, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.GAMES_WRITE))]
) -> dict[str, int]:
    stats = sync_games(db)
    set_audit(request, action="games.sync", stats=stats)
    return stats


@router.get("/{game_id}", response_model=GameOut, summary="One game")
def get_game(
    game_id: str, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.GAMES_READ))]
) -> GameOut:
    game = db.get(Game, game_id)
    if game is None:
        raise_error(404, "unknown_game", "game not found")
    return _game_out(db, game)


@router.get("/{game_id}/versions", response_model=list[GameVersionOut], summary="Versions of a game")
def game_versions(
    game_id: str, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.GAMES_READ))]
) -> list[GameVersionOut]:
    return [GameVersionOut.model_validate(v) for v in _versions(db, game_id)]


@router.get("/{game_id}/versions/{version}", response_model=GameVersionDetail, summary="Version with full config")
def game_version(
    game_id: str, version: str, db: DbSession, principal: Annotated[Principal, Depends(require(Perm.GAMES_READ))]
) -> GameVersionDetail:
    row = db.execute(
        select(GameVersion).where(GameVersion.game_id == game_id, GameVersion.version == version)
    ).scalar_one_or_none()
    if row is None:
        raise_error(404, "unknown_game_version", "game version not found")
    out = GameVersionDetail.model_validate(row)
    out.trial_definitions = [
        {
            "block_id": t.block_id,
            "sequence": t.sequence,
            "phase": t.phase,
            "condition_id": t.condition_id,
            "planned_trials": t.planned_trials,
            "min_trials": t.min_trials,
            "scorable": t.scorable,
        }
        for t in db.execute(
            select(TrialDefinition).where(TrialDefinition.game_version_id == row.id).order_by(TrialDefinition.sequence)
        ).scalars()
    ]
    return out


@router.post("/{game_id}/versions/{version}/approve", response_model=GameVersionOut, summary="Approve a version")
def approve_version(
    game_id: str,
    version: str,
    body: ApproveBody,
    request: Request,
    db: DbSession,
    principal: Annotated[Principal, Depends(require(Perm.GAMES_WRITE))],
) -> GameVersionOut:
    if len(set(body.approvers)) < 2:
        raise_error(422, "two_person_rule", "approval needs two distinct approvers")
    row = db.execute(
        select(GameVersion).where(GameVersion.game_id == game_id, GameVersion.version == version)
    ).scalar_one_or_none()
    if row is None:
        raise_error(404, "unknown_game_version", "game version not found")
    row.status = "approved"
    row.approved_by = sorted(set(body.approvers))
    row.approved_at = datetime.now(UTC)
    set_audit(request, action="games.approve", resource_type="game_version", resource_id=f"{game_id}@{version}")
    return GameVersionOut.model_validate(row)
