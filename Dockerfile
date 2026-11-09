FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    WEB_DIST=/app/dist
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "server/index.ts"]
