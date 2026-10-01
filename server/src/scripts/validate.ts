/**
 * Контроль целостности: точка входа.
 *
 *   npm run validate                          # проверить БД + файлы
 *   npm run validate -- --source              # проверить только исходники (без БД)
 *   npm run validate -- --source --dir content
 *   npm run validate -- --json db/seeds/demo.json
 *   npm run validate -- --all                 # и исходники, и БД
 *   npm run validate -- --strict              # warnings тоже дают ненулевой код возврата
 */
import path from 'node:path';
import { pool } from '../lib/db.js';
import { config } from '../lib/config.js';
import { loadJsonSource, loadDirSource } from '../lib/source.js';
import { validateTree, validateDatabase, counts, type Issue, type Severity } from '../lib/validator.js';
import { ensureStorage } from '../lib/storage.js';

const C: Record<Severity, string> = {
  error: '\x1b[31mОШИБКА\x1b[0m',
  warning: '\x1b[33mВНИМАНИЕ\x1b[0m',
  info: '\x1b[36mИНФО\x1b[0m',
};

const SEVERITY_ORDER: Severity[] = ['error', 'warning', 'info'];

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = {
    source: false,
    db: false,
    all: false,
    strict: false,
    json: undefined as string | undefined,
    dir: undefined as string | undefined,
    noChecksums: false,
    limit: 40,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') out.source = true;
    else if (a === '--db') out.db = true;
    else if (a === '--all') out.all = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--no-checksums') out.noChecksums = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(fs_help());
      process.exit(0);
    }
  }
  if (!out.source && !out.db && !out.all && !out.json && !out.dir) {
    // По умолчанию проверяем БД, если исходник явно не указан
    out.db = true;
  }
  return out;
}

function fs_help(): string {
  return `
Проверка целостности данных

  --source          проверить исходники (каталог content или --json)
  --db              проверить базу данных и файлы на диске
  --all             проверить и то, и другое
  --dir <path>      каталог с Markdown (по умолчанию ${config.contentDir})
  --json <file>     JSON-документ вместо каталога
  --no-checksums    не сверять sha256 файлов (быстрее)
  --strict          ненулевой код возврата и при предупреждениях
  --limit <n>       сколько проблем показать по каждому коду (по умолчанию 40)
`;
}

function printIssues(title: string, issues: Issue[], limit: number): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);

  if (issues.length === 0) {
    console.log('\x1b[32m✓ Проблем не найдено\x1b[0m');
    return;
  }

  for (const severity of SEVERITY_ORDER) {
    const group = issues.filter((i) => i.severity === severity);
    if (group.length === 0) continue;

    console.log(`\n${C[severity]} — ${group.length} шт.`);

    const byCode = new Map<string, Issue[]>();
    for (const issue of group) {
      byCode.set(issue.code, [...(byCode.get(issue.code) ?? []), issue]);
    }

    for (const [code, list] of byCode) {
      console.log(`\n  [${code}] × ${list.length}`);
      for (const issue of list.slice(0, limit)) {
        console.log(`    • ${issue.where ? issue.where + ' — ' : ''}${issue.message}`);
        if (issue.hint) console.log(`      подсказка: ${issue.hint}`);
      }
      if (list.length > limit) console.log(`    … ещё ${list.length - limit}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  await ensureStorage();

  let hasErrors = false;
  let hasWarnings = false;

  /* --- исходники --------------------------------------------------------- */
  if (args.source || args.all || args.json || args.dir) {
    const baseDir = path.resolve(args.dir ?? config.contentDir);
    const tree = args.json ? await loadJsonSource(path.resolve(args.json)) : await loadDirSource(baseDir);
    const source = args.json ? path.resolve(args.json) : baseDir;

    const report = await validateTree(tree, { baseDir, maxDepth: 8, requireAlt: true });
    const c = counts(report);

    console.log(`\n\x1b[1mИсходники: ${source}\x1b[0m`);
    console.log(
      `рубрик ${report.stats.topics} · статей ${report.stats.articles} · слов ${report.stats.words} · ` +
        `картинок ${report.stats.images} · заголовков ${report.stats.headings} · ${report.durationMs} мс`,
    );

    printIssues('Отчёт по исходникам', report.issues, args.limit);
    if (c.error) hasErrors = true;
    if (c.warning) hasWarnings = true;
  }

  /* --- база данных ------------------------------------------------------- */
  if (args.db || args.all) {
    const dbReport = await validateDatabase({ verifyChecksums: !args.noChecksums, requireAlt: true });
    const c = counts(dbReport);

    console.log(`\n\x1b[1mБаза данных: ${config.databaseUrl}\x1b[0m`);
    console.log(
      `рубрик ${dbReport.stats.topics} · статей ${dbReport.stats.articles} · слов ${dbReport.stats.words} · ` +
        `файлов ${dbReport.stats.assets} · ссылок ${dbReport.stats.links} · битых ${dbReport.stats.broken_links} · ` +
        `${dbReport.durationMs} мс`,
    );

    printIssues('Отчёт по базе данных', dbReport.issues, args.limit);
    if (c.error) hasErrors = true;
    if (c.warning) hasWarnings = true;
  }

  console.log('');
  if (hasErrors) {
    console.log('\x1b[31m✗ Есть ошибки — исправьте их перед публикацией.\x1b[0m');
    process.exitCode = 1;
  } else if (hasWarnings && args.strict) {
    console.log('\x1b[33m△ Только предупреждения (--strict).\x1b[0m');
    process.exitCode = 1;
  } else {
    console.log('\x1b[32m✓ Проверка пройдена.\x1b[0m');
  }
}

main()
  .catch((err) => {
    console.error('[validate] Ошибка:', err instanceof Error ? err.message : err);
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'ECONNREFUSED') {
      console.error('PostgreSQL недоступен. Запустите: npm run db:up  (или проверьте только исходники: npm run validate -- --source)');
    }
    process.exitCode = 1;
  })
  .finally(() => pool.end());
