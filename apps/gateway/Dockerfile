FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/gateway/package.json apps/gateway/package.json
RUN pnpm install --frozen-lockfile
COPY packages/contracts packages/contracts
COPY apps/gateway apps/gateway
RUN pnpm --filter @huzaifa/gateway build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/gateway/node_modules ./apps/gateway/node_modules
COPY --from=build /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /app/apps/gateway/package.json ./apps/gateway/package.json
COPY --from=build /app/packages/contracts ./packages/contracts
USER node
WORKDIR /app/apps/gateway
EXPOSE 3001
CMD ["node", "dist/index.js"]