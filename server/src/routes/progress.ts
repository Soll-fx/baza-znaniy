import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../lib/db.js';
import { asyncRoute, notFound, param } from '../lib/http.js';

export const progressRouter: Router = Router();

/** Интервалы повторения в днях по уровню уверенности 0..5 */
const INTERVAL_DAYS = [0, 1, 2, 4, 9, 21];

const reviewSchema = z.object({
  user: z.string().max(64).default('local'),
  correct: z.boolean(),
  delta: z.number().int().min(-5).max(5).optional(),
});

/** Очередь на повторение. */
progressRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const user = String(req.query.user ?? 'local');
    const due = req.query.due === '1';
    const limit = Math.min(Number(req.query.limit ?? 20), 200);

    const rows = await query(
      `SELECT a.id, a.slug, a.title, a.summary, a.reading_minutes AS "readingMinutes",
              t.path AS "topicPath", t.title AS "topicTitle",
              p.status, p.confidence, p.reps, p.next_review_at AS "nextReviewAt"
         FROM study_progress p
         JOIN articles a ON a.id = p.article_id
         JOIN topics t ON t.id = a.topic_id
        WHERE p.user_id = $1
          AND ($2::bool IS NOT TRUE OR p.next_review_at <= now())
        ORDER BY p.next_review_at
        LIMIT $3`,
      [user, due, limit],
    );

    const stats = await queryOne<{ total: number; known: number; learning: number; due: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'known')::int    AS known,
              count(*) FILTER (WHERE status = 'learning')::int AS learning,
              count(*) FILTER (WHERE next_review_at <= now())::int AS due
         FROM study_progress WHERE user_id = $1`,
      [user],
    );

    res.json({ queue: rows.rows, stats });
  }),
);

/** Отметка результата повторения: пересчёт уверенности и следующей даты. */
progressRouter.post(
  '/:articleId',
  asyncRoute(async (req, res) => {
    const body = reviewSchema.parse(req.body);

    const current = await queryOne<{ confidence: number; reps: number; status: string }>(
      'SELECT confidence, reps, status FROM study_progress WHERE user_id = $1 AND article_id = $2',
      [body.user, param(req, 'articleId')],
    );
    if (!current) throw notFound('Запись прогресса');

    const confidence = body.correct
      ? Math.min(5, current.confidence + (body.delta ?? 1))
      : 0;
    const days = body.correct ? (INTERVAL_DAYS[confidence] ?? 21) : 1;
    const status = confidence >= 4 ? 'known' : confidence === 0 ? 'relearning' : 'learning';

    const updated = await queryOne(
      `UPDATE study_progress
          SET confidence = $3, reps = reps + 1, status = $4,
              last_seen_at = now(), next_review_at = now() + ($5 || ' days')::interval
        WHERE user_id = $1 AND article_id = $2
        RETURNING article_id AS "articleId", status, confidence, reps, next_review_at AS "nextReviewAt"`,
      [body.user, param(req, 'articleId'), confidence, status, String(days)],
    );

    res.json(updated);
  }),
);

progressRouter.put(
  '/:articleId',
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        user: z.string().max(64).default('local'),
        status: z.enum(['new', 'learning', 'known', 'relearning']),
        confidence: z.number().int().min(0).max(5).optional(),
      })
      .parse(req.body);

    const row = await queryOne(
      `INSERT INTO study_progress (user_id, article_id, status, confidence, reps, last_seen_at)
       VALUES ($1, $2, $3, $4, 0, now())
       ON CONFLICT (user_id, article_id) DO UPDATE
         SET status = EXCLUDED.status, confidence = COALESCE(EXCLUDED.confidence, study_progress.confidence)
       RETURNING article_id AS "articleId", status, confidence,
                 reps, next_review_at AS "nextReviewAt"`,
      [body.user, param(req, 'articleId'), body.status, body.confidence ?? null],
    );
    res.json(row);
  }),
);
