/**
 * Один запуск — и всё работает.
 *
 *   npm start
 *
 * Скрипт сам:
 *   1. поднимает PostgreSQL (скачивается при установке, Docker не нужен);
 *   2. создаёт базу и схему таблиц;
 *   3. при первом запуске загружает 455 документов из папки content;
 *   4. запускает сервер API и сайт;
 *   5. печатает адрес, по которому всё это открыть.
 *
 * Всё держится в одном процессе: PostgreSQL не переживает выход родителя,
 * поэтому сервер БД и сайт живут вместе, а Ctrl+C останавливает всё.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT_DB = 5432;
const PORT_API = 4000;
const PORT_WEB = 5173;

const DATABASE_URL = `postgres://baza:baza@127.0.0.1:${PORT_DB}/baza`;
const DATA_DIR = path.join(ROOT, '.pgdata');

const kids = [];
let pg = null;
let stopping = false;

const log = (m) => console.log(m);

/**
 * Адрес в локальной сети, по которому сайт откроется с телефона.
 * Берём первый неслужебный IPv4 — обычно это Wi-Fi.
 */
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.startsWith('169.254.')) continue;
      return ni.address;
    }
  }
  return null;
}
const step = (m) => console.log(`\n[1m▸ ${m}[0m`);

/** Запускает npm-скрипт проекта и ждёт его завершения. */
function run(args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd: ROOT,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, DATABASE_URL },
    });
    let out = '';
    if (capture) {
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
    }
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(out.slice(-1200)))));
  });
}

/** Запускает долгоживущий процесс и запоминает его, чтобы остановить при выходе. */
function start(args, name) {
  const child = spawn('npm', args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, DATABASE_URL } });
  child.on('close', (code) => {
    if (!stopping) {
      log(`\n${name} завершился (код ${code}). Останавливаю всё.`);
      shutdown(1);
    }
  });
  kids.push(child);
  return child;
}

async function waitForPort(port, label, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return;
    } catch {
      /* ещё не слушает */
    }
    await sleep(500);
  }
  throw new Error(`${label} не ответил на порту ${port} за ${timeoutMs / 1000} с`);
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const k of kids) k.kill('SIGTERM');
  if (pg) {
    try {
      await pg.stop();
      log('PostgreSQL остановлен.');
    } catch (e) {
      log('Не удалось остановить PostgreSQL: ' + e.message);
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

try {
  step('PostgreSQL');
  pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'baza',
    password: 'baza',
    port: PORT_DB,
    persistent: true,
    // Та же локаль, что и в Docker: детерминированная сортировка по тексту.
    initdbFlags: ['--locale=C', '--encoding=UTF8'],
    onLog: () => {},
    onError: (e) => console.error('[postgres]', String(e).trim()),
  });
  if (!existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    log('  первый запуск: создаю кластер (это один раз, ~15 секунд)');
    await pg.initialise();
  } else {
    log('  кластер уже создан');
  }
  await pg.start();
  try {
    await pg.createDatabase('baza');
  } catch {
    /* база уже есть */
  }
  log(`  готов на порту ${PORT_DB}`);

  step('Схема таблиц');
  await run(['run', 'migrate', '--workspace', 'server']);
  log('  готово');

  step('Проверяю, загружена ли база');
  const { default: pgClient } = await import('pg');
  const client = new pgClient.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const res = await client.query('select count(*)::int as n from articles');
  const count = res.rows[0].n;
  await client.end();

  if (count === 0) {
    step('Загружаю базу знаний из content (один раз, несколько минут)');
    // абсолютный путь: npm запускает скрипт из папки server, а content лежит в корне
    await run(['run', 'import', '--workspace', 'server', '--', '--dir', path.join(ROOT, 'content')]);
  } else {
    log(`  в базе уже ${count} статей, повторно не гружу`);
  }

  step('Запускаю сервер и сайт');
  start(['run', 'dev', '--workspace', 'server'], 'Сервер');
  start(['run', 'dev', '--workspace', 'web'], 'Сайт');
  await waitForPort(PORT_WEB, 'Сайт');
  await waitForPort(PORT_API, 'Сервер');

  const lan = lanAddress();
  const lines = [
    'Сайт готов',
    '',
    `http://localhost:${PORT_WEB}`,
    ...(lan ? [`http://${lan}:${PORT_WEB}   ← с телефона`] : []),
    '',
    `API:      http://localhost:${PORT_API}`,
    `База:     ${DATABASE_URL}`,
    `Статей:   ${count || 'загружаются при первом запуске'}`,
    '',
    'Остановить — Ctrl+C',
  ];
  const w = Math.max(44, ...lines.map((l) => l.length));
  const box = (l) => `  │  ${l.padEnd(w)} │`;
  const top = `  ┌${'─'.repeat(w + 4)}┐`;
  const bottom = `  └${'─'.repeat(w + 4)}┘`;
  console.log(`
${top}
${lines.map(box).join('\n')}
${bottom}
`);
  if (lan) {
    console.log(`  С телефона в той же сети: http://${lan}:${PORT_WEB}`);
    console.log('  Если не открывается — телефон и компьютер должны быть в одной Wi-Fi сети,');
    console.log('  а не в гостевой. Проверить: ping ' + lan + '\n');
  }
  setInterval(() => {}, 1 << 30);
} catch (e) {
  console.error('\nНе удалось запустить:', e.message);
  await shutdown(1);
}
