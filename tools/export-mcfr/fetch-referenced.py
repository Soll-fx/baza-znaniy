#!/usr/bin/env python3
"""Скачивает документы 1gb.uz, на которые ссылаются уже загруженные статьи.

Зачем: в статьях базы знаний ссылки на НПА, памятки, статьи и бланки ведут
на 1gb.uz. Часть этих документов в выгрузке crawler'а отсутствует (они лежат
в других разделах базы), поэтому ссылки уводили читателя с сайта. Скрипт
догружает их штатной кнопкой скачивания `/system/content/export/doc/<m>/<d>/`
и складывает рядом манифест, по которому потом собираются статьи.

Куки вашей сессии обязательны: без них сайт отдаёт страницу входа вместо файла.

  python3 fetch-referenced.py --cookies ~/Downloads/1gb.uz_cookies.txt

Скачивание идемпотентно: уже скачанные документы пропускаются,
поэтому скрипт можно перезапускать.
"""

import argparse
import hashlib
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

SITE = "https://1gb.uz"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

DOC_RE = re.compile(r"https://1gb\.uz/#/document/(\d+)/(\d+)")
# Заголовок документа в выгрузке: у НПА это div.head, у статей — h2.auth__title.
_TITLE_CANDIDATES = (
    re.compile(r'(?is)<div[^>]*\bclass=["\'][^"\']*\bhead\b[^"\']*["\'][^>]*>(.*?)</div>'),
    re.compile(r'(?is)<h[12][^>]*\bclass=["\'][^"\']*\bauth__title\b[^"\']*["\'][^>]*>(.*?)</h[12]>'),
    re.compile(r"(?is)<title[^>]*>(.*?)</title>"),
    re.compile(r"(?is)<h1[^>]*>(.*?)</h1>"),
)
_TAG_RE = re.compile(r"(?s)<[^>]+>")


def ssl_context():
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def load_cookies(args):
    """Возвращает строку Cookie из файла cookies.txt, аргумента или окружения."""
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


def make_opener(cookie):
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl_context())
    )
    opener.addheaders = []  # куки передаём заголовком сами
    return opener, cookie


def export_url(module_id, doc_id):
    return f"{SITE}/system/content/export/doc/{module_id}/{doc_id}/"


def fetch(opener, cookie, module_id, doc_id, timeout=120, tries=3):
    """Возвращает (bytes, content_type) либо (None, причина)."""
    url = export_url(module_id, doc_id)
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": UA,
                "Cookie": cookie,
                "Referer": f"{SITE}/#/document/{module_id}/{doc_id}",
                "Accept": "*/*",
            },
        )
        try:
            with opener.open(req, timeout=timeout) as resp:
                data = resp.read()
                ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
            if len(data) < 200:
                last = f"слишком мало данных ({len(data)} байт)"
                time.sleep(2 * (attempt + 1))
                continue
            return data, ctype
        except urllib.error.HTTPError as exc:
            last = f"HTTP {exc.code}"
            if exc.code in (429, 500, 502, 503, 504):
                time.sleep(2 * (attempt + 1))
                continue
            return None, last
        except Exception as exc:  # noqa: BLE001 - сеть отдаёт что угодно
            last = str(exc)
            time.sleep(2 * (attempt + 1))
    return None, last


def title_from(data, content_type):
    """Заголовок документа из выгрузки 1gb.uz."""
    if "html" not in content_type and not data[:200].lstrip().lower().startswith(b"<"):
        return ""
    text = data.decode("utf-8", "ignore")
    for rx in _TITLE_CANDIDATES:
        m = rx.search(text)
        if not m:
            continue
        head = _TAG_RE.sub(" ", m.group(1))
        head = re.sub(r"\s+", " ", head.replace("\xa0", " ")).strip()
        if head:
            return head
    return ""


def collect_referenced(content_dir):
    """{ (module, doc) : [файлы, где встретилась ссылка] } по всему контенту."""
    out = {}
    for root, _dirs, files in os.walk(content_dir):
        for name in files:
            if not name.endswith(".md"):
                continue
            path = os.path.join(root, name)
            try:
                text = open(path, encoding="utf-8").read()
            except OSError:
                continue
            for m in DOC_RE.finditer(text):
                out.setdefault((m.group(1), m.group(2)), []).append(path)
    return out


def collect_local(content_dir):
    """Документы, уже представленные статьёй: source_url во frontmatter."""
    out = set()
    for root, _dirs, files in os.walk(content_dir):
        for name in files:
            if not name.endswith(".md"):
                continue
            path = os.path.join(root, name)
            try:
                text = open(path, encoding="utf-8").read()
            except OSError:
                continue
            m = re.search(r'source_url:\s*"https://1gb\.uz/#/document/(\d+)/(\d+)', text)
            if m:
                out.add((m.group(1), m.group(2)))
    return out


def doc_id_from_url(url):
    m = re.search(r"/document/(\d+)/(\d+)", url or "")
    return (m.group(1), m.group(2)) if m else (None, None)


def refetch_repaired(args, opener, cookie):
    """Докачивает документы, помеченные needs_refetch после repair-export.py.

    При обходе 1gb.uz отдавал печатную версию чужого документа, поэтому
    repair-export.py оставил эти документы без содержимого. Здесь мы берём
    их заново и проверяем, что заголовок в файле теперь совпадает с
    заголовком статьи, — иначе файл снова не попадёт в корпус.
    """
    root = os.path.abspath(args.repair)
    mpath = os.path.join(root, "_manifest.json")
    if not os.path.isfile(mpath):
        sys.exit(f"  Нет манифеста: {mpath}")
    manifest = json.load(open(mpath, encoding="utf-8"))

    todo = [r for r in manifest if r.get("needs_refetch")]
    print(f"  документов к докачке: {len(todo)}")

    ok = failed = 0
    for i, rec in enumerate(todo, 1):
        module_id, doc = doc_id_from_url(rec.get("source_url"))
        if not module_id:
            failed += 1
            print(f"  [{i}/{len(todo)}] нет source_url: {rec.get('title', '')[:50]}")
            continue
        data, ctype = fetch(opener, cookie, module_id, doc)
        if not data:
            failed += 1
            rec["error"] = ctype
            print(f"  [{i}/{len(todo)}] {module_id}/{doc} не отдан ({ctype})")
            continue
        name = rec.get("file")
        if not name:
            name = safe_file_name(rec.get("title") or f"{module_id}-{doc}") + ".doc"
            rec["file"] = name
        with open(os.path.join(root, name), "wb") as fh:
            fh.write(data)
        title = title_from(data, ctype)
        rec["title"] = title or rec.get("title")
        rec["contentType"] = ctype
        rec["bytes"] = len(data)
        rec["sha256"] = hashlib.sha256(data).hexdigest()
        rec.pop("needs_refetch", None)
        rec.pop("error", None)
        ok += 1
        print(f"  [{i}/{len(todo)}] {module_id}/{doc} {len(data):>8} байт  {title[:56]}")
        with open(mpath, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=1)
        time.sleep(args.delay)

    with open(mpath, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
    print(f"  скачано: {ok}, не отдано: {failed}")
    left = sum(1 for r in manifest if r.get("needs_refetch"))
    if left:
        print(f"  осталось needs_refetch: {left}")
    return 0 if failed == 0 else 1


def safe_file_name(title):
    name = re.sub(r'[\\/:*?"<>|\n\r\t]+', " ", title).strip().rstrip(".")
    return re.sub(r"\s+", " ", name)[:120] or "document"


def main():
    ap = argparse.ArgumentParser(description="Догрузка документов, на которые ссылаются статьи")
    ap.add_argument("--content", default="content", help="каталог content")
    ap.add_argument("--out", default="tools/export-mcfr/data/referenced", help="каталог выгрузки")
    ap.add_argument("--cookies", default="", help="файл cookies.txt")
    ap.add_argument("--cookie", default="", help="строка Cookie")
    ap.add_argument("--delay", type=float, default=1.2, help="пауза между запросами, с")
    ap.add_argument("--limit", type=int, default=0, help="скачать только первые N (для проверки)")
    ap.add_argument("--repair", default="",
                    help="каталог выгрузки с repair-export.py: докачать "
                         "документы, помеченные needs_refetch")
    args = ap.parse_args()

    cookie = load_cookies(args)
    opener, cookie = make_opener(cookie)

    if args.repair:
        return refetch_repaired(args, opener, cookie)

    refs = collect_referenced(args.content)
    local = collect_local(args.content)
    todo = sorted(k for k in refs if k not in local)
    if args.limit:
        todo = todo[: args.limit]

    os.makedirs(args.out, exist_ok=True)
    manifest_path = os.path.join(args.out, "manifest.json")
    manifest = {}
    if os.path.exists(manifest_path):
        try:
            manifest = json.load(open(manifest_path, encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            manifest = {}

    print(f"  ссылок на документы в контенте: {len(refs)}")
    print(f"  уже есть статья: {len(set(refs) & local)}")
    print(f"  к догрузке: {len(todo)}")

    ok = failed = skipped = 0
    for i, (module_id, doc_id) in enumerate(todo, 1):
        key = f"{module_id}/{doc_id}"
        rec = manifest.get(key)
        if rec and rec.get("file") and os.path.exists(os.path.join(args.out, rec["file"])):
            skipped += 1
            continue
        data, ctype = fetch(opener, cookie, module_id, doc_id)
        if not data:
            failed += 1
            manifest[key] = {
                "moduleId": module_id,
                "documentId": doc_id,
                "error": ctype,
                "referencedFrom": sorted(set(refs[(module_id, doc_id)])),
            }
            print(f"  [{i}/{len(todo)}] {key} не отдан ({ctype})")
            continue
        name = f"{module_id}-{doc_id}.doc"
        path = os.path.join(args.out, name)
        with open(path, "wb") as fh:
            fh.write(data)
        title = title_from(data, ctype)
        manifest[key] = {
            "moduleId": module_id,
            "documentId": doc_id,
            "url": f"{SITE}/#/document/{module_id}/{doc_id}",
            "title": title,
            "file": name,
            "contentType": ctype,
            "bytes": len(data),
            "referencedFrom": sorted(set(refs[(module_id, doc_id)])),
        }
        ok += 1
        print(f"  [{i}/{len(todo)}] {key} {len(data):>8} байт  {title[:60]}")
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2, sort_keys=True)
        time.sleep(args.delay)

    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2, sort_keys=True)

    print(f"  скачано: {ok}, уже было: {skipped}, не отдано: {failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
