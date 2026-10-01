#!/usr/bin/env python3
"""Превращает догруженные документы (fetch-referenced.py) в статьи сайта.

Зачем: ссылки в тексте уводили читателя на 1gb.uz. Этот скрипт кладёт недостающие
документы рядом с уже загруженными, чтобы relink.py переписал ссылки внутрь сайта.

Куда раскладываем (по модулю 1gb.uz):
  16  -> Налогообложение и бухгалтерский учет (с тематическими подгруппами)
  86  -> Новости и семинары
  90  -> Кодексы и законы
  118 -> Шаблоны документов
  113 -> Словарь терминов      (глоссарий: Договор, Выходные, ...)
  126 -> Женщина в бухгалтерии (книга по саморазвитию, не бухгалтерия)
  прочее -> Налогообложение и бухгалтерский учет

Слаги делаем уникальными по всему сайту: вики-ссылка [[slug]] резолвится в браузере
по одному slug, и два разных документа с одинаковым slug сделали бы ссылку
неоднозначной.

Запуск:
  python3 build-referenced.py --content content
"""

import argparse
import importlib.util
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DOC_RE = re.compile(r"https://1gb\.uz/#/document/(\d+)/(\d+)")


def load_kb_module():
    """Переиспользуем проверенный HTML->Markdown из import-kb.py."""
    spec = importlib.util.spec_from_file_location("import_kb", os.path.join(HERE, "import-kb.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


kb = load_kb_module()

# Модуль 1gb.uz -> раздел сайта. Подгруппы внутри «ленты» — те же, что у import-kb.
SECTION_BY_MODULE = {
    "90": "Кодексы и законы",
    "118": "Шаблоны документов",
    "113": "Словарь терминов",
    "126": "Женщина в бухгалтерии",
}
DEFAULT_SECTION = "Налогообложение и бухгалтерский учет"

# Модули, которые в существующей структуре сайта относятся к разделу, а не к ленте.
# 86 — «Новости и семинары» по общему правилу import-kb, но конкретные документы
# модуля 86, на которые нас отправляют статьи, — это памятки и разъяснения
# (допсоглашение, KPI, командировка), а не новости: кладём их в ленту.
ARTICLES_AS_NOTES = {"86", "12", "145"}


def q(s):
    """Значение frontmatter в двойных кавычках — как это делает import-kb.py."""
    return '"' + (s or "").replace('"', "'").replace("\\", "") + '"'


def section_for(module_id, title):
    if str(module_id) in ARTICLES_AS_NOTES or str(module_id) not in SECTION_BY_MODULE:
        section = DEFAULT_SECTION
    else:
        section = SECTION_BY_MODULE[str(module_id)]
    sub = kb.subsection_for(section, title)
    return [section] + ([sub] if sub else [])


def existing_slugs(content_dir):
    """Все слагаги статей на сайте: имя файла .md (без '_topic')."""
    out = set()
    for root, _dirs, files in os.walk(content_dir):
        for name in files:
            if name.endswith(".md") and name != "_topic.md":
                out.add(name[:-3])
    return out


def unique_slug(title, taken, doc_key):
    base = kb.slug(title, 90)
    if base not in taken:
        return base
    # Названия у 1gb.uz не уникальны («Об утверждении НСБУ» — девять документов),
    # поэтому дописываем номер документа: он делает слаг уникальным и показывает,
    # какой версии закона соответствует статья.
    suffix = doc_key.replace("/", "-")
    cand = f"{base}-{suffix}"
    n = 2
    while cand in taken:
        cand = f"{base}-{suffix}-{n}"
        n += 1
    return cand


def ensure_topic(content_dir, section_path, title):
    """Создаёт _topic.md для раздела/подраздела, если его ещё нет."""
    for depth in range(1, len(section_path) + 1):
        path = os.path.join(content_dir, *[kb.slug(x) for x in section_path[:depth]], "_topic.md")
        if os.path.exists(path):
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(f"---\ntitle: {q(section_path[depth - 1])}\nis_published: true\n---\n")


def summary_from(body, fallback):
    """Первый содержательный абзац — он же показывается в списках и поиске."""
    for para in re.split(r"\n{2,}", body):
        for line in para.split("\n"):
            line = line.strip()
            if not line or line.startswith(("-", "*", "#", "|", ">", "\\", "!")):
                continue
            cand = re.sub(r"[*_`]", "", line)
            cand = re.sub(r"\s+", " ", cand).strip()
            if len(cand) >= 60:
                return cand[:180].rsplit(" ", 1)[0]
    return fallback


def link_label_from_refs(rec):
    """Заголовок из текста ссылки в статье, где на документ ссылаются.

    У четырёх документов 1gb.uz не отдаёт заголовок, но в статье он назван
    своими словами («памятка по ...») — берём эту подпись. Пути в referencedFrom
    указаны от корня репозитория.
    """
    key = f"document/{rec.get('moduleId')}/{rec.get('documentId')}"
    for rel in rec.get("referencedFrom") or []:
        try:
            text = open(rel, encoding="utf-8").read()
        except OSError:
            continue
        for m in re.finditer(r"\[([^\]\n]{4,120})\]\([^)\n]*" + re.escape(key) + r"[^)\n]*\)", text):
            label = re.sub(r"\s+", " ", m.group(1)).strip()
            if label and not label.startswith("!"):
                return label
    return ""


def main():
    ap = argparse.ArgumentParser(description="Сборка статей из догруженных документов")
    ap.add_argument("--content", default="content", help="каталог content")
    ap.add_argument("--src", default="tools/export-mcfr/data/referenced", help="каталог выгрузки")
    args = ap.parse_args()

    manifest_path = os.path.join(args.src, "manifest.json")
    manifest = json.load(open(manifest_path, encoding="utf-8"))
    image_map = kb.build_image_map(os.path.join(args.content, "images"))
    img_stats = {"локальные": 0, "внешние": 0, "нет файла": 0, "битая ссылка": 0}

    taken = existing_slugs(args.content)
    mapping_path = os.path.join(args.src, "slugmap.json")
    slugmap = json.load(open(mapping_path, encoding="utf-8")) if os.path.exists(mapping_path) else {}

    written = 0
    for key, rec in sorted(manifest.items(), key=lambda kv: int(kv[0].split("/")[0])):
        if rec.get("error") or not rec.get("file"):
            continue
        path = os.path.join(args.src, rec["file"])
        if not os.path.exists(path):
            print(f"  ! нет файла для {key}")
            continue
        data = open(path, "rb").read()
        module_id = str(rec.get("moduleId"))

        body = kb.html_to_md(data, rec.get("url", "")) if len(data) > 400 else ""

        title = (rec.get("title") or "").strip()
        if not title:
            title = link_label_from_refs(rec)
        if not title:
            title = f"Материал 1gb.uz {key.replace('/', '-')}"

        section_path = section_for(module_id, title)
        ensure_topic(args.content, section_path, title)

        slug = slugmap.get(key) or unique_slug(title, taken, key)
        taken.add(slug)
        slugmap[key] = slug

        adir = os.path.join(args.content, *[kb.slug(x) for x in section_path], slug)
        os.makedirs(adir, exist_ok=True)
        # Оригинал кладём рядом со статьёй: сервер ищет src относительно каталога
        # статьи, общий content/images он бы не увидел.
        ext = kb.sniff_ext(data, rec.get("contentType", ""), rec.get("url", ""))
        with open(os.path.join(adir, f"{slug}.{ext}"), "wb") as fh:
            fh.write(data)

        used = set()
        body = kb.localize_images(body, image_map, img_stats, used)
        if used:
            idir = os.path.join(adir, "images")
            os.makedirs(idir, exist_ok=True)
            for rel in sorted(used):
                src = os.path.join(args.content, "images", os.path.basename(rel))
                if os.path.isfile(src):
                    shutil.copyfile(src, os.path.join(idir, os.path.basename(rel)))

        source = rec.get("url") or f"https://1gb.uz/#/document/{module_id}/{rec.get('documentId')}"
        section_label = " / ".join(section_path)
        with open(os.path.join(adir, "_topic.md"), "w", encoding="utf-8") as fh:
            fh.write(f"---\ntitle: {q(title)}\nsource_url: {q(source)}\n---\n")

        if len(body) > 120:
            kind = "article"
            md = [
                "---",
                f"title: {q(title)}",
                f"summary: {q(summary_from(body, title))}",
                "status: published",
                f"source_url: {q(source)}",
                f"source_section: {q(section_label)}",
                f"original_format: {q(ext)}",
                "---",
                "",
                f"# {title}",
                "",
                f"> Материал из «Системы Главбух» ([оригинал]({source})).",
                "",
                body,
                "",
            ]
        else:
            kind = "stub"
            md = [
                "---",
                f"title: {q(title)}",
                f"summary: {q('Оригинал без текстовой версии: ' + title)}",
                "status: published",
                f"source_url: {q(source)}",
                f"source_section: {q(section_label)}",
                f"original_format: {q(ext)}",
                "---",
                "",
                f"# {title}",
                "",
                f"Оригинал сохранён рядом со статьёй: `{slug}.{ext}`.",
                "",
                f"Источник: [1gb.uz]({source}).",
                "",
            ]
        with open(os.path.join(adir, f"{slug}.md"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(md))
        written += 1
        print(f"  [{written:>3}] {key:>10}  {kind:<7} {len(body):>8} симв.  {'/'.join(kb.slug(x) for x in section_path)}/{slug}")

    with open(mapping_path, "w", encoding="utf-8") as fh:
        json.dump(slugmap, fh, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"  статей записано: {written}; карта слагов: {mapping_path}")
    print(f"  картинки: {img_stats}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
