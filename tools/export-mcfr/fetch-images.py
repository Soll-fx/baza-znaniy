#!/usr/bin/env python3
"""Скачивает картинки, на которые ссылаются выгруженные .doc, в content/images/.

Зачем: в выгрузке самих картинок нет — есть только ссылки вида
https://1gb.uz/system/content/image/297/<id>/. Раньше конвертер их выбрасывал,
поэтому на сайте иллюстраций не было вовсе.

Картинки на 1gb.uz отдаются без авторизации, поэтому отдельная сессия не нужна.

Запуск:
  python3 fetch-images.py <каталог-файлов> -o content/images
"""
import argparse
import glob
import hashlib
import os
import re
import subprocess
import sys

IMG_RE = re.compile(r"(?is)<img\b[^>]*\bsrc\s*=\s*[\"']([^\"']+)[\"']")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
EXT_BY_MIME = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp",
    "image/svg+xml": ".svg", "image/tiff": ".tif",
}
MAGIC = [
    (b"\xff\xd8\xff", ".jpg"),
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"GIF8", ".gif"),
    (b"BM", ".bmp"),
]


def sniff(buf, mime):
    for sig, ext in MAGIC:
        if buf.startswith(sig):
            return ext
    if buf[:4] == b"RIFF" and buf[8:12] == b"WEBP":
        return ".webp"
    if b"<svg" in buf[:400].lower():
        return ".svg"
    return EXT_BY_MIME.get((mime or "").split(";")[0].strip().lower(), ".img")


def slug_id(url):
    """Идентификатор картинки из URL: .../image/297/1/-41882102/ -> 41882102."""
    m = re.search(r"/image/\d+/(\d+)/(-?\d+)/", url)
    if m:
        return m.group(2).lstrip("-")
    m = re.search(r"/image/(\d+)/", url)
    return m.group(1) if m else hashlib.sha1(url.encode()).hexdigest()[:12]


def collect(files_dir):
    urls = {}
    for path in glob.glob(os.path.join(files_dir, "*.doc")):
        text = open(path, "rb").read().decode("utf-8", "ignore")
        for url in IMG_RE.findall(text):
            url = url.strip()
            if url.startswith(("http://", "https://")) and "/image/" in url:
                urls.setdefault(url, set()).add(os.path.basename(path))
    return urls


def download(url, timeout):
    """Скачиваем через curl: 1gb.uz выдаёт новый корневой сертификат Let's Encrypt
    («Root YR»), которого ещё нет в хранилище Python, но он есть в системном."""
    proc = subprocess.run(
        ["curl", "-sS", "-L", "--fail", "-m", str(timeout),
         "-A", UA, "-w", "\n%{content_type}", "-o", "-", url],
        capture_output=True, timeout=timeout + 10,
    )
    if proc.returncode != 0:
        raise OSError(proc.stderr.decode("utf-8", "ignore").strip()[:80] or f"curl exit {proc.returncode}")
    data = proc.stdout
    if b"\n" not in data:
        return data, ""
    body, _, mime = data.rpartition(b"\n")
    return body, mime.decode("utf-8", "ignore")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files_dir")
    ap.add_argument("-o", "--out", default="content/images")
    ap.add_argument("--timeout", type=int, default=30)
    args = ap.parse_args()

    urls = collect(args.files_dir)
    os.makedirs(args.out, exist_ok=True)
    print(f"[images] уникальных ссылок: {len(urls)}")

    ok = failed = skipped = 0
    total_bytes = 0
    failed_list = []
    for i, url in enumerate(sorted(urls), 1):
        ident = slug_id(url)
        existing = [f for f in os.listdir(args.out) if f.startswith(ident + ".")]
        if existing:
            skipped += 1
            continue
        try:
            buf, mime = download(url, args.timeout)
        except (OSError, subprocess.TimeoutExpired) as exc:
            failed += 1
            failed_list.append((url, str(exc)[:60]))
            continue
        if not buf or mime.startswith("text/"):
            failed += 1
            failed_list.append((url, f"не картинка: {mime or 'пусто'}"))
            continue
        name = ident + sniff(buf, mime)
        with open(os.path.join(args.out, name), "wb") as fh:
            fh.write(buf)
        ok += 1
        total_bytes += len(buf)
        if i % 100 == 0:
            print(f"[images] {i}/{len(urls)} — скачано {ok}, пропущено {skipped}, ошибок {failed}")

    print(f"[images] готово: скачано {ok}, уже было {skipped}, ошибок {failed}, объём {total_bytes/1048576:.1f} МБ")
    for url, why in failed_list[:10]:
        print(f"  ! {why} — {url[:80]}")
    if len(failed_list) > 10:
        print(f"  … и ещё {len(failed_list) - 10}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
