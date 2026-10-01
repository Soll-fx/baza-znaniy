/**
 * Наполнение демо-контентом: `npm run db:seed`
 * По умолчанию берёт каталог content — он и есть рабочий каталог проекта.
 */
import path from 'node:path';
import { pool, withTransaction } from '../lib/db.js';
import { config } from '../lib/config.js';
import { loadDirSource } from '../lib/source.js';
import { ingestTree } from '../lib/ingest.js';
import { ensureStorage } from '../lib/storage.js';

const SEED_DIR = process.env.SEED_DIR ?? config.contentDir;

async function main(): Promise<void> {
  await ensureStorage();
  const dir = path.resolve(SEED_DIR);
  console.log(`[seed] Каталог: ${dir}`);

  const tree = await loadDirSource(dir);
  if (tree.length === 0) {
    console.log('[seed] Нечего импортировать: каталог пуст');
    return;
  }

  const report = await withTransaction((client) =>
    ingestTree(client, tree, { baseDir: dir, conflict: 'upsert' }),
  );

  console.log(`[seed] Рубрик: +${report.topicsCreated} / ~${report.topicsUpdated}`);
  console.log(`[seed] Статей:  +${report.articlesCreated} / ~${report.articlesUpdated}`);
  console.log(`[seed] Медиа:   +${report.assetsNew}`);

  if (report.brokenLinks.length) {
    console.warn(`[seed] Битых ссылок: ${report.brokenLinks.length}`);
  }
  console.log('[seed] Готово. Проверка: npm run validate');
}

main()
  .catch((err) => {
    console.error('[seed] Ошибка:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
