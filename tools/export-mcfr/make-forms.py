#!/usr/bin/env python3
"""Собирает раздел «Бланки» и расставляет ссылки на него в статьях.

Вход — результат harvest-forms.py:
  forms.ndjson             формы с описанием файлов
  forms-by-article.ndjson  какие формы упоминает какая статья

Создаёт content/blanki/<форма>/<форма>.md и дописывает в конец каждой
статьи блок «Полезные шаблоны» с вики-ссылками на формы.

  python3 make-forms.py --content content --data data/forms
"""

import argparse
import json
import os
import re
import sys

# свой заголовок: в исходных статьях уже есть «## Полезные шаблоны» —
# это сетка превью-картинок, её нельзя трогать
BLOCK_HEADING = "## Бланки и формы документов"

# тот же словарь, что в import-kb.py и server/src/lib/slug.ts
CYRILLIC_MAP = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya",
}


def slug(s, maxlen=90):
    """Совпадает с server/src/lib/slug.ts: кириллица -> latin, kebab-case."""
    t = "".join(CYRILLIC_MAP.get(ch, ch) for ch in (s or "").lower())
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    return t[:maxlen].strip("-") or "blank"


def read_ndjson(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def scan_articles(content_root):
    """source_url документа -> цель ссылки для resolveLinks.

    resolveLinks ищет «путь рубрики/slug». Если в каталоге статьи лежит свой
    _topic.md, рубрикой является каталог, и путь заканчивается каталогом —
    тогда к цели надо дописать имя файла. Иначе рубрика совпадает с
    каталогом, а каталог уже заканчивается слагом статьи.
    """
    index = {}
    for dirpath, _dirs, files in os.walk(content_root):
        for name in files:
            if not name.endswith(".md") or name == "_topic.md":
                continue
            path = os.path.join(dirpath, name)
            head = open(path, encoding="utf-8").read(1200)
            m = re.search(r'^source_url:\s*"?([^"\n]+)"?\s*$', head, re.M)
            if not m:
                continue
            rel = os.path.relpath(path, content_root).replace(os.sep, "/")[:-3]
            index[m.group(1).strip()] = (rel, rel)
    return index


def reserved_slugs(content_root, section):
    """Слаги, уже занятые статьями вне раздела бланков.

    Внутренняя нумерация форм ничего не знает о других разделах, поэтому
    «Трудовой договор» из раздела бланков и одноимённая статья раздела
    шаблонов получали один bare slug — а wikilinks резолвятся именно по нему.
    Такие формы получают суффикс раздела.
    """
    taken = set()
    sec_abs = os.path.abspath(os.path.join(content_root, section))
    for dirpath, dirs, files in os.walk(content_root):
        here = os.path.abspath(dirpath)
        if here == sec_abs or here.startswith(sec_abs + os.sep):
            dirs[:] = []  # весь раздел пропускаем, включая вложенные каталоги форм
            continue
        for name in files:
            if name.endswith(".md") and name != "_topic.md":
                taken.add(name[:-3])
    return taken


def form_block(entries):
    lines = [BLOCK_HEADING, ""]
    for e in entries:
        label = e["title"].replace("|", "\\|")
        lines.append(f"- [[{e['link']}|{label}]]")
    lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="Раздел «Бланки» + ссылки из статей")
    ap.add_argument("--content", required=True, help="каталог content")
    ap.add_argument("--data", required=True, help="каталог с forms.ndjson")
    ap.add_argument("--section", default="blanki", help="каталог раздела")
    ap.add_argument("--title", default="Бланки и формы документов")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    forms = read_ndjson(os.path.join(args.data, "forms.ndjson"))
    by_article = read_ndjson(os.path.join(args.data, "forms-by-article.ndjson"))
    if not forms:
        sys.exit("  forms.ndjson пуст — сначала запустите harvest-forms.py")

    content_root = args.content
    article_index = scan_articles(content_root)
    print(f"  статей в каталоге: {len(article_index)}")

    # ---- уникальные формы с файлами
    by_gid = {}
    for f in forms:
        if f.get("files") is not None and f.get("documentModuleType") == "form":
            by_gid[f["groupId"]] = f
    print(f"  форм с файлами: {len(by_gid)}")

    used = {}
    taken = reserved_slugs(content_root, args.section)
    suffix = args.section.rstrip("i") or "form"
    for gid, f in sorted(by_gid.items(), key=lambda kv: kv[1]["title"].lower()):
        base = slug(f["title"])
        stem = base if base not in taken else f"{base}-{suffix}"
        n = used.get(stem, 0)
        cand = stem if n == 0 else f"{stem}-{n + 1}"
        while cand in taken:
            n += 1
            cand = f"{stem}-{n + 1}"
        used[stem] = n + 1
        f["slug"] = cand

    # ---- раздел бланков
    sec_root = os.path.join(content_root, args.section)
    if not args.dry_run:
        os.makedirs(sec_root, exist_ok=True)
        with open(os.path.join(sec_root, "_topic.md"), "w", encoding="utf-8") as fh:
            fh.write(
                f"---\ntitle: \"{args.title}\"\n"
                f"summary: \"Шаблоны документов, на которые ссылаются статьи базы знаний.\"\n"
                "status: published\n---\n\n"
                f"# {args.title}\n\n"
                f"Формы и шаблоны документов, на которые ссылаются материалы базы знаний.\n"
                f"Всего форм: {len(by_gid)}.\n\n"
                "Файлы лежат на 1gb.uz: их можно скачать со страницы оригинала, требуется вход.\n"
            )

    n_files = 0
    for gid, f in by_gid.items():
        title = f["title"]
        files = f.get("files") or []
        # одна и та же форма отдаётся в двух экземплярах (пустая и заполненная)
        seen_files, uniq = set(), []
        for x in files:
            name = x.get("fileName")
            if not name or name in seen_files:
                continue
            seen_files.add(name)
            uniq.append(x)
        files = uniq
        n_files += len(files)
        link = f"{args.section}/{f['slug']}/{f['slug']}"
        f["link"] = link
        src = f.get("url") or ""
        exts = sorted({(x["fileName"] or "").rsplit(".", 1)[-1].lower() for x in files if x.get("fileName")})
        summary = f"Бланк «{title}»"
        if exts:
            summary += f". Формат: {', '.join(exts)}"
        rows = "\n".join(
            f"| {x['fileName']} | {x['fileName'].rsplit('.', 1)[-1].lower()} |" for x in files
        )
        # ссылки «упоминается в статьях» дописываются вторым проходом:
        # на этом шаге пути статей ещё не собраны
        refs = ""

        body = [
            "---",
            f'title: "{title}"',
            f'summary: "{summary}"',
            "status: published",
            f'source_url: "{src}"',
            f'source_section: "{args.title}"',
            f'original_format: "{(exts[0] if exts else "docx")}"',
            "---",
            "",
            f"# {title}",
            "",
            f"Форма из раздела «Формы» системы Главбух. Оригинал: [1gb.uz]({src or 'https://1gb.uz'}).",
            "",
            "## Файлы формы",
            "",
            "| Файл | Формат |",
            "|---|---|",
            rows,
            "",
            f"> Файлы хранятся на 1gb.uz — скачать их можно со страницы оригинала, требуется вход.",
        ]
        if refs:
            body += ["", "## Упоминается в статьях", "", refs]
        body.append("")

        if not args.dry_run:
            d = os.path.join(sec_root, f["slug"])
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "_topic.md"), "w", encoding="utf-8") as fh:
                # без тела: иначе source.ts зав��ёт статью «<rubrika> — обзор»,
                # лишний узел сдвинет путь рубрики и собьёт ссылки
                fh.write(f'---\ntitle: "{title}"\nsummary: "{summary}"\nstatus: published\n---\n')
            with open(os.path.join(d, f["slug"] + ".md"), "w", encoding="utf-8") as fh:
                fh.write("\n".join(body))

    print(f"  файлов у форм: {n_files}")

    # ---- ссылки из статей
    patched = 0
    for rec in by_article:
        key = rec.get("key") or ""
        mid, _, did = key.partition("/")
        url_forms = f"https://1gb.uz/#/document/{mid}/{did}"
        rel = article_index.get(url_forms)
        if rel is None:
            for u, p in article_index.items():
                if re.search(rf"/document/{mid}/{did}/?$", u):
                    rel = p
                    break
        if rel is None:
            continue
        rel, art_link = rel
        entries = []
        for f in rec.get("forms", []):
            if f.get("documentModuleType") != "form":
                continue
            g = by_gid.get(f.get("groupId"))
            if not g:
                continue
            entries.append({
                "title": f["title"],
                "link": g["link"],
                "gid": f["groupId"],
            })
            g.setdefault("usedIn", []).append(
                (art_link, rec.get("articleTitle") or art_link)
            )
        if not entries:
            continue
        path = os.path.join(content_root, rel + ".md")
        text = open(path, encoding="utf-8").read()
        # идемпотентность: убираем только свой прошлый блок
        if BLOCK_HEADING in text:
            text = text.split(BLOCK_HEADING)[0].rstrip() + "\n"
        text = text.rstrip() + "\n\n" + form_block(entries)
        if not args.dry_run:
            open(path, "w", encoding="utf-8").write(text)
        patched += 1

    print(f"  статей дополнено блоком шаблонов: {patched}")
    if not args.dry_run:
        # ссылки из карточек бланков пишем вторым проходом: к этому моменту
        # пути всех статей уже известны
        for gid, f in by_gid.items():
            used_in = f.get("usedIn") or []
            if not used_in:
                continue
            path = os.path.join(sec_root, f["slug"], f["slug"] + ".md")
            text = open(path, encoding="utf-8").read()
            refs = "\n".join(f"- [[{p}|{t}]]" for p, t in used_in)
            if "## Упоминается в статьях" in text:
                text = re.split("## Упоминается в статьях", text)[0].rstrip() + "\n"
            open(path, "w", encoding="utf-8").write(
                text + f"\n\n## Упоминается в статьях\n\n{refs}\n"
            )
    print("  готово")


if __name__ == "__main__":
    main()
