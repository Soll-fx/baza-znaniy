import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../lib/db.js';
import { asyncRoute, notFound, badRequest, param, uuidParam } from '../lib/http.js';

export const topicsRouter: Router = Router();

const createTopicSchema = z.object({
  parentId: z.string().uuid().nullable().optional(),
  slug: z.string().min(1).max(120).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug: только a-z0-9 и дефисы'),
  title: z.string().min(1).max(300),
  summary: z.string().max(2000).nullish(),
  sortOrder: z.number().int().optional(),
  isPublished: z.boolean().optional(),
  sourceUrl: z.string().url().nullish(),
});

/**
 * Плоский список всех рубрик + статей — источник данных для сайдбара.
 * Клиент сам собирает дерево: один запрос вместо N+1.
 */
topicsRouter.get(
  '/tree',
  asyncRoute(async (req, res) => {
    const includeUnpublished = req.query.all === '1';

    const [nodes, articles] = await Promise.all([
      query(
        `SELECT id, parent_id AS "parentId", slug, title, summary, kind, depth,
                path_text AS "pathText", path, sort_order AS "sortOrder",
                is_published AS "isPublished", direct_articles AS "directArticles",
                subtree_articles AS "subtreeArticles"
           FROM topic_tree
          WHERE ($1::boolean OR is_published)
          ORDER BY path`,
        [includeUnpublished],
      ),
      query(
        `SELECT a.id, a.topic_id AS "topicId", a.slug, a.title, a.status
           FROM articles a JOIN topics t ON t.id = a.topic_id
          WHERE ($1::boolean OR (a.status = 'published' AND t.is_published))
          ORDER BY a.slug`,
        [includeUnpublished],
      ),
    ]);

    res.json({ nodes: nodes.rows, articles: articles.rows, total: nodes.rowCount });
  }),
);

/** Полная карточка рубрики: дети + статьи + цепочка предков. */
async function loadTopic(id: string) {
  const topic = await queryOne(
    `SELECT id, parent_id AS "parentId", slug, title, summary, kind, depth,
            path, path_text AS "pathText", sort_order AS "sortOrder",
            is_published AS "isPublished", source_url AS "sourceUrl",
            direct_articles AS "directArticles", subtree_articles AS "subtreeArticles",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM topic_tree WHERE id = $1`,
    [id],
  );
  if (!topic) throw notFound('Рубрика');

  const [children, articles, breadcrumbs] = await Promise.all([
    query(
      `SELECT id, slug, title, kind, depth, subtree_articles AS "subtreeArticles"
         FROM topic_tree WHERE parent_id = $1 ORDER BY sort_order, title`,
      [id],
    ),
    query(
      `SELECT id, slug, title, summary, status, version,
              reading_minutes AS "readingMinutes", updated_at AS "updatedAt",
              assets_count AS "assetsCount"
         FROM article_list
        WHERE topic_id = $1 AND status <> 'archived'
        ORDER BY slug`,
      [id],
    ),
      query(
        // Префикс пути, а не «содержится в»: оператор <@ для массивов
        // проверяет вхождение элементов, из-за чего родительский раздел
        // терялся из хлебных крошек.
        `SELECT id, slug, title, depth FROM topic_tree
          WHERE (SELECT path FROM topics WHERE id = $1)[1:array_length(path, 1)] = path
          ORDER BY depth`,
        [id],
      ),
  ]);

  return {
    ...topic,
    children: children.rows,
    articles: articles.rows,
    breadcrumbs: breadcrumbs.rows,
  };
}

topicsRouter.get(
  '/by-path',
  asyncRoute(async (req, res) => {
    const segments = String(req.query.path ?? '')
      .split('/')
      .filter(Boolean);
    if (segments.length === 0) throw badRequest('Укажите path, например ?path=nalogovyy-kodeks/nds-st-12');

    const row = await queryOne<{ id: string }>(
      'SELECT id FROM topics WHERE path = $1::text[]',
      [segments],
    );
    if (!row) throw notFound(`Рубрика ${segments.join(' / ')}`);

    res.json(await loadTopic(row.id));
  }),
);

topicsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    res.json(await loadTopic(uuidParam(req, 'id')));
  }),
);

topicsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const data = createTopicSchema.parse(req.body);
    if (data.parentId) {
      const parent = await queryOne('SELECT id FROM topics WHERE id = $1', [data.parentId]);
      if (!parent) throw badRequest(`Родитель ${data.parentId} не найден`);
    }
    const row = await queryOne<{ id: string }>(
      `INSERT INTO topics (parent_id, slug, title, summary, sort_order, is_published, source_url)
       VALUES ($1, $2, $3, $4, COALESCE($5, 0), COALESCE($6, true), $7)
       RETURNING id`,
      [data.parentId ?? null, data.slug, data.title, data.summary ?? null, data.sortOrder ?? null,
       data.isPublished ?? null, data.sourceUrl ?? null],
    );
    res.status(201).json(row);
  }),
);

/** Перенос рубрики — триггер сам пересчитает path у всего поддерева. */
topicsRouter.patch(
  '/:id/move',
  asyncRoute(async (req, res) => {
    const body = z
      .object({ parentId: z.string().uuid().nullable(), sortOrder: z.number().int().optional() })
      .parse(req.body);
    await query(
      `UPDATE topics
          SET parent_id = $2,
              sort_order = COALESCE($3, sort_order)
        WHERE id = $1`,
      [uuidParam(req, 'id'), body.parentId, body.sortOrder ?? null],
    );
    const updated = await queryOne(
      'SELECT id, parent_id AS "parentId", path, depth FROM topics WHERE id = $1',
      [uuidParam(req, 'id')],
    );
    res.json(updated);
  }),
);

topicsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const deleted = await query('DELETE FROM topics WHERE id = $1 RETURNING id', [uuidParam(req, 'id')]);
    if (deleted.rowCount === 0) throw notFound('Рубрика');
    res.status(204).end();
  }),
);
