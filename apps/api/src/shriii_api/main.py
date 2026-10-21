"""FastAPI application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
from shriii_contracts import UploadBatch
from sqlalchemy import text

from shriii_api import __version__
from shriii_api.api.v1 import api_router
from shriii_api.audit import audit_middleware
from shriii_api.db.session import dispose_engines, get_engine, get_identity_engine
from shriii_api.errors import DomainError
from shriii_api.observability import configure_logging, configure_tracing
from shriii_api.settings import Settings, get_settings

API_DESCRIPTION = """
SHRIII Kiosk Behavioural Games backend (ingestion, research and admin APIs).

Five data layers are kept separate: raw events (append-only) -> behavioural indicators -> criterion
scale scores -> validated trait estimates -> participant-facing interpretations (release-gated).
Authentication: OIDC JWT bearer tokens (dev: ``POST /api/v1/auth/dev-login``); kiosks use device
tokens (``kdt_...``). Every write and every research-data read is audited.
"""

OPENAPI_TAGS: list[dict[str, Any]] = [
    {"name": "auth", "description": "Dev login and principal introspection."},
    {"name": "sessions", "description": "Game session lifecycle (create, resume, complete, invalidate)."},
    {"name": "events", "description": "Idempotent UploadBatch ingestion (layer 1)."},
    {"name": "games", "description": "Game definitions and approved versions."},
    {"name": "participants", "description": "Pseudonymous participants, linkage, consent, withdrawal, erasure."},
    {"name": "instruments", "description": "Criterion instrument registry and licensing."},
    {"name": "assessment-responses", "description": "Criterion responses, scoring, corrections and imports."},
    {"name": "features", "description": "Layer-2 behavioural indicators."},
    {"name": "validation", "description": "Analysis snapshots and validation runs."},
    {"name": "models", "description": "Predictive models (participant-grouped evaluation)."},
    {"name": "norms", "description": "Reference populations and norm tables."},
    {"name": "reports", "description": "Release-gated participant reports (fail closed)."},
    {"name": "studies", "description": "Studies, protocols, cohorts, quotas, arms, enrollment, retests."},
    {"name": "admin", "description": "Kiosks, deployments, content, gates, settings, audit, jobs."},
    {"name": "health", "description": "Liveness and readiness."},
]


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    yield
    dispose_engines()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings)
    app = FastAPI(
        title="SHRIII API",
        version=__version__,
        description=API_DESCRIPTION,
        openapi_tags=OPENAPI_TAGS,
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.api_cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Device-Token", "X-Request-Id"],
        expose_headers=["X-Request-Id"],
    )
    app.middleware("http")(audit_middleware)

    @app.exception_handler(DomainError)
    async def domain_error_handler(request: Request, exc: DomainError) -> JSONResponse:
        if exc.status_code in (401, 403):
            request.state.audit_outcome = "denied"
        return JSONResponse(
            status_code=exc.status_code, content={"detail": {"code": exc.code, "message": exc.message, **exc.extra}}
        )

    @app.get("/healthz", tags=["health"], summary="Liveness")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    @app.get("/readyz", tags=["health"], summary="Readiness (research DB, identity DB, migrations)")
    def readyz() -> JSONResponse:
        checks: dict[str, Any] = {}
        ok = True
        for name, engine in (("database", get_engine()), ("identity_database", get_identity_engine())):
            try:
                with engine.connect() as conn:
                    conn.execute(text("SELECT 1"))
                checks[name] = "ok"
            except Exception as exc:
                checks[name] = f"error: {type(exc).__name__}"
                ok = False
        try:
            with get_engine().connect() as conn:
                checks["migration"] = conn.execute(text("SELECT version_num FROM public.alembic_version")).scalar()
        except Exception:
            checks["migration"] = None
            ok = False
        return JSONResponse(
            status_code=200 if ok else 503, content={"status": "ok" if ok else "unavailable", "checks": checks}
        )

    app.include_router(api_router, prefix="/api/v1")

    def custom_openapi() -> dict[str, Any]:
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(
            title=app.title, version=app.version, description=app.description, routes=app.routes, tags=OPENAPI_TAGS
        )
        components = schema.setdefault("components", {}).setdefault("schemas", {})
        batch = UploadBatch.model_json_schema(ref_template="#/components/schemas/{model}")
        for name, definition in batch.pop("$defs", {}).items():
            components.setdefault(name, definition)
        components["UploadBatch"] = batch
        schema.setdefault("components", {})["securitySchemes"] = {
            "bearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT or kdt_ device token"}
        }
        schema["security"] = [{"bearer": []}]
        app.openapi_schema = schema
        return schema

    app.openapi = custom_openapi  # type: ignore[method-assign]
    configure_tracing(settings, app)
    return app
