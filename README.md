# База знаний по бухгалтерии

Своя fullstack-база знаний: кликабельный nested-сайдбар, полнотекстовый поиск, статьи с
оглавлением и режимом повторения, импорт/экспорт контента и автоматическая проверка
целостности данных.

Стек: React 18 + TypeScript + Vite + Tailwind CSS 4 (фронт) и Express + PostgreSQL 16 (бэк).

---

## Быстрый старт

Нужен только Node.js 20+. Ни Docker, ни отдельная установка PostgreSQL не нужны.

```bash
npm install
npm start
```

`npm start` самодостаточен: поднимает PostgreSQL, создаёт схему, при первом
запуске загружает базу знаний из `content/` и запускает сервер и сайт.
Дальше откройте **http://localhost:5173**. Остановить — Ctrl+C.

Если Docker и PostgreSQL уже есть, работают и прежние команды:

```bash
cp .env.example .env          # проверьте DATABASE_URL
npm run db:up                 # поднять PostgreSQL в Docker
npm run db:migrate            # создать схему, индексы, триггеры
npm run db:seed               # загрузить демо-контент из content/

npm run dev                   # API :4000 + веб :5173
```

Отдельные команды вместо `npm run dev`:

```bash
npm run dev:api               # только API       http://localhost:4000
npm run dev:web               # только фронт
npm run build                 # сборка продакшна
```

## Проверки

```bash
npm run typecheck             # tsc --noEmit в обоих пакетах
npm run test                  # 95 тестов: 77 server + 18 web
npm run validate -- --source  # проверить исходники в content/
npm run validate              # проверить данные в PostgreSQL
```

Тесты схемы БД выполняются на настоящем движке PostgreSQL, собранном в
WebAssembly (PGlite) — Docker и `psql` для этого не нужны. Триггеры, PL/pgSQL,
CHECK, enum, generated columns и представления проверяются по-настоящему.

`validate` возвращает код 1, если есть ошибки (битые ссылки, отсутствующие
изображения, пересечения якорей, файлы с неверной контрольной суммой и т.д.).

## Структура

```
content/          исходники: каталоги = рубрики, .md = статьи
storage/          загруженные файлы, имя = sha256 (content-addressed)
db/               schema.sql и скрипты
server/src/
  lib/            markdown, slug, source, ingest, validator, storage
  routes/         HTTP API
  scripts/        migrate, seed, import, export, validate
  __tests__/      schema.test.ts — схема БД на PostgreSQL (PGlite)
web/src/
  lib/            дерево сайдбара, API-клиент, роуты
  components/     Sidebar, SearchBar, Breadcrumbs, TableOfContents, ...
```

## Как добавить материал

Создайте файл в каталоге рубрики:

```
content/nalogovyy-kodeks/nds-st-20.md
```

```markdown
---
title: НДС: расчётные счета
status: published
source_url: https://example.ru/docs/nds
---

## Общие положения

Условия в [[nds-st-12]] и [[uchetnaya-politika/p6-1]].

![Схема](images/schema-nds-20.png)
```

Опции frontmatter: `title`, `summary`, `status` (`draft|review|published|archived`),
`sort`, `source_url`, `effective_from`, `effective_to`, `tags`, `assets`.

Рубрика описывается файлом `_topic.md` (или `_index.md`, `README.md`) в каталоге:

```markdown
---
title: Налоговый кодекс
summary: Статьи 120–145 и разъяснения к ним
sort: 1
---

## О разделе
Здесь собраны статьи по НДС.
```

Изображения кладите в `images/` рядом со статьёй — они подхватятся автоматически
(использованные в тексте станут `inline`, остальные — `attachment`).

Затем:

```bash
npm run validate -- --source   # проверить
npm run import -- --dir content --reset
```

`--reset` очищает рубрики, статьи и файлы перед загрузкой. Импорт сам по себе
только добавляет и обновляет записи, поэтому если материал переехал в другой
раздел (например, при появлении подгрупп), старая копия осталась бы в базе
навсегда. Вся база собирается из `content/`, так что очистка безопасна.

## Импорт и экспорт

```bash
# JSON-манифест
npm run import -- --json db/seeds/demo.json
npm run export -- --out backup.json

# каталог Markdown
npm run import -- --dir content --dry-run
npm run import -- --dir content --conflict upsert
```

`--dry-run` показывает план без записи в базу. Повторный импорт того же каталога
идемпотентен: материалы обновляются, а не дублируются.

## Пересборка из выгрузки 1gb.uz

```bash
tools/export-mcfr/rebuild.sh /Users/soll/Downloads/kb-final \
                             /Users/soll/Downloads/kb-pages-2026-09-28.ndjson
```

Скрипт выполняет три шага: `import-kb.py` пересобирает статьи и рубрики из
выгрузки, `make-forms.py` добавляет раздел «Бланки», затем идёт загрузка в базу
с `--reset`. Шаг 1 перезаписывает `content/`, поэтому порядок важен.

### Бланки

Статьи 1gb.uz заканчиваются блоком «Полезные шаблоны» — это список форм. Формы
живут в отдельном разделе сайта и содержат настоящие файлы `.docx`/`.doc`.
Списки и метаданные файлов отдаёт публичный API, сами файлы — только после
входа.

```bash
# собрать индекс бланков (медленно: по запросу на каждую статью)
python3 tools/export-mcfr/harvest-forms.py \
  --manifest /Users/soll/Downloads/kb-pages-2026-09-28.ndjson \
  --out tools/export-mcfr/data

# скачать сами файлы: нужны куки вашей сессии 1gb.uz
python3 tools/export-mcfr/download-forms.py \
  --content content --cookies ~/cookies.txt

npm run import -- --dir content --reset
```

`harvest-forms.py` перезапрашивает каждую статью, поэтому после полного обхода
`tools/export-mcfr/data/forms.ndjson` можно переиспользовать: `rebuild.sh`
подхватит его сам. Куки для скачивания берутся из `--cookies`, из `--cookie`
или из переменной `M1GB_COOKIE`.

## API

| Метод  | Путь                        | Назначение                                    |
| ------ | --------------------------- | --------------------------------------------- |
| GET    | `/api/health`               | проверка живости и версии схемы                |
| GET    | `/api/stats`                | счётчики для дашборда                         |
| GET    | `/api/tree`                 | всё дерево рубрик + статьи (для сайдбара)      |
| GET    | `/api/topics`               | корневые рубрики                               |
| GET    | `/api/topics/:id`           | рубрика, статьи, дочерние рубрики              |
| GET    | `/api/topics/*path`         | рубрика по полному пути слага                  |
| POST   | `/api/topics`               | создать рубрику                                |
| PATCH  | `/api/topics/:id`           | переименовать / переставить / сменить статус   |
| DELETE | `/api/topics/:id`           | удалить ветку (статьи и файлы каскадом)         |
| GET    | `/api/articles`             | список статей (фильтры: `status`, `topic`)     |
| GET    | `/api/articles/:id`         | статья + HTML + оглавление + ссылки + файлы    |
| PUT    | `/api/articles/:id`         | создать или обновить статью                    |
| DELETE | `/api/articles/:id`         | удалить статью                                  |
| GET    | `/api/search?q=...`         | полнотекстовый поиск + пагинация               |
| GET    | `/api/assets`               | список файлов                                  |
| POST   | `/api/assets`               | загрузить файл (multipart)                     |
| GET    | `/api/assets/:id/file`      | отдать файл                                    |
| GET    | `/api/progress`             | очередь повторения                             |
| POST   | `/api/progress`             | отметить статью как выученную                  |

## Проверка целостности

`npm run validate` проверяет и исходники, и базу:

- деревья рубрик: циклы, потерянные родители, дубль slug в одной рубрике;
- slug статей: коллизии, пробелы, несовпадение с заголовком;
- ссылки `[[...]]`: битые, ведущие на себя, неоднозначные, `#якорь` без статьи;
- якоря: дубли, вложенность, отсутствие в тексте, несовпадение регистра;
- изображения и вложения: файл на диске, размер, ширина/высота PNG и JPEG;
- контрольные суммы: sha256 файла против `assets.checksum`;
- вики-ссылки в тексте против `assets[]` в манифесте;
- ссылки на удалённые статьи в `article_links`;
- `source_url` у опубликованных статей (предупреждение).

## Переменные окружения

Скопируйте `.env.example` в `.env`. Основные: `DATABASE_URL`, `PORT`, `CONTENT_DIR`,
`STORAGE_DIR`, `CORS_ORIGIN`, `LOG_LEVEL`. Полный список — в `.env.example`.

## Данные и авторские права

В репозиторий попадает только то, что вы можете публиковать. Для заимствованных
материалов заполняйте `source_url` — валидатор напомнит, если у опубликованной
статьи нет источника.
