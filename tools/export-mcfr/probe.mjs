/**
 * Шаг 2. Разведка страницы под вашей сессией.
 *
 *   node probe.mjs [url]
 *
 * Ничего не скачивает. Задача — выяснить, как устроено дерево разделов и
 * что именно отдаёт кнопка «Скачать», чтобы выгрузщик писался по фактам,
 * а не по догадкам.
 *
 * Разбор страницы живёт в analyze.mjs — он же используется cdp-probe.mjs
 * для вашего основного Chrome, чтобы выводы совпадали.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { analyzePage, formatSummary } from './analyze.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* --profile <dir> — использовать другой каталог профиля Chrome. */
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const PROFILE = path.resolve(argOf('--profile') ?? path.join(HERE, 'profile'));
const OUT = path.join(HERE, 'probe');
const START_URL =
  argOf('--url') ??
  process.env.KB_URL ??
  'https://id.mcfr.uz/fl/uni/59eeddc0-ebdc-4ac6-a8a0-26208970a6e4';

const HEADED = process.argv.includes('--headed');
const log = (...m) => console.log(...m);

await fs.mkdir(OUT, { recursive: true });

log(`Профиль: ${PROFILE}`);
if (PROFILE !== path.join(HERE, 'profile')) {
  log('  (взят из аргумента --profile, куки скопированы с вашего основного Chrome)');
}


const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: !HEADED,
  acceptDownloads: true,
  locale: 'ru-RU',
  viewport: HEADED ? null : { width: 1600, height: 1000 },
});

const page = context.pages()[0] ?? (await context.newPage());

log(`Открываю ${START_URL} …`);
await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });

/* Приложение на Next.js: ждём, пока отрендерится хоть что-то. */
await page
  .waitForFunction(() => document.querySelectorAll('a[href], button, [role="button"]').length > 15, { timeout: 30_000 })
  .catch(() => log('  …первичная отрисовка не дождалась, продолжаю как есть'));
await page.waitForTimeout(2500);

if (/AuthGate|OutdatedLink|login|signin|войти/i.test(page.url())) {
  log('\n⚠️  Сессия не подхватилась: страница ушла на экран авторизации.');
  log(`   Фактический URL: ${page.url()}`);
  log('   Запустите заново: npm run session');
  await context.close();
  process.exit(2);
}

const report = await analyzePage(page, { log });

await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
await fs.writeFile(path.join(OUT, 'page.html'), await page.content(), 'utf8');

const summary = formatSummary(report, [
  '',
  `Полный отчёт: ${path.join(OUT, 'report.json')}`,
  `Разметка:     ${path.join(OUT, 'page.html')}`,
]);

await fs.writeFile(path.join(OUT, 'summary.txt'), summary, 'utf8');

console.log('\n' + '─'.repeat(64));
console.log(summary);
console.log('─'.repeat(64));
console.log('\nСкопируйте блок выше (между линиями) в чат — этого хватит, чтобы я дописал выгрузщик.');

await context.close();
