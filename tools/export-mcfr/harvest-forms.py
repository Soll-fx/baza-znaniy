#!/usr/bin/env python3
"""Собирает бланки (формы), на которые ссылаются статьи базы знаний.

Статьи на 1gb.uz заканчиваются блоком «Полезные шаблоны» — это elemList
с viewType="forms", где каждый пункт ведёт на форму по groupId. Сами формы
лежат в разделе «Формы» (moduleId 118) и содержат массив attachments с
настоящими файлами .docx/.xlsx.

Списки бланков и метаданные файлов отдаёт публичный API. Само скачивание
файлов требует входа, поэтому здесь мы их только описываем.

  python3 harvest-forms.py --manifest <ndjson> --out <dir>
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
from http.cookiejar import CookieJar

API = "https://m.1gb.uz"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def ssl_context():
    """Системный бандл на macOS не всегда подхватывается, берём certifi."""
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def make_opener() -> urllib.request.OpenerDirector:
    jar = CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar),
        urllib.request.HTTPSHandler(context=ssl_context()),
    )
    # прогреваем cookie-бар: без него 1gb.uz уводит в бесконечный редирект
    req = urllib.request.Request(
        "https://1gb.uz/", headers={"User-Agent": UA, "Accept": "text/html"}
    )
    try:
        opener.open(req, timeout=30).read()
    except Exception as exc:  # noqa: BLE001 - куки не критичны для API
        print(f"  предупреждение: не удалось прогреть cookie ({exc})", file=sys.stderr)
    return opener


def get_json(opener, path, params, tries=3):
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Referer": f"{API}/",
            "Accept-Language": "ru,uz;q=0.8",
        },
    )
    last = None
    for attempt in range(tries):
        try:
            with opener.open(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "ignore")[:200]
            if exc.code in (429, 500, 502, 503, 504):
                last = f"HTTP {exc.code}"
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"{url} -> HTTP {exc.code}: {body}") from exc
        except Exception as exc:  # noqa: BLE001
            last = str(exc)
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{url} -> {last}")


def walk(node):
    """Обходит дерево узлов документа."""
    stack = [node]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            yield cur
            stack.extend(cur.get("children") or [])
        elif isinstance(cur, list):
            stack.extend(cur)


def forms_in_doc(doc):
    """Достаёт пункты блоков «Полезные шаблоны» из документа."""
    out = []
    body = (((doc or {}).get("document") or {}).get("content") or {})
    body = body.get("body") or {}
    for node in walk(body):
        if node.get("type") != "elemList":
            continue
        if (node.get("options") or {}).get("viewType") != "forms":
            continue
        for item in node.get("children") or []:
            for link in walk(item):
                if link.get("type") != "linkGroup":
                    continue
                opts = link.get("options") or {}
                ident = opts.get("id") or {}
                title = "".join(
                    (c.get("options") or {}).get("value", "")
                    for c in (link.get("children") or [])
                    if c.get("type") == "text"
                )
                out.append(
                    {
                        "title": re.sub(r"\s+", " ", title).strip(),
                        "groupId": ident.get("groupId"),
                        "moduleId": ident.get("moduleId") or opts.get("moduleId"),
                        "documentModuleType": opts.get("documentModuleType"),
                        "date": opts.get("date"),
                    }
                )
    return out


def attachments_of(doc):
    """Достаёт описание вложенных файлов из документа."""
    out = []
    for att in ((doc or {}).get("document") or {}).get("attachments") or []:
        out.append(
            {
                "attachmentId": att.get("id"),
                "fileName": att.get("fileName"),
                "name": att.get("name"),
                "mime": att.get("mime"),
                "isFilled": (att.get("options") or {}).get("isFilled"),
                "downloadUrl": f"{API}/api/v2/attachment-file_get?attachmentId={att.get('id')}",
            }
        )
    return out


def read_manifest(path):
    ids = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            m = re.search(r"#/document/(\d+)/(\d+)", row.get("url") or "")
            if not m:
                continue
            ids[(m.group(1), m.group(2))] = row.get("title")
    return ids


def main():
    ap = argparse.ArgumentParser(description="Сбор бланков, связанных со статьями")
    ap.add_argument("--manifest", required=True, help="ndjson с выгрузкой статей")
    ap.add_argument("--out", required=True, help="каталог для результата")
    ap.add_argument("--limit", type=int, default=0, help="ограничить число статей")
    ap.add_argument("--delay", type=float, default=0.25, help="пауза между запросами")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    opener = make_opener()
    docs = read_manifest(args.manifest)
    items = sorted(docs.items())
    if args.limit:
        items = items[: args.limit]
    print(f"  статей к обходу: {len(items)}")

    arts_path = os.path.join(args.out, "forms-by-article.ndjson")
    forms_path = os.path.join(args.out, "forms.ndjson")
    done = set()
    if os.path.exists(arts_path):
        with open(arts_path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    done.add(json.loads(line)["key"])
                except Exception:  # noqa: BLE001
                    pass
        print(f"  уже обработано: {len(done)}")

    seen_forms = {}
    if os.path.exists(forms_path):
        with open(forms_path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                    seen_forms[rec["groupId"]] = rec
                except Exception:  # noqa: BLE001
                    pass

    n_new_links = 0
    with open(arts_path, "a", encoding="utf-8") as arts:
        for i, ((module_id, doc_id), title) in enumerate(items, 1):
            key = f"{module_id}/{doc_id}"
            if key in done:
                continue
            try:
                doc = get_json(
                    opener,
                    "/api/v1/desktop/document_get-by-id",
                    {"DocumentId": doc_id, "ModuleId": module_id},
                )
            except Exception as exc:  # noqa: BLE001
                print(f"  [{i}/{len(items)}] {key} пропущена: {exc}", file=sys.stderr)
                continue
            forms = forms_in_doc(doc)
            if forms:
                n_new_links += len(forms)
                arts.write(
                    json.dumps(
                        {"key": key, "articleTitle": title, "forms": forms},
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                arts.flush()
                print(f"  [{i}/{len(items)}] {title[:44]:<46} бланков: {len(forms)}")
            done.add(key)
            time.sleep(args.delay)

    print(f"  ссылок на бланки: {n_new_links}")

    # добираем метаданные самих форм
    pending = {k: v for k, v in seen_forms.items() if not v.get("files")}
    for arts_line in open(arts_path, encoding="utf-8"):
        for f in json.loads(arts_line)["forms"]:
            if f.get("groupId") and f["groupId"] not in seen_forms:
                pending[f["groupId"]] = {**f, "files": None}

    with open(forms_path, "w", encoding="utf-8") as out:
        for i, (group_id, rec) in enumerate(sorted(pending.items()), 1):
            rec = dict(rec)
            rec["groupId"] = group_id
            try:
                ident = get_json(
                    opener,
                    "/api/v1/desktop/document-identifier_get-by-group",
                    {"GroupId": group_id, "Locale": "uz"},
                )
                rec["moduleId"] = ident.get("moduleId")
                rec["documentId"] = ident.get("documentId")
                doc = get_json(
                    opener,
                    "/api/v1/desktop/document_get-by-id",
                    {
                        "DocumentId": ident.get("documentId"),
                        "ModuleId": ident.get("moduleId"),
                    },
                )
                rec["files"] = attachments_of(doc)
                rec["url"] = (
                    f"https://1gb.uz/#/document/{ident.get('moduleId')}"
                    f"/{ident.get('documentId')}"
                )
            except Exception as exc:  # noqa: BLE001
                rec["error"] = str(exc)[:200]
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            time.sleep(args.delay)
            if i % 25 == 0:
                print(f"  форм: {i}/{len(pending)}")

    with open(forms_path, encoding="utf-8") as fh:
        total = sum(1 for _ in fh)
    print(f"  уникальных бланков: {total}")
    print(f"  результат: {args.out}")


if __name__ == "__main__":
    main()
