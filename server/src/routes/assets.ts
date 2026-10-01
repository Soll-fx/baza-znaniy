import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query, queryOne } from '../lib/db.js';
import { asyncRoute, notFound, badRequest, param, uuidParam } from '../lib/http.js';
import { config } from '../lib/config.js';
import { saveBuffer, sha256, imageSize, kindFor, mimeFor, streamStored, fileExists } from '../lib/storage.js';

export const assetsRouter: Router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

/** Отдача файла с ETag по контрольной сумме — браузер кэширует картинки. */
assetsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const asset = await queryOne<{
      id: string; storage_key: string; mime: string; checksum: string;
      bytes: number; filename: string; alt: string | null;
    }>('SELECT id, storage_key, mime, checksum, bytes, filename, alt FROM assets WHERE id = $1', [uuidParam(req, 'id')]);

    if (!asset) throw notFound('Файл');

    const etag = `"${asset.checksum}"`;
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    if (!(await fileExists(asset.storage_key))) {
      throw notFound(`Файл ${asset.filename} (отсутствует на диске)`);
    }

    res.setHeader('Content-Type', asset.mime);
    res.setHeader('Content-Length', String(asset.bytes));
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Документы отдаём как вложение с исходным именем файла, а не открываем в браузере
    if (asset.mime !== 'image/svg+xml' && !asset.mime.startsWith('image/')) {
      const safe = asset.filename.replace(/[^\w.@+-]+/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    }

    // Файл уходит потоком: в базе лежат .doc и картинки, чтение целиком
    // в память на бесплатном хостинге с ограниченным heap недопустимо.
    const stream = streamStored(asset.storage_key);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ error: 'Файл недоступен' });
      else res.destroy();
    });
    stream.pipe(res);
  }),
);

const uploadSchema = z.object({
  articleId: z.string().uuid().optional(),
  role: z.enum(['cover', 'inline', 'attachment', 'diagram']).default('inline'),
  alt: z.string().max(500).optional(),
  caption: z.string().max(1000).optional(),
  position: z.coerce.number().int().optional(),
  sourceUrl: z.string().url().optional(),
});

assetsRouter.post(
  '/',
  upload.single('file'),
  asyncRoute(async (req, res) => {
    if (!req.file) throw badRequest('Файл обязателен (поле «file»)');
    const meta = uploadSchema.parse(req.body);

    const stored = await saveBuffer(req.file.buffer, req.file.originalname);
    const dims = await imageSize(req.file.buffer);
    const checksum = sha256(req.file.buffer);

    const asset = await queryOne<{ id: string }>(
      `INSERT INTO assets (kind, filename, storage_key, mime, bytes, checksum, width, height, alt, caption, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (storage_key) DO UPDATE
         SET alt = COALESCE(EXCLUDED.alt, assets.alt),
             caption = COALESCE(EXCLUDED.caption, assets.caption)
       RETURNING id`,
      [
        kindFor(mimeFor(req.file.originalname)),
        req.file.originalname,
        stored.storageKey,
        stored.mime,
        stored.bytes,
        checksum,
        dims?.width ?? null,
        dims?.height ?? null,
        meta.alt ?? null,
        meta.caption ?? null,
        meta.sourceUrl ?? null,
      ],
    );

    if (meta.articleId && asset) {
      await query(
        `INSERT INTO article_assets (article_id, asset_id, role, position)
         VALUES ($1, $2, $3, COALESCE($4, 0))
         ON CONFLICT (article_id, asset_id, role) DO UPDATE SET position = EXCLUDED.position`,
        [meta.articleId, asset.id, meta.role, meta.position ?? null],
      );
    }

    res.status(201).json({
      id: asset!.id,
      url: `/api/assets/${asset!.id}`,
      storageKey: stored.storageKey,
      checksum,
      bytes: stored.bytes,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
    });
  }),
);

/** Медиа без ссылок на статьи — кандидаты на «осиротевшие». */
assetsRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    const rows = await query(
      `SELECT s.id, s.filename, s.kind, s.bytes, s.alt,
              (SELECT count(*) FROM article_assets aa WHERE aa.asset_id = s.id)::int AS uses
         FROM assets s ORDER BY uses, s.created_at DESC`,
    );
    res.json({ assets: rows.rows });
  }),
);
