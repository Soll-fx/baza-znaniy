#!/usr/bin/env python3
"""Приводит выгрузку crawler'а к единому виду и превращает её в Markdown для проекта.

Что чинит:
  * расширения: application/msword -> .doc, бинарный Word больше не .bin;
  * имена: кириллица, коллизии обрезанных заголовков, кириллические имена в ZIP;
  * дубли: по <type>/<id>, с выбором самой полной версии;
  * иерархия: section из манифеста, иначе из kb-tree.txt, иначе "_uncategorized";
  * HTML -> Markdown с сохранением заголовков, списков, таблиц и ссылок.

Запуск:
  python3 import-kb.py <каталог-распакованных-файлов> [-o content-dir] [--manifest file.ndjson]
"""

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import sys
import zipfile
from html.parser import HTMLParser

BAD_FS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

TYPE_EXT = {
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/pdf": "pdf",
    "application/rtf": "rtf",
    "application/vnd.oasis.opendocument.text": "odt",
    "application/epub+zip": "epub",
    "application/zip": "zip",
}

DOC_RE = re.compile(r"document/(\d+)/(\d+)")

# Тип документа в 1gb.uz соответствует разделу базы знаний.
# Восстановлен по характеру заголовков выгруженных материалов.
DOC_TYPE_SECTION = {
    "16": "Налогообложение и бухгалтерский учет",
    "90": "Кодексы и законы",
    "118": "Шаблоны документов",
    "86": "Новости и семинары",
    "184": "Руководство пользователя",
    "192": "Журналы",
    "207": "Инструменты и калькуляторы",
}

# Внутри «Налогообложение и бухгалтерский учет» 432 материала лежат одной
# лентой — на сайте это нечитаемо. Делим на подгруппы по теме заголовка.
# Порядок важен: срабатывает первое совпадение, поэтому частные темы
# (НДС, маркировка, таможня) стоят раньше общих (учёт, кадры).
SUBSECTIONS = [
    ("Новости, семинары и мероприятия",
     r"семинар|конференц|вебинар|новост|подборк|top-\d|главное в |круглый стол|"
     r"мастер-класс|мероприяти|поддержк|личный кабинет|знакомств|видеоурок|1с:|didox|"
     r"записывайтесь|ситуаци\w+ недели|кр[иu]зис|форс-мажор|вакцинац"),
    ("ЕГАИС, маркировка и онлайн-кассы",
     r"егаис|маркиров|упакованн|информационн\w+ знак|асн|сгкт|онлайн-касс|онлайн-касс|ккм|"
     r"кассов\w+ аппарат|фк-касс|расходн\w+ накладн|розниц|оптов|торгов\w+ точк|"
     r"виртуальн\w+ касс|кассы|кассе|кассов|инкассир|наличн\w+ выручк|чек-лист|чек лист"),
    ("Внешняя торговля и таможня",
     r"импорт|экспорт|тамож|контракт в еэисво|внешнеторгов|поставщик|поставк|инвойс|"
     r"валютн\w+ операц|уполномоченн\w+ банк|логист|карго|склад|доставк"),
    ("Налоги и сборы",
     r"ндс|ндфл|налог|акциз|сбор|госпошлин|пошлин|страхов\w+ взнос|пенсионн\w+ взнос|"
     r"льгот|вычет|доначислен|недоимк|пени|штраф за налог"),
    ("Кадры и трудовое право",
     r"кадр|трудов|работник|сотрудник|отпуск|зарплат|заработн\w+ плат|з\/п|пенси|стаж|"
     r"увольн|приказ|должностн|обучени|охрана труда|медосмотр|командиров|табель|"
     r"график рабоч|профсоюз|декрет|больнич|дисциплин|коллективн\w+ договор|центр занят|"
     r"непрогосударственн|пенсионер|инвалид|при[её]м на работу|на[её]м на работу|"
     r"на работу|при[её]м|стажиров|выходн\w+ день|праздник|рабочего времени|"
     r"рабочих мест|сверхурочн|ночное время|надомник|увольн|совмещен"),
    ("Отчётность и декларации",
     r"отчетн|отчётн|декларац|расчет по|справк|книга учета|бухгалтерск\w+ отчет|"
     r"персонифиц|представлен\w+ отчет|выходн\w+ день|статистическ|финансов\w+ отчетност"),
    ("ИП, самозанятые и организация бизнеса",
     r"самозанят|предпринимател|учредител|устав|дивиденд|обществ\w+ с ограничен|"
     r"ооо|директор|участник|эмисси|управляющ|обособленн\w+ подраздел|инвестиц|"
     r"реорганизац|ликвидац|банкротств|присоединен|разделен|слияни|поглощени|"
     r"преобразовани\w+ предпр|ревизи|представител"),
    ("Банки, валюта и расчёты",
     r"банк|валют|корреспондент|эквайр|расчетн\w+ счет|расчётн\w+ счёт|платеж|карт|"
     r"банкомат|зарплатн\w+ проект|зарплатн\w+ карт|инкассац|депозит|кредит|займ|"
     r"расчетный терминал|терминал|процент|комисси"),
    ("Основные средства, запасы и оценка",
     r"основн\w+ средств|амортизац|нематериал|инвентар|лизинг|переоценк|капитальн|"
     r"незавершенн|вложени|товарн\w+ запас|готов\w+ продукц|себестоимост|калькулятор|"
     r"работа в пути|дебиторск|кредиторск|резерв|нематериальн|основных средств|"
     r"материальн\w+ актив|инвентаризац|взыскани|должник|долг"),
    ("Выручка, доходы и расходы",
     r"выручк|реализац|доход|цена реализац|ценообразован|оборот|прибыл|убытк|"
     r"расход|затрат|доходност|рентабельност|структур\w+ затрат|классифицирова\w+ расход"),
    ("Электронные документы и ЭДО",
     r"эдо|электронн|сби|сфр|эцп|электронн\w+ подпис|электронн\w+ счет|qr|мэкод|"
     r"электронн\w+ архив|нумерац|товарно-транспортн"),
    ("Договоры и документооборот",
     r"договор|пломбир|акт |акта|накладн|доверенност|документооборот|оформить и "
     r"отразить|оформить и зарегистрировать|оформить и провести|оформить прием|"
     r"исполнительн\w+ документ|жалоб|претенз|исков"),
    ("Бухгалтерский учёт и контроль",
     r"бухуч|бухгалтер|проводк|дебет|кредит|журнал регистрац|калькуляц|аудит|контрол|"
     r"проверк|ответственност|упрощенн|учет доходов|первичн\w+ документ|учетн\w+ политик|"
     r"хозрасчетн|финэкономическ|учет |учё|работа в системе|мсфо|инвентаризаци"),
]
SUBSECTION_FALLBACK = "Прочее"


def subsection_for(section, title):
    """Подгруппа внутри раздела. Только для разделов-лент."""
    if section != "Налогообложение и бухгалтерский учет":
        return None
    t = (title or "").lower()
    for name, pattern in SUBSECTIONS:
        if re.search(pattern, t):
            return name
    return SUBSECTION_FALLBACK


def section_from_url(url):
    m = DOC_RE.search(url or "")
    if m:
        return DOC_TYPE_SECTION.get(m.group(1), "Прочее")
    return ""



def safe_name(s, maxlen=100):
    s = BAD_FS.sub("_", s or "")
    s = " ".join(s.split()).strip()
    return (s[:maxlen] or "file").rstrip(" .")


def doc_id(url):
    m = DOC_RE.search(url or "")
    return f"{m.group(1)}/{m.group(2)}" if m else None


def load_sidecar(srcdir):
    """_manifest.json рядом с файлами: точное соответствие файл -> документ.

    Приоритетнее сопоставления по заголовкам: у разных документов бывают
    одинаковые названия, и поиск по заголовку склеивал их в один id.
    """
    path = os.path.join(srcdir, "_manifest.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"  ! не удалось прочитать {path}: {e}")
        return {}
    if isinstance(data, dict):
        data = data.get("files") or data.get("records") or []
    out = {}
    for r in data:
        if r.get("file"):
            out[r["file"]] = r
    if out:
        print(f"  точный манифест: {path} ({len(out)} записей)")
    return out


def doc_id_by_title(title, by_file):
    """Ищет id документа по заголовку: имя файла могло быть переименовано или обрезано.

    Если заголовок совпадает у нескольких документов, возвращает None:
    лучше оставить файл без источника, чем склеить два разных документа в один.
    """
    t = (title or "").strip().lower()
    if not t:
        return None
    found = set()
    for fn, rec in (by_file or {}).items():
        if (rec.get("title") or "").strip().lower() == t:
            i = doc_id(rec.get("source_url") or "")
            if i:
                found.add(i)
    if len(found) == 1:
        return found.pop()
    if len(found) > 1:
        return None
    # обрезанное имя: заголовок файла — префикс заголовка из манифеста
    for fn, rec in (by_file or {}).items():
        rt = (rec.get("title") or "").strip().lower()
        if rt and (t.startswith(rt[:len(t)]) or rt.startswith(t[:len(rt)])):
            i = doc_id(rec.get("source_url") or "")
            if i:
                found.add(i)
    return found.pop() if len(found) == 1 else None


def _norm_title(s):
    s = (s or "").lower()
    for a, b in (("«", '"'), ("»", '"'), ("“", '"'), ("”", '"'),
                 ("„", '"'), ("‘", "'"), ("’", "'"), ("–", "-"), ("—", "-")):
        s = s.replace(a, b)
    s = re.sub(r"[^\w\s]", " ", s, flags=re.U)
    return re.sub(r"\s+", " ", s).strip()


# Служебные блоки печатного шаблона 1gb.uz — заголовком статьи не являются.
_PRINT_NOISE = re.compile(
    r"^(print\s+\d+|©|copyright|action|система\s+главбух|содержание|оглавление"
    r"|страница\s+\d+|1gb\.uz|www\.|http)", re.I)


def file_own_title(data):
    """Заголовок статьи, напечатанный внутри файла выгрузки.

    Печатная версия 1gb.uz начинается с заголовка самой статьи. Сверка с
    заголовком со страницы списка ловит случай, когда endpoint отдал другой
    документ: заголовок один, а текст внутри совсем другой.
    """
    if not is_html(data):
        return ""
    t = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", data.decode("utf-8", "ignore"))
    t = re.sub(r"<[^>]+>", "\n", t).replace("&nbsp;", " ")
    for line in t.split("\n"):
        line = re.sub(r"\s+", " ", line).strip()
        line = re.sub(r"^print\s+\d+\s*", "", line, flags=re.I).strip()
        if len(_norm_title(line)) > 20 and not _PRINT_NOISE.match(line):
            return line
    return ""


def _title_tokens(s):
    return {w for w in _norm_title(s).split() if len(w) > 3}


def titles_agree(own, title):
    """Похожи ли заголовок файла заголовку статьи.

    Точного равенства мало: у части материалов печатная версия начинается
    не с заголовка, а с лид-абзаца («Когда понадобится: чтобы заключить
    трудовой договор…» для статьи «Трудовой договор»). Признаём совпадением
    и случай, когда все значимые слова заголовка нашлись в первой строке.
    """
    a, b = _norm_title(own), _norm_title(title)
    if a == b:
        return True
    ta, tb = _title_tokens(title), _title_tokens(own)
    if not ta or not tb:
        return False
    return ta <= tb


def _title_appears_in_body(title, body, raw=""):
    """Есть ли значимые слова заголовка в начале текста.

    Сверяем по сырому содержимому файла, а не по результату html_to_md:
    у подборок-заставок заголовок стоит в обложке-таблице, которую
    конвертер выкидывает, хотя материал верный.
    """
    tk = {w for w in _norm_title(title).split() if len(w) > 3}
    if not tk:
        return True
    haystack = _norm_title(body[:6000])
    if raw:
        try:
            txt = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", raw.decode("utf-8", "ignore"))
            txt = _norm_title(re.sub(r"<[^>]+>", " ", txt).replace("&nbsp;", " "))
            haystack += " " + txt[:8000]
        except (AttributeError, UnicodeDecodeError):
            pass
    return bool(tk & set(haystack.split()))


def title_conflicts(best, title, body=""):
    """Заголовок страницы и текст внутри файла расходятся — вернём причину.

    Печатная версия не всегда начинается с заголовка: у части материалов
    первым идёт лид-«Когда понадобится: …». Поэтому лид-формулировки
    пропускаем, а решение принимаем по остальному тексту: если заголовок
    нигде не подтверждается, перед нами чужой документ.
    """
    own = file_own_title(best["data"])
    if not own or titles_agree(own, title):
        return ""
    if not body:
        return ""
    lead = re.match(
        r"(?i)^(когда понадобиться|в (рекомендации|памятке|статье|руководстве|обзоре)"
        r"|в этой (рекомендации|памятке|статье)|читайте наши|скачайте|"
        r"бухгалтерский учет ведется|и базового использования|"
        r"предприятия могут применять|редакция системы|в 20\d\d году "
        r"бухгалтеров ждут|ежемесячный обзор|расчетчик моментально|"
        r"приложение в платном доступе|эксперт системы сэкономил ваше время)",
        _norm_title(own),
    )
    if not lead:
        # НПА печатаются с реквизитами («Закон от 13.04.2016 № ЗРУ-404»),
        # а не с названием: сверяем по тексту, а не по первой строке.
        if re.match(r"(?i)^(закон|приказ|указ|постановление|кодекс|письмо)\b", _norm_title(own)):
            return "" if _title_appears_in_body(title, body, best["data"]) else \
                f"текст не подтверждает заголовок «{title[:60]}»"
        return f"заголовок в файле: {own[:90]}"
    if _PRINT_NOISE.match(own) or "платном доступе" in _norm_title(own):
        # материал закрыт подпиской: сверять нечего и нечего импортировать
        return ""
    # лид-абзац: доверяем тексту статьи, а не первой строке
    tk = {w for w in _norm_title(title).split() if len(w) > 3}
    body_words = set(_norm_title(body[:6000]).split())
    if tk and not tk & body_words and not _title_appears_in_body(title, body, best["data"]):
        return f"текст не подтверждает заголовок «{title[:60]}»"
    return ""


def sniff_ext(data, content_type, url=""):
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct in TYPE_EXT:
        return TYPE_EXT[ct]
    if data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        return "doc"
    if data[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
        return "zip"
    if data[:4] == b"%PDF":
        return "pdf"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    m = (url or "").split("?")[0].lower()
    m = re.search(r"\.([a-z0-9]{2,5})$", m)
    if m:
        ext = m.group(1)
        if ext in ("doc", "docx", "pdf", "xls", "xlsx", "rtf", "odt", "zip", "htm", "html"):
            return "doc" if ext == "htm" else ext
    head = data[:512].lstrip().lower()
    if head.startswith(b"<html") or head.startswith(b"<!doctype html"):
        return "doc"
    return "bin"


def is_html(data):
    head = data[:1024].lstrip().lower()
    return head.startswith(b"<html") or head.startswith(b"<!doctype html") or b"<body" in head


# ---------------------------------------------------------------- HTML -> MD
def _text(s):
    return re.sub(r"[ \t\xa0]+", " ", s or "").strip()


# --------------------------------------------------------------- картинки
# Выгрузка содержит только ссылки вида …/system/content/image/297/<id>/.
# Самих файлов в ней нет, поэтому fetch-images.py кладёт их в content/images,
# а мы переписываем ссылки на локальные пути от корня content/.
_IMAGE_URL_RE = re.compile(r"^(?:https?:)?//[^/]+/system/content/image/(\d+)/(\d+)/(-?\d+)/?$")
# Ссылка без идентификатора (…/image/297///) — битая в самой выгрузке: CMS
# обрезала атрибут src. Такие отдают 404, поэтому картинку убираем.
_IMAGE_BROKEN_RE = re.compile(r"^(?:https?:)?//[^/]+/system/content/image/(\d+)/")
_DECORATIVE = ("/i/attach-locked", "/i/lock", "/i/icon-")
_IMAGE_MD_RE = re.compile(r"(!\[[^\]]*\]\()([^)\s]+)(\))")


def build_image_map(images_dir):
    """{id картинки -> 'images/<файл>'} по уже скачанным файлам."""
    out = {}
    if not images_dir or not os.path.isdir(images_dir):
        return out
    for name in os.listdir(images_dir):
        stem, dot, ext = name.rpartition(".")
        if dot:
            out[stem] = "images/" + name
    return out


def localize_images(md, image_map, stats, used=None):
    """Ссылки на 1gb.uz -> локальные файлы. Не найдено — убираем картинку."""
    def repl(m):
        url = m.group(2)
        # служебные иконки сайта (замок на платном разделе) к статье не относятся
        if any(d in url for d in _DECORATIVE) or re.match(r"^/i/", url):
            stats["нет файла"] += 1
            return ""
        found = _IMAGE_URL_RE.match(url)
        if not found:
            if _IMAGE_BROKEN_RE.match(url):
                stats["битая ссылка"] += 1
                return ""
            stats["внешние"] += 1
            return m.group(0)
        local = image_map.get(found.group(3).lstrip("-"))
        if local:
            stats["локальные"] += 1
            if used is not None:
                used.add(local)
            return m.group(1) + local + m.group(3)
        stats["нет файла"] += 1
        return ""

    md = _IMAGE_MD_RE.sub(repl, md)
    # остатки от удалённых картинок: пустые строки подряд
    return re.sub(r"\n{3,}", "\n\n", md)


class _TableGrid(HTMLParser):
    """Разбирает <table> в сетку с учётом colspan и rowspan.

    Без этого таблицы превращались в текст с «|» без строки-заголовка,
    и Markdown их не отображал: на сайте таблиц не было вовсе.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.grid = []          # строки -> ячейки (str | None)
        self._occupied = {}     # (row, col) -> True
        self._r = 0
        self._c = 0
        self._span = (1, 1)
        self._buf = []
        self._in_cell = False
        self._head = {}         # (row, col) -> True для <th>

    # -- служебное -------------------------------------------------
    def _ensure(self, r):
        while len(self.grid) <= r:
            self.grid.append([])

    def _free_col(self, r):
        c = 0
        while (r, c) in self._occupied:
            c += 1
        return c

    def _mark(self, r, c, rs, cs):
        for i in range(r, r + rs):
            self._ensure(i)
            for j in range(c, c + cs):
                self._occupied[(i, j)] = True
                while len(self.grid[i]) <= j:
                    self.grid[i].append(None)

    # -- события ---------------------------------------------------
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "tr":
            self._r = self._free_col(self._r) if False else self._r
            self._c = 0
            self._ensure(self._r)
        elif tag in ("td", "th"):
            self._in_cell = True
            self._buf = []
            try:
                cs = max(1, int(a.get("colspan", "1") or 1))
            except ValueError:
                cs = 1
            try:
                rs = max(1, int(a.get("rowspan", "1") or 1))
            except ValueError:
                rs = 1
            c = self._free_col(self._r)
            self._span = (rs, cs)
            self._c = c
            self._mark(self._r, c, rs, cs)
            if tag == "th":
                self._head[(self._r, c)] = True
        elif tag == "br" and self._in_cell:
            self._buf.append(" ")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._in_cell:
            text = _text("".join(self._buf))
            self.grid[self._r][self._c] = text
            self._in_cell = False
            self._r += self._span[0] - 1
        elif tag == "tr":
            self._r += 1
            self._c = 0

    def handle_data(self, data):
        if self._in_cell:
            self._buf.append(data)


def _cell_md(s):
    """Экранируем вертикальную черту, иначе таблица развалится."""
    s = re.sub(r"\s*\n\s*", " ", s or "").strip()
    return s.replace("|", "\\|")


def table_to_md(block):
    """<table>…</table> -> настоящая Markdown-таблица."""
    p = _TableGrid()
    try:
        p.feed(block)
        p.close()
    except Exception:
        return None

    grid = [row for row in p.grid if any(c not in (None, "") for c in row)]
    if not grid:
        return None
    width = max(len(r) for r in grid)
    grid = [r + [""] * (width - len(r)) for r in grid]
    # ширину берём по объединённым ячейкам, иначе строки разной длины
    width = max((sum(1 for c in r) for r in grid), default=width)

    head = grid[0]
    body = grid[1:]
    if not body:
        body = []
    out = ["| " + " | ".join(_cell_md(c) for c in head) + " |",
           "| " + " | ".join("---" for _ in head) + " |"]
    for row in body:
        out.append("| " + " | ".join(_cell_md(c) for c in row) + " |")
    return "\n".join(out)


_IMG_RE = re.compile(r"(?is)<img\b([^>]*)>")
_ALT_RE = re.compile(r"""(?is)\balt\s*=\s*["']([^"']*)["']""")
_SRC_RE = re.compile(r"""(?is)\bsrc\s*=\s*["']([^"']*)["']""")


def img_to_md(tag):
    a = tag if isinstance(tag, str) else ""
    m = _SRC_RE.search(a)
    if not m:
        return ""
    src = m.group(1).strip()
    if not src or src.startswith("data:"):
        return ""
    alt = _ALT_RE.search(a)
    return "![%s](%s)" % (_text(alt.group(1)) if alt else "", src)


def html_to_md(raw, base_url=""):
    s = raw.decode("utf-8", "ignore")

    m = re.search(r"(?is)<div[^>]*\bid=[\"']documentBody[\"'][^>]*>(.*)", s)
    if m:
        s = m.group(1)
    s = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?is)<!--.*?-->", " ", s)
    s = re.sub(r"(?is)<div[^>]*class=[\"'][^\"']*footer[^\"']*[\"'][^>]*>.*?</div>", " ", s)

    # 1. Таблицы и картинки вынимаем целиком и прячем в плейсхолдеры:
    #    дальше по тексту идут регулярки, которые всё это растерли бы.
    store = []

    def _keep(text):
        store.append(text)
        return "@@K%d@@" % (len(store) - 1)

    def _img_sub(m):
        return _keep(img_to_md(m.group(1)) or " ")

    s = _IMG_RE.sub(_img_sub, s)

    def _tbl_sub(m):
        md = table_to_md(m.group(0))
        return _keep(md if md else " ")

    # внутренние таблицы — раньше внешних
    for _ in range(4):
        new = re.sub(r"(?is)<table[^>]*>(?:(?!<table).)*?</table>", _tbl_sub, s)
        if new == s:
            break
        s = new
    s = re.sub(r"(?is)<table[^>]*>.*?</table>", _tbl_sub, s)

    s = re.sub(r"(?is)<(br|hr)\s*/?>", "\n", s)
    s = re.sub(r"(?is)</(p|div|h[1-6]|li)>", "\n", s)
    s = re.sub(r"(?is)<li[^>]*>", "- ", s)
    s = re.sub(r"(?is)<h([1-6])[^>]*>", lambda m: "\n" + "#" * int(m.group(1)) + " ", s)
    s = re.sub(r"(?s)<a [^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>",
               lambda m: "[%s](%s)" % (_text(re.sub(r"(?s)<[^>]+>", "", m.group(2))) or m.group(1),
                                        m.group(1).strip()), s)
    s = re.sub(r"(?s)<[^>]+>", "", s)
    s = html.unescape(s)
    s = s.replace("\xa0", " ")
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    s = re.sub(r"(?m)^[ \t]*\|[ \t]*\|[ \t]*$", "", s)
    s = re.sub(r"(?m)^[ \t]+\|[ \t]+$", "", s)
    s = re.sub(r"(?m)^[ \t]*\|[ \t]*$", "", s)
    # SPA-ссылки вида #/document/16/123 и корневые /... -> абсолютный адрес сайта
    s = re.sub(r"\]\(\s*/?#/", "](https://1gb.uz/#/", s)
    s = re.sub(r"\]\(\s*/system/", "](https://1gb.uz/system/", s)
    s = re.sub(r"\]\(\s*/(?!/|#|http)", "](https://1gb.uz/", s)
    # ссылки-просто "#/document/..." без markdown-обёртки
    s = re.sub(r'(?<![\w(/])(#/(?:document|rubric|recommendations|law|forms|handbook|press|videos|services)/)',
               r"https://1gb.uz/\1", s)
    # возвращаем таблицы и картинки (в несколько проходов: картинка может
    # находиться внутри ячейки таблицы, т.е. плейсхолдер появляется после подстановки)
    for _ in range(6):
        new = re.sub(r"@@K(\d+)@@", lambda m: store[int(m.group(1))], s)
        if new == s:
            break
        s = new
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


CYRILLIC_MAP = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya",
}


def slug(s, maxlen=80):
    """Совпадает с server/src/lib/slug.ts: кириллица -> latin, kebab-case, /^[a-z0-9]+(-[a-z0-9]+)*$/."""
    t = "".join(CYRILLIC_MAP.get(ch, ch) for ch in (s or "").lower())
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    return (t[:maxlen].strip("-") or "untitled")


# ---------------------------------------------------------------- загрузка
def load_records(manifest_path):
    if not manifest_path or not os.path.exists(manifest_path):
        return []
    out = []
    with open(manifest_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def read_tree(tree_path):
    """Плоский список заголовков -> словарь заголовок -> раздел (если раздел один)."""
    if not tree_path or not os.path.exists(tree_path):
        return {}
    section, out = None, {}
    with open(tree_path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            m = re.match(r"\s*(?:\d+[.)]\s*)?[«\"]?(.*?)[»\"]?:\s*$", line)
            if m and not line.startswith(" ") and "  " not in line[:2]:
                section = m.group(1).strip()
                continue
            t = line.strip()
            if t and not t.startswith("==") and t != section:
                out.setdefault(t, section)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("srcdir", help="каталог с выгруженными файлами")
    ap.add_argument("-o", "--out", default="content/sistemy-glavbuh")
    ap.add_argument("--manifest", default="", help="kb-pages-*.ndjson")
    ap.add_argument("--tree", default="kb-tree.txt")
    ap.add_argument("--src", default="https://1gb.uz", help="хост для атрибуции")
    ap.add_argument("--images-dir", default="", help="каталог со скачанными картинками (обычно content/images)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply-mismatched", action="store_true",
                    help="импортировать файлы, у которых заголовок внутри "
                         "не совпадает с заголовком страницы (обычно не нужно)")
    args = ap.parse_args()

    image_map = build_image_map(args.images_dir)
    img_stats = {"локальные": 0, "внешние": 0, "нет файла": 0, "битая ссылка": 0}

    recs = load_records(args.manifest)
    by_file = {r.get("fileName"): r for r in recs if r.get("fileName")}
    # точный манифест из каталога выгрузки: файл -> документ, без догадок
    side = load_sidecar(args.srcdir)
    for fn, r in side.items():
        by_file[fn] = {
            "source_url": r.get("source_url", ""),
            "title": r.get("title", ""),
            "section": ([section_from_url(r.get("source_url", ""))]
                        if section_from_url(r.get("source_url", "")) else []),
            "contentType": r.get("contentType", ""),
        }
    # карта по id документа: имя в каталоге могло быть переименовано/обрезано
    by_id = {}
    for r in recs:
        i = doc_id(r.get("source_url") or "")
        if i and i not in by_id:
            by_id[i] = r
    tree = read_tree(os.path.join(os.path.dirname(os.path.abspath(args.manifest)) or ".",
                                   args.tree)) if args.manifest else read_tree(args.tree)

    # собрать содержимое всех входных файлов
    entries = []
    for name in sorted(os.listdir(args.srcdir)):
        path = os.path.join(args.srcdir, name)
        if not os.path.isfile(path) or name.startswith((".", "_")):
            continue
        data = open(path, "rb").read()
        base_title = os.path.splitext(name)[0]
        url0 = ""
        for cand in (by_file.get(name), by_id.get(doc_id_by_title(base_title, by_file))):
            if cand and cand.get("source_url"):
                url0 = cand["source_url"]
                break
        rec = next((c for c in (by_file.get(name), by_id.get(doc_id_by_title(base_title, by_file)))
                    if c and c.get("source_url")), {})
        url = rec.get("source_url") or url0
        entries.append({
            "path": path,
            "data": data,
            "url": url,
            "id": doc_id(url),
            "title": rec.get("title") or base_title,
            "section": ([rec["section"]] if isinstance(rec.get("section"), str)
                        else (rec.get("section") or [])),
            "content_type": rec.get("contentType", ""),
        })

    orphan_files = [e for e in entries if not e["url"]]
    if orphan_files:
        print(f"  ! {len(orphan_files)} файлов без source_url — "
              f"проверьте, что _manifest.json лежит рядом с файлами:")
        for e in orphan_files[:5]:
            print("    -", os.path.basename(e["path"]))

    # дедуп по id
    groups = {}
    for e in entries:
        key = e["id"] or ("file:" + hashlib.sha256(e["data"]).hexdigest()[:16])
        groups.setdefault(key, []).append(e)

    dropped, written = 0, 0
    report = []
    mismatched, mismatches = 0, []
    used_names = {}
    out_root = os.path.abspath(args.out)
    if not args.dry_run:
        os.makedirs(out_root, exist_ok=True)

    for key, items in groups.items():
        # самая полная версия
        def weight(e):
            if is_html(e["data"]):
                return len(html_to_md(e["data"]))
            return len(e["data"])
        best = max(items, key=weight)
        dropped += len(items) - 1

        ext = sniff_ext(best["data"], best["content_type"], best["url"])
        title = best["title"] or "Без названия"
        sec = best["section"]
        if isinstance(sec, str):
            sec = [sec] if sec else []
        section = " / ".join(x for x in sec if x)
        if not section:
            section = section_from_url(best["url"])
        if not section:
            section = tree.get(title) or ""
        if not section:
            section = "Разное"
        # Ленту разбиваем на тематические подгруппы: 432 ссылки подряд нечитаемы
        sub = subsection_for(section, title)
        section_path = [section] + ([sub] if sub else [])
        section_label = " / ".join(section_path)

        used_images = set()
        if is_html(best["data"]):
            body = html_to_md(best["data"], best["url"])
            body = localize_images(body, image_map, img_stats, used_images)
            content = "html"
        else:
            body = ""
            content = "binary"

        # Заголовок страницы и заголовок внутри файла могут разойтись, если
        # выгрузка отдала другой документ. Такой текст в корпус не пускаем.
        conflict = title_conflicts(best, title, body)
        if conflict:
            mismatched += 1
            mismatches.append((title, conflict, key))
            if not args.apply_mismatched:
                continue

        fname = safe_name(title)
        if not args.dry_run:
            os.makedirs(out_root, exist_ok=True)

        sname = os.path.join(*[slug(x) for x in section_path])
        iname = slug(title)
        if iname in used_names and used_names[iname] != key:
            ident = doc_id(best["url"]) or key
            iname = "%s-%s" % (iname, slug(ident, 20) if ident else "v2")
        used_names[iname] = key
        # Статья живёт в собственном каталоге: так оригинал (.doc) прикрепляется
        # только к своей статье. Если положить все статьи в одну папку раздела,
        # каждая получит в assets все файлы раздела сразу.
        adir = os.path.join(out_root, sname, iname)
        if not args.dry_run:
            os.makedirs(adir, exist_ok=True)
            (open(os.path.join(adir, iname + "." + ext), "wb")).write(best["data"])
            # Картинки кладём в images/ рядом со статьёй: сервер ищет src
            # относительно каталога статьи (source.ts -> collectAssets),
            # поэтому общий content/images/ он бы не увидел.
            if used_images:
                idir = os.path.join(adir, "images")
                os.makedirs(idir, exist_ok=True)
                for rel in sorted(used_images):
                    src_path = os.path.join(args.images_dir, os.path.basename(rel))
                    if os.path.isfile(src_path):
                        dst = os.path.join(idir, os.path.basename(rel))
                        if not os.path.exists(dst):
                            shutil.copyfile(src_path, dst)

        source = best["url"] or args.src
        q = lambda s: '"' + s.replace('"', "'").replace("\\", "") + '"'
        if not args.dry_run:
            # Заголовок узла берётся из _topic.md, иначе в дереве сайта
            # появится «Umenshaem ustavnoy fond chek list» вместо названия.
            # Тело намеренно пустое: с текстом создалась бы лишняя статья «обзор».
            with open(os.path.join(adir, "_topic.md"), "w", encoding="utf-8") as f:
                f.write(f"---\ntitle: {q(title)}\nsource_url: {q(source)}\n---\n")
        if content == "html" and len(body) > 120:
            # summary = первый содержательный абзац; оглавление-ссылки отсекаем
            summary = ""
            for para in re.split(r"\n{2,}", body):
                for line in para.split("\n"):
                    line = line.strip()
                    # пропускаем оглавление, маркеры, заголовки и таблицы
                    if not line or line.startswith(("-", "*", "#", "|", ">", "\\")):
                        continue
                    cand = re.sub(r"[*_`]", "", line)
                    cand = re.sub(r"\s+", " ", cand).strip()
                    if len(cand) >= 60:
                        summary = cand
                        break
                if summary:
                    break
            if not summary:
                summary = "Материал базы знаний «Система Главбух»: " + title
            summary = summary[:180].rsplit(" ", 1)[0]
            md = ["---",
                  f"title: {q(title)}",
                  f"summary: {q(summary)}",
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
                  ""]
            if not args.dry_run:
                (open(os.path.join(adir, iname + ".md"), "w", encoding="utf-8")).write("\n".join(md))
            kind = "article"
        else:
            kind = "stub" if len(body) < 400 else "short"
            if not args.dry_run:
                with open(os.path.join(adir, iname + ".md"), "w", encoding="utf-8") as f:
                    f.write(f"---\n"
                            f"title: {q(title)}\n"
                            f"summary: {q('Оригинал без текстовой версии: ' + title)}\n"
                            f"status: published\n"
                            f"source_url: {q(source)}\n"
                            f"source_section: {q(section_label)}\n"
                            f"original_format: {q(ext)}\n"
                            f"---\n\n# {title}\n\n"
                            f"Оригинал сохранён рядом со статьёй: `{iname}.{ext}`.\n"
                            f"Источник: [1gb.uz]({source}).\n")
        written += 1
        report.append((kind, len(body), section_label, title, key, len(items), sname, iname, section_path))

    # В проекте каталог с подкаталогами трактуется как контейнер корневых рубрик
    # (loadDirSource в server/src/lib/source.ts). Поэтому разделы кладём прямо в
    # корень content/, иначе появится лишний уровень sistemy-glavbuh/<раздел>/<статья>.
    root = slug(os.path.basename(out_root))
    if not args.dry_run:
        from collections import defaultdict as _dd
        by_sec = _dd(list)
        for r in report:
            by_sec[tuple(r[8])].append(r)

        def write_topic(path, title, items):
            """_topic.md для узла. items — материалы этого узла (пусто у
            промежуточных разделов: их статьи лежат в подгруппах)."""
            d = os.path.join(out_root, *[slug(x) for x in path])
            if not os.path.isdir(d):
                return
            n_articles = sum(1 for i in items if i[0] == "article")
            n_all = len(items)
            if n_all:
                summary = f"{n_all} материалов: {n_articles} статей и {n_all - n_articles} кратких"
            else:
                summary = "Тематические подгруппы раздела"
            with open(os.path.join(d, "_topic.md"), "w", encoding="utf-8") as f:
                f.write(f"---\n"
                        f"title: {q(title)}\n"
                        f"summary: {q(summary)}\n"
                        f"sort_order: 1\n"
                        f"is_published: true\n"
                        f"---\n\n# {title}\n\n")
                if not items:
                    # листья-подгруппы перечисляем списком: рубрики не резолвятся
                    # вики-ссылками, а на них ссылается заголовок раздела
                    subs = [p[-1] for p in by_sec if len(p) == len(path) + 1 and p[:-1] == tuple(path)]
                    for s in sorted(subs):
                        f.write(f"- **{s}**\n")
                    f.write("\n")
                    return
                for it in sorted(items, key=lambda x: x[1], reverse=True)[:60]:
                    # У статьи внутри рубрики заводится собственный узел дерева
                    # (asChildTopic в server/src/lib/source.ts), поэтому ref —
                    # трёхсегментный: <рубрика>/<узел статьи>/<слаг статьи>.
                    f.write(f"- [[{os.path.join(*[slug(x) for x in it[8]])}/{it[7]}/{it[7]}]] — {it[3]}\n")
                f.write("\n")

        # сначала листья, потом родители: у родителя понадобятся подгруппы
        for path in sorted(by_sec, key=len, reverse=True):
            write_topic(list(path), path[-1], by_sec[path])
        # верхний уровень, у которого нет своих материалов
        seen = set()
        for path in by_sec:
            for i in range(1, len(path)):
                parent = path[:i]
                if parent in seen:
                    continue
                seen.add(parent)
                write_topic(list(parent), parent[-1], by_sec.get(parent, []))

        # корневой _topic.md: без него рубрики не попадают в topicPath
        n_all = len(report)
        n_articles = sum(1 for i in report if i[0] == "article")
        with open(os.path.join(out_root, "_topic.md"), "w", encoding="utf-8") as f:
            f.write(f"---\n"
                    f"title: {q('Система Главбух')}\n"
                    f"summary: {q(f'База знаний: {n_all} материалов, {n_articles} статей')}\n"
                    f"sort_order: 1\n"
                    f"is_published: true\n"
                    f"---\n\n# Система Главбух\n\n"
                    f"Материалы из базы знаний «Система Главбух» (1gb.uz).\n\n")
            for sec in sorted(by_sec, key=lambda s: -len(by_sec[s])):
                # рубрики не резолвятся вики-ссылками — перечисляем списком
                f.write(f"- **{' / '.join(sec)}** — {len(by_sec[sec])} материалов\n")
            f.write("\n")

    report.sort(key=lambda r: -r[1])
    print("уникальных документов:", written)
    print("отброшено дублей    :", dropped)
    print("каталог             :", out_root if not args.dry_run else "(dry-run)")
    if mismatched:
        print()
        print(f"!! расхождение заголовка и содержимого: {mismatched} "
              f"(в корпус НЕ попали)")
        print("   Такие файлы отдали чужой документ — перекачайте их:")
        for t, own, k in mismatches[:15]:
            print(f"     - {t[:60]}")
            print(f"       {own}")
        if mismatched > 15:
            print(f"     ... ещё {mismatched - 15}")
        print("   Подробности: python3 repair-export.py <каталог> --report")
    from collections import Counter
    print("типы                :", dict(Counter(r[0] for r in report)))
    print("разделов            :", len({r[2] for r in report}))
    print("символов в Markdown :", f"{sum(r[1] for r in report):,}".replace(",", " "))
    print("картинок в тексте   : локальных %d, внешних %d, битых ссылок %d, без файла %d"
          % (img_stats["локальные"], img_stats["внешние"],
             img_stats["битая ссылка"], img_stats["нет файла"]))
    print()
    print("топ-15 по объёму:")
    for kind, n, sec, title, key, v, _s, _i, _p in report[:15]:
        print("  %8s  %-7s %-32s %s" % (f"{n:,}".replace(",", " "), kind, sec[:32], title[:44]))


if __name__ == "__main__":
    sys.exit(main())
