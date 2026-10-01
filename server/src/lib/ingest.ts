/**
 * Ядро импорта: нормализованное дерево -> PostgreSQL.
 * Одна и та же логика используется и CLI-скриптами, и тестами.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { renderMarkdown, readingMinutes, extractLinks, splitAnchor, extractImages } from './markdown.js';
import { saveBuffer, sha256, imageSize, kindFor, mimeFor } from './storage.js';
import { slugify } from './slug.js';
import { isDecorativeImage } from './images.js';

export type ArticleStatus = 'draft' | 'review' | 'published' | 'archived';
export type AssetRole = 'cover' | 'inline' | 'attachment' | 'diagram';

export interface IngestAsset {
  /** Путь к файлу относительно каталога контента (или абсолютный) */
  file: string;
  role?: AssetRole;
  alt?: string;
  caption?: string;
  position?: number;
  blockAnchor?: string;
  sourceUrl?: string;
  /** Явно помеченная декоративная картинка (перекрывает автоопределение). */
  decorative?: boolean;
}

export interface IngestArticle {
  slug: string;
  title: string;
  summary?: string;
  bodyMd: string;
  status?: ArticleStatus;
  sourceUrl?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  assets?: IngestAsset[];
}

export interface IngestTopic {
  slug: string;
  title: string;
  summary?: string;
  sourceUrl?: string;
  sortOrder?: number;
  isPublished?: boolean;
  children?: IngestTopic[];
  article?: IngestArticle;
  /** Заметки для валидатора: игнорируются при записи в БД */
  notes?: string;
}

export interface BrokenLink {
  article: string;
  target: string;
  reason: string;
}

export interface IngestReport {
  topicsCreated: number;
  topicsUpdated: number;
  articlesCreated: number;
  articlesUpdated: number;
  assetsNew: number;
  assetsLinked: number;
  missingFiles: string[];
  brokenLinks: BrokenLink[];
  warnings: string[];
  durationMs: number;
}

function emptyReport(): IngestReport {
  return {
    topicsCreated: 0,
    topicsUpdated: 0,
    articlesCreated: 0,
    articlesUpdated: 0,
    assetsNew: 0,
    assetsLinked: 0,
    missingFiles: [],
    brokenLinks: [],
    warnings: [],
    durationMs: 0,
  };
}

interface PendingLink {
  fromId: string;
  articleRef: string;
  target: string;
  kind: 'internal' | 'external' | 'anchor';
}

export interface IngestOptions {
  /** Базовый каталог для относительных путей к файлам-ассетам */
  baseDir: string;
  /** 'upsert' — обновлять существующие, 'skip' — не трогать, 'error' — падать */
  conflict?: 'upsert' | 'skip' | 'error';
  dryRun?: boolean;
}

/**
 * Загружает дерево в БД внутри одной транзакции.
 * Идемпотентна: повторный запуск с теми же данными ничего не ломает.
 */
export async function ingestTree(
  client: PoolClient,
  tree: IngestTopic[],
  options: IngestOptions,
): Promise<IngestReport> {
  const started = Date.now();
  const report = emptyReport();
  const conflict = options.conflict ?? 'upsert';
  const pendingLinks: PendingLink[] = [];
  const seenPaths = new Set<string>();
  const assetByChecksum = new Map<string, string>(); // checksum -> asset id

  async function walk(nodes: IngestTopic[], parentId: string | null, trail: string[]): Promise<void> {
    const ordered = [...nodes].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    for (const [index, node] of ordered.entries()) {
      const slug = node.slug || slugify(node.title);
      const topicPath = [...trail, slug];
      const pathKey = topicPath.join('/');

      if (seenPaths.has(pathKey)) {
        report.warnings.push(`Дубликат пути рубрики: ${pathKey}`);
        continue;
      }
      seenPaths.add(pathKey);

      const hasChildren = (node.children?.length ?? 0) > 0;
      const kind = hasChildren ? 'branch' : 'leaf';
      const sortOrder = node.sortOrder ?? index;

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM topics
          WHERE slug = $1 AND parent_id IS NOT DISTINCT FROM $2`,
        [slug, parentId],
      );
      const prior = existing.rows[0];

      let topicId: string;
      if (prior) {
        topicId = prior.id;
        if (conflict === 'skip') {
          report.topicsUpdated += 1;
        } else if (conflict === 'error') {
          throw new Error(`Рубрика уже существует: ${pathKey}`);
        } else {
          await client.query(
            `UPDATE topics
                SET title = $2, summary = $3, sort_order = $4,
                    is_published = $5, source_url = COALESCE($6, source_url)
              WHERE id = $1`,
            [topicId, node.title, node.summary ?? null, sortOrder, node.isPublished ?? true, node.sourceUrl ?? null],
          );
          report.topicsUpdated += 1;
        }
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO topics (parent_id, slug, title, summary, kind, sort_order, is_published, source_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [parentId, slug, node.title, node.summary ?? null, kind, sortOrder, node.isPublished ?? true, node.sourceUrl ?? null],
        );
        topicId = inserted.rows[0]!.id;
        report.topicsCreated += 1;
      }

      if (node.article) {
        const articleId = await upsertArticle(client, node.article, topicId, {
          conflict,
          report,
          pendingLinks,
          assetByChecksum,
          options,
        });
        if (articleId) {
          // Файлы привязываем после статьи: сначала узнаём id каждого файла,
          // затем подставляем их в текст — иначе в HTML остаётся относительный
          // путь, который в браузере ищется от /article/<slug> и даёт 404.
          const rewritten = await linkAssets(client, articleId, node.article, topicId, {
            report, assetByChecksum, options,
          });
          if (rewritten.size > 0) {
            let bodyMd = node.article.bodyMd;
            for (const [from, to] of rewritten) bodyMd = bodyMd.split(from).join(to);
            const { html } = renderMarkdown(bodyMd);
            await client.query('UPDATE articles SET body_md = $2, body_html = $3 WHERE id = $1', [
              articleId, bodyMd, html,
            ]);
          }
        }
      }

      if (hasChildren) await walk(node.children!, topicId, topicPath);
    }
  }

  await walk(tree, null, []);
  await resolveLinks(client, pendingLinks, report);

  report.durationMs = Date.now() - started;
  return report;
}

interface ArticleCtx {
  conflict: 'upsert' | 'skip' | 'error';
  report: IngestReport;
  pendingLinks: PendingLink[];
  assetByChecksum: Map<string, string>;
  options: IngestOptions;
}

async function upsertArticle(
  client: PoolClient,
  article: IngestArticle,
  topicId: string,
  ctx: ArticleCtx,
): Promise<string | null> {
  const slug = article.slug || slugify(article.title);
  const { html, toc } = renderMarkdown(article.bodyMd);
  const status = article.status ?? 'draft';

  const prior = await client.query<{ id: string; version: number }>(
    'SELECT id, version FROM articles WHERE topic_id = $1 AND slug = $2',
    [topicId, slug],
  );
  const existing = prior.rows[0];

  if (existing && ctx.conflict === 'error') {
    throw new Error(`Статья уже существует: ${slug}`);
  }

  if (existing && ctx.conflict === 'skip') {
    ctx.report.articlesUpdated += 1;
    return null;
  }

  const params = [
    topicId,
    slug,
    article.title,
    article.summary ?? null,
    article.bodyMd,
    html,
    JSON.stringify(toc),
    status,
    readingMinutes(article.bodyMd),
    article.effectiveFrom ?? null,
    article.effectiveTo ?? null,
    article.sourceUrl ?? null,
  ];

  if (existing) {
    // params начинается с topic_id (нужен для INSERT), а в UPDATE $1 — это
    // id самой статьи, поэтому собираем свой список с нуля.
    const updateParams = [existing.id, slug, ...params.slice(2)];
    const bumped = await client.query<{ version: number }>(
      `UPDATE articles
          SET title = $3, summary = $4, body_md = $5, body_html = $6, toc = $7,
              status = $8, reading_minutes = $9, effective_from = $10,
              effective_to = $11, source_url = COALESCE($12, source_url),
              version = version + 1, updated_at = now()
        WHERE id = $1 AND slug = $2
        RETURNING version`,
      updateParams,
    );
    const version = bumped.rows[0]!.version;
    await client.query(
      `INSERT INTO article_revisions (article_id, version, title, body_md, editor, note)
       VALUES ($1, $2, $3, $4, 'importer', 'автоимпорт')`,
      [existing.id, version, article.title, article.bodyMd],
    );
    ctx.report.articlesUpdated += 1;
    return existing.id;
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO articles
       (topic_id, slug, title, summary, body_md, body_html, toc, status,
        reading_minutes, effective_from, effective_to, source_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    params,
  );
  const articleId = inserted.rows[0]!.id;
  await client.query(
    `INSERT INTO article_revisions (article_id, version, title, body_md, editor, note)
     VALUES ($1, 1, $2, $3, 'importer', 'первичный импорт')`,
    [articleId, article.title, article.bodyMd],
  );
  ctx.report.articlesCreated += 1;

  for (const link of extractLinks(article.bodyMd)) {
    if (link.kind === 'file') continue; // локальные файлы-ассеты, а не статьи
    ctx.pendingLinks.push({ fromId: articleId, articleRef: slug, target: link.rawTarget, kind: link.kind });
  }
  return articleId;
}

interface AssetCtx {
  report: IngestReport;
  assetByChecksum: Map<string, string>;
  options: IngestOptions;
}

async function linkAssets(
  client: PoolClient,
  articleId: string,
  article: IngestArticle,
  topicId: string,
  ctx: AssetCtx,
): Promise<Map<string, string>> {
  const declared = article.assets ?? [];
  /** относительный путь в тексте -> /api/assets/<id> */
  const rewritten = new Map<string, string>();

  // Пути, как они выглядят в тексте статьи. В assets[] путь хранится
  // относительно корня контента, а в разметке — относительно каталога статьи,
  // поэтому сопоставляем их по обоим вариантам.
  const bodySrcs = extractImages(article.bodyMd)
    .map((i) => i.src)
    .filter((s) => s && !/^(https?:)?\/\//i.test(s));

  // Локальные ссылки на файлы ([текст](./file.docx)) — после привязки
  // заменяются на /api/assets/<id>, как и src у изображений.
  const fileTargets = extractLinks(article.bodyMd)
    .filter((l) => l.kind === 'file' && !/^(https?:)?\/\//i.test(l.rawTarget))
    .map((l) => l.rawTarget.split('#')[0]!.split('?')[0]!.replace(/^\.\//, ''));

  // Файлы, упомянутые в тексте, но не объявленные в манифесте — тоже подхватываем
  const declaredSrcs = new Set(declared.map((a) => a.file));
  const bodyImages = extractImages(article.bodyMd).filter(
    (img) => img.src && !/^(https?:)?\/\//i.test(img.src),
  );

  /**
   * Контекст картинки в разметке, собранный по всем её вхождениям.
   * Нужен, потому что для объявленных в assets[] файлов запись из текста
   * отбрасывается, а без неё картинка выглядела бы обычной картинкой
   * в тексте, даже если на деле это логотип в таблице или баннер в ссылке.
   */
  const sigBySrc = new Map<string, { inLink: boolean; inTable: boolean }>();
  for (const img of bodyImages) {
    const prev = sigBySrc.get(img.src);
    sigBySrc.set(img.src, {
      // картинка в ссылке где-либо = баннер
      inLink: (prev?.inLink ?? false) || !!img.inLink,
      // логотипом считаем только то, что везде в таблице
      inTable: (prev?.inTable ?? true) && !!img.inTable,
    });
  }
  const signalsFor = (file: string): { inLink: boolean; inTable: boolean } => {
    const direct = sigBySrc.get(file);
    if (direct) return direct;
    for (const [src, sig] of sigBySrc) {
      if (file.endsWith(`/${src}`)) return sig;
    }
    return { inLink: false, inTable: false };
  };
  const fromBody: IngestAsset[] = bodyImages.map((img, i) => ({
    file: img.src,
    alt: img.alt,
    role: 'inline' as const,
    position: i,
  }));

  /**
   * Картинка объявлена, если её путь совпал с assets[] напрямую или как
   * суффикс: в разметке src относителен каталогу статьи («images/файл.png»),
   * а в assets[] — корню контента («rubrika/images/файл.png»). Сравнение
   * только по точному равенству пропускало бы такую картинку, и она
   * обрабатывалась бы второй раз уже с неверным путём — как «файл не найден».
   */
  const isDeclared = (src: string): boolean => {
    if (declaredSrcs.has(src)) return true;
    for (const f of declaredSrcs) if (f.endsWith(`/${src}`)) return true;
    return false;
  };

  const undeclared = fromBody.filter((a) => !isDeclared(a.file));
  const all = [...declared, ...undeclared];
  if (undeclared.length) {
    ctx.report.warnings.push(
      `Статья «${article.title}»: ${undeclared.length} изображени(й) упомянуто в тексте, но не описано в assets[]`,
    );
  }

  for (const [index, item] of all.entries()) {
    const abs = path.resolve(ctx.options.baseDir, item.file);
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch {
      ctx.report.missingFiles.push(item.file);
      ctx.report.warnings.push(`Файл не найден: ${item.file} (статья «${article.title}»)`);
      continue;
    }

    const checksum = sha256(buf);
    const cached = ctx.assetByChecksum.get(checksum);

    // Картинка считается декоративной по контексту в разметке и размерам.
    const dims = await imageSize(buf);
    const signals = signalsFor(item.file);
    const decorative =
      item.decorative ??
      isDecorativeImage({
        inLink: signals.inLink,
        inTable: signals.inTable,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        role: item.role,
      });

    let assetId = cached;
    if (assetId) {
      // Тот же файл уже загружен в этой сессии импорта. Повторное вхождение
      // всё равно уточняет классификацию: если хотя бы раз картинка
      // содержательная, общий asset не должен остаться декоративным.
      if (!decorative) {
        await client.query('UPDATE assets SET decorative = false WHERE id = $1', [assetId]);
      }
    }
    if (!assetId) {
      const stored = await saveBuffer(buf, path.basename(item.file));
      const prior = await client.query<{ id: string }>(
        'SELECT id FROM assets WHERE storage_key = $1',
        [stored.storageKey],
      );
      if (prior.rows[0]) {
        // Файл остался от прошлого импорта: переиспользуем строку,
        // но alt мог появиться в разметке — обновляем описание.
        assetId = prior.rows[0].id;
        if (item.alt) {
          await client.query('UPDATE assets SET alt = $1 WHERE id = $2', [item.alt, assetId]);
        }
        if (!decorative) {
          await client.query('UPDATE assets SET decorative = false WHERE id = $1', [assetId]);
        }
      } else {
        const ins = await client.query<{ id: string }>(
          `INSERT INTO assets (kind, filename, storage_key, mime, bytes, checksum, width, height, alt, caption, source_url, decorative)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id`,
          [
            kindFor(mimeFor(item.file)),
            path.basename(item.file),
            stored.storageKey,
            stored.mime,
            stored.bytes,
            stored.checksum,
            dims?.width ?? null,
            dims?.height ?? null,
            item.alt ?? null,
            item.caption ?? null,
            item.sourceUrl ?? null,
            decorative,
          ],
        );
        assetId = ins.rows[0]!.id;
        ctx.report.assetsNew += 1;
      }
      ctx.assetByChecksum.set(checksum, assetId);
    }

    await client.query(
      `INSERT INTO article_assets (article_id, asset_id, role, position, block_anchor)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (article_id, asset_id, role)
       DO UPDATE SET position = EXCLUDED.position, block_anchor = EXCLUDED.block_anchor`,
      [articleId, assetId, item.role ?? 'inline', item.position ?? index, item.blockAnchor ?? null],
    );
    ctx.report.assetsLinked += 1;
    // Файл из текста статьи: запоминаем, на что заменить путь в разметке
    const url = `/api/assets/${assetId}`;
    if (item.role === 'inline') {
      for (const src of bodySrcs) {
        if (item.file === src || item.file.endsWith(`/${src}`)) rewritten.set(src, url);
      }
    }
    const base = path.posix.basename(item.file);
    for (const t of fileTargets) {
      const tm = t.replace(/^\.\//, '');
      if (item.file === tm || item.file.endsWith(`/${tm}`) || base === tm) {
        rewritten.set(`./${tm}`, url);
      }
    }
  }

  void topicId;
  return rewritten;
}

/** Вторая фаза: проставляем article_links.to_id. */
async function resolveLinks(
  client: PoolClient,
  pending: PendingLink[],
  report: IngestReport,
): Promise<void> {
  if (pending.length === 0) return;

  const rows = await client.query<{ id: string; slug: string; topic_path: string; title: string }>(
    `SELECT a.id, a.slug, array_to_string(t.path, '/') AS topic_path, a.title
       FROM articles a JOIN topics t ON t.id = a.topic_id`,
  );

  const bySlug = new Map<string, string[]>();      // slug -> [id]
  const byFullPath = new Map<string, string>();   // topic_path/slug -> id
  const byTitle = new Map<string, string>();      // lower(title) -> id

  for (const r of rows.rows) {
    const list = bySlug.get(r.slug) ?? [];
    list.push(r.id);
    bySlug.set(r.slug, list);
    byFullPath.set(`${r.topic_path}/${r.slug}`, r.id);
    byTitle.set(r.title.toLowerCase(), r.id);
  }

  for (const link of pending) {
    let toId: string | null = null;
    const { slug, anchor } = splitAnchor(link.target);
    const clean = slug.replace(/\.md$/i, '');

    if (clean) {
      const direct = byFullPath.get(clean) ?? byFullPath.get(clean.replace(/^\//, ''));
      if (direct) {
        toId = direct;
      } else {
        const candidates = bySlug.get(clean) ?? [];
        if (candidates.length === 1) {
          toId = candidates[0]!;
        } else if (candidates.length > 1) {
          byTitle.get(clean)?.length; // несколько совпадений — трактуем как неоднозначность
          toId = null;
        } else {
          toId = byTitle.get(clean.toLowerCase()) ?? null;
        }
      }
    } else if (anchor) {
      toId = link.fromId; // ссылка на якорь внутри той же статьи
    }

    if (link.kind === 'internal' && !toId) {
      report.brokenLinks.push({
        article: link.articleRef,
        target: link.target,
        reason: candidatesInfo(link.target),
      });
    }

    await client.query(
      `INSERT INTO article_links (from_id, kind, raw_target, to_id, resolved_slug)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (from_id, kind, raw_target)
       DO UPDATE SET to_id = EXCLUDED.to_id, resolved_slug = EXCLUDED.resolved_slug`,
      [link.fromId, link.kind, link.target, toId, toId ? await slugOf(client, toId) : null],
    );
  }
}

function candidatesInfo(target: string): string {
  return `цель «${target}» не найдена среди статей`;
}

async function slugOf(client: PoolClient, id: string): Promise<string | null> {
  const res = await client.query<{ slug: string }>('SELECT slug FROM articles WHERE id = $1', [id]);
  return res.rows[0]?.slug ?? null;
}
