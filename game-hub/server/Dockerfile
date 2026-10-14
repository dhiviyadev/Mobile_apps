# Cobalt Game Hub — game server image.
# Build from the game-hub/ directory (the monorepo root):
#   docker build -f server/Dockerfile -t cobalt-hub-server .
#   docker run -p 2567:2567 cobalt-hub-server

# ---- build: bundle server + shared TypeScript into one file ---------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY client/package.json ./client/package.json
RUN npm ci --workspace server --no-audit --no-fund
RUN npm run build --workspace server

# ---- runtime: production dependencies only ---------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=2567 \
    HOST=0.0.0.0
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --workspace server --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
USER node
EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:2567/health || exit 1
CMD ["node", "server/dist/index.js"]
