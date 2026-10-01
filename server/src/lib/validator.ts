/**
 * Проверка целостности данных.
 *
 * Два независимых уровня:
 *   1) validateTree()   — проверка исходников (JSON / каталог Markdown) без БД.
 *                         Работает в CI, ловит ошибки ДО импорта.
 *   2) validateDatabase() — проверка того, что реально лежит в PostgreSQL и на диске.
 *                         Ловит битые ссылки, потерянные файлы, нарушения дерева.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { query, queryOne } from './db.js';
import { renderMarkdown, extractLinks, extractImages, splitAnchor } from './markdown.js';
import { verifyIntegrity, resolveOnDisk } from './storage.js';
import type { IngestTopic } from './ingest.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  where?: string;
  hint?: string;
}

export interface ValidationReport {
  issues: Issue[];
  stats: Record<string, number>;
  durationMs: number;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function emptyReport(): ValidationReport {
  return { issues: [], stats: {}, durationMs: 0 };
}

export function counts(report: ValidationReport): Record<Severity, number> {
  return {
    error: report.issues.filter((i) => i.severity === 'error').length,
    warning: report.issues.filter((i) => i.severity === 'warning').length,
    info: report.issues.filter((i) => i.severity === 'info').length,
  };
}

/* ========================================================================== */
/*  Уровень 1: исходники                                                      */
/* ========================================================================== */

export interface TreeCheckOptions {
  /** Корень, относительно которого ищутся файлы из assets[].file */
  baseDir: string;
  /** Максимально допустимая вложенность рубрик */
  maxDepth?: number;
  /** Требовать alt у изображений (доступность) */
  requireAlt?: boolean;
  /** Разрешить ссылки на внешние источники */
  allowExternalLinks?: boolean;
}

interface FlatArticle {
  ref: string;
  slug: string;
  title: string;
  bodyMd: string;
  tocAnchors: Set<string>;
  topicPath: string;
}

/** Плоский индекс статей: slug -> [ref] и полный путь -> ref. */
function indexArticles(tree: IngestTopic[]): {
  bySlug: Map<string, string[]>;
  byFullPath: Map<string, FlatArticle>;
  all: FlatArticle[];
} {
  const bySlug = new Map<string, string[]>();
  const byFullPath = new Map<string, FlatArticle>();
  const all: FlatArticle[] = [];

  const walk = (nodes: IngestTopic[], trail: string[]) => {
    for (const node of nodes) {
      const p = [...trail, node.slug];
      const topicPath = p.join('/');

      if (node.article) {
        const { toc } = renderMarkdown(node.article.bodyMd);
        const flat: FlatArticle = {
          ref: `${topicPath}/${node.article.slug}`,
          slug: node.article.slug,
          title: node.article.title,
          bodyMd: node.article.bodyMd,
          tocAnchors: new Set(toc.map((t) => t.id)),
          topicPath,
        };
        all.push(flat);
        byFullPath.set(flat.ref, flat);
        const list = bySlug.get(node.article.slug) ?? [];
        list.push(flat.ref);
        bySlug.set(node.article.slug, list);
      }
      if (node.children?.length) walk(node.children, p);
    }
  };

  walk(tree, []);
  return { bySlug, byFullPath, all };
}

export async function validateTree(
  tree: IngestTopic[],
  options: TreeCheckOptions,
): Promise<ValidationReport> {
  const started = Date.now();
  const report = emptyReport();
  const maxDepth = options.maxDepth ?? 8;
  const seenTopicPaths = new Set<string>();
  const titles = new Map<string, string[]>();
  const { bySlug, byFullPath, all } = indexArticles(tree);

  const add = (i: Issue) => report.issues.push(i);

  async function walk(nodes: IngestTopic[], trail: string[]) {
    for (const node of nodes) {
      const topicPath = [...trail, node.slug].join('/');
      const where = `рубрика «${topicPath}»`;

      // --- slug и заголовки
      if (!SLUG_RE.test(node.slug)) {
        add({
          severity: 'error',
          code: 'TOPIC_SLUG_INVALID',
          message: `некорректный slug: «${node.slug}»`,
          where,
          hint: 'Ожидается kebab-case: только латиница в нижнем регистре, цифры и дефисы',
        });
      }
      if (seenTopicPaths.has(topicPath)) {
        add({ severity: 'error', code: 'TOPIC_PATH_DUPLICATE', message: `дубликат пути: ${topicPath}`, where });
      }
      seenTopicPaths.add(topicPath);

      if (!node.title?.trim()) {
        add({ severity: 'error', code: 'TOPIC_TITLE_EMPTY', message: 'пустое название рубрики', where });
      }
      if (trail.length > maxDepth) {
        add({
          severity: 'warning',
          code: 'TOPIC_TOO_DEEP',
          message: `вложенность ${trail.length} > ${maxDepth}`,
          where,
          hint: 'Глубже 4–5 уровней сайдбар перестаёт быть удобным',
        });
      }

      const dup = titles.get(node.title.toLowerCase());
      if (dup) {
        add({
          severity: 'warning',
          code: 'TITLE_DUPLICATE',
          message: `название «${node.title}» уже встречалось: ${dup.join(', ')}`,
          where,
          hint: 'Дубли названий мешают навигации — переименуйте или уточните',
        });
      }
      titles.set(node.title.toLowerCase(), [...(dup ?? []), topicPath]);

      // --- статья
      if (node.article) {
        await checkArticle(node, topicPath, where, add, options, { bySlug, byFullPath, all });
      } else if (!node.children?.length) {
        add({
          severity: 'warning',
          code: 'TOPIC_EMPTY',
          message: 'рубрика без статей и подрубрик',
          where,
          hint: 'Либо добавьте статью, либо удалите рубрику',
        });
      }

      if (node.children?.length) await walk(node.children, [...trail, node.slug]);
    }
  }

  await walk(tree, []);

  // --- итоговая статистика
  report.stats = {
    topics: countTopics(tree),
    articles: all.length,
    words: all.reduce((sum, a) => sum + (a.bodyMd.match(/[\p{L}\p{N}]+/gu)?.length ?? 0), 0),
    images: all.reduce(
      (sum, a) => sum + extractImages(a.bodyMd).filter((i) => !/^(https?:)?\/\//i.test(i.src)).length,
      0,
    ),
    headings: all.reduce((sum, a) => sum + renderMarkdown(a.bodyMd).toc.length, 0),
  };

  // --- статьи с одинаковым содержимым (частый признак копипасты)
  const bodyHashes = new Map<string, string[]>();
  for (const a of all) {
    const norm = a.bodyMd.replace(/\s+/g, ' ').trim();
    if (norm.length < 200) continue;
    const list = bodyHashes.get(norm) ?? [];
    list.push(a.ref);
    bodyHashes.set(norm, list);
  }
  for (const refs of bodyHashes.values()) {
    if (refs.length > 1) {
      add({
        severity: 'warning',
        code: 'ARTICLE_DUPLICATE_BODY',
        message: `одинаковый текст у ${refs.length} статей: ${refs.join(', ')}`,
        hint: 'Проверьте, не дублируется ли контент',
      });
    }
  }

  report.durationMs = Date.now() - started;
  return report;
}

function countTopics(nodes: IngestTopic[]): number {
  return nodes.reduce((sum, n) => sum + 1 + (n.children ? countTopics(n.children) : 0), 0);
}

interface Indexes {
  bySlug: Map<string, string[]>;
  byFullPath: Map<string, FlatArticle>;
  all: FlatArticle[];
}

async function checkArticle(
  node: IngestTopic,
  topicPath: string,
  where: string,
  add: (i: Issue) => void,
  options: TreeCheckOptions,
  idx: Indexes,
): Promise<void> {
  const article = node.article!;
  // Полный путь рубрики, которой принадлежит статья, — он же её идентификатор
  const ref = topicPath;

  if (!SLUG_RE.test(article.slug)) {
    add({
      severity: 'error',
      code: 'ARTICLE_SLUG_INVALID',
      message: `некорректный slug статьи: «${article.slug}»`,
      where: ref,
    });
  }
  if (!article.title?.trim()) {
    add({ severity: 'error', code: 'ARTICLE_TITLE_EMPTY', message: 'пустое название статьи', where: ref });
  }
  if (!article.bodyMd?.trim()) {
    add({ severity: 'error', code: 'ARTICLE_BODY_EMPTY', message: 'пустое тело статьи', where: ref });
    return;
  }

  // --- файлы, объявленные в манифесте
  const declared = new Map((article.assets ?? []).map((a) => [a.file.replace(/^\.\//, ''), a]));
  for (const [file, item] of declared) {
    const abs = path.resolve(options.baseDir, file);
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        add({
          severity: 'error',
          code: 'ASSET_IS_DIRECTORY',
          message: `в assets[] указан каталог: ${file}`,
          where: ref,
        });
      } else if (st.size === 0) {
        add({ severity: 'error', code: 'ASSET_EMPTY', message: `файл пустой (0 байт): ${file}`, where: ref });
      }
    } catch {
      add({
        severity: 'error',
        code: 'ASSET_FILE_MISSING',
        message: `файл не найден: ${file}`,
        where: ref,
        hint: `Ожидался по пути ${abs}`,
      });
    }

    // Явно помеченные декоративные файлы alt не требуют: пустой alt для них —
    // корректная разметка, а не забытое описание.
    if (
      item.role !== 'attachment' &&
      !item.decorative &&
      (options.requireAlt ?? true) &&
      !item.alt?.trim()
    ) {
      add({
        severity: 'warning',
        code: 'ASSET_ALT_EMPTY',
        message: `не заполнен alt: ${file}`,
        where: ref,
        hint: 'Alt обязателен: он используется скринридерами и при отказе загрузки картинки',
      });
    }
  }

  // --- картинки в тексте
  const declaredNames = new Set([...declared.keys()].map((f) => f.split('/').pop()!));
  for (const img of extractImages(article.bodyMd)) {
    if (/^(https?:)?\/\//i.test(img.src)) continue;
    const clean = img.src.split('#')[0]!.split('?')[0]!.replace(/^\.\//, '');
    // src задан относительно каталога статьи, assets[] — относительно корня,
    // поэтому сверяем по имени файла
    const base = clean.split('/').pop()!;
    if (!declared.has(clean) && !declaredNames.has(base)) {
      add({
        severity: 'error',
        code: 'IMAGE_NOT_DECLARED',
        message: `изображение «${img.src}» не описано в assets[]`,
        where: ref,
        hint: 'Добавьте его в манифест, иначе файл не проверится и не попадёт в экспорт',
      });
    }
  }

  // --- ссылки
  const { toc } = renderMarkdown(article.bodyMd);
  const anchors = new Set(toc.map((t) => t.id));

  for (const link of extractLinks(article.bodyMd)) {
    if (link.kind === 'external') {
      if (!options.allowExternalLinks && !/^https?:\/\//.test(link.rawTarget)) {
        add({
          severity: 'warning',
          code: 'LINK_SUSPICIOUS',
          message: `внешняя ссылка без схемы: «${link.rawTarget}»`,
          where: ref,
        });
      }
      if (/\s/.test(link.rawTarget)) {
        add({ severity: 'error', code: 'LINK_HAS_SPACE', message: `пробел в ссылке: «${link.rawTarget}»`, where: ref });
      }
      continue;
    }

    if (link.kind === 'anchor') {
      const anchor = link.rawTarget.slice(1);
      if (anchor && !anchors.has(anchor)) {
        add({
          severity: 'error',
          code: 'ANCHOR_MISSING',
          message: `якорь «#${anchor}» не найден среди заголовков статьи`,
          where: ref,
        });
      }
      continue;
    }

    // Локальный файл (./file.docx, ../rubrika/file.xlsx) — не статья;
    // существование проверяет media/exists ниже.
    if (link.kind === 'file') {
      continue;
    }

    // kind === 'internal'
    const { slug, anchor } = splitAnchor(link.rawTarget);
    if (!slug) {
      if (anchor && !anchors.has(anchor)) {
        add({ severity: 'error', code: 'ANCHOR_MISSING', message: `якорь «#${anchor}» не найден`, where: ref });
      }
      continue;
    }

    const clean = slug.replace(/\.md$/i, '').replace(/^\//, '');
    const candidates = idx.bySlug.get(clean) ?? [];
    const byFullPath = idx.byFullPath.get(clean);
    const byTitle = idx.all.find((a) => a.title.toLowerCase() === clean.toLowerCase());

    // Полный путь «рубрика/статья» всегда однозначен — он приоритетнее
    const target = byFullPath ?? (candidates.length === 1 ? idx.byFullPath.get(candidates[0]!) : undefined) ?? byTitle;

    if (!target) {
      if (candidates.length > 1) {
        // Слаг повторяется в нескольких рубриках — это не «битая» ссылка,
        // а неоднозначность: статья есть, но какая именно — непонятно
        add({
          severity: 'warning',
          code: 'LINK_AMBIGUOUS',
          message: `[[${clean}]] соответствует ${candidates.length} статьям: ${candidates.join(', ')}`,
          where: ref,
          hint: 'Укажите полный путь вида [[рубрика/статья]]',
        });
        continue;
      }
      add({
        severity: 'error',
        code: 'LINK_BROKEN',
        message: `битая ссылка [[${link.rawTarget}]] — статья не найдена`,
        where: ref,
        hint: candidatesHint(idx, clean),
      });
      continue;
    }

    if (candidates.length > 1 && !byFullPath) {
      add({
        severity: 'warning',
        code: 'LINK_AMBIGUOUS',
        message: `[[${clean}]] соответствует ${candidates.length} статьям: ${candidates.join(', ')}`,
        where: ref,
        hint: 'Укажите полный путь вида [[рубрика/статья]]',
      });
    }

    if (anchor && target.tocAnchors.size > 0 && !target.tocAnchors.has(anchor)) {
      add({
        severity: 'error',
        code: 'ANCHOR_MISSING',
        message: `якорь «#${anchor}» отсутствует в статье «${target.title}»`,
        where: ref,
      });
    }
  }
}

function candidatesHint(idx: Indexes, clean: string): string {
  const near = idx.all
    .map((a) => ({ ref: a.ref, d: distance(clean.toLowerCase(), a.slug.toLowerCase()) }))
    .filter((x) => x.d <= 2)
    .slice(0, 3)
    .map((x) => x.ref);
  return near.length ? `Близкие по имени: ${near.join(', ')}` : 'Создайте статью с таким slug или исправьте ссылку';
}

/** Расстояние Левенштейна — для подсказок «возможно, имелось в виду…». */
function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i]![0] = i;
  for (let j = 0; j <= n; j += 1) dp[0]![j] = j;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}

/* ========================================================================== */
/*  Уровень 2: база данных + файлы на диске                                  */
/* ========================================================================== */

export interface DbCheckOptions {
  /** Сверять sha256 файлов (медленно на больших архивах, но надёжно) */
  verifyChecksums: boolean;
  /** Требовать alt у картинок */
  requireAlt: boolean;
}

export async function validateDatabase(options: DbCheckOptions): Promise<ValidationReport> {
  const started = Date.now();
  const report = emptyReport();
  const add = (i: Issue) => report.issues.push(i);

  /* --- 1. Инварианты дерева рубрик ---------------------------------------- */

  const treeInvariants = await query<{
    id: string; slug: string; title: string; depth: number; path: string[]; parent_id: string | null;
    parent_path: string[] | null;
  }>(
    `SELECT t.id, t.slug, t.title, t.depth, t.path, t.parent_id, p.path AS parent_path
       FROM topics t LEFT JOIN topics p ON p.id = t.parent_id`,
  );

  for (const t of treeInvariants.rows) {
    const where = `рубрика «${t.title}» (${t.id.slice(0, 8)})`;

    if (t.path.length !== t.depth + 1) {
      add({
        severity: 'error',
        code: 'TREE_DEPTH_MISMATCH',
        message: `depth=${t.depth}, а длина path=${t.path.length}`,
        where,
        hint: 'Нарушен инвариант дерева: пересчитать через topics_biu',
      });
    }
    // path включает саму рубрику последним элементом, поэтому path[0] — это
    // слаг КОРНЯ. Инвариант path[0] === slug выполняется только у корневых.
    if (t.depth === 0 && t.path[0] !== t.slug) {
      add({ severity: 'error', code: 'TREE_PATH_HEAD', message: `path начинается с «${t.path[0]}», а slug = «${t.slug}»`, where });
    }
    if (t.parent_id === null && t.depth !== 0) {
      add({ severity: 'error', code: 'TREE_ROOT_DEPTH', message: `корневая рубрика с depth=${t.depth}`, where });
    }
    if (t.parent_path) {
      const expected = [...t.parent_path, t.slug];
      if (expected.join('/') !== t.path.join('/')) {
        add({
          severity: 'error',
          code: 'TREE_PATH_BREAK',
          message: `path «${t.path.join('/')}» не продолжает path родителя «${t.parent_path.join('/')}»`,
          where,
        });
      }
    }
  }

  /* --- 2. Рубрики без содержимого и «неправильный» kind -------------------- */

  const badKinds = await query<{ id: string; title: string; kind: string; childs: number; arts: number }>(
    `SELECT t.id, t.title, t.kind,
            (SELECT count(*) FROM topics c WHERE c.parent_id = t.id)::int AS childs,
            (SELECT count(*) FROM articles a WHERE a.topic_id = t.id)::int AS arts
       FROM topics t
      WHERE (t.kind = 'branch' AND NOT EXISTS (SELECT 1 FROM topics c WHERE c.parent_id = t.id))
         OR (t.kind = 'leaf'   AND EXISTS (SELECT 1 FROM topics c WHERE c.parent_id = t.id))`,
  );
  for (const t of badKinds.rows) {
    add({
      severity: 'warning',
      code: 'TOPIC_KIND_MISMATCH',
      message: `kind='${t.kind}', но рубрик ${t.childs}, статей ${t.arts}`,
      where: `рубрика «${t.title}»`,
      hint: 'Рубрика с детьми должна быть branch',
    });
  }

  const emptyTopics = await query<{ title: string; subtree_articles: number; childs: number }>(
    `SELECT t.title, t.subtree_articles, (SELECT count(*) FROM topics c WHERE c.parent_id = t.id)::int AS childs
       FROM topic_tree t
      WHERE t.subtree_articles = 0
        AND (SELECT count(*) FROM topics c WHERE c.parent_id = t.id) = 0`,
  );
  for (const t of emptyTopics.rows) {
    add({
      severity: 'warning',
      code: 'TOPIC_EMPTY',
      message: `рубрика «${t.title}» не содержит ни статей, ни подрубрик`,
      hint: 'Пустая рубрика попадает в сайдбар и выглядит как ошибка',
    });
  }

  /* --- 3. Статьи ---------------------------------------------------------- */

  const badArticles = await query<{ id: string; title: string; reason: string }>(
    `SELECT id, title,
            CASE
              WHEN btrim(coalesce(body_md, '')) = '' THEN 'пустое тело'
              WHEN btrim(coalesce(title, '')) = ''   THEN 'пустое название'
              WHEN status = 'published' AND (body_html IS NULL OR body_html = '') THEN 'published, но HTML не отрендерен'
              ELSE '—'
            END AS reason
       FROM articles
      WHERE btrim(coalesce(body_md, '')) = ''
         OR btrim(coalesce(title, '')) = ''
         OR (status = 'published' AND coalesce(body_html, '') = '')`,
  );
  for (const a of badArticles.rows) {
    add({
      severity: 'error',
      code: 'ARTICLE_INVALID',
      message: `${a.reason}`,
      where: `статья «${a.title}» (${a.id.slice(0, 8)})`,
    });
  }

  const unpublishedParent = await query<{ title: string; topic: string }>(
    `SELECT a.title, t.title AS topic
       FROM articles a JOIN topics t ON t.id = a.topic_id
      WHERE a.status = 'published' AND t.is_published = false`,
  );
  for (const r of unpublishedParent.rows) {
    add({
      severity: 'warning',
      code: 'ARTICLE_IN_HIDDEN_TOPIC',
      message: `статья «${r.title}» опубликована, но её рубрика «${r.topic}» скрыта`,
      hint: 'Статья не будет видна в интерфейсе',
    });
  }

  const withoutSource = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM articles
      WHERE source_url IS NULL AND status = 'published'`,
  );
  const srcCount = withoutSource.rows[0]?.count ?? 0;
  if (srcCount > 0) {
    add({
      severity: 'info',
      code: 'ARTICLE_NO_SOURCE',
      message: `у ${srcCount} опубликованных статей нет ссылки на первоисточник`,
      hint: 'Рекомендация: для нормативных тем (НК, ПК, инструкции) проставьте source_url — это и проверка авторства, и защита при перепечатке',
    });
  }

  /* --- 4. Файлы: наличие, размер, контрольные суммы ------------------------ */

  const assetsRes = await query<{
    id: string; storage_key: string; filename: string; checksum: string;
    bytes: number; kind: string; alt: string | null; uses: number; decorative: boolean;
  }>(
    `SELECT s.id, s.storage_key, s.filename, s.checksum, s.bytes, s.kind, s.alt, s.decorative,
            (SELECT count(*) FROM article_assets aa WHERE aa.asset_id = s.id)::int AS uses
       FROM assets s`,
  );

  for (const a of assetsRes.rows) {
    const where = `файл «${a.filename}» (${a.id.slice(0, 8)})`;

    const result = options.verifyChecksums
      ? await verifyIntegrity(a.storage_key, { checksum: a.checksum, bytes: Number(a.bytes) })
      : await fs
          .access(resolveOnDisk(a.storage_key))
          .then(() => ({ ok: true as const }))
          .catch(() => ({ ok: false as const, reason: 'файл отсутствует на диске' }));

    if (!result.ok) {
      add({
        severity: 'error',
        code: 'ASSET_BROKEN',
        message: `${result.reason ?? 'файл повреждён'}`,
        where,
        hint: 'Перезагрузить файл: npm run import повторно скопирует его по контрольной сумме',
      });
    }

    if (a.uses === 0) {
      add({
        severity: 'warning',
        code: 'ASSET_ORPHAN',
        message: `файл не привязан ни к одной статье (${a.storage_key})`,
        where,
      });
    }
    if (a.kind === 'image' && options.requireAlt && !a.decorative && !a.alt?.trim()) {
      add({
        severity: 'warning',
        code: 'ASSET_ALT_EMPTY',
        message: 'не заполнен alt',
        where,
        hint: 'Без alt картинка недоступна при программном чтении и ломается при ошибке загрузки',
      });
    }
  }

  /* --- 5. Медиа, привязанные к статьям, но потерянные ----------------------- */

  const missingLinked = await query<{ article: string; filename: string; storage_key: string }>(
    `SELECT a.title AS article, s.filename, s.storage_key
       FROM article_assets aa
       JOIN assets s ON s.id = aa.asset_id
       JOIN articles a ON a.id = aa.article_id
      WHERE NOT EXISTS (SELECT 1 FROM assets x WHERE x.id = aa.asset_id)`,
  );
  for (const r of missingLinked.rows) {
    add({ severity: 'error', code: 'ARTICLE_ASSET_MISSING', message: `нет файла ${r.filename}`, where: `статья «${r.article}»` });
  }

  /* --- 6. Ссылки ---------------------------------------------------------- */

  const brokenLinks = await query<{ from_title: string; raw_target: string; from_id: string }>(
    `SELECT a.title AS from_title, al.raw_target, a.id AS from_id
       FROM article_links al JOIN articles a ON a.id = al.from_id
      WHERE al.kind = 'internal' AND al.to_id IS NULL`,
  );
  for (const l of brokenLinks.rows) {
    add({
      severity: 'error',
      code: 'LINK_BROKEN',
      message: `битая внутренняя ссылка [[${l.raw_target}]]`,
      where: `статья «${l.from_title}» (${l.from_id.slice(0, 8)})`,
      hint: 'Либо создайте целевую статью, либо исправьте цель в тексте',
    });
  }

  const badAnchors = await query<{ from_title: string; raw_target: string; to_title: string | null; toc: unknown }>(
    `SELECT a.title AS from_title, al.raw_target, t.title AS to_title, t.toc
       FROM article_links al
       JOIN articles a ON a.id = al.from_id
       LEFT JOIN articles t ON t.id = al.to_id
      WHERE al.kind = 'internal' AND al.raw_target LIKE '%#%' AND t.id IS NOT NULL`,
  );
  for (const l of badAnchors.rows) {
    const anchor = l.raw_target.split('#')[1] ?? '';
    const toc = Array.isArray(l.toc) ? (l.toc as { id: string }[]) : [];
    if (anchor && !toc.some((t) => t.id === anchor)) {
      add({
        severity: 'error',
        code: 'ANCHOR_MISSING',
        message: `якорь «#${anchor}» отсутствует в «${l.to_title}»`,
        where: `статья «${l.from_title}»`,
      });
    }
  }

  const imagesInBody = await query<{ id: string; title: string; body_md: string }>(
    `SELECT id, title, body_md FROM articles WHERE body_md LIKE '%![%'`,
  );
  const assetsOfArticle = await query<{ article_id: string; asset_id: string; filename: string }>(
    `SELECT aa.article_id, aa.asset_id, s.filename
       FROM article_assets aa JOIN assets s ON s.id = aa.asset_id`,
  );
  const byArticle = new Map<string, { files: Set<string>; ids: Set<string> }>();
  for (const r of assetsOfArticle.rows) {
    const cur = byArticle.get(r.article_id) ?? { files: new Set<string>(), ids: new Set<string>() };
    cur.files.add(r.filename);
    cur.ids.add(r.asset_id);
    byArticle.set(r.article_id, cur);
  }
  for (const a of imagesInBody.rows) {
    const declared = byArticle.get(a.id) ?? { files: new Set<string>(), ids: new Set<string>() };
    for (const img of extractImages(a.body_md)) {
      if (/^(https?:)?\/\//i.test(img.src)) continue;
      // Импорт переписывает ссылки на файлы в /api/assets/<id>, поэтому сверять
      // тут надо с id привязанного файла, а не с его именем. Локальный путь
      // (черновик, ещё не импортированный) сверяем по имени файла.
      const isInternal = img.src.startsWith('/api/assets/');
      const base = img.src.split('#')[0]!.split('?')[0]!.split('/').pop()!;
      const ok = isInternal ? declared.ids.has(base) : declared.files.has(base);
      if (!ok) {
        add({
          severity: 'error',
          code: 'IMAGE_NOT_LINKED',
          message: `в тексте есть «${img.src}», но файл не привязан к статье (в article_assets нет «${base}»)`,
          where: `статья «${a.title}»`,
          hint: 'Переимпортируйте статью, чтобы картинка зарегистрировалась в БД',
        });
      }
    }
  }

  /* --- 7. Прогресс обучения ------------------------------------------------ */

  const progressIssues = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM study_progress
      WHERE next_review_at < last_seen_at - interval '1 year'`,
  );
  void progressIssues;

  /* --- 8. Сводка ---------------------------------------------------------- */

  const [topics, articles, assets, links, words] = await Promise.all([
    queryOne<{ n: number }>('SELECT count(*)::int AS n FROM topics'),
    queryOne<{ n: number }>('SELECT count(*)::int AS n FROM articles'),
    queryOne<{ n: number }>('SELECT count(*)::int AS n FROM assets'),
    queryOne<{ n: number }>('SELECT count(*)::int AS n FROM article_links'),
    queryOne<{ n: number }>(`SELECT COALESCE(sum(array_length(regexp_split_to_array(body_md, '\\s+'), 1)), 0)::int AS n FROM articles`),
  ]);

  report.stats = {
    topics: topics?.n ?? 0,
    articles: articles?.n ?? 0,
    assets: assets?.n ?? 0,
    links: links?.n ?? 0,
    words: words?.n ?? 0,
    broken_links: brokenLinks.rowCount ?? 0,
  };

  report.durationMs = Date.now() - started;
  return report;
}
