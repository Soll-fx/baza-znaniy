/**
 * Загрузчики источников: JSON-документ и каталог с Markdown-файлами.
 * Оба приводят к общему формату IngestTopic[]. Формат выгрузки экспортера
 * обратно совместим с загрузчиком JSON — round-trip без потерь.
 */
import fs from 'node:fs/promises';
import { readFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { IngestArticle, IngestAsset, IngestTopic } from './ingest.js';
import { slugify } from './slug.js';

export interface SourceMeta {
  title?: string;
  summary?: string;
  status?: 'draft' | 'review' | 'published' | 'archived';
  sort_order?: number;
  order?: number;
  source_url?: string;
  effective_from?: string;
  effective_to?: string;
  is_published?: boolean;
  tags?: string[];
  updated?: string;
}

const TOPIC_INDEX_FILES = ['_topic.md', '_index.md', 'README.md', 'index.md'];
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx']);
const IGNORED_DIRS = new Set(['node_modules', '.git', '.obsidian', 'images', 'assets', 'files', '__pycache__']);
const MEDIA_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.zip', '.rar', '.txt',
]);

/**
 * Разбор front matter с понятной диагностикой.
 * Самая частая ошибка в YAML — двоеточие в значении без кавычек
 * (`title: НДС: ставки`), поэтому подсказываем именно это.
 */
function readMatter(file: string): matter.GrayMatterFile<string> {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Не удалось прочитать файл: ${file}`);
  }
  try {
    return matter(raw);
  } catch (err) {
    const reason = (err as { reason?: string }).reason ?? (err as Error).message;
    throw new Error(
      `Некорректный front matter в ${file}\n  ${reason}\n` +
        '  Подсказка: значения с двоеточием, «#» или кавычками берите в кавычки: title: "НДС: ставки 12 %"',
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  JSON                                                                      */
/* -------------------------------------------------------------------------- */

export interface BazaDocument {
  version: number;
  exported_at?: string;
  generator?: string;
  topics: IngestTopic[];
}

export async function loadJsonSource(file: string): Promise<IngestTopic[]> {
  const raw = await fs.readFile(file, 'utf8');
  const doc = JSON.parse(raw) as BazaDocument;

  if (!Array.isArray(doc?.topics)) {
    throw new Error(`Некорректный документ: ожидается { "topics": [...] } (${file})`);
  }
  return doc.topics;
}

/* -------------------------------------------------------------------------- */
/*  Каталог Markdown                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Структура каталога = структура рубрик:
 *   content/
 *     nalogovyy-kodeks/          <- рубрика (slug = имя каталога)
 *       _topic.md                <- title/summary/sort_order рубрики
 *       nds-st-10.md             <- статья (slug = имя файла)
 *       images/pwz-schema.png    <- медиа, упомянутое в статьях
 *       podrazdel/
 *         _topic.md
 *         st-10-1.md
 *
 * Пути к файлам в assets[].file всегда относительно КОРНЯ (sourceRoot),
 * потому что именно относительно него их разрешает ingestTree.
 */
export async function loadDirSource(dir: string): Promise<IngestTopic[]> {
  const root = path.resolve(dir);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const subdirs = entries.filter(
    (e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.'),
  );

  // Каталог с подкаталогами — это контейнер корневых рубрик, а не сама рубрика
  if (subdirs.length > 0) {
    const roots: IngestTopic[] = [];
    for (const d of subdirs) roots.push(...(await readTopicDir(path.join(root, d.name), [d.name], root)));
    return roots;
  }
  return readTopicDir(root, [], root);
}

async function readTopicDir(dir: string, stack: string[], sourceRoot: string): Promise<IngestTopic[]> {
  if (stack.length > 12) throw new Error(`Слишком глубокая вложенность каталогов: ${dir}`);

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile());
  const dirs = entries.filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.'));

  // --- метаданные рубрики
  let meta: SourceMeta = {};
  for (const candidate of TOPIC_INDEX_FILES) {
    const found = files.find((f) => f.name === candidate);
    if (found) {
      meta = readMatter(path.join(dir, found.name)).data as SourceMeta;
      break;
    }
  }

  const topicSlug = path.basename(dir);
  // Слаг рубрики берём из имени каталога: он стабилен и ASCII,
  // на него опираются вики-ссылки вида [[rubrika/podrazdel]]
  const topic: IngestTopic = {
    slug: slugify(topicSlug),
    title: meta.title ?? humanize(topicSlug),
    summary: meta.summary,
    sourceUrl: meta.source_url,
    sortOrder: meta.sort_order ?? meta.order,
    isPublished: meta.is_published ?? true,
  };

  // --- статьи
  const articles: IngestArticle[] = [];
  const usedSlugs = new Set<string>();

  for (const file of files) {
    if (!MARKDOWN_EXT.has(path.extname(file.name).toLowerCase())) continue;
    if (TOPIC_INDEX_FILES.includes(file.name)) continue;

    const full = path.join(dir, file.name);
    const parsed = readMatter(full);
    const data = parsed.data as SourceMeta;
    const rawSlug = path.basename(file.name, path.extname(file.name)).toLowerCase();
    const slug = slugify(rawSlug);
    if (usedSlugs.has(slug)) {
      throw new Error(`Два файла дают один слаг «${slug}» в каталоге ${dir}: ${file.name}`);
    }
    usedSlugs.add(slug);

    articles.push({
      slug,
      title: data.title ?? humanize(rawSlug),
      summary: data.summary,
      bodyMd: parsed.content,
      status: data.status ?? 'draft',
      sourceUrl: data.source_url,
      effectiveFrom: data.effective_from,
      effectiveTo: data.effective_to,
      assets: await collectAssets(dir, parsed.content, sourceRoot),
    });
  }

  // Статья рубрики: файл _topic.md/#topic
  const indexFile = TOPIC_INDEX_FILES.find((n) => files.some((f) => f.name === n));
  if (indexFile) {
    const parsed = readMatter(path.join(dir, indexFile));
    if (parsed.content.trim()) {
      const slug = `${slugify(topicSlug)}-obzor`;
      if (!usedSlugs.has(slug)) {
        usedSlugs.add(slug);
        articles.push({
          slug,
          title: `${topic.title} — обзор раздела`,
          bodyMd: parsed.content,
          status: (parsed.data as SourceMeta).status ?? 'draft',
          sourceUrl: (parsed.data as SourceMeta).source_url,
          assets: await collectAssets(dir, parsed.content, sourceRoot),
        });
      }
    }
  }

  if (articles.length === 1 && !topic.children) {
    topic.article = articles[0];
  } else if (articles.length > 0) {
    topic.children = [...(topic.children ?? []), ...articles.map(asChildTopic)];
  }

  // --- подрубрики
  for (const d of dirs) {
    topic.children = [...(topic.children ?? []), ...(await readTopicDir(path.join(dir, d.name), [...stack, d.name], sourceRoot))];
  }

  if (!topic.children?.length && !topic.article) {
    // пустая рубрика — пропускаем, но это стоит отметить в отчёте валидатора
    return [];
  }
  return [topic];
}

function asChildTopic(article: IngestArticle): IngestTopic {
  return { slug: article.slug, title: article.title, article };
}

/**
 * Все медиафайлы каталога рубрики. Ключ map — путь относительно sourceRoot,
 * значение — абсолютный путь на диске. Именно относительно sourceRoot
 * ingestTree разрешает file из assets[].
 */
async function collectAssets(topicDir: string, bodyMd: string, sourceRoot: string): Promise<IngestAsset[]> {
  const media = await collectMediaInDir(topicDir, sourceRoot);
  const referenced = [...bodyMd.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g)].map((m) => m[1] ?? '');

  const assets: IngestAsset[] = [];
  const used = new Set<string>();

  for (const ref of referenced) {
    if (/^(https?:)?\/\//i.test(ref)) continue;
    // src в тексте задан относительно каталога статьи
    const cleaned = ref.split('#')[0]!.split('?')[0]!;
    const rel = normalizeSlash(path.relative(sourceRoot, path.resolve(topicDir, cleaned)));
    if (!media.has(rel)) continue;
    assets.push({
      file: rel,
      alt: altFromMarkdown(bodyMd, cleaned),
      role: 'inline',
      position: assets.length,
    });
    used.add(rel);
  }

  for (const rel of media.keys()) {
    if (used.has(rel)) continue;
    assets.push({ file: rel, role: 'attachment', position: assets.length });
  }

  return assets;
}

const normalizeSlash = (p: string): string => p.split(path.sep).join('/');

async function collectMediaInDir(dir: string, sourceRoot: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const sub of ['images', 'assets', 'files', '.']) {
    const subDir = path.join(dir, sub);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(subDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!MEDIA_EXT.has(ext)) continue;
      const rel = normalizeSlash(path.relative(sourceRoot, path.join(subDir, e.name)));
      if (!out.has(rel)) out.set(rel, path.join(subDir, e.name));
    }
  }
  return out;
}

function altFromMarkdown(md: string, src: string): string {
  for (const m of md.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?/g)) {
    if (m[2] === src) return (m[1] ?? '').trim();
  }
  return '';
}

function humanize(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : slug;
}
