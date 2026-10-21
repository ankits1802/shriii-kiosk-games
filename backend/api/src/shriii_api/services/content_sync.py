"""Load versioned repository content into the DB: games, trait registry (dictionary), content versions."""

from __future__ import annotations

from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from shriii_api import content
from shriii_api.canonical import canonical_sha256
from shriii_api.db.models.games import Condition, Episode, Game, GameVersion, TrialDefinition
from shriii_api.db.models.ops import ContentVersion
from shriii_api.db.models.scored import Construct, FeatureDefinition, IndicatorDefinition, TraitMapping
from shriii_api.db.models.validation import ScoreInterpretation


def sync_games(db: Session) -> dict[str, int]:
    """Add every game config version found under ``content/games`` (existing versions are immutable)."""
    stats = {"games": 0, "versions_added": 0, "unchanged": 0}
    for doc in content.game_documents():
        cfg = doc.data
        if "module_id" not in cfg:
            continue
        game = db.get(Game, cfg["module_id"])
        if game is None:
            game = Game(
                game_id=cfg["module_id"],
                kind=cfg["kind"],
                pathways=cfg.get("pathways", []),
                constructs=cfg.get("constructs", []),
                slot=bool(cfg.get("slot", False)),
            )
            db.add(game)
            db.flush()
        else:
            game.kind, game.pathways = cfg["kind"], cfg.get("pathways", [])
            game.constructs, game.slot = cfg.get("constructs", []), bool(cfg.get("slot", False))
        stats["games"] += 1
        existing = db.execute(
            select(GameVersion).where(GameVersion.game_id == game.game_id, GameVersion.version == cfg["version"])
        ).scalar_one_or_none()
        if existing is not None:
            stats["unchanged"] += 1
            continue
        version = GameVersion(
            game_id=game.game_id,
            version=cfg["version"],
            config_id=cfg["config_id"],
            config=cfg,
            sha256=doc.sha256,
            status="draft",
            source_path=doc.relpath,
        )
        db.add(version)
        db.flush()
        if cfg["kind"] == "episode":
            db.add(
                Episode(
                    game_version_id=version.id,
                    episode_id=cfg["module_id"],
                    sequence=1,
                    details={"paradigms": cfg.get("paradigms", []), "constructs": cfg.get("constructs", [])},
                )
            )
        conditions: dict[str, dict[str, Any]] = {}
        for seq, block in enumerate(cfg.get("blocks", []), start=1):
            db.add(
                TrialDefinition(
                    game_version_id=version.id,
                    block_id=block["block_id"],
                    sequence=seq,
                    phase=block["phase"],
                    condition_id=block.get("condition_id"),
                    planned_trials=int(block.get("trials", 0)),
                    min_trials=int(block.get("min_trials", 0)),
                    scorable=bool(block.get("scorable")),
                    details={
                        k: v
                        for k, v in block.items()
                        if k not in ("block_id", "phase", "condition_id", "trials", "min_trials", "scorable")
                    },
                )
            )
            cid = block.get("condition_id")
            if cid and cid not in conditions:
                conditions[cid] = {"phase": block["phase"], "details": block.get("conditions", {})}
        for cid, c in conditions.items():
            db.add(Condition(game_version_id=version.id, condition_id=cid, phase=c["phase"], details=c["details"]))
        stats["versions_added"] += 1
    db.flush()
    return stats


def sync_dictionary(db: Session) -> dict[str, int]:
    """Trait registry from ``stats/measurement-model/dictionary``.

    Constructs, indicators, feature definitions, mappings.
    """
    shared = content.dictionary_shared()
    version = str(shared.data["version"])
    stats = {"constructs": 0, "indicators": 0, "mappings": 0, "phrases": 0}
    db.execute(delete(TraitMapping).where(TraitMapping.dictionary_version == version))
    for c in shared.data["constructs"]:
        row = db.get(Construct, c["id"])
        if row is None:
            row = Construct(
                construct_id=c["id"], name=c["name"], kind=c.get("kind"), dictionary_version=version, definition=c
            )
            db.add(row)
        else:
            row.name, row.kind, row.dictionary_version, row.definition = c["name"], c.get("kind"), version, c
        stats["constructs"] += 1
        for relation in ("convergent", "discriminant", "nomological"):
            for rel in (c.get("criterion_relations") or {}).get(relation, []):
                db.add(
                    TraitMapping(
                        construct_id=c["id"],
                        pathway=None,
                        relation=relation,
                        indicator_id=None,
                        criterion_ref=rel.get("criterion"),
                        expected_sign=rel.get("expected_sign"),
                        expected_r_low=rel.get("expected_r_low"),
                        expected_r_high=rel.get("expected_r_high"),
                        dictionary_version=version,
                        details=rel,
                    )
                )
                stats["mappings"] += 1
        for band, key in ((c.get("report") or {}).get("phrase_keys") or {}).items():
            exists = db.execute(
                select(ScoreInterpretation).where(
                    ScoreInterpretation.trait == c["id"],
                    ScoreInterpretation.band == band,
                    ScoreInterpretation.version == version,
                )
            ).scalar_one_or_none()
            if exists is None:
                db.add(ScoreInterpretation(trait=c["id"], band=band, phrase_key=key, version=version, approved=False))
                stats["phrases"] += 1
    for pathway in ("A", "B"):
        doc = content.dictionary_pathway(pathway)
        pversion = str(doc.data["version"])
        for ind in doc.data.get("indicators", []):
            existing_def = db.execute(
                select(IndicatorDefinition).where(
                    IndicatorDefinition.indicator_id == ind["id"],
                    IndicatorDefinition.pathway == pathway,
                    IndicatorDefinition.dictionary_version == pversion,
                )
            ).scalar_one_or_none()
            if existing_def is not None:
                existing_def.definition = ind
                continue
            source = ind.get("source") or {}
            db.add(
                IndicatorDefinition(
                    indicator_id=ind["id"],
                    pathway=pathway,
                    dictionary_version=pversion,
                    construct_id=ind["construct"],
                    role=ind.get("role"),
                    tier=ind.get("tier"),
                    status=ind.get("status"),
                    kind=ind.get("kind"),
                    module_id=source.get("module_id") or source.get("episode_id"),
                    definition=ind,
                )
            )
            mvt = ind.get("min_valid_trials") or {}
            db.add(
                FeatureDefinition(
                    indicator_id=ind["id"],
                    pathway=pathway,
                    dictionary_version=pversion,
                    algorithm=(ind.get("formula") or {}).get("ref"),
                    direction=ind.get("direction"),
                    min_valid_trials=mvt.get("count") if isinstance(mvt, dict) else None,
                    event_inputs=ind.get("event_inputs", []),
                    exclusions=ind.get("exclusions", []),
                    definition={
                        "transformation": ind.get("transformation"),
                        "aggregation": ind.get("aggregation"),
                        "reliability_method": ind.get("reliability_method"),
                        "unit": ind.get("unit"),
                    },
                )
            )
            db.add(
                TraitMapping(
                    construct_id=ind["construct"],
                    pathway=pathway,
                    relation="indicator",
                    indicator_id=ind["id"],
                    criterion_ref=None,
                    expected_sign=None,
                    expected_r_low=None,
                    expected_r_high=None,
                    dictionary_version=version,
                    details={
                        "role": ind.get("role"),
                        "tier": ind.get("tier"),
                        "convergent_criteria": ind.get("convergent_criteria", []),
                    },
                )
            )
            stats["indicators"] += 1
    db.flush()
    return stats


def record_content_versions(db: Session, actor: str) -> list[ContentVersion]:
    """Hash-stamp each content kind (PLT-03) so deployments can reference exact versions."""
    entries: list[tuple[str, str, str, dict[str, Any]]] = []
    games = content.game_documents()
    entries.append(
        (
            "games",
            content.session_plan().data.get("version", "0.0.0"),
            canonical_sha256({d.relpath: d.sha256 for d in games}),
            {d.relpath: d.sha256 for d in games},
        )
    )
    instruments = content.instrument_documents()
    entries.append(
        (
            "instruments",
            "registry",
            canonical_sha256({d.relpath: d.sha256 for d in instruments}),
            {d.relpath: d.sha256 for d in instruments},
        )
    )
    for pathway in ("A", "B"):
        d = content.dictionary_pathway(pathway)
        entries.append((f"dictionary_{pathway}", str(d.data["version"]), d.sha256, {d.relpath: d.sha256}))
    for d, kind in (
        (content.dictionary_shared(), "dictionary_shared"),
        (content.gates(), "gates"),
        (content.hypotheses(), "hypotheses"),
    ):
        entries.append((kind, str(d.data["version"]), d.sha256, {d.relpath: d.sha256}))
    out: list[ContentVersion] = []
    for kind, version, digest, manifest in entries:
        row = db.execute(
            select(ContentVersion).where(
                ContentVersion.kind == kind, ContentVersion.version == version, ContentVersion.sha256 == digest
            )
        ).scalar_one_or_none()
        if row is None:
            row = ContentVersion(
                kind=kind, version=version, sha256=digest, manifest=manifest, status="draft", created_by=actor
            )
            db.add(row)
        out.append(row)
    db.flush()
    return out
