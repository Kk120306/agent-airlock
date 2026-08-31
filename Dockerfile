ARG NODE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/transactional-resource-sdk/package.json packages/transactional-resource-sdk/package.json
COPY packages/http-object-resource/package.json packages/http-object-resource/package.json
COPY packages/portable-promotion-receipt/package.json packages/portable-promotion-receipt/package.json
RUN npm ci

COPY apps ./apps
COPY packages ./packages
RUN npm run build
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

ARG DEBIAN_MIRROR=""
ARG DEBIAN_SECURITY_MIRROR=""

COPY docker/codex-runtime/package.json docker/codex-runtime/package-lock.json /opt/codex/

RUN if [ -n "$DEBIAN_SECURITY_MIRROR" ]; then \
      find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) \
        -exec sed -i "s|http://deb.debian.org/debian-security|$DEBIAN_SECURITY_MIRROR|g" {} +; \
    fi \
    && if [ -n "$DEBIAN_MIRROR" ]; then \
      find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) \
        -exec sed -i "s|http://deb.debian.org/debian|$DEBIAN_MIRROR|g" {} +; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && npm ci --prefix /opt/codex --omit=dev --ignore-scripts \
    && ln -s /opt/codex/node_modules/.bin/codex /usr/local/bin/codex \
    && codex --version \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/transactional-resource-sdk/package.json ./packages/transactional-resource-sdk/package.json
COPY --from=build /app/packages/transactional-resource-sdk/dist ./packages/transactional-resource-sdk/dist
COPY --from=build /app/packages/http-object-resource/package.json ./packages/http-object-resource/package.json
COPY --from=build /app/packages/http-object-resource/dist ./packages/http-object-resource/dist
COPY --from=build /app/packages/portable-promotion-receipt/package.json ./packages/portable-promotion-receipt/package.json
COPY --from=build /app/packages/portable-promotion-receipt/dist ./packages/portable-promotion-receipt/dist

RUN mkdir -p /app/data /app/workspaces /app/codex-home \
    && chown -R node:node /app

USER node
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
