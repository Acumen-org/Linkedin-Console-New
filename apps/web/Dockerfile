# Builds the web app and bakes it into the Caddy image (Caddy serves it + proxies the API).
# Build context: repository root.
FROM node:24-slim AS build
WORKDIR /web
COPY apps/web/package.json ./
RUN npm install --no-audit --no-fund
COPY apps/web/ ./
RUN npm run build

FROM caddy:2
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /web/dist /srv
