# syntax=docker/dockerfile:1.7
# SHRIII kiosk static build (apps/kiosk, Vite) served by unprivileged nginx. This is the browser build used
# for pilots and E2E tests; the Electron artefacts are built by .github/workflows/kiosk-release.yml.
#
#   docker build -f infra/docker/kiosk.Dockerfile --build-arg VITE_API_BASE_URL=http://localhost:8000 -t shriii/kiosk .
#
# The `dist` stage can also be used to extract the static bundle:
#   docker build -f infra/docker/kiosk.Dockerfile --target dist --output type=local,dest=out .

ARG NODE_VERSION=24
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine

# ---------------------------------------------------------------------------------------------- build
FROM node:${NODE_VERSION}-trixie-slim AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# 1) Fetch the locked dependency set (cached until the lockfile changes).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store

# 2) Install offline and build the kiosk with its workspace dependencies.
COPY . .
ARG VITE_API_BASE_URL=http://localhost:8000
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_DEV_VOICE_PLACEHOLDER=false \
    VITE_DEV_OVERLAY=false
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --store-dir /pnpm/store --offline --frozen-lockfile --filter "@shriii/kiosk..." \
 && pnpm --filter "@shriii/kiosk..." run build \
 && test -f apps/kiosk/dist/index.html

FROM scratch AS dist
COPY --from=build /repo/apps/kiosk/dist /

# -------------------------------------------------------------------------------------------- runtime
FROM ${NGINX_IMAGE} AS runtime
LABEL org.opencontainers.image.title="shriii-kiosk" \
      org.opencontainers.image.description="SHRIII kiosk browser build (static)"
COPY infra/docker/nginx/kiosk.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/kiosk/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
