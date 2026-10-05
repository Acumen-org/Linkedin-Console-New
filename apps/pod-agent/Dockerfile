FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
# Needs the Docker socket (root) to manage pods. Never expose this service publicly.
CMD ["node", "server.mjs"]
