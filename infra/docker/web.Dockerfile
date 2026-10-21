# syntax=docker/dockerfile:1.7
# SHRIII web app (apps/web, Next.js: /kiosk, /research/*, /admin/*) as a Next.js standalone server.
# Requires `output: "standalone"` in apps/web/next.config.* (and `outputFileTracingRoot` set to the repository
# root so workspace packages are traced). Build from the repository root:
#
#   docker build -f infra/docker/web.Dockerfile --build-arg API_PROXY_TARGET=http://api:8000 -t shriii/web .
#
# The pnpm package name is read from apps/web/package.json unless WEB_PACKAGE is given. Next.js bakes rewrite
# destinations into the build, so API_PROXY_TARGET (the FastAPI origin behind the app's /api/v1, /healthz and
# /readyz rewrites) is a build argument as well as a runtime variable. NEXT_PUBLIC_* values are inlined into
# the client bundle at build time.

ARG NODE_VERSION=24

# ---------------------------------------------------------------------------------------------- build
FROM node:${NODE_VERSION}-trixie-slim AS build
ARG WEB_PACKAGE=
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store

COPY . .
ARG NEXT_PUBLIC_API_BASE_URL=
ARG API_PROXY_TARGET=http://127.0.0.1:8000
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    API_PROXY_TARGET=${API_PROXY_TARGET} \
    NODE_ENV=production
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pkg="${WEB_PACKAGE:-$(node -p 'require("./apps/web/package.json").name')}" \
 && echo "building web package: ${pkg}" \
 && NODE_ENV=development pnpm install --store-dir /pnpm/store --offline --frozen-lockfile --filter "${pkg}..." \
 && pnpm --filter "${pkg}..." run build \
 && if [ ! -f apps/web/.next/standalone/apps/web/server.js ]; then \
      echo "apps/web must set output: 'standalone' and outputFileTracingRoot (repo root) in next.config" >&2; exit 1; \
    fi \
 && mkdir -p apps/web/public

# -------------------------------------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-trixie-slim AS runtime
ARG API_PROXY_TARGET=http://127.0.0.1:8000
LABEL org.opencontainers.image.title="shriii-web" \
      org.opencontainers.image.description="SHRIII web app (Next.js standalone)"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    API_PROXY_TARGET=${API_PROXY_TARGET} \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# Application files stay root-owned (read-only for the runtime user); only the Next.js cache is writable.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
RUN mkdir -p apps/web/.next/cache && chown -R node:node apps/web/.next/cache
# The node image ships an unprivileged `node` user (uid 1000).
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
