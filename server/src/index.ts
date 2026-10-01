import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, isProd } from './lib/config.js';
import { pool } from './lib/db.js';
import { errorHandler } from './lib/http.js';
import { ensureStorage } from './lib/storage.js';
import { topicsRouter } from './routes/topics.js';
import { articlesRouter } from './routes/articles.js';
import { searchRouter } from './routes/search.js';
import { assetsRouter } from './routes/assets.js';
import { progressRouter } from './routes/progress.js';

export function createApp(): express.Express {
  const app = express();

  app.use(cors({ origin: isProd ? false : true, credentials: true }));
  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, db: 'up', env: config.nodeEnv });
    } catch (err) {
      res.status(503).json({ ok: false, db: 'down', error: (err as Error).message });
    }
  });

  app.get('/api/stats', async (_req, res) => {
    const [t, a, m, l] = await Promise.all([
      pool.query<{ n: number }>('SELECT count(*)::int AS n FROM topics'),
      pool.query<{ n: number; words: number }>(
        `SELECT count(*)::int AS n, COALESCE(sum(array_length(regexp_split_to_array(body_md, '\\s+'), 1)), 0)::int AS words FROM articles`,
      ),
      pool.query<{ n: number }>('SELECT count(*)::int AS n FROM assets'),
      pool.query<{ n: number }>('SELECT count(*)::int AS n FROM article_links WHERE kind = $1 AND to_id IS NULL', ['internal']),
    ]);
    res.json({
      topics: t.rows[0]?.n ?? 0,
      articles: a.rows[0]?.n ?? 0,
      words: a.rows[0]?.words ?? 0,
      assets: m.rows[0]?.n ?? 0,
      brokenLinks: l.rows[0]?.n ?? 0,
    });
  });

  app.use('/api/topics', topicsRouter);
  app.use('/api/articles', articlesRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/assets', assetsRouter);
  app.use('/api/progress', progressRouter);

  if (isProd) {
    const webDist = path.resolve(config.storageDir, '..', 'web', 'dist');
    app.use(express.static(webDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Неизвестный метод API' }));
  app.use(errorHandler);

  return app;
}

// Сравниваем через fileURLToPath: в import.meta.url кириллица в пути
// percent-экранирована, а path.resolve() её не кодирует. Без этого
// isMain всегда ложно и сервер не слушает порт.
const isMain = Boolean(
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]),
);

if (isMain) {
  await ensureStorage();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[api] http://localhost:${config.port}  (${config.nodeEnv})`);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n[api] ${signal}, останавливаюсь…`);
      void pool.end().then(() => process.exit(0));
    });
  }
}
