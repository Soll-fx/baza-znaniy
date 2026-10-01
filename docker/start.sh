#!/bin/sh
# Старт в production: миграции → API.
#
# Миграции идемпотентны (CREATE ... IF NOT EXISTS), поэтому их безопасно
# гонять на каждом старте: инстанс на Render поднимается заново, а база
# общая и должна быть со схемой актуальной версии кода.
set -e

echo "[start] применяю миграции"
node server/dist/scripts/migrate.js

echo "[start] запускаю API на порту ${PORT:-4000}"
exec node server/dist/index.js
