"""Structured JSON logging, request ids and OpenTelemetry hooks.

Tracing is always wired through the OpenTelemetry API (no-op unless a provider is installed). When
``OTEL_ENABLED=true`` an SDK tracer provider is installed; spans are exported over OTLP/HTTP only if
the optional ``otel`` extra is installed and ``OTEL_EXPORTER_OTLP_ENDPOINT`` is set.
"""

from __future__ import annotations

import contextvars
import json
import logging
import sys
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from opentelemetry import trace

if TYPE_CHECKING:
    from fastapi import FastAPI

    from shriii_api.settings import Settings

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
_RESERVED = frozenset(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime"}

tracer = trace.get_tracer("shriii_api")


class JsonFormatter(logging.Formatter):
    """One JSON object per line with trace/request correlation fields."""

    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        rid = request_id_var.get()
        if rid:
            out["request_id"] = rid
        span_ctx = trace.get_current_span().get_span_context()
        if span_ctx.is_valid:
            out["trace_id"] = format(span_ctx.trace_id, "032x")
            out["span_id"] = format(span_ctx.span_id, "016x")
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                out[key] = value
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str, ensure_ascii=False)


def configure_logging(settings: Settings) -> None:
    """Install the root handler once (idempotent)."""
    root = logging.getLogger()
    if any(getattr(h, "_shriii", False) for h in root.handlers):
        root.setLevel(settings.log_level.upper())
        return
    handler = logging.StreamHandler(sys.stdout)
    handler._shriii = True  # type: ignore[attr-defined]
    handler.setFormatter(
        JsonFormatter() if settings.log_json else logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    root.addHandler(handler)
    root.setLevel(settings.log_level.upper())


_otel_configured = False


def configure_tracing(settings: Settings, app: FastAPI | None = None) -> None:
    """Install an SDK tracer provider and optional exporter/instrumentation (idempotent)."""
    global _otel_configured  # noqa: PLW0603 - process-wide one-time setup
    log = logging.getLogger(__name__)
    if not settings.otel_enabled or _otel_configured:
        return
    from opentelemetry.sdk.resources import Resource  # noqa: PLC0415
    from opentelemetry.sdk.trace import TracerProvider  # noqa: PLC0415

    provider = TracerProvider(resource=Resource.create({"service.name": settings.service_name}))
    if settings.otel_exporter_otlp_endpoint:
        try:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import (  # type: ignore[import-not-found]  # noqa: PLC0415
                OTLPSpanExporter,
            )
            from opentelemetry.sdk.trace.export import BatchSpanProcessor  # noqa: PLC0415

            exporter = OTLPSpanExporter(endpoint=settings.otel_exporter_otlp_endpoint.rstrip("/") + "/v1/traces")
            provider.add_span_processor(BatchSpanProcessor(exporter))
        except ImportError:
            log.warning("otel exporter requested but the 'otel' extra is not installed; spans stay local")
    trace.set_tracer_provider(provider)
    if app is not None:
        try:
            from opentelemetry.instrumentation.fastapi import (  # type: ignore[import-not-found]  # noqa: PLC0415
                FastAPIInstrumentor,
            )

            FastAPIInstrumentor.instrument_app(app)
        except ImportError:
            log.info("opentelemetry-instrumentation-fastapi not installed; using manual spans only")
    _otel_configured = True
