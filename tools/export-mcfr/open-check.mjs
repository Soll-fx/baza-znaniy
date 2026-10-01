/**
 * Разовая ручная проверка: открыть ссылку из письма целиком (с UTM) в
 * обычном окне Chrome и НЕ закрывать его, чтобы можно было посмотреть
 * глазами. Диагностика пишется в open-check.json.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const URL_FULL =
  'https://id.mcfr.uz/fl/uni/59eeddc0-ebdc-4ac6-a8a0-26208970a6e4?utm_campaign=service_DemoUser&utm_medium=letter&utm_source=letter_crm';

const context = await chromium.launchPersistentContext(path.join(HERE, 'profile'), {
  channel: 'chrome',
  headless: false,
  viewport: null,
  acceptDownloads: true,
  locale: 'ru-RU',
});

const page = context.pages()[0] ?? (await context.newPage());

console.log('Открываю ссылку из письма целиком, с UTM-метками:');
console.log(URL_FULL);
console.log('\nОкно Chrome оставлено открытым — посмотрите его сами.');

await page.goto(URL_FULL, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch((e) => {
  console.log('переход:', e.message.split('\n')[0]);
});
await page.waitForTimeout(6000);

const info = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  articleLinks: document.querySelectorAll('a[href*="/fl/uni/"]').length,
  loginButtons: [...document.querySelectorAll('button, a')]
    .filter((e) => /вход|регистрац|войти|login/i.test(e.textContent || ''))
    .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40))
    .slice(0, 5),
  headings: [...document.querySelectorAll('h1, h2, h3')]
    .map((e) => e.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 12),
  totalLinks: document.querySelectorAll('a[href]').length,
  hasSidebar: !!document.querySelector('aside, nav, [class*="side"], [class*="menu"], [class*="tree"]'),
}));

const cookies = await context.cookies();
const out = {
  requestedUrl: URL_FULL,
  landedUrl: info.url,
  title: info.title,
  articleLinks: info.articleLinks,
  totalLinks: info.totalLinks,
  hasSidebar: info.hasSidebar,
  loginButtons: info.loginButtons,
  headings: info.headings,
  cookieNames: cookies.map((c) => c.name),
  cookiesWithValue: cookies.filter((c) => c.value).length,
};
await fs.writeFile(path.join(HERE, 'open-check.json'), JSON.stringify(out, null, 2), 'utf8');

console.log('\nКуда приземлились :', info.url);
console.log('Заголовок         :', info.title);
console.log('Ссылок на разделы :', info.articleLinks, '(всего ссылок:', info.totalLinks + ')');
console.log('Сайдбар           :', info.hasSidebar ? 'есть' : 'нет');
console.log('Кнопки входа      :', JSON.stringify(info.loginButtons));
console.log('Заголовки         :', JSON.stringify(info.headings.slice(0, 6)));
console.log('\nДиагностика: open-check.json');

process.on('SIGINT', async () => {
  await context.close();
  process.exit(0);
});

/* Держим окно живым, пока пользователь смотрит. */
console.log('\nЗакройте окно Chrome, когда закончите смотреть, или нажмите Ctrl+C.');
await new Promise(() => {});
