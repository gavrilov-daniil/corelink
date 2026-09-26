# Сборка core. Монорепо на pnpm-workspace, поэтому в образ едет весь репозиторий:
# core зависит от локальных пакетов (@corelink/db, @corelink/payments, @corelink/xray-config, @corelink/core-kit),
# и собрать его в отрыве нельзя.
FROM node:22-alpine AS builder
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Сначала манифесты — слой с зависимостями переиспользуется, пока они не менялись
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY apps/core/package.json apps/core/
COPY packages/db/package.json packages/db/
COPY packages/core-kit/package.json packages/core-kit/
COPY packages/payments/package.json packages/payments/
COPY packages/xray-config/package.json packages/xray-config/
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps/core apps/core
RUN pnpm --filter @corelink/core... build

# Прод-зависимости отдельно: dev-пакеты (typescript, tsx) в рантайме не нужны
RUN pnpm --filter @corelink/core --prod deploy /app

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Ревизия сборки. Отдаётся в /healthz, по ней деплой убеждается, что поднялся
# именно выкатываемый образ, а не остался работать прежний контейнер.
ARG GIT_SHA=dev
ENV APP_VERSION=$GIT_SHA

# Синтетическая проба сети (MonitoringService) гоняет трафик через каналы локальным
# Xray и curl — той же версией Xray, что на нодах. Бинарь из релиза XTLS со сверкой
# SHA256 из его же .dgst: подменённый архив не доедет до образа.
ARG XRAY_VERSION=26.3.27
RUN apk add --no-cache curl unzip \
 && case "$(apk --print-arch)" in \
      x86_64) XRAY_ASSET=Xray-linux-64.zip ;; \
      aarch64) XRAY_ASSET=Xray-linux-arm64-v8a.zip ;; \
      *) echo "нет сборки Xray под $(apk --print-arch)"; exit 1 ;; \
    esac \
 && base="https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}" \
 && wget -q -O /tmp/xray.zip "$base/$XRAY_ASSET" \
 && wget -q -O /tmp/xray.dgst "$base/$XRAY_ASSET.dgst" \
 && expect="$(awk -F'= ' '/^SHA2-256=/{print $2}' /tmp/xray.dgst)" \
 && [ -n "$expect" ] && echo "$expect  /tmp/xray.zip" | sha256sum -c - \
 && unzip -q -o /tmp/xray.zip xray -d /usr/local/bin \
 && chmod 0755 /usr/local/bin/xray \
 && rm -f /tmp/xray.zip /tmp/xray.dgst \
 && apk del unzip

# Не от root: у процесса нет причин иметь права на систему
RUN addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /app ./
# Миграции едут внутри пакета @corelink/db (pnpm deploy их уже положил)

USER app
EXPOSE 3100

# Проверка живости: healthz не ходит в БД, поэтому отвечает даже при недоступной базе —
# это осознанно, иначе рестарт контейнера при моргании БД только усугубит.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CORE_PORT||3100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
