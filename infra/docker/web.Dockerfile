# syntax=docker/dockerfile:1.7
# SHRIII web app (apps/web, Next.js: /kiosk, /research/*, /admin/*) as a Next.js standalone server.
# Requires `output: "standalone"` in apps/web/next.config.* (and `outputFileTracingRoot` set to the repository
# root so workspace packages are traced). Build from the repository root:
#
#   docker build -f infra/docker/web.Dockerfile --build-arg NEXT_PUBLIC_API_BASE_URL=http://localhost:8000 -t shriii/web .

ARG NODE_VERSION=24
ARG WEB_PACKAGE=@shriii/web

# ---------------------------------------------------------------------------------------------- build
FROM node:${NODE_VERSION}-trixie-slim AS build
ARG WEB_PACKAGE
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
# NEXT_PUBLIC_* values are inlined into the client bundle at build time.
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --store-dir /pnpm/store --offline --frozen-lockfile --filter "${WEB_PACKAGE}..." \
 && pnpm --filter "${WEB_PACKAGE}..." run build \
 && test -f apps/web/.next/standalone/apps/web/server.js \
      || { echo "apps/web must set output: 'standalone' (and outputFileTracingRoot) in next.config" >&2; exit 1; }

# -------------------------------------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-trixie-slim AS runtime
LABEL org.opencontainers.image.title="shriii-web" \
      org.opencontainers.image.description="SHRIII web app (Next.js standalone)"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# The node image ships an unprivileged `node` user (uid 1000).
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
