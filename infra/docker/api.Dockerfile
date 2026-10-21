# syntax=docker/dockerfile:1.7
# SHRIII backend image: FastAPI service (target `api`, default) and the Postgres-backed job worker
# (target `worker`). Build from the repository root:
#
#   docker build -f infra/docker/api.Dockerfile -t shriii/api .
#   docker build -f infra/docker/api.Dockerfile --target worker -t shriii/worker .
#
# uv installs the locked workspace (backend/api, contracts/python and the stats/* engines) non-editable into /opt/venv; the runtime stage is
# python-slim with no compiler, runs as an unprivileged user and reads the canonical schemas, scoring
# dictionary and content from /app (SHRIII_REPO_ROOT). Scientific thresholds stay in those YAML files.

ARG PYTHON_VERSION=3.14
ARG UV_VERSION=0.13

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# ---------------------------------------------------------------------------------------------- build
FROM python:${PYTHON_VERSION}-slim-trixie AS build
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src

# 1) Third-party dependencies only (cached until the lockfile or a member manifest changes).
COPY pyproject.toml uv.lock ./
COPY backend/api/pyproject.toml backend/api/
COPY contracts/python/pyproject.toml contracts/python/
COPY stats/scoring/pyproject.toml stats/scoring/
COPY stats/validation/pyproject.toml stats/validation/
COPY stats/simulator/pyproject.toml stats/simulator/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace \
        --package shriii-api --package shriii-simulator --extra otel

# 2) Workspace members, installed non-editable so the venv is self-contained.
COPY backend/api backend/api
COPY contracts/python contracts/python
COPY stats/scoring stats/scoring
COPY stats/validation stats/validation
COPY stats/simulator stats/simulator
COPY stats/rbridge stats/rbridge
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable \
        --package shriii-api --package shriii-simulator --extra otel \
 && /opt/venv/bin/python -c "import shriii_api, shriii_scoring, shriii_validation, shriii_simulator"

# -------------------------------------------------------------------------------------------- runtime
FROM python:${PYTHON_VERSION}-slim-trixie AS runtime
ARG APP_UID=10001
ARG APP_GID=10001
LABEL org.opencontainers.image.title="shriii-api" \
      org.opencontainers.image.description="SHRIII behavioural games backend (FastAPI + job worker)" \
      org.opencontainers.image.source="https://github.com/shriii/behavioural-games" \
      org.opencontainers.image.licenses="UNLICENSED"

RUN groupadd --system --gid "${APP_GID}" app \
 && useradd --system --uid "${APP_UID}" --gid app --home-dir /app --shell /usr/sbin/nologin app \
 && mkdir -p /app /var/lib/shriii \
 && chown app:app /var/lib/shriii

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SHRIII_REPO_ROOT=/app \
    DATA_DIR=/var/lib/shriii \
    LOG_JSON=true \
    PORT=8000

COPY --from=build /opt/venv /opt/venv
# Read-only runtime resources (canonical contracts, scoring dictionary and gates, content).
COPY contracts/schemas /app/contracts/schemas
COPY stats/measurement-model /app/stats/measurement-model
COPY content /app/content
COPY infra/docker/healthcheck.py /usr/local/bin/shriii-healthcheck
WORKDIR /app
USER app:app

# --------------------------------------------------------------------------------------------- worker
FROM runtime AS worker
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["python", "/usr/local/bin/shriii-healthcheck", "db"]
CMD ["shriii-api", "worker"]

# ------------------------------------------------------------------------------------- api (default)
FROM runtime AS api
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD ["python", "/usr/local/bin/shriii-healthcheck", "http", "http://127.0.0.1:8000/healthz"]
CMD ["sh", "-c", "exec uvicorn shriii_api.main:create_app --factory --host 0.0.0.0 --port \"${PORT}\" --proxy-headers --forwarded-allow-ips='*' --no-server-header"]
