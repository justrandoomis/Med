# syntax=docker/dockerfile:1
# MedLevo AI — one container: the Node server (Fastify + node:sqlite + background jobs) serving the built PWA.
# Built by Render from this repository (render.yaml) and by CI (workflow_dispatch input «docker»). Data lives in
# MEDLEVO_DATA_DIR on a mounted persistent disk; nothing else in the container survives a redeploy.
#
# Choices (docs/DEPLOYMENT.md §8):
#  * node:22-bookworm-slim — Node ≥ 22.13 for node:sqlite; Debian bookworm because poppler and LibreOffice come as
#    maintained packages there (Alpine's musl builds of LibreOffice are larger and slower to install).
#  * three stages: «build» (all dev dependencies, builds apps/web/dist), «deps» (production dependencies of the server
#    and the shared package only — no Vite, Vitest, TypeScript, Playwright, React), «runtime» (OS tools + the two).
#  * runtime tools: poppler-utils (pdftoppm: page renders for OCR and figure crops), LibreOffice WITHOUT a GUI and only
#    Writer + Impress (.doc/.docx → PDF, .ppt/.pptx display copies, Word → PDF exports), fonts that cover Arabic
#    (Noto Naskh / Kufi / Sans Arabic in fonts-noto-core) plus metric-compatible Latin fonts for Word layouts
#    (Liberation for Arial/Times, Carlito for Calibri), tini as PID 1 (signals, zombie reaping).
#  * the server runs as the unprivileged «node» user; the entrypoint only makes sure the (possibly root-owned) disk
#    is writable by it, then drops privileges for good.
#  * TypeScript runs through tsx exactly like `npm start` (no separate compile step to drift from the source).

ARG NODE_IMAGE=node:22-bookworm-slim

# ───────────── build: install everything, build the PWA ─────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build

# ───────────── deps: production dependencies of the server (+ shared) only ─────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund --workspace @medlevo/server --workspace @medlevo/shared --include-workspace-root=false \
  && npm cache clean --force \
  # prebuilt native binaries for musl (Alpine) are never loaded on this glibc image (~30 MB)
  && find node_modules -mindepth 2 -maxdepth 2 -type d -name '*-linux-*-musl' -exec rm -rf {} +

# ───────────── runtime ─────────────
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tini \
    ca-certificates \
    poppler-utils \
    libreoffice-writer-nogui \
    libreoffice-impress-nogui \
    fonts-noto-core \
    fonts-liberation2 \
    fonts-crosextra-carlito \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /var/cache/debconf/*-old

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY apps/server/package.json apps/server/tsconfig.json apps/server/
COPY apps/server/src apps/server/src
COPY --from=build /app/apps/web/dist apps/web/dist
COPY deploy/docker/entrypoint.sh /usr/local/bin/medlevo-entrypoint
COPY deploy/docker/medlevo-restore-offsite /usr/local/bin/medlevo-restore-offsite
RUN chmod 755 /usr/local/bin/medlevo-entrypoint /usr/local/bin/medlevo-restore-offsite \
  && mkdir -p /var/data/medlevo \
  && chown -R node:node /var/data

# Render sends traffic to PORT (10000 by default); the server reads MEDLEVO_PORT. Listen on every interface inside
# the container (the setup token is then required for the first account — see docs/DEPLOY_PHONE_AR.md).
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    MEDLEVO_HOST=0.0.0.0 \
    MEDLEVO_PORT=10000 \
    MEDLEVO_DATA_DIR=/var/data/medlevo \
    MEDLEVO_TIMEZONE=Asia/Baghdad
EXPOSE 10000

# A local `docker run` health signal (Render uses the blueprint's healthCheckPath instead).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MEDLEVO_PORT||10000)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"]

WORKDIR /app/apps/server
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/medlevo-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts"]
