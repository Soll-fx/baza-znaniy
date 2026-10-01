/**
 * Слаги для рубрик, статей и якорей.
 * Требование БД: /^[a-z0-9]+(-[a-z0-9]+)*$/
 */

const NON_SLUG = /[^a-z0-9]+/g;
const CYRILLIC_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya',
};

/** Транслитерация кириллицы → latin, затем приведение к kebab-case. */
export function slugify(input: string): string {
  const transliterated = [...input.toLowerCase()]
    .map((ch) => CYRILLIC_MAP[ch] ?? ch)
    .join('');

  const slug = transliterated
    .replace(NON_SLUG, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'untitled';
}

/** Слаг якоря заголовка: сохраняет буквы любого алфавита (кириллица — норм). */
export function slugifyAnchor(input: string): string {
  const anchor = input
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

  return anchor || 'section';
}

/** Уникализирует якоря: section, section-1, section-2 ... */
export function uniqueAnchor(base: string, used: Map<string, number>): string {
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}
