# syntax=docker/dockerfile:1.7
# One Dockerfile for all Node apps in the monorepo. Build a specific image with --target:
#   server     api + worker (same image, different command)
#   sidecar    Live View + bridge (one per LinkedIn account pod)
#   pod-agent  manages account pods through the Docker API
#   web        Caddy + the built React app
# The Chrome image lives in apps/chrome (no Node).

ARG NODE_IMAGE=node:24-alpine

# ---------- workspace install (cached on lockfile + manifests) ----------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install -g pnpm@10.34.6 --no-audit --no-fund
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/contracts/package.json packages/contracts/
COPY apps/server/package.json apps/server/
COPY apps/sidecar/package.json apps/sidecar/
COPY apps/pod-agent/package.json apps/pod-agent/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# ---------- build shared packages + web ----------
FROM deps AS build
COPY . .
RUN pnpm --filter @linkunify/contracts build \
 && pnpm --filter @linkunify/web build \
 && pnpm --filter @linkunify/server deploy --prod --legacy /out/server \
 && pnpm --filter @linkunify/sidecar deploy --prod --legacy /out/sidecar \
 && pnpm --filter @linkunify/pod-agent deploy --prod --legacy /out/pod-agent

# ---------- runtime images ----------
FROM ${NODE_IMAGE} AS server
ENV NODE_ENV=production NODE_NO_WARNINGS=1 SERVICE_NAME=server
WORKDIR /app
COPY --from=build --chown=node:node /out/server ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/api.ts"]

FROM ${NODE_IMAGE} AS sidecar
ENV NODE_ENV=production NODE_NO_WARNINGS=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_OPTIONS=--max-old-space-size=160
WORKDIR /app
COPY --from=build --chown=node:node /out/sidecar ./
USER node
CMD ["node", "src/main.ts"]

FROM ${NODE_IMAGE} AS pod-agent
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=build /out/pod-agent ./
# Needs the Docker socket (root) to manage pods. Never expose this service publicly.
CMD ["node", "src/main.ts"]

FROM caddy:2 AS web
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
