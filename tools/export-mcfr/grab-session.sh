#!/bin/bash
#
# Копирует сессию из вашего основного Chrome в отдельный профиль.
#
# Запускать ИЗ ВАШЕГО ТЕРМИНАЛА: у него есть доступ к профилю Chrome,
# у меня — нет, это ограничение macOS.
#
# Chrome при этом должен быть полностью закрыт, иначе база кук
# копируется неполной и сессия не сработает.
#
# Копируются только cookies и настройки. НЕ копируются история,
# закладки, пароли, расширения и данные других сайтов.
#
# Удалить после работы:  rm -rf "$HOME/.mcfr-export-profile"

set -uo pipefail

SRC="$HOME/Library/Application Support/Google/Chrome"
DST="$HOME/.mcfr-export-profile"
FAIL=0

echo "== 1. Проверяю, что Chrome закрыт =="
if pgrep -f "Google Chrome$" >/dev/null 2>&1; then
  echo "✗ Chrome ещё работает. Закройте его полностью через Cmd+Q и запустите заново."
  exit 1
fi
echo "✓ Chrome закрыт"

# macOS может закрывать папку профиля от командной строки (TCC).
# Проверяем это ДО копирования, иначе cp молча падает, а скрипт радостно
# сообщает об успехе — так и случилось в прошлый раз.
echo
echo "== 1b. Проверяю, читается ли профиль =="
if ls "$SRC" >/dev/null 2>&1; then
  echo "✓ Папка профиля читается"
else
  cat <<'MSG'
✗ macOS не даёт прочитать профиль Chrome из командной строки.
  Это системная защита, а не поломка скрипта: даже ваш Терминал
  получает "Operation not permitted".

  Что делать — один раз:
    1. Откройте: Системные настройки → Конфиденциальность и безопасность
       → Полный доступ к диску
    2. Нажмите «+» и добавьте Терминал (или то приложение, в котором вы
       работаете: Терминал, iTerm, Warp, Alacritty — то, откуда вы запускаете
       команды)
    3. Полностью закройте его и откройте заново
    4. Запустите скрипт снова

  Право нужно только на чтение папки Chrome; скрипт копирует из неё
  cookies и настройки и ничего больше не трогает.
MSG
  exit 1
fi

echo
echo "== 2. Ищу профили с куками =="
if [ ! -d "$SRC" ]; then
  echo "✗ Каталог Chrome не найден: $SRC"
  exit 1
fi

# active — тот профиль, в котором вы сидите (Default или Profile 1, …)
ACTIVE="$(grep -o '"last_used": *"[^"]*"' "$SRC/Local State" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"//')"
ACTIVE="${ACTIVE:-Default}"
echo "  активный профиль по Local State: $ACTIVE"

rm -rf "$DST"
mkdir -p "$DST"

# Копируем через cat, а не cp: так ошибка доступа видна сразу, а не
# превращается в пустой файл, который потом принимают за успех.
copy_checked() {
  local src="$1" dst="$2"
  if ! cat "$src" > "$dst" 2>/dev/null; then
    echo "  ✗ не удалось прочитать: $src"
    return 1
  fi
  local a b
  a=$(wc -c < "$src" | tr -d ' ')
  b=$(wc -c < "$dst" | tr -d ' ')
  if [ "$a" -eq 0 ]; then
    echo "  ✗ файл пустой: $src"
    return 1
  fi
  if [ "$a" != "$b" ]; then
    echo "  ✗ размер не совпал ($a → $b): $src"
    return 1
  fi
  echo "  ✓ $(basename "$dst")  $a байт"
  return 0
}

# Ключ шифрования cookies — без него сессия не расшифруется.
copy_checked "$SRC/Local State" "$DST/Local State" || FAIL=1

COPIED=0
for dir in "$SRC"/Default "$SRC"/Profile\ *; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  csrc="$dir/Cookies"
  [ -f "$csrc" ] || csrc="$dir/Network/Cookies"
  if [ ! -f "$csrc" ]; then
    continue
  fi
  mkdir -p "$DST/$name"
  if ! copy_checked "$csrc" "$DST/$name/Cookies"; then
    FAIL=1
    continue
  fi
  copy_checked "$dir/Preferences" "$DST/$name/Preferences" || true
  [ -d "$dir/Local Storage" ] && cp -R "$dir/Local Storage" "$DST/$name/Local Storage" 2>/dev/null

  COPIED=$((COPIED + 1))
done

echo
if [ "$COPIED" -eq 0 ]; then
  echo "✗ Ни в одном профиле не нашлось базы cookies. Скопировать нечего."
  exit 1
fi
echo "  профилей с куками скопировано: $COPIED (активный по Local State: $ACTIVE)"

if [ "$ACTIVE" != "Default" ] && [ -f "$DST/Default/Cookies" ]; then
  echo
  echo "  ВНИМАНИЕ: активный профиль — $ACTIVE, куки нашлись и в Default."
  echo "  Если разведка снова покажет лендинг, попробуем --profile с $ACTIVE."
fi

chmod -R go-rwx "$DST"

echo
if [ "$FAIL" -ne 0 ]; then
  echo "✗ Копирование прошло с ошибками — строки с ✗ выше."
  echo "  Дальше не идите: папка $DST неполная, сессия не сработает."
  exit 1
fi

echo "✓ Готово: $DST"
echo
echo "Дальше выполните:"
echo
echo "  node probe.mjs --profile \"$DST\""
echo
echo "Если macOS спросит доступ к «Связке ключей» — нажмите «Всегда разрешить»."
echo "После работы:  rm -rf \"$DST\""
