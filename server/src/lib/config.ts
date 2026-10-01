import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Корень монорепо: server/src/lib -> ../../.. */
export const ROOT = path.resolve(here, '..', '..', '..');

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: envInt('PORT', 4000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://baza:baza@localhost:5432/baza',
  storageDir: path.resolve(ROOT, process.env.STORAGE_DIR ?? 'storage'),
  contentDir: path.resolve(ROOT, process.env.CONTENT_DIR ?? 'content'),
  schemaPath: path.resolve(ROOT, 'db', 'schema.sql'),
  ftsLanguage: process.env.FTS_LANGUAGE ?? 'russian',
  maxUploadBytes: envInt('MAX_UPLOAD_BYTES', 25 * 1024 * 1024),
} as const;

export const isProd = config.nodeEnv === 'production';
