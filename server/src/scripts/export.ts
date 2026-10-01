/**
 * Выгрузка всей базы в переносимый JSON + каталог файлов.
 * Формат совместим с `npm run import -- --json`, поэтому работает round-trip.
 *
 *   npm run export -- --out backup/2026-09-28
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../lib/db.js';
import { config } from '../lib/config.js';
import { readStored } from '../lib/storage.js';
import type { IngestArticle, IngestAsset, IngestTopic } from '../lib/ingest.js';

interface Args {
  out: string;
  includeDrafts: boolean;
  copyAssets: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = {
    out: path.resolve(config.storageDir, '..', `export-${new Date().toISOString().slice(0, 10)}`),
    includeDrafts: true,
    copyAssets: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out.out = path.resolve(argv[i + 1]!);
    else if (argv[i] === '--published-only') out.includeDrafts = false;
    else if (argv[i] === '--no-assets') out.copyAssets = false;
  }
  return out;
}

interface TopicRow {
  id: string;
  parent_id: string | null;
  slug: string;
  title: string;
  summary: string | null;
  source_url: string | null;
  sort_order: number;
}

interface ArticleRow {
  id: string;
  topic_id: string;
  slug: string;
  title: string;
  summary: string | null;
  body_md: string;
  status: string;
  source_url: string | null;
  effective_from: string | null;
  effective_to: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const statusFilter = args.includeDrafts ? null : 'published';

  console.log(`[export] Источник: ${config.databaseUrl}`);
  console.log(`[export] Назначение: ${args.out}`);

  const topicsRes = await pool.query<TopicRow>(
    `SELECT id, parent_id, slug, title, summary, source_url, sort_order
       FROM topics ORDER BY depth, sort_order, title`,
  );
  const articlesRes = await pool.query<ArticleRow>(
    `SELECT id, topic_id, slug, title, summary, body_md, status,
            source_url, effective_from, effective_to
       FROM articles
      WHERE ($1::article_status IS NULL OR status = $1::article_status)
      ORDER BY slug`,
    [statusFilter],
  );
  const assetsRes = await pool.query<{
    article_id: string;
    storage_key: string;
    filename: string;
    role: string;
    position: number;
    alt: string | null;
    caption: string | null;
    source_url: string | null;
  }>(
    `SELECT aa.article_id, s.storage_key, s.filename, aa.role, aa.position,
            s.alt, s.caption, s.source_url
       FROM article_assets aa JOIN assets s ON s.id = aa.asset_id
      WHERE ($1::article_status IS NULL OR EXISTS (
              SELECT 1 FROM articles a WHERE a.id = aa.article_id AND a.status = $1::article_status))
      ORDER BY aa.position`,
    [statusFilter],
  );

  const assetsByArticle = new Map<string, IngestAsset[]>();
  const exportedFiles = new Map<string, string>(); // storageKey -> относительный путь в экспорте
  const missingFiles: string[] = [];

  if (args.copyAssets) {
    const outAssets = path.join(args.out, 'assets');
    await fs.mkdir(outAssets, { recursive: true });
    for (const row of assetsRes.rows) {
      let rel = exportedFiles.get(row.storage_key);
      if (rel === undefined) {
        rel = `assets/${row.filename}`;
        try {
          const buf = await readStored(row.storage_key);
          await fs.writeFile(path.join(args.out, rel), buf);
        } catch {
          missingFiles.push(row.storage_key);
          continue;
        }
        exportedFiles.set(row.storage_key, rel);
      }
      const list = assetsByArticle.get(row.article_id) ?? [];
      list.push({
        file: rel,
        role: row.role as IngestAsset['role'],
        alt: row.alt ?? undefined,
        caption: row.caption ?? undefined,
        position: row.position,
        sourceUrl: row.source_url ?? undefined,
      });
      assetsByArticle.set(row.article_id, list);
    }
  }

  const articlesByTopic = new Map<string, IngestArticle[]>();
  for (const row of articlesRes.rows) {
    const bodyMd = rewriteImagePaths(row.body_md, (src) => resolveExported(src, row.id, exportedFiles));
    const article: IngestArticle = {
      slug: row.slug,
      title: row.title,
      summary: row.summary ?? undefined,
      bodyMd,
      status: row.status as IngestArticle['status'],
      sourceUrl: row.source_url ?? undefined,
      effectiveFrom: row.effective_from ?? undefined,
      effectiveTo: row.effective_to ?? undefined,
      assets: assetsByArticle.get(row.id),
    };
    const list = articlesByTopic.get(row.topic_id) ?? [];
    list.push(article);
    articlesByTopic.set(row.topic_id, list);
  }

  const nodes = new Map<string, IngestTopic>();
  for (const row of topicsRes.rows) {
    nodes.set(row.id, {
      slug: row.slug,
      title: row.title,
      summary: row.summary ?? undefined,
      sourceUrl: row.source_url ?? undefined,
      sortOrder: row.sort_order,
      children: [],
      article: articlesByTopic.get(row.id)?.[0],
    });
    const rest = articlesByTopic.get(row.id)?.slice(1) ?? [];
    for (const article of rest) {
      nodes.get(row.id)!.children!.push({ slug: article.slug, title: article.title, article });
    }
  }

  // Сборка снизу вверх
  const roots: IngestTopic[] = [];
  for (const row of topicsRes.rows) {
    const node = nodes.get(row.id)!;
    if (row.parent_id && nodes.has(row.parent_id)) {
      nodes.get(row.parent_id)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }

  const doc = {
    version: 1,
    exported_at: new Date().toISOString(),
    generator: 'baza-znaniy/export',
    topics: roots,
  };

  await fs.mkdir(args.out, { recursive: true });
  const jsonPath = path.join(args.out, 'baza.json');
  await fs.writeFile(jsonPath, JSON.stringify(doc, null, 2), 'utf8');

  const bytes = (await fs.stat(jsonPath)).size;
  console.log(`\n=== Готово ===`);
  console.log(`файл:  ${jsonPath} (${(bytes / 1024).toFixed(1)} КБ)`);
  console.log(`рубрик: ${topicsRes.rowCount}, статей: ${articlesRes.rowCount}, файлов: ${exportedFiles.size}`);
  if (missingFiles.length) {
    console.log(`\n!! Не удалось скопировать файлов: ${missingFiles.length}`);
    for (const m of missingFiles.slice(0, 10)) console.log(`   - ${m}`);
    console.log('   Проверьте: npm run validate');
  }
}

/** Заменяет src картинки на путь внутри экспорта (если файл выгружен). */
function rewriteImagePaths(md: string, map: (src: string) => string | null): string {
  return md.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?/g, (full, alt: string, src: string) => {
    const replaced = map(src);
    return replaced ? `![${alt}](${replaced})` : full;
  });
}

function resolveExported(
  src: string,
  articleId: string,
  exportedFiles: Map<string, string>,
): string | null {
  if (/^(https?:)?\/\//i.test(src)) return null;
  void articleId;
  // src вида assets/ab/cd/<sha>.png — уже совпадает с ключом хранилища
  const byKey = exportedFiles.get(src);
  if (byKey) return byKey;
  // src вида images/foo.png: ищем по имени файла
  for (const [key, rel] of exportedFiles) {
    if (key.endsWith(path.basename(src))) return rel;
  }
  return null;
}

main()
  .catch((err) => {
    console.error('[export] Ошибка:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
