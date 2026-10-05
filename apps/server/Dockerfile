# Node 24 runs the TypeScript sources directly (type stripping), so there is no build step.
FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY migrations ./migrations
COPY src ./src
ENV NODE_ENV=production NODE_NO_WARNINGS=1
USER node
EXPOSE 4000
CMD ["node", "src/api.ts"]
