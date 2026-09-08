FROM node:24-alpine AS build

RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/telegram-bot/package.json ./apps/telegram-bot/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/agents/package.json ./packages/agents/package.json
COPY packages/connectors/package.json ./packages/connectors/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/telegram/package.json ./packages/telegram/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ENV NODE_ENV=production
ARG ORIGINPOST_API_UPSTREAM=http://127.0.0.1:4000
ENV ORIGINPOST_API_UPSTREAM=$ORIGINPOST_API_UPSTREAM
RUN pnpm build

FROM build AS api
RUN apk add --no-cache ffmpeg font-noto font-noto-gujarati font-noto-devanagari
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]

FROM build AS worker
CMD ["node", "apps/worker/dist/worker.js"]

FROM build AS web
EXPOSE 3000
CMD ["pnpm", "--filter", "@originpost/web", "start"]
