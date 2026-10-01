import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../lib/db.js';
import { asyncRoute, notFound, badRequest, param, uuidParam } from '../lib/http.js';
import { renderMarkdown, readingMinutes, extractLinks } from '../lib/markdown.js';

export const articlesRouter: Router = Router();

const updateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  summary: z.string().max(2000).nullish(),
  bodyMd: z.string().max(2_000_000).optional(),
  status: z.enum(['draft', 'review', 'published', 'archived']).optional(),
  sourceUrl: z.string().url().nullish(),
  effectiveFrom: z.string().date().nullish(),
  effectiveTo: z.string().date().nullish(),
  editor: z.string().max(120).optional(),
});

articlesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : 'published';
    const topicId = req.query.topic ? String(req.query.topic) : null;
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);

    const rows = await query(
      `SELECT id, topic_id AS "topicId", topic_path AS "topicPath", topic_title AS "topicTitle",
              slug, title, summary, status, version, reading_minutes AS "readingMinutes",
              updated_at AS "updatedAt", source_url AS "sourceUrl",
              assets_count AS "assetsCount", links_count AS "linksCount"
         FROM article_list
        WHERE ($1::text IS NULL OR status = $1::article_status)
          AND ($2::uuid IS NULL OR topic_id = $2)
        ORDER BY topic_path, slug
        LIMIT $3`,
      [status === 'all' ? null : status, topicId, limit],
    );
    res.json({ articles: rows.rows, total: rows.rowCount });
  }),
);

articlesRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const article = await queryOne(
      `SELECT a.id, a.topic_id AS "topicId", a.slug, a.title, a.summary,
              a.body_md AS "bodyMd", a.body_html AS "bodyHtml", a.toc,
              a.status, a.version, a.reading_minutes AS "readingMinutes",
              a.effective_from AS "effectiveFrom", a.effective_to AS "effectiveTo",
              a.source_url AS "sourceUrl", a.created_at AS "createdAt", a.updated_at AS "updatedAt",
              t.path AS "topicPath", t.title AS "topicTitle", t.slug AS "topicSlug"
         FROM articles a JOIN topics t ON t.id = a.topic_id
        WHERE a.id = $1`,
      [uuidParam(req, 'id')],
    );
    if (!article) throw notFound('Статья');

    const [assets, links, breadcrumbs, progress] = await Promise.all([
      query(
        `SELECT s.id, s.kind, s.filename, s.mime, s.bytes, s.width, s.height,
                s.alt, s.caption, s.source_url AS "sourceUrl", aa.role, aa.position,
                aa.block_anchor AS "blockAnchor"
           FROM article_assets aa JOIN assets s ON s.id = aa.asset_id
          WHERE aa.article_id = $1
          ORDER BY aa.role, aa.position`,
        [uuidParam(req, 'id')],
      ),
      query(
        `SELECT al.kind, al.raw_target AS "rawTarget", al.to_id AS "toId",
                al.resolved_slug AS "resolvedSlug", a.title AS "toTitle", a.slug AS "toSlug"
           FROM article_links al LEFT JOIN articles a ON a.id = al.to_id
          WHERE al.from_id = $1 ORDER BY al.kind, al.raw_target`,
        [uuidParam(req, 'id')],
      ),
      query(
        // Префикс пути, а не «содержится в» — см. комментарий в topics.ts
        `SELECT id, slug, title, depth FROM topic_tree
          WHERE (SELECT path FROM topics WHERE id = $1)[1:array_length(path, 1)] = path
          ORDER BY depth`,
        [article.topicId],
      ),
      query(
        `SELECT status, confidence, reps, next_review_at AS "nextReviewAt"
           FROM study_progress WHERE article_id = $1 AND user_id = $2`,
        [uuidParam(req, 'id'), String(req.query.user ?? 'local')],
      ),
    ]);

    res.json({
      ...article,
      assets: assets.rows,
      links: links.rows,
      brokenLinks: links.rows.filter((l) => l.kind === 'internal' && !l.toId),
      breadcrumbs: breadcrumbs.rows,
      progress: progress.rows[0] ?? null,
    });
  }),
);

const createSchema = z.object({
  topicId: z.string().uuid(),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  title: z.string().min(1).max(300),
  summary: z.string().max(2000).nullish(),
  bodyMd: z.string().default(''),
  status: z.enum(['draft', 'review', 'published', 'archived']).default('draft'),
  sourceUrl: z.string().url().nullish(),
});

articlesRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const data = createSchema.parse(req.body);
    const { html, toc } = renderMarkdown(data.bodyMd);
    const row = await queryOne<{ id: string }>(
      `INSERT INTO articles
         (topic_id, slug, title, summary, body_md, body_html, toc, status, reading_minutes, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [data.topicId, data.slug, data.title, data.summary ?? null, data.bodyMd, html,
       JSON.stringify(toc), data.status, readingMinutes(data.bodyMd), data.sourceUrl ?? null],
    );
    res.status(201).json(row);
  }),
);

articlesRouter.put(
  '/:id',
  asyncRoute(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const current = await queryOne<{ id: string; title: string; body_md: string; version: number }>(
      'SELECT id, title, body_md, version FROM articles WHERE id = $1',
      [uuidParam(req, 'id')],
    );
    if (!current) throw notFound('Статья');

    const bodyMd = data.bodyMd ?? current.body_md;
    const title = data.title ?? current.title;
    const { html, toc } = renderMarkdown(bodyMd);

    const updated = await queryOne<{ id: string; version: number }>(
      `UPDATE articles
          SET title = $2, summary = COALESCE($3, summary), body_md = $4, body_html = $5, toc = $6,
              status = COALESCE($7, status), source_url = COALESCE($8, source_url),
              effective_from = $9, effective_to = $10,
              reading_minutes = $11, version = version + 1, updated_at = now()
        WHERE id = $1
        RETURNING id, version`,
      [uuidParam(req, 'id'), title, data.summary ?? null, bodyMd, html, JSON.stringify(toc),
       data.status ?? null, data.sourceUrl ?? null, data.effectiveFrom ?? null,
       data.effectiveTo ?? null, readingMinutes(bodyMd)],
    );

    await query(
      `INSERT INTO article_revisions (article_id, version, title, body_md, editor, note)
       VALUES ($1, $2, $3, $4, $5, 'правка через API')`,
      [current.id, updated!.version, title, bodyMd, data.editor ?? 'api'],
    );

    // Пересчёт внутренних ссылок из текста
    await query('DELETE FROM article_links WHERE from_id = $1 AND kind <> $2', [current.id, 'external']);
    for (const link of extractLinks(bodyMd)) {
      await query(
        `INSERT INTO article_links (from_id, kind, raw_target) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [current.id, link.kind, link.rawTarget],
      );
    }
    await query(
      `UPDATE article_links SET to_id = a.id
         FROM articles a
        WHERE article_links.from_id = $1
          AND article_links.kind = 'internal'
          AND a.slug = split_part(article_links.raw_target, '#', 1)
          AND a.id NOT IN (SELECT to_id FROM article_links WHERE from_id = $1 AND to_id IS NOT NULL)`,
      [current.id],
    );

    res.json(updated);
  }),
);

articlesRouter.get(
  '/:id/revisions',
  asyncRoute(async (req, res) => {
    const rows = await query(
      `SELECT id, version, title, editor, note, created_at AS "createdAt",
              length(body_md) AS bytes
         FROM article_revisions WHERE article_id = $1 ORDER BY version DESC`,
      [uuidParam(req, 'id')],
    );
    res.json({ revisions: rows.rows });
  }),
);

articlesRouter.get(
  '/:id/revisions/:version',
  asyncRoute(async (req, res) => {
    const row = await queryOne(
      'SELECT article_id AS "articleId", version, title, body_md AS "bodyMd", editor, created_at AS "createdAt" FROM article_revisions WHERE article_id = $1 AND version = $2',
      [uuidParam(req, 'id'), Number(param(req, 'version'))],
    );
    if (!row) throw badRequest(`Версия ${param(req, 'version')} не найдена`);
    res.json(row);
  }),
);

articlesRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const deleted = await query('DELETE FROM articles WHERE id = $1 RETURNING id', [uuidParam(req, 'id')]);
    if (deleted.rowCount === 0) throw notFound('Статья');
    res.status(204).end();
  }),
);
