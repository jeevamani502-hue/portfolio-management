# Bharat Terminal — single image, API plus the built frontend.
#
# One service rather than two: same origin (so no CORS), one URL, one thing to
# keep running. The worker runs from this same image with a different command.

# ── build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so the dependency layer is cached across code changes.
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci

COPY . .
RUN npm run build

# Reinstall production-only dependencies into a clean tree. `npm ci --omit=dev`
# over the existing node_modules would leave dev packages behind.
RUN rm -rf node_modules backend/node_modules frontend/node_modules \
 && npm ci --omit=dev --workspace backend --include-workspace-root

# ── run ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Where the API finds the built frontend to serve.
ENV WEB_ROOT=/app/web

# Run unprivileged. The node image already ships a `node` user.
RUN mkdir -p /app/web && chown -R node:node /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/node_modules ./backend/node_modules
COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
COPY --from=build --chown=node:node /app/backend/package.json ./backend/
COPY --from=build --chown=node:node /app/frontend/dist ./web
COPY --from=build --chown=node:node /app/database ./database
COPY --from=build --chown=node:node /app/package.json ./

USER node
EXPOSE 4000

# The platform's own health check should use this; it reports database and
# Redis reachability, not merely that the process is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/backend
CMD ["node", "dist/index.js"]
