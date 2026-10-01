#!/usr/bin/env bash
# Полная пересборка базы знаний из выгрузки 1gb.uz.
#
#   tools/export-mcfr/rebuild.sh <каталог выгрузки> <манифест ndjson> [cookie]
#
# Порядок шагов важен:
#   1. fetch-images.py  — картинки выгрузки. import-kb.py строит image_map
#      из content/images и ссылки, которых нет в карте, ВЫБРАСЫВАЕТ, поэтому
#      скачивать надо до конвертации.
#   2. import-kb.py     — статьи и рубрики 1gb.uz (перезаписывает content/).
#   3. fetch-referenced.py — догрузка документов, на которые ссылаются статьи.
#   4. fetch-images.py  — картинки догруженных документов (до build-referenced,
#      иначе они будут выброшены тем же image_map).
#   5. build-referenced.py — статьи из догруженных документов.
#   6. make-forms.py    — раздел «Бланки» и блоки «Бланки и формы документов».
#   7. download-forms.py — файлы бланков (если передан cookie).
#   8. relink.py        — внешние ссылки 1gb.uz -> внутренние wikilinks.
#   9. alt-images.py    — alt картинок из подписей «Рис. N».
#  10. npm run import   — загрузка в базу с полной очисткой (--reset).
#  11. npm run validate — проверка битых ссылок и assets.
#
# Шаги 6-9 идут строго после 2-5: import-kb.py и build-referenced.py пишут
# исходный HTML с внешними ссылками, поэтому relink.py обязан быть последним.
set -euo pipefail

SRC="${1:?укажите каталог выгрузки, например /Users/soll/Downloads/kb-final}"
MANIFEST="${2:?укажите манифест, например /Users/soll/Downloads/kb-pages-2026-09-28.ndjson}"
COOKIE="${3:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/tools/export-mcfr"
DATA="$HERE/data"
REF="$DATA/referenced"
IMAGES="$ROOT/content/images"

cd "$ROOT"
STEP=0
TOTAL=12
step() { STEP=$((STEP + 1)); echo; echo "==> $STEP/$TOTAL $1"; }

# Старые статьи обязаны исчезнуть, иначе они переживут пересборку: import-kb.py
# ничего не удаляет, и статьи прошлой (битой) выгрузки снова попадут в базу
# как дубли одного source_url. Кэш картинок content/images переживает сборку.
step "очистка content/ от прежних статей"
if [ -d "$ROOT/content" ]; then
  find "$ROOT/content" -mindepth 1 -maxdepth 1 ! -name images -exec rm -rf {} +
  echo "  удалено, кэш картинок сохранён: $(ls -1 "$ROOT/content" 2>/dev/null | tr '\n' ' ')"
fi

# fetch-referenced.py по построению идемпотентен и пропускает уже скачанное,
# поэтому догруженные документы прошлой (битой) выгрузки пережили бы сборку.
if [ -d "$REF" ]; then
  rm -rf "$REF"
  echo "  очищен кэш догруженных документов: $REF"
fi

step "картинки выгрузки"
python3 "$HERE/fetch-images.py" "$SRC" -o "$IMAGES"

step "статьи и рубрики"
python3 "$HERE/import-kb.py" "$SRC" \
  --manifest "$MANIFEST" \
  --images-dir "$IMAGES" \
  -o "$ROOT/content"

if [ -n "$COOKIE" ]; then
  step "догрузка документов, на которые ссылаются статьи"
  python3 "$HERE/fetch-referenced.py" \
    --content "$ROOT/content" \
    --out "$REF" \
    --cookies "$COOKIE"
else
  echo
  echo "==> догрузка документов пропущена (не передан cookie)"
fi

if [ -d "$REF" ]; then
  step "картинки догруженных документов"
  python3 "$HERE/fetch-images.py" "$REF" -o "$IMAGES"
else
  echo
  echo "==> картинки догруженных документов пропущены (нет $REF)"
fi

step "статьи из догруженных документов"
python3 "$HERE/build-referenced.py" --content "$ROOT/content" --src "$REF"

if [ -f "$DATA/forms.ndjson" ]; then
  step "раздел «Бланки»"
  python3 "$HERE/make-forms.py" --content "$ROOT/content" --data "$DATA"
  if [ -n "$COOKIE" ]; then
    step "файлы бланков"
    python3 "$HERE/download-forms.py" --content "$ROOT/content" --cookies "$COOKIE"
  else
    echo
    echo "==> скачивание файлов бланков пропущено (не передан cookie)"
  fi
else
  echo
  echo "==> раздел «Бланки» пропущен (нет $DATA/forms.ndjson)"
fi

step "внешние ссылки 1gb.uz -> внутренние"
python3 "$HERE/relink.py" --content "$ROOT/content"

step "alt картинок из подписей"
python3 "$HERE/alt-images.py" --content "$ROOT/content"

step "загрузка в базу"
npm run import --workspace server -- --dir ../content --reset

step "проверка"
npm run validate --workspace server
