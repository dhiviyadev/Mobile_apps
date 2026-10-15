# Cobalt Game Hub — game server image.
# Build from the game-hub/ directory (the monorepo root):
#   docker build -f server/Dockerfile -t cobalt-hub-server .
#   docker run -p 2567:2567 -v hub_data:/data cobalt-hub-server
# Saved Voxelvale worlds go to DATA_DIR (/data); mount a volume there to keep them across deploys.

# Base image is overridable, e.g. to use a registry mirror:
#   docker build --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-alpine ...
ARG NODE_IMAGE=node:22-alpine

# ---- build: bundle server + shared TypeScript into one file ---------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY client/package.json ./client/package.json
RUN npm ci --workspace server --no-audit --no-fund
RUN npm run build --workspace server

# ---- runtime: production dependencies only ---------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
# su-exec lets the entrypoint drop from root to the node user after preparing the data dir.
RUN apk add --no-cache su-exec
ENV NODE_ENV=production \
    PORT=2567 \
    HOST=0.0.0.0 \
    DATA_DIR=/data
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --workspace server --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
COPY server/docker-entrypoint.sh /usr/local/bin/hub-entrypoint.sh
RUN chmod +x /usr/local/bin/hub-entrypoint.sh && mkdir -p /data && chown node:node /data
# No USER here: the entrypoint starts as root only to chown the (often root-owned) volume
# mounted at DATA_DIR, then runs the server as "node".
EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:2567/health || exit 1
ENTRYPOINT ["/usr/local/bin/hub-entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
