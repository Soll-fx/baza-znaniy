import { Router } from 'express';
import { query } from '../lib/db.js';
import { asyncRoute, badRequest } from '../lib/http.js';
import { config } from '../lib/config.js';

export const searchRouter: Router = Router();

const LANG = /^(russian|english|simple)$/i.test(config.ftsLanguage)
  ? config.ftsLanguage
  : 'russian';

/**
 * Полнотекстовый поиск + нечёткий фоллбэк по триграммам.
 * Ранжирование: ts_rank_cd (tsvector) → similarity (trigram) → позиция в заголовке.
 */
searchRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const raw = String(req.query.q ?? '').trim();
    if (raw.length < 2) {
      res.json({ query: raw, results: [], tookMs: 0 });
      return;
    }
    // websearch_to_tsquery падает на незакрытых кавычках
    const cleaned = raw.replace(/"/g, ' ').slice(0, 200);
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const topicPath = req.query.path ? String(req.query.path).split('/').filter(Boolean) : null;
    const status = req.query.status ? String(req.query.status) : 'published';

    const started = Date.now();
    const rows = await query(
      `WITH q AS (
         SELECT websearch_to_tsquery($1::regconfig, $2) AS tsq
       )
       SELECT a.id,
              a.topic_id AS "topicId",
              a.slug,
              a.title,
              a.summary,
              a.reading_minutes AS "readingMinutes",
              a.status,
              t.path AS "topicPath",
              t.title AS "topicTitle",
              ts_headline($1::regconfig, a.body_md, q.tsq,
                  'MaxWords=28, MinWords=12, StartSel=<mark>, StopSel=</mark>, MaxFragments=2') AS excerpt,
              GREATEST(
                ts_rank_cd(a.tsv, q.tsq, 32) * 2,
                similarity(a.title, $2) * 0.6,
                CASE WHEN a.title ILIKE $2 || '%' THEN 0.5 ELSE 0 END,
                CASE WHEN a.title ILIKE '%' || $2 || '%' THEN 0.2 ELSE 0 END
              ) AS score
         FROM articles a
         JOIN topics t ON t.id = a.topic_id
         CROSS JOIN q
        WHERE ($4::text IS NULL OR a.status = $4::article_status)
          AND a.tsv @@ q.tsq
        ORDER BY score DESC, a.updated_at DESC
        LIMIT $3`,
      [LANG, cleaned, limit, status === 'all' ? null : status],
    );

    // Фоллбэк: если полнотекст ничего не дал (опечатка, другой словоформ) — триграммы
    let results = rows.rows;
    if (results.length === 0) {
      const fuzzy = await query(
        `SELECT a.id, a.topic_id AS "topicId", a.slug, a.title, a.summary,
                a.reading_minutes AS "readingMinutes", a.status,
                t.path AS "topicPath", t.title AS "topicTitle",
                left(a.summary, 200) AS excerpt,
                similarity(a.title, $1) AS score
           FROM articles a JOIN topics t ON t.id = a.topic_id
          WHERE ($2::text IS NULL OR a.status = $2::article_status)
            AND (similarity(a.title, $1) > 0.25
                 OR a.title % $1
                 OR a.summary ILIKE '%' || $1 || '%')
          ORDER BY score DESC LIMIT $3`,
        [cleaned, status === 'all' ? null : status, limit],
      );
      results = fuzzy.rows.map((r) => ({ ...r, score: Number(r.score) * 0.5 }));
    }

    let filtered = results;
    if (topicPath && topicPath.length) {
      filtered = results.filter((r) => {
        const p = Array.isArray(r.topicPath) ? r.topicPath : [];
        return topicPath.every((seg, i) => p[i] === seg);
      });
    }

    res.json({ query: cleaned, results: filtered, tookMs: Date.now() - started });
  }),
);

searchRouter.get(
  '/suggest',
  asyncRoute(async (req, res) => {
    const q = String(req.query.q ?? '').trim().replace(/"/g, ' ');
    if (q.length < 2) {
      res.json({ suggestions: [] });
      return;
    }
    if (q.length > 100) throw badRequest('Слишком длинный запрос');
    const rows = await query(
      `SELECT DISTINCT t.id, t.slug, t.title, t.path, t.depth
         FROM topics t
        WHERE t.is_published
          AND (t.title ILIKE '%' || $1 || '%' OR t.slug ILIKE '%' || $1 || '%')
        ORDER BY t.depth, similarity(t.title, $1) DESC
        LIMIT 8`,
      [q],
    );
    res.json({ suggestions: rows.rows });
  }),
);
