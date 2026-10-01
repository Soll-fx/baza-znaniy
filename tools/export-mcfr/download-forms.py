#!/usr/bin/env python3
"""Скачивает файлы бланков с 1gb.uz в каталог раздела «Бланки».

Метаданные форм лежат в tools/export-mcfr/data/forms.ndjson (их собирает
harvest-forms.py). Сами файлы отдаёт /api/v2/attachment-file_get и только
авторизованному запросу, поэтому нужны куки вашей сессии.

Куки берутся из файла, экспортированного расширением браузера
(например «Get cookies.txt LOCALLY» для Chrome), либо из переменной
окружения M1GB_COOKIE.

  python3 download-forms.py --content content --cookies cookies.txt

После загрузки карточки бланков получают локальные ссылки на файлы, а
импорт превращает их в обычные вложения базы знаний.
"""

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://m.1gb.uz"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def ssl_context():
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def read_ndjson(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def load_cookies(args):
    """Возвращает заголовок Cookie."""
    if args.cookie:
        return args.cookie.strip()
    env = os.environ.get("M1GB_COOKIE")
    if env:
        return env.strip()
    if args.cookies and os.path.exists(args.cookies):
        jar = []
        for line in open(args.cookies, encoding="utf-8", errors="ignore"):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 7:
                jar.append(f"{parts[5]}={parts[6]}")
        if jar:
            return "; ".join(jar)
    sys.exit(
        "  Нужны куки сессии: укажите --cookies <файл> или --cookie '<строка>'.\n"
        "  Либо экспортируйте переменную M1GB_COOKIE."
    )


def download(opener, cookie, attachment_id, timeout=120):
    url = f"{API}/api/v2/attachment-file_get?attachmentId={attachment_id}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Cookie": cookie,
            "Referer": f"{API}/",
            "Accept": "*/*",
        },
    )
    with opener.open(req, timeout=timeout) as resp:
        return resp.read(), resp.headers.get("Content-Type", "")


def safe_name(name, maxlen=60):
    """Имя файла на диске: ASCII, без пробелов и скобок.

    Пробелы и скобки ломают разбор markdown-ссылок: в markdown.ts цель ссылки
    описывается как [^)\\s>]+, поэтому «(клиентам)» обрезал бы ссылку.
    Человекочитаемое имя остаётся в тексте ссылки.
    """
    stem, dot, ext = (name or "").strip().rpartition(".")
    if not dot:
        stem, ext = name or "", ""
    base = slug(stem, maxlen) or "file"
    return f"{base}.{ext.lower()}" if ext else base


# тот же словарь и правило, что в make-forms.py и server/src/lib/slug.ts
CYRILLIC_MAP = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya",
}


def slug(s, maxlen=90):
    t = "".join(CYRILLIC_MAP.get(ch, ch) for ch in (s or "").lower())
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    return t[:maxlen].strip("-") or "blank"


def assign_slugs(forms):
    """Проставляет slug так же, как make-forms.py: по алфавиту, с суффиксами."""
    used = {}
    for f in sorted(forms, key=lambda x: x["title"].lower()):
        base = slug(f["title"])
        n = used.get(base, 0)
        used[base] = n + 1
        f["slug"] = base if n == 0 else f"{base}-{n + 1}"


def main():
    ap = argparse.ArgumentParser(description="Скачивание файлов бланков")
    ap.add_argument("--content", required=True, help="каталог content")
    ap.add_argument("--data", default="tools/export-mcfr/data", help="каталог с forms.ndjson")
    ap.add_argument("--section", default="blanki")
    ap.add_argument("--cookies", default="", help="файл cookies.txt")
    ap.add_argument("--cookie", default="", help="строка Cookie")
    ap.add_argument("--limit", type=int, default=0, help="ограничить число форм")
    ap.add_argument("--delay", type=float, default=0.3)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    forms = read_ndjson(os.path.join(args.data, "forms.ndjson"))
    forms = [f for f in forms if f.get("files") and f.get("documentModuleType") == "form"]
    assign_slugs(forms)
    if args.limit:
        forms = forms[: args.limit]
    total_files = sum(len(f["files"]) for f in forms)
    print(f"  форм: {len(forms)}, файлов: {total_files}")

    cookie = load_cookies(args)
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl_context())
    )

    # проверяем авторизацию до основной работы
    probe = next((f for f in forms if f["files"]), None)
    if probe is None:
        sys.exit("  нет форм с файлами")
    try:
        data, ctype = download(opener, cookie, probe["files"][0]["attachmentId"])
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "ignore")[:200]
        sys.exit(f"  сервер ответил HTTP {exc.code}: {body}\n  Проверьте куки и срок их действия.")
    if data[:1] == b"[":
        sys.exit(f"  это JSON-ошибка, а не файл: {data[:200].decode('utf-8','ignore')}")
    print(f"  авторизация есть: пробный файл {len(data)} байт, {ctype}")

    ok = fail = skip = 0
    for i, f in enumerate(forms, 1):
        d = os.path.join(args.content, args.section, f["slug"])
        if not os.path.isdir(d):
            skip += 1
            continue
        card = os.path.join(d, f["slug"] + ".md")
        if not os.path.exists(card):
            skip += 1
            continue
        text = open(card, encoding="utf-8").read()
        lines = []
        seen = set()
        used = set()
        for att in f["files"]:
            name = att.get("fileName")
            if not name or name in seen:
                continue
            seen.add(name)
            local = safe_name(name)
            if local in used:
                n = 2
                while f"{os.path.splitext(local)[0]}-{n}{os.path.splitext(local)[1]}" in used:
                    n += 1
                local = f"{os.path.splitext(local)[0]}-{n}{os.path.splitext(local)[1]}"
            used.add(local)
            rel = f"{args.section}/{f['slug']}/{local}"
            if os.path.exists(os.path.join(args.content, rel)) and not args.dry_run:
                ok += 1
                lines.append(f"- [{name}](./{local}) — **{att.get('mime','')}**")
                continue
            if args.dry_run:
                lines.append(f"- {name} — **{att.get('mime','')}**")
                continue
            try:
                data, _ = download(opener, cookie, att["attachmentId"])
            except Exception as exc:  # noqa: BLE001
                fail += 1
                lines.append(f"- {name} — не удалось скачать: {exc}")
                continue
            with open(os.path.join(args.content, rel), "wb") as fh:
                fh.write(data)
            ok += 1
            lines.append(f"- [{name}](./{local}) — **{att.get('mime','')}**")
            time.sleep(args.delay)
        if lines and not args.dry_run:
            block = "\n".join(lines)
            section = "## Файлы формы\n\n" + block + "\n"
            if "## Файлы формы" in text:
                # Заменяем только секцию до следующего заголовка ##,
                # чтобы не потерять «Упоминается в статьях».
                parts = re.split(r"(?m)^## ", text)
                head, rest = parts[0], parts[1:]
                out = [head]
                for part in rest:
                    if part.startswith("Файлы формы"):
                        out.append(section)
                    else:
                        out.append("## " + part)
                text = "".join(out)
            else:
                text = text.rstrip() + "\n\n" + section
            open(card, "w", encoding="utf-8").write(text)
        if i % 10 == 0:
            print(f"  форм: {i}/{len(forms)} (скачано {ok}, ошибок {fail})")

    print(f"  готово: скачано {ok}, ошибок {fail}, пропущено разделов {skip}")
    if not args.dry_run:
        print("  Теперь пересоберите базу: npm run import -- --dir content --reset")


if __name__ == "__main__":
    main()
