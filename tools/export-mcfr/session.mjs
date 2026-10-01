/**
 * Шаг 1. Один раз логинитесь руками, дальше сессия переиспользуется.
 *
 *   node tools/export-mcfr/session.mjs
 *
 * Открывается отдельный профиль Chrome. Войдите в Систему Главбух и
 * дождитесь дерева разделов — скрипт сам заметит куки сессии и закроет
 * окно. Нажимать Enter не нужно: он лишь ускоряет, если хочется.
 *
 * Скрипт не знает и не хранит ваш пароль — только куки сессии.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const PROFILE = path.resolve(argOf('--profile') ?? path.join(HERE, 'profile'));
const START_URL =
  argOf('--url') ??
  process.env.KB_URL ??
  'https://id.mcfr.uz/fl/uni/59eeddc0-ebdc-4ac6-a8a0-26208970a6e4';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

// channel: 'chrome' — используем уже установленный Chrome, ничего не качаем
const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: false,
  viewport: null,
  acceptDownloads: true,
  locale: 'ru-RU',
});

const hadProfile = await exists(PROFILE);

/*
 * Признак входа — куки, а не сам факт существования папки: каталог может
 * остаться пустым после неудачного запуска, и тогда молча пропустить
 * ожидание входа нельзя.
 */
const authCookie = async () => {
  const cookies = await context.cookies();
  const looksAuthed = cookies.some(
    (c) => c.value && c.value.length > 8 && /auth|session|sid|token|jwt|csrf|user/i.test(c.name),
  );
  return { cookies, looksAuthed };
};

/*
 * Одних кук мало: на публичном лендинге их тоже около 40, и по именам они
 * попадают под шаблон. Поэтому вход подтверждаем только вместе с признаком
 * того, что мы внутри приложения: маршрут /fl/ или ссылки на разделы.
 * 1gb.uz — витрина, id.mcfr.uz — само приложение.
 */
const pageLooksInside = async () => {
  try {
    return await page.evaluate(() => {
      if (/\/fl\//.test(location.pathname)) return true;
      if (document.querySelectorAll('a[href*="/fl/uni/"]').length > 0) return true;
      return /(^|\.)id\.mcfr\.uz$/.test(location.hostname);
    });
  } catch {
    return false;
  }
};

const authed = async () => {
  const { cookies, looksAuthed } = await authCookie();
  if (!looksAuthed) return { cookies, looksAuthed: false, inside: false };
  const inside = await pageLooksInside();
  return { cookies, looksAuthed: inside, inside };
};

/*
 * Ждём входа, опрашивая куки, а не читая терминал.
 *
 * Раньше здесь стояло ожидание Enter, и скрипт падал с EIO, когда поток
 * ввода отваливался (закрытая вкладка терминала, запуск не из интерактивной
 * сессии). Теперь Enter только необязательное ускорение, а обрыв stdin
 * ничего не ломает.
 */
const armEnterShortcut = () => {
  let pressed = false;
  try {
    if (!process.stdin.isTTY) return () => pressed;
    process.stdin.resume();
    process.stdin.on('data', () => {
      pressed = true;
    });
    // Отвалившийся поток ввода — не повод падать.
    process.stdin.on('error', () => {});
  } catch {
    /* терминала нет — опросим куки */
  }
  return () => pressed;
};

const enterPressed = armEnterShortcut();

const waitForLogin = async () => {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let last = { cookies: [], looksAuthed: false, inside: false };
  for (;;) {
    try {
      last = await authed();
    } catch (e) {
      /* Пользователь закрыл окно Chrome — это не ошибка, а отмена. */
      return { ...last, closed: true, error: e.message };
    }
    if (last.looksAuthed) return last;
    if (enterPressed()) return last;
    if (Date.now() > deadline) return { ...last, timedOut: true };
    await new Promise((r) => setTimeout(r, 2000));
  }
};

let { cookies, looksAuthed, timedOut, inside, closed } = {
  cookies: [],
  looksAuthed: false,
  inside: false,
};

/* Сначала открываем сайт: без этого в окне будет пустая страница. */
const page = context.pages()[0] ?? (await context.newPage());
console.log('Открываю сайт в отдельном окне Chrome…');
await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
await page.waitForTimeout(3000);
console.log(`  страница: ${await page.title()}`);

if (!looksAuthed) {
  console.log(hadProfile ? 'Профиль есть, но входа в нём нет — войдите заново.' : 'Профиль создан.');
  console.log('');
  console.log('  1. В окне Chrome нажмите «Вход и регистрация».');
  console.log('  2. Введите свои данные и дождитесь дерева разделов.');
  console.log('  3. Больше ничего делать не нужно: скрипт сам увидит куки');
  console.log('     сессии и закроет окно. Enter только ускоряет.');
  console.log('');
  console.log('Пароль скрипту не передаётся и нигде не сохраняется.');
  console.log('В профиле остаются только куки сессии.');
  console.log('');
  ({ cookies, looksAuthed, timedOut, inside, closed } = await waitForLogin());
}

if (closed) {
  console.log('\nОкно Chrome закрыто — вход не завершён.');
  console.log('  Закройте это окно терминала и запустите npm run start заново.');
  process.exit(4);
}

console.log(`\nURL:        ${page.url()}`);
console.log(`Заголовок:  ${await page.title()}`);
console.log(`Куки:       ${cookies.length} шт.`);
console.log(`Внутри приложения: ${inside ? 'да' : 'нет'}${inside ? '' : '  ← значит, открыт публичный лендинг'}`);

await fs.writeFile(
  path.join(HERE, 'session-check.json'),
  JSON.stringify(
    { url: page.url(), title: await page.title(), cookies: cookies.length, inside, looksAuthed },
    null,
    2,
  ),
);

if (looksAuthed) {
  console.log('\n✓ Вход подтверждён, куки сохранены в профиле. Закрываю окно.');
  await context.close();
  console.log('  Дальше выполните: node tools/export-mcfr/probe.mjs');
  process.exit(0);
}

console.log('\n⚠️  Сессия так и не появилась' + (timedOut ? ' (ждал 10 минут).' : '.'));
console.log('   Что было на экране?');
console.log('   · форма входа не открылась');
console.log('   · форма открылась, но не принимает данные');
console.log('   · вошли, но дерево разделов не появилось');
console.log('   Ответьте одним из вариантов — по нему пойму, что чинить.');
await context.close();
process.exit(3);
