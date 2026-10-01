#!/usr/bin/env python3
"""Проставляет alt картинкам, у которых рядом есть подпись вида «Рис. 16. …».

Зачем: 1gb.uz не отдаёт alt почти ни для одной картинки, но у части из них
рядом стоит готовая подпись. Берём её дословно — это единственный источник
правдивого описания.

Чего скрипт НЕ делает: придумывает alt там, где подписи нет. Выдуманное
описание вводит читателя со скринридером в заблуждение, поэтому такие
картинки остаются с пустым alt, и валидатор продолжает на них напоминать.

    python3 alt-images.py --content content [--dry-run]

Скрипт идемпотентен: уже заполненный alt не перезаписывается.
"""
from __future__ import annotations

import argparse
import os
import re
import sys

# ![](images/x.jpg) — alt пустой; [![](images/x.jpg)](url) — картинка в ссылке
IMG_RE = re.compile(r'(!?)\[([^\]]*)\]\(\s*<?(images/[^)\s>]+)>?\s*\)')
# Подпись стоит сразу за картинкой в той же строке: «Рис. 16. Окно МАПК …»
CAPTION_RE = re.compile(r'^(?:Рис(?:унок)?\.?|Таблица)\s*\d+[.:]?\s*(.+)$')


def clean_caption(text: str) -> str:
    """Убирает хвост строки, который к подписи не относится."""
    text = text.strip()
    # в подпись не должны попасть следующие картинки или wikilinks
    text = re.split(r'!?\[\[|\[!\[[^\]]*\]\(', text)[0]
    text = text.rstrip('|').strip()
    return re.sub(r'\s+', ' ', text)


def process(path: str, dry_run: bool) -> tuple[int, int]:
    """Возвращает (заполнено alt, пропущено из-за отсутствия подписи)."""
    text = open(path, encoding="utf-8").read()
    filled = skipped = 0
    out_lines = []
    for line in text.split("\n"):
        new = line
        for m in IMG_RE.finditer(line):
            if m.group(2).strip():
                continue  # alt уже есть
            tail = line[m.end():]
            cm = CAPTION_RE.match(tail.strip())
            if not cm:
                skipped += 1
                continue
            caption = clean_caption(cm.group(0))
            if not caption:
                skipped += 1
                continue
            bang, _, src = m.group(1), m.group(2), m.group(3)
            replacement = f'{bang}[{caption}]({src})'
            new = new[:m.start()] + replacement + new[m.end():]
            filled += 1
            break  # на строке достаточно одной правки, индексы бы сместились
        out_lines.append(new)
    if new != text and not dry_run:
        open(path, "w", encoding="utf-8").write("\n".join(out_lines))
    return filled, skipped


def main() -> int:
    ap = argparse.ArgumentParser(description="alt картинок из подписей «Рис. N»")
    ap.add_argument("--content", default="content", help="каталог content")
    ap.add_argument("--dry-run", action="store_true", help="только показать, что изменится")
    args = ap.parse_args()

    total_filled = total_skipped = files = 0
    for root, _dirs, names in os.walk(args.content):
        for name in names:
            if not name.endswith(".md"):
                continue
            path = os.path.join(root, name)
            filled, skipped = process(path, args.dry_run)
            total_filled += filled
            total_skipped += skipped
            files += bool(filled or skipped)

    print(f"  картинок с подписью -> alt проставлен: {total_filled}")
    print(f"  без подписи (остаются с пустым alt):  {total_skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
