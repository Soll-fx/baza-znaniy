#!/usr/bin/env bash
# Локальный сервер для crawler.js.
# Нужен, чтобы не вставлять 500 строк в DevTools вручную:
# в консоль попадает одна короткая строка-загрузчик.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8765}"
cd "$DIR"

echo "Отдаю $DIR по http://127.0.0.1:$PORT/"
echo "Остановить: Ctrl+C"
echo

exec python3 -m http.server "$PORT" --bind 127.0.0.1
