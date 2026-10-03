# obs-web 서버 이미지. 배포 구성: deploy/docker-compose.yml, 절차: docs/DEPLOY.md
# Prisma 엔진이 빌드·실행 단계에서 같은 OpenSSL을 쓰도록 같은 기반 이미지를 쓴다.
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# 의존성(postinstall에서 prisma generate가 돌아서 스키마를 먼저 넣는다)
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

# DB 마이그레이션 전용(앱 기동 전에 compose의 obs-web-migrate가 한 번 실행)
FROM deps AS migrator
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

FROM deps AS builder
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# 배포한 커밋 SHA. /api/health가 돌려준다(빌드 마지막 단계라 바뀌어도 앞 단계 캐시는 그대로).
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 3000
CMD ["node", "server.js"]
