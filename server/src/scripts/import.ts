/**
 * Импорт из JSON-файла или каталога Markdown в PostgreSQL.
 *
 *   npm run import -- --json db/seeds/demo.json
 *   npm run import -- --dir content --conflict upsert
 *   npm run import -- --dir content --dry-run
 */
import fsSync from 'node:fs';
import path from 'node:path';
import { pool, withTransaction } from '../lib/db.js';
import { config } from '../lib/config.js';
import { ingestTree, type IngestTopic } from '../lib/ingest.js';
import { loadJsonSource, loadDirSource } from '../lib/source.js';
import { ensureStorage } from '../lib/storage.js';
import { slugify } from '../lib/slug.js';

interface Args {
  json?: string;
  dir?: string;
  conflict: 'upsert' | 'skip' | 'error';
  dryRun: boolean;
  reset: boolean;
  baseDir?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { conflict: 'upsert', dryRun: false, reset: false };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i + 1];
    if (a === '--json') out.json = next();
    else if (a === '--dir') out.dir = next();
    else if (a === '--base-dir') out.baseDir = next();
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--reset') out.reset = true;
    else if (a === '--conflict') out.conflict = next() as Args['conflict'];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`
Импорт контента в базу знаний

  --json <file>     JSON-документ { version, topics[] }
  --dir <path>      каталог с Markdown (по умолчанию ${config.contentDir})
  --base-dir <path> база для относительных путей к файлам (по умолчанию корень проекта)
  --conflict <mode> upsert | skip | error   (по умолчанию upsert)
  --reset           очистить рубрики/статьи/файлы перед загрузкой
  --dry-run         прочитать и проверить, не записывая в БД
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Каталог по умолчанию — contentDir, поэтому требовать --dir не нужно:
  // без источника импортировать нечего, но это ошибка вызова, а не справка.
  if (!args.json && !args.dir && !fsSync.existsSync(config.contentDir)) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  await ensureStorage();

  const baseDir = path.resolve(args.baseDir ?? args.dir ?? config.contentDir);
  let tree: IngestTopic[];

  if (args.json) {
    const file = path.resolve(args.json);
    tree = await loadJsonSource(file);
    console.log(`[import] Источник: ${file}`);
  } else {
    const dir = path.resolve(args.dir ?? config.contentDir);
    tree = await loadDirSource(dir);
    console.log(`[import] Источник: ${dir}`);
  }

  // Считаем статистику до записи, чтобы показать, что именно приедет
  const stats = summarize(tree);
  console.log(`[import] В дереве: рубрик ${stats.topics}, статей ${stats.articles}, медиа ${stats.assets}`);

  const problems = preflight(tree);
  if (problems.length) {
    console.log(`\n!! Замечания к структуре (${problems.length}):`);
    for (const p of problems.slice(0, 20)) console.log(`   - ${p}`);
    if (args.conflict === 'error') {
      throw new Error('Импорт остановлен: --conflict error');
    }
  }

  if (args.dryRun) {
    console.log('\n[import] --dry-run: подключение к БД не выполняется');
    console.log(`[import] Корневые рубрики: ${tree.map((t) => t.slug).join(', ') || '—'}`);
    return;
  }

  const report = await withTransaction(async (client) => {
    if (args.reset) {
      // Импорт только добавляет записи: если в каталоге материал переехал в
      // другой раздел, старая копия осталась бы в базе навсегда. Содержимое
      // целиком собирается из этого каталога, поэтому чистим содержимое БД.
      await client.query('TRUNCATE article_links, article_assets, article_revisions, articles, topics, assets CASCADE');
      console.log('[import] --reset: содержимое базы очищено');
    }
    return ingestTree(client, tree, { baseDir, conflict: args.conflict });
  });

  console.log('\n=== Отчёт импорта ===');
  console.log(`рубрики:  +${report.topicsCreated} новых, ~${report.topicsUpdated} обновлено`);
  console.log(`статьи:   +${report.articlesCreated} новых, ~${report.articlesUpdated} обновлено`);
  console.log(`медиа:    +${report.assetsNew} файлов, ${report.assetsLinked} привязок`);
  console.log(`время:    ${report.durationMs} мс`);

  if (report.missingFiles.length) {
    console.log(`\n!! Не найдено файлов (${report.missingFiles.length}):`);
    for (const f of report.missingFiles.slice(0, 20)) console.log(`   - ${f}`);
  }
  if (report.brokenLinks.length) {
    console.log(`\n!! Битые внутренние ссылки (${report.brokenLinks.length}):`);
    for (const l of report.brokenLinks.slice(0, 20)) console.log(`   - ${l.article} -> [[${l.target}]]`);
    console.log('   Исправить: создать целевую статью или исправить цель в тексте.');
  }
  if (report.warnings.length) {
    console.log(`\n.. Предупреждения (${report.warnings.length}):`);
    for (const w of report.warnings.slice(0, 20)) console.log(`   - ${w}`);
  }

  const fatal = report.missingFiles.length + report.brokenLinks.length;
  console.log(fatal ? `\n[import] Завершено с замечаниями (${fatal})` : '\n[import] Завершено без замечаний');
}

interface TreeStats {
  topics: number;
  articles: number;
  assets: number;
}

export function summarize(nodes: IngestTopic[], acc: TreeStats = { topics: 0, articles: 0, assets: 0 }): TreeStats {
  for (const node of nodes) {
    acc.topics += 1;
    if (node.article) {
      acc.articles += 1;
      acc.assets += node.article.assets?.length ?? 0;
    }
    if (node.children?.length) summarize(node.children, acc);
  }
  return acc;
}

/** Проверка структуры до записи: дубликаты путей, пустые заголовки, битые слаги. */
export function preflight(nodes: IngestTopic[], trail: string[] = [], seen = new Set<string>()): string[] {
  const problems: string[] = [];

  for (const node of nodes) {
    const slug = node.slug || slugify(node.title);
    const p = [...trail, slug].join('/');
    if (seen.has(p)) problems.push(`дубликат пути рубрики: ${p}`);
    seen.add(p);

    if (!node.title?.trim()) problems.push(`пустой заголовок рубрики: ${p}`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) problems.push(`некорректный slug рубрики: «${slug}» (${p})`);

    if (node.article) {
      if (!node.article.title?.trim()) problems.push(`пустой заголовок статьи в ${p}`);
      if (!node.article.bodyMd?.trim()) problems.push(`пустое тело статьи «${node.article.title}»`);
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(node.article.slug)) {
        problems.push(`некорректный slug статьи: «${node.article.slug}»`);
      }
    }
    if (!node.article && !node.children?.length) {
      problems.push(`пустая рубрика без статей: ${p}`);
    }
    if (node.children?.length) preflight(node.children, [...trail, slug], seen);
  }
  return problems;
}

await ensureStorage();

main()
  .catch((err) => {
    console.error('[import] Ошибка:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
