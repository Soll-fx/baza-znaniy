#!/usr/bin/env python3
"""Восстанавливает выгрузку 1gb.uz, в которой заголовок и содержимое разошлись.

Что случилось: при обходе эндпоинт `/system/content/export/doc/<m>/<d>/`
отдавал печатную версию ЧУЖОГО документа. Заголовок брался со страницы
списка, байты — из ответа endpoint'а, поэтому в архиве 455 файлов, но
0 содержат свою статью.

Идея восстановления: внутри каждого файла есть заголовок самой статьи
(печатный шаблон печатает его первым содержательным блоком). Сопоставляем
его с заголовками из манифеста и перепривязываем файл к тому документу,
который он на самом деле содержит.

Скрипт ничего не перезаписывает: результат пишется в отдельный каталог.

  python3 repair-export.py ~/Downloads/kb-final -o ~/Downloads/kb-repaired
  python3 repair-export.py ~/Downloads/kb-final -o /tmp/out --report
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from collections import defaultdict

# Служебные блоки печатного шаблона 1gb.uz, которые не являются заголовком.
_NOISE = re.compile(
    r"^(print\s+\d+|©|copyright|action|система\s+главбух|содержание|оглавление"
    r"|страница\s+\d+|1gb\.uz|www\.|http)",
    re.I,
)
_STYLE = re.compile(r"(?is)<(script|style)\b.*?</\1>")
_TAGS = re.compile(r"(?s)<[^>]+>")


def norm(s):
    """Нормализует заголовок для сопоставления: регистр, кавычки, пробелы."""
    s = (s or "").lower()
    for a, b in (("«", '"'), ("»", '"'), ("“", '"'), ("”", '"'),
                 ("„", '"'), ("‘", "'"), ("’", "'"), ("–", "-"), ("—", "-")):
        s = s.replace(a, b)
    s = re.sub(r"[^\w\s]", " ", s, flags=re.U)
    return re.sub(r"\s+", " ", s).strip()


def text_lines(data):
    """Содержательные строки файла: HTML-разметка печатной версии снята."""
    t = _STYLE.sub(" ", data.decode("utf-8", "ignore"))
    t = _TAGS.sub("\n", t)
    t = t.replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", '"')
    out = []
    for line in t.split("\n"):
        line = re.sub(r"\s+", " ", line).strip()
        if len(line) > 15:
            out.append(line)
    return out


def inner_title(data):
    """Заголовок статьи, напечатанный внутри файла."""
    for line in text_lines(data):
        line = re.sub(r"^print\s+\d+\s*", "", line, flags=re.I).strip()
        if len(norm(line)) > 20 and not _NOISE.match(line):
            return line
    return ""


def load_manifest(src):
    path = os.path.join(src, "_manifest.json")
    if not os.path.isfile(path):
        sys.exit(f"  Нет манифеста: {path}")
    return json.load(open(path, encoding="utf-8"))


def build_map(manifest, src, verbose=False):
    """{ индекс документа : индекс файла с его содержимым } и отчёт."""
    by_title = defaultdict(list)
    for i, rec in enumerate(manifest):
        by_title[norm(rec.get("title"))].append(i)

    # файл -> заголовки статей, которые он может содержать
    owner = {}
    for i, rec in enumerate(manifest):
        path = os.path.join(src, rec.get("file") or "")
        if not os.path.isfile(path):
            continue
        title = inner_title(open(path, "rb").read())
        if not title:
            continue
        owner[i] = by_title.get(norm(title), [])

    claims = defaultdict(list)
    for file_idx, targets in owner.items():
        for t in targets:
            claims[t].append(file_idx)

    unique = {t: v[0] for t, v in claims.items() if len(v) == 1}
    conflict = {t: v for t, v in claims.items() if len(v) > 1}
    missing = [i for i in range(len(manifest)) if i not in claims]

    if verbose:
        print(f"  документов: {len(manifest)}")
        print(f"  восстановлено однозначно: {len(unique)}")
        print(f"  конфликт (несколько файлов): {len(conflict)}")
        print(f"  содержимое не найдено: {len(missing)}")
    return unique, conflict, missing


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", nargs="?", default=os.path.expanduser("~/Downloads/kb-final"))
    ap.add_argument("-o", "--out", default=os.path.expanduser("~/Downloads/kb-repaired"))
    ap.add_argument("--report", action="store_true", help="подробный список проблем")
    ap.add_argument("--apply", action="store_true",
                    help="собрать исправленную выгрузку в --out (по умолчанию dry-run)")
    args = ap.parse_args()

    src = os.path.abspath(args.src)
    if not os.path.isdir(src):
        sys.exit(f"  Каталог не найден: {src}")

    manifest = load_manifest(src)
    print(f"Исходная выгрузка: {src}")
    unique, conflict, missing = build_map(manifest, src, verbose=True)

    correct = sum(1 for t, f in unique.items() if t == f)
    print(f"\n  файлов, где заголовок совпал с содержимым: {correct}")

    if args.report:
        print("\n--- Конфликты: содержимое претендуют несколько файлов ---")
        for t, files in sorted(conflict.items()):
            print(f"  [{t}] {manifest[t].get('title')}")
            for f in files:
                print(f"      <- {manifest[f].get('file')}")
        print("\n--- Не найдено содержимое (нужно перекачать) ---")
        for i in missing:
            print(f"  [{i}] {manifest[i].get('title')}\n"
                  f"      {manifest[i].get('source_url')}")

    if not args.apply:
        print("\nЭто dry-run. Добавьте --apply, чтобы собрать исправленную выгрузку.")
        return

    out = os.path.abspath(args.out)
    if os.path.exists(out) and os.listdir(out):
        sys.exit(f"  Каталог {out} не пуст — очистите или укажите другой --out.")
    os.makedirs(out, exist_ok=True)

    for path in os.listdir(src):
        if not path.startswith("_"):
            shutil.copy2(os.path.join(src, path), os.path.join(out, path))

    fixed = []
    new_manifest = []
    # хэши уже восстановленного содержимого: их дубликаты в исходной выгрузке
    # не нужны, иначе в наборе снова окажется файл с чужим заголовком
    restored = set()
    for i, rec in enumerate(manifest):
        if i in unique:
            data = open(os.path.join(src, manifest[unique[i]].get("file")), "rb").read()
            restored.add(hashlib.sha256(data).hexdigest())

    for i, rec in enumerate(manifest):
        rec = dict(rec)
        if i in unique:
            src_name = manifest[unique[i]].get("file")
            dst_name = rec.get("file")
            if src_name and dst_name and src_name != dst_name:
                shutil.copy2(os.path.join(src, src_name), os.path.join(out, dst_name))
                fixed.append((i, dst_name, src_name))
        else:
            # содержимое не подтверждено. Если это копия уже восстановленной
            # статьи — удаляем, иначе файл уедет в корпус с чужим заголовком.
            path = os.path.join(out, rec.get("file") or "")
            digest = None
            if os.path.isfile(path):
                digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
                if digest in restored:
                    os.remove(path)
            rec["needs_refetch"] = True
        new_manifest.append(rec)

    with open(os.path.join(out, "_manifest.json"), "w", encoding="utf-8") as f:
        json.dump(new_manifest, f, ensure_ascii=False, indent=1)

    print(f"\nИсправленная выгрузка: {out}")
    print(f"  перепривязано файлов: {len(fixed)}")
    print(f"  помечено needs_refetch: {sum(1 for r in new_manifest if r.get('needs_refetch'))}")
    left = sum(1 for r in new_manifest
               if r.get("needs_refetch") and os.path.isfile(os.path.join(out, r.get("file") or "")))
    print(f"  из них осталось файлов на диске: {left}")
    print(f"\nСледующий шаг: перекачать {sum(1 for r in new_manifest if r.get('needs_refetch'))} "
          f"документов с вашими куками и заменить их в этой выгрузке.")


if __name__ == "__main__":
    main()
