# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/sync-core/package.json packages/sync-core/tsconfig.json ./packages/sync-core/
COPY packages/sync-core/src ./packages/sync-core/src
COPY clients/headless/package.json clients/headless/tsconfig.json ./clients/headless/
COPY clients/headless/src ./clients/headless/src
RUN npm ci --ignore-scripts && \
    npm --workspace @picassio/sync-core run build && \
    npm --workspace web-vault-sync run build && \
    npm prune --omit=dev && \
    mkdir -p /runtime/config /runtime/vault

FROM node:22-alpine
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages/sync-core/package.json ./packages/sync-core/package.json
COPY --from=build /src/packages/sync-core/dist ./packages/sync-core/dist
COPY --from=build /src/clients/headless/package.json ./clients/headless/package.json
COPY --from=build /src/clients/headless/dist ./clients/headless/dist
COPY --from=build --chown=node:node /runtime/config /config
COPY --from=build --chown=node:node /runtime/vault /vault
USER node
VOLUME ["/config", "/vault"]
ENV WEB_VAULT_SYNC_CONFIG_DIR=/config
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 CMD ["node", "/app/clients/headless/dist/cli.js", "doctor", "--json"]
ENTRYPOINT ["node", "/app/clients/headless/dist/cli.js"]
CMD ["watch"]
