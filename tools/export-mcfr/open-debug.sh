#!/bin/bash
#
# Открывает ОТДЕЛЬНЫЙ Chrome с отладочным портом.
#
#   bash open-debug.sh
#
# Почему отдельная папка профиля:
#   Chrome 136+ (у вас 153) НАМЕРЕННО игнорирует --remote-debugging-port,
#   если профиль дефолтный — защита от программ, которые так воруют куки.
#   Как только указан свой --user-data-dir, порт включается.
#
# Ваш обычный Chrome при этом не трогаем: ни профиль, ни куки, ни вкладки.
# Вход делается один раз вручную в этом окне.

set -uo pipefail

PORT=9222
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HERE/session-profile"

echo "== 1. Готовлю отдельный профиль =="
mkdir -p "$DIR"
chmod go-rwx "$DIR"
echo "  папка: $DIR"

echo
echo "== 2. Открываю Chrome с портом $PORT =="
# Запускаем бинарник напрямую: open -a аргументы игнорирует.
# Прямой запуск с --user-data-dir работает: падение SingletonLock было
# только на вашем обычном профиле, до которого macOS не пускает.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$DIR" \
  --remote-debugging-port="$PORT" \
  --no-first-run \
  --no-default-browser-check \
  > "$HERE/chrome-debug.log" 2>&1 &

echo "  жду, пока порт поднимется…"
for i in $(seq 1 15); do
  sleep 2
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo
    echo "✓ Порт $PORT открыт — управление готово."
    echo
    echo "  Войдите в систему в этом окне и откройте базу разделов."
    echo "  Потом выполните:"
    echo
    echo "    npm run cdp"
    echo
    echo "  Закончите — закройте это окно. Ваш обычный Chrome не пострадал."
    exit 0
  fi
done

echo
echo "✗ Порт $PORT не открылся."
echo "  Подробности в $HERE/chrome-debug.log — пришлите их, если видите ошибку."
exit 1
