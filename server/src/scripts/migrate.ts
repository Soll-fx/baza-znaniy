/**
 * Применение схемы: `npm run db:migrate -- --reset`
 */
import fs from 'node:fs/promises';
import { pool } from '../lib/db.js';
import { config } from '../lib/config.js';

const args = new Set(process.argv.slice(2));
const reset = args.has('--reset') || args.has('--drop');
const file = process.env.SCHEMA_FILE ?? config.schemaPath;

async function tableExists(name: string): Promise<boolean> {
  const res = await pool.query('SELECT to_regclass($1) AS t', [`public.${name}`]);
  return res.rows[0]?.t !== null;
}

async function main(): Promise<void> {
  const sql = await fs.readFile(file, 'utf8');

  if (await tableExists('topics')) {
    if (!reset) {
      console.log('[migrate] Схема уже применена. Для пересоздания: npm run db:migrate -- --reset');
      return;
    }
    console.log('[migrate] --reset: удаляю схему public…');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }

  console.log(`[migrate] Применяю ${file}`);
  await pool.query(sql);

  const version = await pool.query('SELECT count(*)::int AS n FROM topics');
  console.log(`[migrate] Готово. Рубрик: ${version.rows[0]?.n ?? 0}`);
}

main()
  .catch((err) => {
    console.error('[migrate] Ошибка:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
