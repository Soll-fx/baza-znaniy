-- ============================================================================
--  База знаний по бухгалтерии — схема PostgreSQL 14+
--  Идея: иерархия тем (topics) + статьи (articles) + медиа (assets)
--         + связи между статьями (article_links) + прогресс обучения
-- ============================================================================

-- gen_random_uuid() встроен в ядро начиная с PostgreSQL 13 — pgcrypto не нужен
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- нечёткий поиск (title gin_trgm_ops)
CREATE EXTENSION IF NOT EXISTS unaccent;   -- поиск без учёта диакритики

-- ---------------------------------------------------------------------------
-- Типы-перечисления
-- ---------------------------------------------------------------------------

CREATE TYPE topic_kind    AS ENUM ('branch', 'leaf');
CREATE TYPE article_status AS ENUM ('draft', 'review', 'published', 'archived');
CREATE TYPE asset_kind    AS ENUM ('image', 'document', 'spreadsheet', 'archive', 'other');
CREATE TYPE asset_role    AS ENUM ('cover', 'inline', 'attachment', 'diagram');
CREATE TYPE link_kind     AS ENUM ('internal', 'external', 'anchor');
CREATE TYPE progress_status AS ENUM ('new', 'learning', 'known', 'relearning');

-- ===========================================================================
--  1. РУБРИКИ И ПОДТЕМЫ
--     parent_id  — список смежности (простое редактирование)
--     path       — материализованный путь (слаги от корня), быстрое чтение дерева
--     depth      — уровень вложенности
-- ===========================================================================

CREATE TABLE topics (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id    uuid REFERENCES topics(id) ON DELETE RESTRICT,
    slug         text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    title        text NOT NULL CHECK (length(btrim(title)) > 0),
    summary      text,
    kind         topic_kind NOT NULL DEFAULT 'leaf',
    path         text[] NOT NULL DEFAULT '{}',
    depth        integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
    sort_order   integer NOT NULL DEFAULT 0,
    is_published boolean NOT NULL DEFAULT true,
    -- Ссылка на законный первоисточник статьи (lex.uz, nalog.uz, ВН РФ и т.п.)
    source_url   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Уникальность слага среди соседей
CREATE UNIQUE INDEX topics_sibling_slug_uniq ON topics (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
-- Быстрый доступ к поддереву
-- GIN, а не GIST: array_ops есть только у GIN, он покрывает @>, <@, &&
CREATE INDEX topics_path_gin ON topics USING gin (path);
CREATE INDEX topics_parent_idx ON topics (parent_id, sort_order);
CREATE INDEX topics_title_trgm ON topics USING gin (title gin_trgm_ops);

-- --- Триггер: пересчёт path/depth + защита от циклов -----------------------

CREATE OR REPLACE FUNCTION topics_biu() RETURNS trigger AS $$
DECLARE
    p_path  text[];
    p_depth integer;
BEGIN
    IF NEW.id IS NOT NULL AND EXISTS (
        SELECT 1 FROM topics c
         WHERE c.id = NEW.parent_id
           AND (SELECT t.path FROM topics t WHERE t.id = NEW.id) <@ c.path
    ) THEN
        RAISE EXCEPTION 'Цикл: рубрику % нельзя вложить в её собственного потомка', NEW.title
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.parent_id IS NULL THEN
        NEW.path  := ARRAY[NEW.slug];
        NEW.depth := 0;
    ELSE
        SELECT t.path, t.depth INTO p_path, p_depth
          FROM topics t WHERE t.id = NEW.parent_id;

        IF p_path IS NULL THEN
            RAISE EXCEPTION 'Родительская рубрика % не найдена', NEW.parent_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        NEW.path  := p_path || NEW.slug;
        NEW.depth := p_depth + 1;
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER topics_biu BEFORE INSERT OR UPDATE OF parent_id, slug
    ON topics FOR EACH ROW EXECUTE FUNCTION topics_biu();

-- Пересчёт путей у потомков при переносе или переименовании рубрики.
-- Потомки собираются рекурсией по parent_id, а не сравнением массивов:
-- внутри AFTER-триггера self-update читает снимок, в котором часть строк
-- ещё не обновлена, и массивы path дают неверный результат.
-- topics.id = t.id обязателен: без этой корреляции UPDATE обновляет всю
-- таблицу (WHERE ограничивает только присоединяемые строки t, а не цели).
CREATE OR REPLACE FUNCTION topics_repath_children() RETURNS trigger AS $$
BEGIN
    IF NEW.path IS NOT DISTINCT FROM OLD.path AND NEW.depth IS NOT DISTINCT FROM OLD.depth THEN
        RETURN NULL;
    END IF;

    UPDATE topics
       SET path   = NEW.path || (t.path)[array_length(OLD.path, 1) + 1:],
           depth  = t.depth + (NEW.depth - OLD.depth),
           updated_at = now()
      FROM topics t
     WHERE t.id = topics.id
       AND t.id IN (
             WITH RECURSIVE sub AS (
                 SELECT c.id FROM topics c WHERE c.parent_id = NEW.id
                 UNION ALL
                 SELECT c.id FROM topics c JOIN sub ON c.parent_id = sub.id
             )
             SELECT id FROM sub
           );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER topics_repath AFTER UPDATE OF parent_id, slug
    ON topics FOR EACH ROW EXECUTE FUNCTION topics_repath_children();

-- Запрет удалять рубрику с детьми (осмысленная ошибка вместо каскада)
CREATE OR REPLACE FUNCTION topics_no_orphan_delete() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM topics c WHERE c.parent_id = OLD.id) THEN
        RAISE EXCEPTION 'Нельзя удалить рубрику "%": сначала удалите или перенесите % вложенных рубрик',
            OLD.title, (SELECT count(*) FROM topics c WHERE c.parent_id = OLD.id)
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER topics_no_orphan BEFORE DELETE ON topics
    FOR EACH ROW EXECUTE FUNCTION topics_no_orphan_delete();

-- --- Синхронизация topic_kind -------------------------------------------------
-- kind не задаётся руками, а вычисляется из структуры:
--   branch — есть вложенные рубрики;  leaf — вложенных рубрик нет.
-- Правило применяется к трём рубрикам: прежнему родителю, новому родителю
-- и самой изменившейся рубрике, поэтому ручное 'leaf' у ветки не закрепится.
--
-- Внутри функции нельзя писать NEW.kind в триггере на articles: там такого
-- поля нет (ошибка 42703), поэтому у articles своя функция.

CREATE OR REPLACE FUNCTION topics_sync_kind() RETURNS trigger AS $$
DECLARE
    old_parent uuid;
    new_parent uuid;
BEGIN
    IF TG_OP <> 'INSERT' THEN old_parent := OLD.parent_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_parent := NEW.parent_id; END IF;

    -- родители: у прежнего мог исчезнуть последний потомок,
    -- у нового — появиться
    UPDATE topics t
       SET kind = CASE WHEN EXISTS (SELECT 1 FROM topics c WHERE c.parent_id = t.id)
                       THEN 'branch'::topic_kind
                       ELSE 'leaf'::topic_kind END,
           updated_at = now()
     WHERE t.id IN (old_parent, new_parent);

    -- сама рубрика: могла получить или потерять потомка
    IF TG_OP <> 'DELETE' THEN
        UPDATE topics t
           SET kind = CASE WHEN EXISTS (SELECT 1 FROM topics c WHERE c.parent_id = t.id)
                           THEN 'branch'::topic_kind
                           ELSE 'leaf'::topic_kind END,
               updated_at = now()
         WHERE t.id = NEW.id
           AND t.kind IS DISTINCT FROM (
                 CASE WHEN EXISTS (SELECT 1 FROM topics c WHERE c.parent_id = t.id)
                      THEN 'branch'::topic_kind ELSE 'leaf'::topic_kind END);
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Та же логика при появлении и исчезновении статьи. TG_OP нужен, потому что
-- в триггере DELETE запись NEW не присвоена.
CREATE OR REPLACE FUNCTION articles_sync_kind() RETURNS trigger AS $$
DECLARE
    target uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN target := OLD.topic_id; ELSE target := NEW.topic_id; END IF;

    UPDATE topics t
       SET kind = CASE WHEN EXISTS (SELECT 1 FROM topics c WHERE c.parent_id = t.id)
                       THEN 'branch'::topic_kind
                       ELSE 'leaf'::topic_kind END,
           updated_at = now()
     WHERE t.id = target;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
--  2. СТАТЬИ
-- ===========================================================================

CREATE TABLE articles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_id    uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    slug        text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    title       text NOT NULL CHECK (length(btrim(title)) > 0),
    summary     text,
    body_md     text,                                   -- исходный Markdown
    body_html   text,                                   -- кэш отрендеренного HTML
    toc         jsonb NOT NULL DEFAULT '[]'::jsonb,     -- [{id,label,level,anchor}]
    status      article_status NOT NULL DEFAULT 'draft',
    version     integer NOT NULL DEFAULT 1,
    reading_minutes integer,
    effective_from date,
    effective_to   date,
    source_url  text,
    -- Полнотекстовый индекс (russian config, генерация на запись)
    tsv         tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('russian', coalesce(title, '')),   'A') ||
                    setweight(to_tsvector('russian', coalesce(summary, '')), 'B') ||
                    setweight(to_tsvector('russian', coalesce(body_md, '')), 'C')
                ) STORED,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX articles_topic_slug_uniq ON articles (topic_id, slug);
CREATE INDEX articles_topic_idx   ON articles (topic_id);
CREATE INDEX articles_status_idx ON articles (status);
CREATE INDEX articles_tsv_gin    ON articles USING gin (tsv);
CREATE INDEX articles_title_trgm ON articles USING gin (title gin_trgm_ops);
CREATE INDEX articles_updated_idx ON articles (updated_at DESC);

CREATE TRIGGER articles_kind AFTER INSERT OR DELETE ON articles
    FOR EACH ROW EXECUTE FUNCTION articles_sync_kind();

CREATE TRIGGER topics_kind AFTER INSERT OR DELETE OR UPDATE OF parent_id
    ON topics FOR EACH ROW EXECUTE FUNCTION topics_sync_kind();

-- История версий
CREATE TABLE article_revisions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    version    integer NOT NULL,
    title      text NOT NULL,
    body_md    text,
    editor     text,
    note       text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (article_id, version)
);

-- ===========================================================================
--  3. МЕДИАФАЙЛЫ
--     Файлы лежат в storage/assets/<shard>/<shard>/<checksum>.<ext>
--     В БД — только метаданные; sha256 используется валидатором целостности.
-- ===========================================================================

CREATE TABLE assets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        asset_kind NOT NULL DEFAULT 'image',
    filename    text NOT NULL,                    -- исходное имя файла
    storage_key text NOT NULL UNIQUE,            -- относительный путь в storage/
    mime        text NOT NULL,
    bytes       bigint NOT NULL CHECK (bytes >= 0),
    checksum    text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
    width       integer,
    height      integer,
    alt         text,                             -- обязателен для image (валидатор)
    decorative  boolean NOT NULL DEFAULT false,   -- картинка без смысловой нагрузки
    caption     text,
    source_url  text,                             -- откуда файл
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assets_checksum_idx ON assets (checksum);
CREATE INDEX assets_kind_idx     ON assets (kind);

-- Связь статья ↔ медиа (многие-ко-многим, с порядком и ролью)
CREATE TABLE article_assets (
    article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    asset_id   uuid NOT NULL REFERENCES assets(id)   ON DELETE RESTRICT,
    role       asset_role NOT NULL DEFAULT 'inline',
    position   integer NOT NULL DEFAULT 0,
    block_anchor text,                             -- якорь блока в тексте
    PRIMARY KEY (article_id, asset_id, role)
);

CREATE INDEX article_assets_asset_idx ON article_assets (asset_id);
CREATE INDEX article_assets_article_idx ON article_assets (article_id, role, position);

-- ===========================================================================
--  4. ССЫЛКИ МЕЖДУ СТАТЬЯМИ (для поиска битых ссылок)
--     [[slug]] и [[slug#anchor]] — вики-ссылки; внешние — http(s)
-- ===========================================================================

CREATE TABLE article_links (
    from_id     uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    kind        link_kind NOT NULL,
    raw_target  text NOT NULL,     -- как написано в Markdown
    to_id       uuid REFERENCES articles(id) ON DELETE SET NULL,  -- NULL = битая
    resolved_slug text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (from_id, kind, raw_target)
);

CREATE INDEX article_links_to_idx ON article_links (to_id);
CREATE INDEX article_links_broken_idx ON article_links (from_id) WHERE to_id IS NULL AND kind = 'internal';

-- ===========================================================================
--  5. ПРОГРЕСС ОБУЧЕНИЯ (упрощённый SRS)
-- ===========================================================================

CREATE TABLE study_progress (
    user_id       text NOT NULL DEFAULT 'local',
    article_id    uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    status        progress_status NOT NULL DEFAULT 'new',
    confidence    smallint NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 5),
    reps          integer NOT NULL DEFAULT 0,
    last_seen_at  timestamptz,
    next_review_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, article_id)
);

CREATE INDEX study_progress_due_idx ON study_progress (user_id, next_review_at);

-- ===========================================================================
--  6. ПРЕДСТАВЛЕНИЯ
-- ===========================================================================

-- Плоское дерево с полным путём и счётчиками — основной источник для сайдбара
CREATE OR REPLACE VIEW topic_tree AS
SELECT
    t.id,
    t.parent_id,
    t.slug,
    t.title,
    t.summary,
    t.kind,
    t.depth,
    t.path,
    t.sort_order,
    t.is_published,
    t.source_url,
    t.created_at,
    t.updated_at,
    array_to_string(t.path, ' / ') AS path_text,
    (SELECT count(*) FROM articles a
       WHERE a.topic_id = t.id AND a.status = 'published')::int AS direct_articles,
    (SELECT count(*) FROM articles a
       JOIN topics c ON c.id = a.topic_id
      WHERE t.path <@ c.path AND a.status = 'published')::int AS subtree_articles
FROM topics t;

-- Соседи + дети одним запросом (для загрузки сайдбара целиком)
CREATE OR REPLACE VIEW topic_children AS
SELECT t.id, t.parent_id, t.slug, t.title, t.kind, t.depth, t.sort_order, t.is_published,
       t.path_text, t.subtree_articles
  FROM topic_tree t;

-- Статьи с путём рубрики и счётчиками вложенных медиа
CREATE OR REPLACE VIEW article_list AS
SELECT a.id, a.topic_id, t.path AS topic_path, t.title AS topic_title,
       a.slug, a.title, a.summary, a.status, a.version,
       a.reading_minutes, a.updated_at, a.source_url,
       (SELECT count(*) FROM article_assets aa WHERE aa.article_id = a.id)::int AS assets_count,
       (SELECT count(*) FROM article_links al WHERE al.from_id = a.id)::int AS links_count
  FROM articles a
  JOIN topics t ON t.id = a.topic_id;
