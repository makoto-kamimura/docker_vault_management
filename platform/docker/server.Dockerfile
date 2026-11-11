# syntax=docker/dockerfile:1
# LocalVault server image. Build context: REPOSITORY ROOT.
#   docker build -f platform/docker/server.Dockerfile .

ARG NODE_VERSION=24
ARG PNPM_VERSION=12.18.0

# ---- manifests: keep only package manifests so dependency layers stay cached
FROM node:${NODE_VERSION}-bookworm-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir /out \
 && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /out \; \
 && cp pnpm-lock.yaml pnpm-workspace.yaml /out/

# ---- build: install all deps, bundle the server
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
RUN npm i -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY --from=manifests /out ./
RUN --mount=type=cache,id=localvault-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@localvault/server..."
COPY . .
RUN pnpm --filter @localvault/server build

# ---- prune: production-only node_modules for the server package
FROM build AS prune
RUN pnpm --filter @localvault/server deploy --prod --legacy /out \
 || pnpm --filter @localvault/server deploy --prod /out
RUN rm -rf /out/dist /out/migrations \
 && cp -r app/server/dist /out/dist \
 && cp -r app/server/migrations /out/migrations

# ---- runtime: distroless, non-root, no shell
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
COPY --from=prune --chown=nonroot:nonroot /out/package.json ./package.json
COPY --from=prune --chown=nonroot:nonroot /out/node_modules ./node_modules
COPY --from=prune --chown=nonroot:nonroot /out/dist ./dist
COPY --from=prune --chown=nonroot:nonroot /out/migrations ./migrations
USER nonroot
EXPOSE 8787
# The image entrypoint is `node`; no curl/wget in distroless.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["dist/server.js"]
