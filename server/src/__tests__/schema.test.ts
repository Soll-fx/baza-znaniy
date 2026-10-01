/**
 * Тесты схемы БД на настоящем движке PostgreSQL.
 *
 * PGlite — это Postgres, собранный в WebAssembly, поэтому db/schema.sql
 * выполняется по-настоящему: триггеры, PL/pgSQL, CHECK, enum, generated
 * columns и представления. Не нужен ни Docker, ни установленный psql.
 *
 * Здесь ловятся ошибки, которых не видит tsc: опечатка в имени колонки,
 * обращение к NEW.полю, которой в таблице триггера нет, инвертированный
 * оператор <@, GIST-индекс на массиве.
 *
 * Каждый describe создаёт собственное дерево рубрик, поэтому порядок
 * выполнения тестов не важен.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';

const SCHEMA = path.resolve(import.meta.dirname, '../../../db/schema.sql');

let db: PGlite;

const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await db.query(sql, params as never[])).rows as T[];

const row = async <T>(sql: string, params: unknown[] = []): Promise<T> => {
  const r = await rows<T>(sql, params);
  if (!r.length) throw new Error(`запрос ничего не вернул: ${sql.slice(0, 60)}…`);
  return r[0]!;
};

/** Порядковый номер — чтобы слаги разных блоков не пересекались. */
let seq = 0;
const uniq = (base: string) => `${base}-${(seq += 1)}`;

/** Создать рубрику, вернуть её id. */
const topic = async (slug: string, parent?: string): Promise<string> => {
  const r = parent
    ? await row<{ id: string }>(
        `insert into topics (parent_id, slug, title) values ($1,$2,$2) returning id`,
        [parent, slug],
      )
    : await row<{ id: string }>(`insert into topics (slug, title) values ($1,$1) returning id`, [slug]);
  return r.id;
};

const pathOf = (id: string) => row<{ path: string[]; depth: number }>(`select path, depth from topics where id = $1`, [id]);

/** Три уровня вложенности: a → b → c. Возвращает id корня. */
const tree3 = async (base: string) => {
  const a = await topic(base);
  const b = await topic(`${base}-b`, a);
  const c = await topic(`${base}-c`, b);
  return { a, b, c };
};

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pg_trgm, unaccent } });
  await db.exec(readFileSync(SCHEMA, 'utf8'));
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe('материализованный путь', () => {
  it('вычисляет path и depth триггером при вставке', async () => {
    const { a, b, c } = await tree3(uniq('nk'));
    expect((await pathOf(a)).path).toEqual([(await pathOf(a)).path[0]!]);
    expect((await pathOf(a)).depth).toBe(0);
    expect((await pathOf(b)).path).toEqual([...(await pathOf(a)).path, (await pathOf(b)).path[1]!]);
    expect((await pathOf(b)).depth).toBe(1);
    expect((await pathOf(c)).depth).toBe(2);
    expect((await pathOf(c)).path).toHaveLength(3);
  });

  it('переносит пути всех потомков при переименовании рубрики', async () => {
    const base = uniq('pereim');
    const { a, b, c } = await tree3(base);
    const newSlug = `${base}-new`;
    await rows(`update topics set slug = $1 where id = $2`, [newSlug, a]);

    expect((await pathOf(a)).path).toEqual([newSlug]);
    expect((await pathOf(b)).path).toEqual([newSlug, `${base}-b`]);
    expect((await pathOf(c)).path).toEqual([newSlug, `${base}-b`, `${base}-c`]);
    expect((await pathOf(c)).depth).toBe(2);
  });

  it('переносит поддерево в другую ветку', async () => {
    const base = uniq('perenos');
    const { a, b, c } = await tree3(base);
    const other = await topic(uniq('other'));

    await rows(`update topics set parent_id = $1 where id = $2`, [other, a]);

    const ob = await pathOf(other);
    expect((await pathOf(a)).path).toEqual([...ob.path, (await pathOf(a)).path[1]!]);
    expect((await pathOf(a)).depth).toBe(1);
    expect((await pathOf(c)).depth).toBe(3);
    expect((await pathOf(b)).depth).toBe(2);
  });

  it('запрещает сделать рубрику родителем её собственного потомка', async () => {
    const base = uniq('cikl');
    const { a, c } = await tree3(base);
    await expect(rows(`update topics set parent_id = $1 where id = $2`, [c, a])).rejects.toThrow(/Цикл/);
  });

  it('не даёт рубрике стать своим же родителем', async () => {
    const { b } = await tree3(uniq('cikl2'));
    await expect(rows(`update topics set parent_id = id where id = $1`, [b])).rejects.toThrow(/Цикл/);
  });

  it('требует уникальный slug только среди соседей', async () => {
    const base = uniq('sosedi');
    const a = await topic(base);
    const b = await topic(`${base}-drugaya`, a);
    // тот же slug в другой ветке — можно
    await expect(
      rows(`insert into topics (parent_id, slug, title) values ($1,$2,'дубль в другой ветке')`, [b, base]),
    ).resolves.toBeDefined();
    // тот же slug под тем же родителем — нельзя
    await expect(rows(`insert into topics (parent_id, slug, title) values ($1,$2,'дубль рядом')`, [b, base])).rejects.toThrow(
      /duplicate key/,
    );
  });
});

describe('topic_kind', () => {
  it('ставит branch, когда появился потомок, и возвращает leaf, когда он исчез', async () => {
    const a = await topic(uniq('vid'));
    expect((await row<{ kind: string }>(`select kind from topics where id = $1`, [a])).kind).toBe('leaf');

    const b = await topic(uniq('vid-det'), a);
    expect((await row<{ kind: string }>(`select kind from topics where id = $1`, [a])).kind).toBe('branch');

    await rows(`delete from topics where id = $1`, [b]);
    expect((await row<{ kind: string }>(`select kind from topics where id = $1`, [a])).kind).toBe('leaf');
  });

  it('не падает при вставке и удалении статьи', async () => {
    // Раньше здесь была ошибка 42703: триггер на articles обращался к NEW.kind
    const t = await topic(uniq('so-statey'));
    const art = await row<{ id: string }>(
      `insert into articles (topic_id, slug, title, status) values ($1,$2,'Обзор','published') returning id`,
      [t, `${t.slice(0, 8)}-ob`],
    );
    expect((await row<{ kind: string }>(`select kind from topics where id = $1`, [t])).kind).toBe('leaf');

    await rows(`delete from articles where id = $1`, [art.id]);
    expect((await row<{ kind: string }>(`select kind from topics where id = $1`, [t])).kind).toBe('leaf');
  });
});

describe('статьи', () => {
  it('заполняет сгенерированный tsv при вставке', async () => {
    const t = await topic(uniq('tsv'));
    const a = await row<{ tsv: string }>(
      `insert into articles (topic_id, slug, title, summary, body_md, status)
       values ($1,'nds-st-12','НДС: ставка 12 процентов','Условия применения','## Раздел один
Текст про налог','published')
       returning tsv::text as tsv`,
      [t],
    );
    expect(a.tsv).toContain('ндс');
    expect(a.tsv).toContain('процен');
  });

  it.each([
    ['пробелом', 'NDS St 12'],
    ['кириллицей', 'ndс-st'],
    ['двойным дефисом', 'nds--st'],
    ['подчёркиванием', 'nds_st'],
    ['точкой', 'nds.st'],
  ])('отвергает slug с %s', async (_why, slug) => {
    const t = await topic(uniq('slug'));
    await expect(
      rows(`insert into articles (topic_id, slug, title) values ($1,$2,'X')`, [t, slug]),
    ).rejects.toThrow(/check constraint/);
  });

  it('требует непустой заголовок', async () => {
    const t = await topic(uniq('pustoy-zagolovok'));
    await expect(
      rows(`insert into articles (topic_id, slug, title) values ($1,'ob','   ')`, [t]),
    ).rejects.toThrow(/check constraint/);
  });

  it('не трогает версию при обычном обновлении', async () => {
    const t = await topic(uniq('versiya'));
    const a = await row<{ id: string }>(
      `insert into articles (topic_id, slug, title, status) values ($1,'st','К обновлению','draft') returning id`,
      [t],
    );
    const v1 = await row<{ version: number }>(`select version from articles where id = $1`, [a.id]);
    await rows(`update articles set title = 'Обновлено' where id = $1`, [a.id]);
    const v2 = await row<{ version: number }>(`select version from articles where id = $1`, [a.id]);
    expect(v2.version).toBe(v1.version);
  });
});

describe('поиск', () => {
  it('находит статью запросом из routes/search.ts', async () => {
    const t = await topic(uniq('poisk'));
    await rows(
      `insert into articles (topic_id, slug, title, summary, body_md, status)
       values ($1,'nalog-12','Налог на прибыль: ставка','Условия','## Раздел один
Про налог на прибыль организаций','published')`,
      [t],
    );
    const found = await rows<{ title: string; score: number; excerpt: string }>(
      `with q as (select websearch_to_tsquery('russian', $1) tsq)
       select a.title,
              greatest(ts_rank_cd(a.tsv, q.tsq), similarity(a.title, $1),
                       case when a.title ilike '%'||$1||'%' then 0.9 else 0 end) as score,
              ts_headline('russian', a.body_md, q.tsq, 'MaxFragments=1') as excerpt
         from articles a, q
        where a.tsv @@ q.tsq or a.title % $1 or a.title ilike '%'||$1||'%'
        order by score desc limit 10`,
      ['налог'],
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.title).toContain('Налог');
    expect(Number(found[0]!.score)).toBeGreaterThan(0);
    expect(found[0]!.excerpt).toBeTruthy();
  });

  it('находит по почти совпадающему тексту через pg_trgm', async () => {
    const t = await topic(uniq('trgm'));
    await rows(
      `insert into articles (topic_id, slug, title, status) values ($1,'uchet','Учётная политика предприятия','published')`,
      [t],
    );
    const found = await rows(`select title from articles where title % $1`, ['Учетная политика']);
    expect(found.length).toBeGreaterThan(0);
  });
});

describe('файлы и связи', () => {
  it('не даёт завести один и тот же storage_key дважды', async () => {
    const key = `ab/cd/${uniq('file')}.png`;
    const checksum = 'a'.repeat(64);
    await rows(
      `insert into assets (storage_key, checksum, bytes, kind, mime, filename, width, height, alt)
       values ($1,$2,1234,'image','image/png','nds.png',760,240,'Схема')`,
      [key, checksum],
    );
    await expect(
      rows(
        `insert into assets (storage_key, checksum, bytes, kind, mime, filename) values ($1,$2,1234,'image','image/png','nds.png')`,
        [key, checksum],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('отвергает чексумму не в виде sha256', async () => {
    await expect(
      rows(
        `insert into assets (storage_key, checksum, bytes, kind, mime, filename)
         values ($1,'не-хеш',1,'image','image/png','y.png')`,
        [`aa/bb/${uniq('bad')}.png`],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('оставляет to_id пустым у битой ссылки, чтобы её нашёл частичный индекс', async () => {
    const t = await topic(uniq('ssylka'));
    const art = await row<{ id: string }>(
      `insert into articles (topic_id, slug, title, status) values ($1,'a','A','published') returning id`,
      [t],
    );
    await rows(`insert into article_links (from_id, kind, raw_target, to_id) values ($1,'internal','[[net-takogo]]',null)`, [
      art.id,
    ]);
    const broken = await rows<{ raw_target: string }>(
      `select raw_target from article_links where from_id = $1 and to_id is null and kind = 'internal'`,
      [art.id],
    );
    expect(broken.map((b) => b.raw_target)).toEqual(['[[net-takogo]]']);
  });

  it('обнуляет to_id при удалении цели ссылки', async () => {
    const t = await topic(uniq('poryadka-ssylok'));
    const target = await row<{ id: string }>(
      `insert into articles (topic_id, slug, title, status) values ($1,'cel','Цель','published') returning id`,
      [t],
    );
    const source = await row<{ id: string }>(
      `insert into articles (topic_id, slug, title, status) values ($1,'ist','Источник','published') returning id`,
      [t],
    );
    await rows(`insert into article_links (from_id, kind, raw_target, to_id) values ($1,'internal','[[cel]]',$2)`, [
      source.id,
      target.id,
    ]);
    await rows(`delete from articles where id = $1`, [target.id]);
    const left = await row<{ to_id: string | null }>(
      `select to_id from article_links where from_id = $1 and raw_target = '[[cel]]'`,
      [source.id],
    );
    expect(left.to_id).toBeNull();
  });
});

describe('представления', () => {
  it('topic_tree отдаёт все колонки, которые выбирают роуты', async () => {
    const have = new Set(
      (
        await rows<{ column_name: string }>(
          `select column_name from information_schema.columns where table_name = 'topic_tree'`,
        )
      ).map((c) => c.column_name),
    );
    const need = [
      'id', 'parent_id', 'slug', 'title', 'summary', 'kind', 'depth', 'path',
      'sort_order', 'is_published', 'source_url', 'created_at', 'updated_at',
      'path_text', 'direct_articles', 'subtree_articles',
    ];
    expect(need.filter((c) => !have.has(c))).toEqual([]);
  });

  it('article_list отдаёт все колонки, которые выбирают роуты', async () => {
    const have = new Set(
      (
        await rows<{ column_name: string }>(
          `select column_name from information_schema.columns where table_name = 'article_list'`,
        )
      ).map((c) => c.column_name),
    );
    const need = [
      'id', 'topic_id', 'topic_path', 'topic_title', 'slug', 'title', 'summary',
      'status', 'version', 'reading_minutes', 'updated_at', 'source_url',
      'assets_count', 'links_count',
    ];
    expect(need.filter((c) => !have.has(c))).toEqual([]);
  });

  it('subtree_articles считает статьи вложенных рубрик, а direct_articles — нет', async () => {
    const base = uniq('schyotchik');
    const { a, b } = await tree3(base);
    await rows(`insert into articles (topic_id, slug, title, status) values ($1,'v-ruk','В рубрике','published')`, [a]);
    await rows(`insert into articles (topic_id, slug, title, status) values ($1,'v-nest','В подрубрике','published')`, [b]);

    const root = await row<{ direct_articles: number; subtree_articles: number }>(
      `select direct_articles, subtree_articles from topic_tree where id = $1`,
      [a],
    );
    const mid = await row<{ direct_articles: number; subtree_articles: number }>(
      `select direct_articles, subtree_articles from topic_tree where id = $1`,
      [b],
    );
    expect(root.direct_articles).toBe(1);
    expect(mid.direct_articles).toBe(1);
    expect(root.subtree_articles).toBe(2);
    expect(mid.subtree_articles).toBe(1);
  });

  it('отдаёт цепочку рубрик запросом крошек из роутов', async () => {
    const base = uniq('kroshki');
    const { a, b, c } = await tree3(base);
    const chain = await rows<{ slug: string; depth: number }>(
      `select slug, depth from topic_tree where (select path from topics where id = $1) <@ path order by depth`,
      [a],
    );
    expect(chain.map((x) => x.slug)).toEqual([base, `${base}-b`, `${base}-c`]);
    expect(chain.map((x) => x.depth)).toEqual([0, 1, 2]);
    expect((await pathOf(c)).path).toHaveLength(3);
    expect((await pathOf(b)).path).toHaveLength(2);
  });
});

describe('защита от удаления', () => {
  it('не даёт удалить рубрику с вложенными рубриками', async () => {
    const { a, b } = await tree3(uniq('zashchita'));
    expect(b).toBeTruthy();
    await expect(rows(`delete from topics where id = $1`, [a])).rejects.toThrow(/Нельзя удалить рубрику/);
  });

  it('удаляет статьи вместе с листовой рубрикой', async () => {
    const t = await topic(uniq('kaskad'));
    await rows(`insert into articles (topic_id, slug, title) values ($1,'kaskad-st','Статья')`, [t]);
    await rows(`delete from topics where id = $1`, [t]);
    const left = await row<{ n: number }>(`select count(*)::int as n from articles where topic_id = $1`, [t]);
    expect(left.n).toBe(0);
  });
});
