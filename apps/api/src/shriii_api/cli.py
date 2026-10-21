"""``shriii-api`` command line: migrate, seed, synthetic ingestion, worker, retention, OpenAPI export."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config

import shriii_api
from shriii_api.settings import Settings, get_settings

API_ROOT = Path(__file__).resolve().parents[2]


def alembic_config(url: str, *, identity: bool = False) -> Config:
    package_dir = Path(shriii_api.__file__).resolve().parent
    cfg = Config()
    cfg.set_main_option("script_location", str(package_dir / ("migrations_identity" if identity else "migrations")))
    cfg.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return cfg


def migrate(settings: Settings, revision: str = "head") -> None:
    command.upgrade(alembic_config(settings.database_url), revision)
    command.upgrade(alembic_config(settings.effective_identity_database_url, identity=True), revision)
    from shriii_api.db.partitions import ensure_upcoming_partitions  # noqa: PLC0415
    from shriii_api.db.session import session_scope  # noqa: PLC0415

    with session_scope() as db:
        ensure_upcoming_partitions(db, datetime.now(UTC).date(), days=7)


def export_openapi(out: Path) -> dict[str, Any]:
    from shriii_api.main import create_app  # noqa: PLC0415

    schema = create_app().openapi()
    out.write_text(json.dumps(schema, indent=2, sort_keys=False, ensure_ascii=False) + "\n", encoding="utf-8")
    return schema


def _print(value: Any) -> None:
    sys.stdout.write(json.dumps(value, indent=2, default=str) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="shriii-api", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("migrate", help="Upgrade research + identity databases to head")
    p.add_argument("--revision", default="head")
    p = sub.add_parser("seed", help="Load instruments, dictionary, games and content versions")
    p.add_argument("--demo", action="store_true", help="Also create the demo study and a dev kiosk")
    p = sub.add_parser("ingest-synthetic", help="End-to-end synthetic dataset (dev/test only)")
    p.add_argument("--participants", type=int, default=20)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--occasions", type=int, default=1, choices=[1, 2])
    p.add_argument("--no-snapshot", action="store_true")
    p = sub.add_parser("worker", help="Run the job worker")
    p.add_argument("--once", action="store_true", help="Drain the queue and exit")
    p = sub.add_parser("retention", help="Run the retention schedule")
    p.add_argument("--apply", action="store_true", help="Delete (default is a dry run)")
    p = sub.add_parser("export-openapi", help="Write the OpenAPI 3.1 document")
    p.add_argument("--out", type=Path, default=API_ROOT / "openapi.json")
    p = sub.add_parser("create-kiosk", help="Register a kiosk and print its device token")
    p.add_argument("kiosk_id")
    p.add_argument("--site", required=True)
    p = sub.add_parser("dev-token", help="Print a dev JWT (ENV=dev/test only)")
    p.add_argument("--sub", default="dev-admin")
    p.add_argument("--roles", default="admin", help="comma-separated")
    p = sub.add_parser("serve", help="Run the API with uvicorn")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true")
    args = parser.parse_args(argv)
    settings = get_settings()

    from shriii_api.observability import configure_logging  # noqa: PLC0415

    configure_logging(settings)
    if args.cmd == "migrate":
        migrate(settings, args.revision)
        _print({"migrated": args.revision})
    elif args.cmd == "seed":
        from shriii_api.db.session import session_scope  # noqa: PLC0415
        from shriii_api.services import seed as seed_svc  # noqa: PLC0415

        with session_scope() as db:
            out: dict[str, Any] = {"reference": seed_svc.seed_reference(db, "cli:seed")}
            if args.demo:
                out["demo_study"] = seed_svc.seed_demo_study(db, "cli:seed")
                if settings.is_dev:
                    token = seed_svc.ensure_kiosk(db, "kiosk-001", "site-pune-01")
                    out["dev_kiosk"] = {"kiosk_id": "kiosk-001", "device_token": token or "(already registered)"}
        _print(out)
    elif args.cmd == "ingest-synthetic":
        from shriii_api.services.synthetic import ingest_synthetic  # noqa: PLC0415

        _print(
            ingest_synthetic(
                settings,
                participants=args.participants,
                seed=args.seed,
                occasions=args.occasions,
                build_snapshot=not args.no_snapshot,
            )
        )
    elif args.cmd == "worker":
        from shriii_api.worker.runner import drain, run_forever  # noqa: PLC0415

        if args.once:
            _print({"jobs_run": drain(settings=settings)})
        else:
            run_forever(settings)
    elif args.cmd == "retention":
        from shriii_api.db.session import session_scope  # noqa: PLC0415
        from shriii_api.services.retention import run_retention  # noqa: PLC0415

        with session_scope() as db:
            run = run_retention(db, settings, dry_run=not args.apply, triggered_by="cli:retention")
            _print({"retention_run_id": str(run.id), "report": run.report})
    elif args.cmd == "export-openapi":
        schema = export_openapi(args.out)
        _print({"written": str(args.out), "paths": len(schema["paths"]), "openapi": schema["openapi"]})
    elif args.cmd == "create-kiosk":
        from shriii_api.db.session import session_scope  # noqa: PLC0415
        from shriii_api.services.seed import ensure_kiosk  # noqa: PLC0415

        with session_scope() as db:
            token = ensure_kiosk(db, args.kiosk_id, args.site)
        _print({"kiosk_id": args.kiosk_id, "device_token": token or "(already registered; rotate via the API)"})
    elif args.cmd == "dev-token":
        from shriii_api.auth.tokens import issue_dev_token  # noqa: PLC0415

        token, exp = issue_dev_token(settings, args.sub, [r.strip() for r in args.roles.split(",") if r.strip()])
        _print({"access_token": token, "expires_at": exp})
    elif args.cmd == "serve":
        import uvicorn  # noqa: PLC0415

        uvicorn.run("shriii_api.main:create_app", factory=True, host=args.host, port=args.port, reload=args.reload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
