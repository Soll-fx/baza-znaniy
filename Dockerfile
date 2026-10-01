# База знаний по бухгалтерии — production-образ.
#
# Схема повторяет рабочий деплой District (Render free + Vercel):
# один сервис отдаёт и API, и собранный фронт. Отличие — в том, что
# содержимое БД берётся из внешнего DATABASE_URL, а не из локального
# кластера: embedded-postgres и папка .pgdata в образ не попадают.
#
# В образ идёт ТОЛЬКО то, что нужно во время работы сервера:
#   server/dist   — скомпилированный API
#   web/dist      — собранный фронт (его сервер раздаёт в production)
#   storage/assets — файлы вложений, которые отдаёт /api/assets/:id
#   db/schema.sql — для миграций
#
# content/ (232 МБ) в образ НЕ копируется: сервер читает его только
# при импорте и валидации, в рантайме он не используется.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Сначала только манифесты — слой с зависимостями кешируется между сборками.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY server ./server
COPY web ./web
RUN npm run build --workspace server && npm run build --workspace web


FROM node:22-bookworm-slim AS run
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    STORAGE_DIR=storage \
    CONTENT_DIR=content

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY db ./db
COPY storage/assets ./storage/assets

# Миграции применяются при старте: на бесплатном хостинге инстанс
# каждый раз поднимается на чистом контейнере, но база внешняя и общая.
COPY docker/start.sh ./docker/start.sh
RUN chmod +x docker/start.sh

EXPOSE 4000
CMD ["sh", "./docker/start.sh"]
