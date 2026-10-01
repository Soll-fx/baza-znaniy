# Технический план: база знаний по бухгалтерии

Документ описывает, как устроен проект в `/Users/soll/Documents/Nick/бухгалтер`,
почему выбран именно такой стек, и как выполнить работу по трём этапам.

---

## 1. Цели и границы

**Что делаем**

1. Свою базу знаний с кликабельным вложенным сайдбаром, поиском, хлебными
   крошками и адаптивной вёрсткой.
2. Импорт собственных материалов 1:1 — с сохранением иерархии рубрик, текста,
   изображений и вложений, плюс экспорт обратно.
3. Автоматические тесты и скрипты проверки, которые ловят битые ссылки, потерянные
   изображения, дубли якорей, коллизии slug и порчу файлов.

**Чего не делаем**

- Не выгружаем и не копируем чужие материалы, особенно закрытые базы
  (`id.mcfr.uz` и подобные) — это и юридический, и технический риск.
- Не строим редактор с полноценным WYSIWYG: статьи пишутся в Markdown, который
  уже является источником истины и легко проверяется.

**Ключевое решение по контенту.** Markdown-файлы на диске — источник истины.
База — производная, её можно пересобрать в любой момент. Отсюда два практических
следствия: валидатор запускается и по файлам (без БД), и импорт идемпотентен.

---

## 2. Tech Stack и почему именно он

| Слой        | Выбор                            | Почему                                                                 |
| ----------- | -------------------------------- | ----------------------------------------------------------------------- |
| Фронтенд    | React 18 + TypeScript + Vite 6    | Быстрый HMR, готовые шаблоны, типизация дерева рубрик «из коробки».     |
| Стили       | Tailwind CSS 4                   | Нет конфиг-файла и сборки тем: тёмная тема через `dark:`-вариант.        |
| Роутинг     | react-router-dom 7               | URL = адрес статьи: `/a/:id`, рубрики `/t/*`, вики-ссылки `/s/:slug`.   |
| Состояние   | React Context + локальный state  | Данных мало, Redux не нужен; состояние сайдбара живёт в localStorage.    |
| Бэкенд      | Express 4 + TypeScript           | Минимум магии, полный контроль над маршрутами и транзакциями.            |
| БД          | PostgreSQL 16                    | Нужны рекурсивные CTE, GIN-индексы, триггеры и полнотекстовый поиск.    |
| Драйвер     | `pg` + параметризованные запросы | Единственное, что нужно; без ORM — видно каждый SQL.                    |
| Markdown    | `marked` + `sanitize-html`       | Рендеринг и обязательная санитизация HTML из недоверенного Markdown.     |
| Валидация   | `zod`                            | Схема запроса = валидация = TypeScript-тип, без дублирования.            |
| Загрузки    | `multer` 2                       | multipart-приём файлов, потоковая запись на диск.                        |
| Тесты       | Vitest + PGlite                  | Общий раннер в обоих пакетах; PGlite выполняет схему БД на WASM-Postgres. |
| Локально     | Docker Compose                   | Один `docker compose up` вместо ручной установки Postgres.               |

Отказ от ORM здесь осознанный: требования к целостности (материализованный путь,
запрет циклов, content-addressed хранилище) лучше выражаются триггерами и
прямыми запросами, чем абстракциями.

### 2.1 Схема компонентов

```
                       ┌──────────────────────────┐
   браузер ───────────▶│  web (React)             │
                       │  Sidebar · Search · TOC  │
                       └────────────┬─────────────┘
                                    │ fetch /api/*
                       ┌────────────▼─────────────┐
                       │  server (Express)        │
                       │  routes → lib → storage  │
                       └───┬──────────────────┬───┘
                           │ SQL              │ fs
                   ┌───────▼────────┐  ┌──────▼───────────────┐
                   │  PostgreSQL    │  │  storage/            │
                   │  topics        │  │   assets/ab/cd/…     │
                   │  articles      │  │   имя = sha256       │
                   │  assets        │  └──────────────────────┘
                   │  article_links │
                   └────────────────┘
        content/*.md  ──import──▶  (те же таблицы)
        content/*.md  ──validate─▶  отчёт в консоль / JSON
```

---

## 3. Схема БД

`db/schema.sql` — единственный источник правды о схеме, применяется через
`npm run db:migrate` (скрипт `server/src/scripts/migrate.ts`).

### 3.1 Типы

```sql
CREATE TYPE topic_kind      AS ENUM ('branch', 'leaf');
CREATE TYPE article_status  AS ENUM ('draft', 'review', 'published', 'archived');
CREATE TYPE asset_kind      AS ENUM ('image', 'document', 'spreadsheet', 'archive', 'other');
CREATE TYPE asset_role      AS ENUM ('cover', 'inline', 'attachment', 'diagram');
CREATE TYPE link_kind       AS ENUM ('internal', 'external', 'anchor');
CREATE TYPE progress_status AS ENUM ('new', 'learning', 'known', 'relearning');
```

Enum вместо `text` + `CHECK`: опечатку в статусе ловит база, а не пользователь.

### 3.2 `topics` — рубрики

```sql
CREATE TABLE topics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id    uuid REFERENCES topics(id) ON DELETE CASCADE,
  slug         text NOT NULL,
  title        text NOT NULL,
  summary      text,
  kind         topic_kind NOT NULL DEFAULT 'leaf',
  depth        integer NOT NULL DEFAULT 0,
  path         text[] NOT NULL DEFAULT '{}',   -- ['nalogovyy-kodeks','nds']
  sort_order   integer NOT NULL DEFAULT 100,
  is_published boolean NOT NULL DEFAULT false,
  source_url   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (id <> parent_id)                      -- защита от самоссылки
);

CREATE UNIQUE INDEX topics_sibling_slug_uniq
  ON topics (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
CREATE INDEX topics_path_gist    ON topics USING gist (path);   -- поиск по предкам
CREATE INDEX topics_parent_idx   ON topics (parent_id, sort_order);
CREATE INDEX topics_title_trgm   ON topics USING gin (title gin_trgm_ops);
```

Решение, которое определяет всю производительность чтения: `path` — это
**материализованный** путь из слагов, а не рекурсия в рантайме.

- список рубрик целиком — один `SELECT`, без N+1;
- хлебные крошки — `path` плюс один запрос по `= ANY($1)`;
- все потомки рубрики — `WHERE path <@ $1::text[]` (GIST-индекс);
- циклы ловит триггер, а не код приложения.

### 3.3 Триггеры дерева

```sql
-- 1. Пересчёт path при вставке и при смене parent_id/slug
CREATE TRIGGER topics_biu BEFORE INSERT OR UPDATE OF parent_id, slug
  ON topics FOR EACH ROW EXECUTE FUNCTION topics_set_path();

-- 2. Перенос всего поддерева при переименовании рубрики
CREATE TRIGGER topics_repath AFTER UPDATE OF parent_id, slug
  ON topics FOR EACH ROW EXECUTE FUNCTION topics_repath();

-- 3. Запрет удалять непустую рубрику
CREATE TRIGGER topics_no_orphan BEFORE DELETE ON topics
  FOR EACH ROW EXECUTE FUNCTION topics_no_orphan_delete();

-- 4. leaf обязан быть листом, branch — рубрикой с детьми
CREATE TRIGGER articles_kind AFTER INSERT OR DELETE ON articles
  ON articles FOR EACH ROW EXECUTE FUNCTION articles_require_kind();
```

`topics_set_path()` вставляет `parent.path || NEW.slug` и вычисляет `depth`.
`topics_repath()` обновляет `path` у всех потомков, чей `path` начинается со
старого пути. Именно поэтому в API нет кода для каскадного переименования.

### 3.4 `articles` — статьи

```sql
CREATE TABLE articles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id      uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  title         text NOT NULL,
  summary       text,
  body_md       text NOT NULL DEFAULT '',
  status        article_status NOT NULL DEFAULT 'draft',
  version       integer NOT NULL DEFAULT 1,
  reading_minutes integer,
  effective_from date,
  effective_to   date,
  source_url    text,
  tags          text[] NOT NULL DEFAULT '{}',
  tsv tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('russian', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('russian', coalesce(summary, '')), 'B') ||
      setweight(to_tsvector('russian', coalesce(body_md, '')), 'C')
  ) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (topic_id, slug)
);

CREATE INDEX articles_tsv_gin  ON articles USING gin (tsv);
CREATE INDEX articles_title_trgm ON articles USING gin (title gin_trgm_ops);
```

`tsvector` как `GENERATED … STORED` означает, что индекс нельзя «забыть
обновить» — это убирает целый класс багов при ручных `UPDATE`.

### 3.5 Файлы и связи

| Таблица         | Назначение                                                       |
| --------------- | ---------------------------------------------------------------- |
| `assets`        | Файл: `storage_key`, `checksum` (sha256), `bytes`, размеры, `mime` |
| `article_assets`| Связь статья ↔ файл с ролью и позицией                            |
| `article_links` | Исходящие ссылки: `raw_target`, `to_id`, `kind`                   |
| `article_revisions` | История версий статьи                                        |
| `study_progress`| Интервальные повторения по статьям                                |

Файлы хранятся по содержимому, а не по имени:

```text
storage/assets/2b/8f/2b8f1c….png
```

Один и тот же файл, приложенный к десяти статьям, лежит на диске один раз;
`assets` — дедуплицированный справочник, `article_assets` — привязки. Сверка
`sha256` при импорте и при `npm run validate` отлавливает подменённые или
битые файлы.

### 3.6 Представления

```sql
CREATE VIEW topic_tree AS
  WITH RECURSIVE t AS (
    SELECT topics.*, ARRAY[path]::text[] AS full_path FROM topics
  ) SELECT …;   -- плоский список рубрик с агрегатами по поддереву

CREATE VIEW topic_children AS …;  -- дети + счётчики статей
CREATE VIEW article_list  AS …;   -- статья + данные рубрики без N+1
```

Фронтенд получает всё дерево одним запросом `GET /api/tree` — это и есть
основа «сайдбар открывается мгновенно».

---

## 4. Формат контента

### 4.1 Каталог

```text
content/
  nalogovyy-kodeks/
    _topic.md                 # метаданные рубрики
    nds-st-12.md              # статья
    images/nds-schema.png     # изображения
  uchetnaya-politika/
    _topic.md
    p6-1.md
    podrazdel/                # вложенная рубрика
      _topic.md
      inventarizaciya.md
```

Правила: каталог = рубрика, `.md` = статья, `_topic.md` (или `_index.md`,
`README.md`) = описание рубрики, `sort` задаёт порядок, `slug` в frontmatter
переопределяет имя файла.

### 4.2 Frontmatter статьи

```yaml
---
title: НДС: ставка 12 %
summary: Условия применения сниженной ставки
status: published        # draft | review | published | archived
sort: 10
source_url: https://example.ru/docs/nds-12   # обязательно для заимствованного
effective_from: 2025-01-01
effective_to: 2027-12-31
tags: [ндс, налоги]
assets:
  - file: images/nds-schema.png
    alt: Схема расчёта НДС
    role: diagram
    position: 0
---
```

Важная деталь валидатора YAML: заголовок с двоеточием нужно заключать в кавычки
(`title: "НДС: ставка 12 %"`), иначе gray-matter считает `12 %` отдельным
отображением. Это проверяется в `server/src/lib/__tests__/units.test.ts`.

### 4.3 Синтаксис внутри текста

| Синтаксис                | Смысл                                              |
| ------------------------ | -------------------------------------------------- |
| `[[slug]]`               | вики-ссылка на статью                             |
| `[[rubrika/statyya]]`    | однозначная ссылка по полному пути                 |
| `[[slug#yаkor]]`         | ссылка на якорь внутри статьи                      |
| `[[slug\|текст]]`        | вики-ссылка со своим текстом                       |
| `![alt](images/x.png)`   | изображение                                        |
| `## Заголовок`           | якорь для оглавления и `#якорей`                   |

Ссылки разрешаются в порядке: полный путь → единственный slug → точное
совпадение заголовка. Неоднозначность — не ошибка, а предупреждение
`LINK_AMBIGUOUS` с подсказкой «укажите полный путь».

---

## 5. API

Контракт описан в README; здесь — детали, важные для понимания кода.

```ts
// server/src/routes/articles.ts
router.get('/:id', async (req, res, next) => {
  try {
    const row = await one<ArticleRow>('select * from article_list where id = $1', [
      param(req, 'id'),
    ]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Статья не найдена' } });

    const { html, toc } = await renderMarkdown(row.body_md, {
      assets: await loadAssets(row.id),
      resolveWikilink: (slug) => resolveSlug(slug),   // на уровне БД, не в браузере
    });

    res.json({ article: { ...row, bodyHtml: html, toc, breadcrumbs: … } });
  } catch (e) { next(e); }
});
```

Инварианты:

- все `id` валидируются `zod` как `uuid` до попадания в SQL;
- ответ — один объект `{ article }`, ошибка — `{ error: { code, message, details } }`;
- HTML статьи санитизируется `sanitize-html` (белый список тегов и атрибутов);
- `GET /api/topics/*path` зарегистрирован раньше `/:id`, иначе `*path` съел бы
  обычный маршрут.

---

## 6. Проверка целостности

`server/src/lib/validator.ts` работает в двух режимах: по каталогу (без БД) и по
базе. Общий движок обхода, разные источники данных.

| Код                      | Severity | Что означает                                   |
| ------------------------ | -------- | ---------------------------------------------- |
| `TREE_CYCLE`             | error    | рубрика является своим предком                  |
| `TOPIC_PARENT_MISSING`   | error    | потерянный родитель                              |
| `TOPIC_SLUG_DUPLICATE`   | error    | два одинаковых slug в одной рубрике             |
| `SLUG_MISMATCH`          | warning  | slug в frontmatter разошёлся с заголовком      |
| `SLUG_HAS_SPACES`        | warning  | пробелы или кириллица в slug                    |
| `LINK_BROKEN`            | error    | `[[...]]` без цели                              |
| `LINK_AMBIGUOUS`         | warning  | slug совпал с несколькими статьями              |
| `LINK_SELF`              | warning  | статья ссылается сама на себя                   |
| `ANCHOR_NOT_IN_TEXT`     | error    | `#якорь` отсутствует в тексте-целе              |
| `ANCHOR_DUPLICATE`       | error    | два одинаковых `## Заголовка`                   |
| `ANCHOR_NESTED`          | warning  | `#### Внутри ## Раздела` — якорь перезапишется  |
| `IMAGE_NOT_DECLARED`     | error    | картинка в тексте отсутствует в `assets[]`      |
| `ASSET_FILE_MISSING`     | error    | файла нет на диске                              |
| `ASSET_CHECKSUM_MISMATCH`| error   | sha256 файла не совпадает с базой               |
| `ASSET_ALT_EMPTY`        | warning  | картинка без alt (доступность и SEO)            |
| `DANGLING_LINK_ROW`      | warning  | в `article_links` осталась ссылка на удалённое  |
| `ASSET_ORPHAN`           | info     | файл не привязан ни к одной статье              |
| `NO_SOURCE_URL`          | warning  | опубликованная статья без источника             |

Сверка изображений идёт по имени файла, а не по полному пути: `src` в Markdown
задан относительно каталога статьи, а `assets[].file` — относительно корня
импорта, и без этого правила валидатор ругался бы на корректный контент.

```ts
// дубли якорей идут по порядку — так же работает и браузерный скролл
if (seen.has(anchor)) {
  add({ severity: 'error', code: 'ANCHOR_DUPLICATE',
        message: `дубль якоря #${anchor}`, where: ref,
        hint: 'Переименуйте один из заголовков' });
}
seen.add(anchor);
```

---

## 7. План работ по этапам

### Этап 1. Интерфейс

**Что уже сделано в репозитории:** `web/src/components/Sidebar.tsx`,
`SearchBar.tsx`, `Breadcrumbs.tsx`, `TableOfContents.tsx`, `ArticlePage.tsx`,
`web/src/lib/tree.ts`, роуты в `App.tsx`.

**Шаги**

1. Развернуть БД и API:

   ```bash
   npm run db:up && npm run db:migrate && npm run db:seed
   ```

2. Запустить фронт и проверить вручную:

   ```bash
   npm run dev          # http://localhost:5173
   ```

   Проверить: раскрытие/сворачивание рубрик, переход по вложенным статьям,
   подсветку активной ветки, поиск (250 мс debounce) с выпадающим списком,
   хлебные крошки, оглавление со scroll-spy, мобильный drawer, тёмную тему.

3. Логика дерева покрыта тестами, чтобы правки сайдбара не ломали навигацию:

   ```bash
   npm run test --workspace web     # 18 тестов на buildTree/filterTree/indexTree
   ```

4. Сборка продакшна: `npm run build` — Vite собирает `web/dist`, сервер
   раздаёт статику.

### Этап 2. Импорт своего контента

**Шаги**

1. Разложить материалы в `content/`: каталог = рубрика, файл = статья,
   изображения — в `images/` рядом со статьёй.

2. Проверить без записи в базу:

   ```bash
   npm run validate -- --source
   ```

   Типичные находки и что с ними делать:

   | Сообщение               | Причина                                          | Решение                              |
   | ----------------------- | ------------------------------------------------ | ------------------------------------ |
   | `LINK_BROKEN`           | опечатка в `[[...]]` или нет статьи-цели          | создать статью или исправить ссылку  |
   | `ANCHOR_DUPLICATE`      | два одинаковых заголовка                         | переименовать один                   |
   | `ANCHOR_NESTED`         | подзаголовок с `####` внутри `##`                 | поднять уровень или дать свой якорь  |
   | `ASSET_FILE_MISSING`    | путь в `assets[]` не совпадает с местом файла    | исправить путь или `src`             |
   | `NO_SOURCE_URL`         | заимствованный материал без источника             | заполнить `source_url`               |

3. Прогнать вхолостую и только потом импортировать:

   ```bash
   npm run import -- --dir content --dry-run
   npm run import -- --dir content --conflict upsert
   ```

4. Убедиться, что в базе то же самое:

   ```bash
   npm run validate
   ```

5. Настроить повторение: в `/a/:id` отметить статью выученной, затем
   `GET /api/progress` вернёт очередь.

### Этап 3. Тесты и скрипты проверки

**Автоматические проверки**

```bash
npm run typecheck     # tsc --noEmit в server и web
npm run test          # 77 тестов server + 18 тестов web = 95
npm run validate      # исходники + база, код возврата 1 при ошибках
```

- `server/src/lib/__tests__/units.test.ts` — slug, Markdown, вики-ссылки,
  TOC, frontmatter, пути хранилища.
- `server/src/lib/__tests__/validator.test.ts` — все коды диагностики на
  фикстурах, включая регрессии: неоднозначный slug не должен давать
  `LINK_BROKEN`, а ссылки резолвятся по имени файла.
- `server/src/__tests__/schema.test.ts` — 28 тестов схемы на настоящем движке
  PostgreSQL (PGlite, WASM-сборка). Без Docker и `psql`.
- `web/src/lib/tree.test.ts` — сборка дерева, индекс, фильтрация поиска,
  инварианты `depth == path.length - 1`.

**Скрипты**

| Скрипт                             | Назначение                              |
| ---------------------------------- | --------------------------------------- |
| `npm run validate -- --source`     | проверка каталога, без БД               |
| `npm run validate -- --dir X`      | проверка произвольного каталога         |
| `npm run validate -- --checksums`  | пересчёт sha256 всех файлов             |
| `npm run validate -- --json`       | отчёт в JSON для CI                     |
| `npm run validate`                 | проверка данных в PostgreSQL            |
| `npm run export -- --out dump.json`| резервная копия в JSON                  |

**Регулярный запуск.** Перед публикацией изменений:

```bash
npm run typecheck && npm run test && npm run validate -- --source
```

В CI то же самое плюс `npm run validate -- --json`, чтобы падение влилось в PR
с машиночитаемым отчётом.

---

## 8. Известные ограничения и развитие

**Ограничения текущей версии**

- На этом компьютере нет Docker и `psql`. Схема проверена на PostgreSQL,
  собранном в WebAssembly (PGlite, 28 тестов), но не на сервере PostgreSQL 16.
  Проверены также: TypeScript (оба пакета), сборка фронта, 95 тестов, валидатор
  по файлам. Первым делом на машине с Postgres:
  `npm run db:migrate && npm run db:seed && npm run validate`.
- `npm audit` показывает 5 уязвимостей (3 moderate, 1 high, 1 critical) — все в
  dev-цепочке `vitest`/`vite`/`esbuild`, в production-сборку они не попадают.
  Обновляются обновлением vitest.
- Пользователей и прав доступа нет: `user_id` в `study_progress` — заглушка
  под будущую авторизацию.
- `GET /api/topics/*path` для очень глубокого дерева стоит перевести на
  материализованный id-кеш на клиенте.

**Куда развивать**

1. Авторизация и роли `editor`/`reviewer`/`reader` — журнал `article_revisions`
   уже готов к истории правок.
2. Версионирование по `effective_from` / `effective_to`: интерфейс «актуальная
   редакция на 1 января 2026» для учётной политики и налоговых ставок.
3. Кеш рендеринга HTML в Redis, если статей станет больше тысячи.
4. CI: `typecheck` → `test` → `validate --json` → сборка Docker-образа.
5. Импорт из DOCX/PDF с извлечением структуры заголовков и картинок.

---

## 9. Чек-лист готовности

- [x] Дерево рубрик с вложенностью, переносом поддерева и защитой от циклов
- [x] Кликабельный nested-сайдбар с раскрытием и подсветкой активной ветки
- [x] Поиск: полнотекстовый в БД + живая фильтрация сайдбара
- [x] Хлебные крошки, оглавление со scroll-spy, адаптив и тёмная тема
- [x] Импорт из Markdown и JSON, экспорт в JSON
- [x] Content-addressed хранилище с проверкой sha256
- [x] Валидатор: 17 правил, код возврата 1, вывод в JSON
- [x] 95 автотестов, включая 28 на реальном движке PostgreSQL (PGlite)
- [x] typecheck и продакшн-сборка проходят
- [ ] Прогон `db:migrate` / `db:seed` / `validate` на сервере PostgreSQL 16
- [ ] Авторизация и роли
