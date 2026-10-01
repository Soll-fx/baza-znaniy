#!/usr/bin/env python3
"""Переписывает внешние ссылки 1gb.uz во внутренние вики-ссылки.

Зачем: после загрузки недостающих документов (fetch-referenced.py ->
build-referenced.py) читатель при клике по упоминанию НПА уходил на 1gb.uz.
Здесь каждая перекрёстная ссылка вида [текст](https://1gb.uz/#/document/M/D…)
заменяется на [[<локальный slug>|текст]], и WikiResolver в браузере открывает
статью на нашем сайте.

Что НЕ трогаем:
  * строку атрибуции «Материал из «Системы Главбух» ([оригинал](…))» — это ссылка
    на первоисточник (кредит авторства), а не навигация по сайту;
  * source_url во frontmatter — служебное поле импорта;
  * ссылки на вложенные файлы форм ([формa](./form.docx)) и валидные
    attachment-ссылки 1gb.uz — это файлы, не статьи;
  * битые плейсхолдеры attachment//16/// — их просто убираем.

Якоря 1gb.uz (…/document/M/D/abc123/) отбрасываем: на нашем сайте таких
идентификаторов нет, ссылка ведёт на начало статьи.

Запуск:
  python3 relink.py --content content [--dry-run]
"""

import argparse
import os
import re
import sys
from collections import defaultdict

# [label](url) — label может содержать экранированные скобки
LINK_RE = re.compile(r'\[((?:[^\]\\]|\\.)*)\]\(\s*<?((?:https?:)?//1gb\.uz/[^)\s>]*)>?\s*((?:"[^"]*")?)\)')
DOC_URL_RE = re.compile(r'^(?:https?:)?//1gb\.uz/#/document/(\d+)/(\d+)')
# Ссылка, в которой подпись — картинка: [![Схема](images/x.jpg)](https://1gb.uz/…)
# LINK_RE такую не ловит (в подписи есть «]»), поэтому разбираем отдельно.
IMG_LINK_RE = re.compile(
    r'\[!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?\s*\)\]'
    r'\(\s*<?((?:https?:)?//1gb\.uz/[^)\s>]*)>?\s*\)'
)
# Строка атрибуции, которую import-kb/build-referenced добавляют сами
ATTRIBUTION_RE = re.compile(r'^>\s*Материал из .*\[оригинал\]')
FRONTMATTER_SOURCE_RE = re.compile(r'^source_url:\s*"?[^"\n]*document/(\d+)/(\d+)', re.M)
FRONTMATTER_TITLE_RE = re.compile(r'^title:\s*"?([^"\n]+)"?\s*$', re.M)
# Приоритет разделов: полнотекстовой статье предпочитаем карточку бланка
SECTION_RANK = {"shablony-dokumentov": 0, "kodeksy-i-zakony": 1}


def build_doc_map(content_dir):
    """{doc_key: slug} — по source_url каждой статьи.

    Один документ иногда представлен и статьёй, и карточкой бланка с тем же
    slug; выбираем единственный «канонический» slug, чтобы [[slug]] не стал
    неоднозначным (сервер такие ссылки считает битыми).
    """
    candidates = defaultdict(list)  # doc_key -> [(rank, slug)]
    titles = {}                     # slug -> заголовок статьи
    for root, _dirs, files in os.walk(content_dir):
        for name in files:
            if not name.endswith(".md") or name == "_topic.md":
                continue
            text = open(os.path.join(root, name), encoding="utf-8").read()
            m = FRONTMATTER_SOURCE_RE.search(text)
            if not m:
                continue
            slug = name[:-3]
            tm = FRONTMATTER_TITLE_RE.search(text[:1500])
            if tm:
                titles.setdefault(slug, re.sub(r'\s+', ' ', tm.group(1)).strip())
            rel = os.path.relpath(root, content_dir)
            top = rel.split(os.sep)[0] if rel != "." else ""
            rank = SECTION_RANK.get(top, 2)  # blanki и прочее — в конец
            candidates[(m.group(1), m.group(2))].append((rank, slug))
    doc_map = {}
    for key, options in candidates.items():
        # при равном ранге берём лексикографически первый slug — детерминированно
        doc_map[key] = min(options)[1]
    return doc_map, titles


def wikilink_label(label, doc_key, doc_map, self_key):
    """Подпись для [[slug|подпись]]. Убирает форматирование и служебные хвосты."""
    lab = re.sub(r'[*_`]', '', label).strip()
    # картинки в вики-ссылку не влезают (label экранируется), оставляем подпись
    lab = re.sub(r'!\[([^\]]*)\]\([^)]*\)', r'\1', lab).strip()
    lab = re.sub(r'\s+', ' ', lab)
    return lab


def process_file(path, doc_map, titles, self_key, dry_run):
    text = open(path, encoding="utf-8").read()
    lines = text.split("\n")
    stats = defaultdict(int)
    out_lines = []
    for line in lines:
        if ATTRIBUTION_RE.match(line):
            out_lines.append(line)
            continue

        # 0) ссылка, у которой подпись — картинка. В [[slug|подпись]] картинка не
        # влезает (label экранируется), поэтому оставляем саму картинку и
        # добавляем рядом внутреннюю ссылку с заголовком статьи-адресата.
        def _img(m):
            alt, img, url = m.group(1), m.group(2), m.group(3)
            d = DOC_URL_RE.match(url)
            if not d:
                return m.group(0)
            key = (d.group(1), d.group(2))
            if key == self_key:
                return m.group(0)
            slug = doc_map.get(key)
            if not slug:
                stats["img_unresolved"] += 1
                return f"![{alt}]({img})"
            lab = (titles.get(slug) or slug).replace("|", "/")
            lab = re.sub(r'[\[\]]', "", lab).strip()
            stats["img_relinked"] += 1
            return f"![{alt}]({img}) [[{slug}|{lab}]]"

        line = IMG_LINK_RE.sub(_img, line)

        # 1) битые плейсхолдеры вложений 1gb.uz — убираем ссылку, оставляем подпись
        def _dead(m):
            label = m.group(1).strip()
            stats["dead_attachment"] += 1
            return label if label else ""
        line = re.sub(r'\[((?:[^\]\\]|\\.)*)\]\(\s*<?https://1gb\.uz/system/content/attachment//[^)\s>]*>?\s*\)', _dead, line)

        # 2) перекрёстные ссылки на документы -> [[slug|подпись]]
        def _doc(m):
            label, url, title = m.group(1), m.group(2), m.group(3)
            d = DOC_URL_RE.match(url)
            if not d:
                return m.group(0)  # не документ (вложение и т.п.) — не трогаем
            key = (d.group(1), d.group(2))
            if key == self_key:
                return m.group(0)  # самоссылка в атрибуции
            slug = doc_map.get(key)
            if not slug:
                stats["unresolved"] += 1
                return m.group(0)
            lab = wikilink_label(label, key, doc_map, self_key) or slug
            lab = lab.replace("|", "/").replace("[", "(").replace("]", ")")
            if "[" in lab or "]" in lab:
                lab = lab.replace("[", "(").replace("]", ")")
            stats["relinked"] += 1
            return f"[[{slug}|{lab}]]"

        line = LINK_RE.sub(_doc, line)
        out_lines.append(line)

    new_text = "\n".join(out_lines)
    if new_text != text and not dry_run:
        open(path, "w", encoding="utf-8").write(new_text)
    return stats


def self_key_of(text):
    m = FRONTMATTER_SOURCE_RE.search(text)
    return (m.group(1), m.group(2)) if m else None


def main():
    ap = argparse.ArgumentParser(description="Переписывание внешних ссылок 1gb.uz во внутренние")
    ap.add_argument("--content", default="content", help="каталог content")
    ap.add_argument("--dry-run", action="store_true", help="только показать, что изменится")
    args = ap.parse_args()

    doc_map, titles = build_doc_map(args.content)
    print(f"  документов со статьёй: {len(doc_map)}")

    totals = defaultdict(int)
    files_changed = 0
    for root, _dirs, files in os.walk(args.content):
        for name in files:
            if not name.endswith(".md"):
                continue
            path = os.path.join(root, name)
            text = open(path, encoding="utf-8").read()
            self_key = self_key_of(text)
            stats = process_file(path, doc_map, titles, self_key, args.dry_run)
            for k, v in stats.items():
                totals[k] += v
            if stats.get("relinked") or stats.get("dead_attachment"):
                files_changed += 1

    print(f"  обработано файлов с изменениями: {files_changed}")
    print(f"  перекрёстных ссылок -> [[slug]]: {totals['relinked']}")
    print(f"  ссылок-картинок переведено: {totals['img_relinked']}")
    print(f"  убрано битых плейсхолдеров вложений: {totals['dead_attachment']}")
    if totals.get("unresolved") or totals.get("img_unresolved"):
        print(f"  ! остались внешние ссылки на документы без статьи: "
              f"{totals['unresolved'] + totals['img_unresolved']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
