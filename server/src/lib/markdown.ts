/**
 * Рендеринг Markdown + извлечение оглавления, ссылок и изображений.
 * Единая точка правды для всех потребителей: API, импортёр, валидатор.
 */
import { Marked, type Tokens } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { slugifyAnchor, uniqueAnchor } from './slug.js';

export interface TocItem {
  id: string;
  label: string;
  level: number;
}

export interface ExtractedLink {
  kind: 'internal' | 'external' | 'anchor' | 'file';
  rawTarget: string;
  label: string;
}

/** Локальные ссылки на файлы (docx, xlsx, pdf и т.п.), а не на статьи. */
const FILE_LINK_RE = /\.(?:docx?|xlsx?|pptx?|pdf|csv|zip|rar|txt|odt|ods|rtf)(?:$|[?#])/i;

export interface ExtractedImage {
  src: string;
  alt: string;
  title?: string;
  /** Картинка обёрнута в markdown-ссылку. */
  inLink?: boolean;
  /** Картинка находится в строке таблицы. */
  inTable?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Синтаксис ссылок                                                          */
/* -------------------------------------------------------------------------- */

/** Вики-ссылка: [[slug]], [[slug|подпись]], [[slug#якорь]] */
const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;
/**
 * Обычная ссылка: [текст](цель "title").
 * В label допускается одна вложенная пара скобок — иначе ссылка на картинку
 * [![Схема](images/x.jpg)](https://site) читалась бы как ссылка на images/x.jpg,
 * и валидатор считал бы файл статьёй.
 */
const MD_LINK_RE =
  /(!?)\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+["']([^"']*)["'])?\s*\)/g;
/**
 * Картинка ищется отдельной регуляркой: внутри ссылки
 * [![Схема](images/x.jpg)](https://site) разбор ссылок съедает всю конструкцию
 * целиком, и картинка без этого переставала бы попадать в статью.
 */
const IMAGE_RE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["']([^"']*)["'])?\s*\)/g;

function classifyTarget(target: string): ExtractedLink['kind'] {
  if (/^(https?:)?\/\//i.test(target) || /^(mailto|tel):/i.test(target)) return 'external';
  if (target.startsWith('#')) return 'anchor';
  // Локальные файлы (./file.docx, ../rubrika/file.xlsx) — не статьи
  if (FILE_LINK_RE.test(target)) return 'file';
  return 'internal';
}

export function extractLinks(markdown: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const seen = new Set<string>();
  const push = (l: ExtractedLink) => {
    const key = `${l.kind}::${l.rawTarget}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(l);
  };

  for (const m of markdown.matchAll(WIKILINK_RE)) {
    const [target, label] = splitWikilink(m[1] ?? '');
    push({ kind: classifyTarget(target), rawTarget: target, label: label ?? target });
  }

  for (const m of markdown.matchAll(MD_LINK_RE)) {
    if (m[1] === '!') continue; // изображения разбираются отдельно
    const target = m[3] ?? '';
    push({
      kind: classifyTarget(target),
      rawTarget: target,
      label: (m[2] ?? '').trim() || target,
    });
  }

  return out;
}

export function extractImages(markdown: string): ExtractedImage[] {
  const out: ExtractedImage[] = [];
  for (const m of markdown.matchAll(IMAGE_RE)) {
    const at = m.index ?? 0;
    const lineStart = markdown.lastIndexOf('\n', at) + 1;
    let lineEnd = markdown.indexOf('\n', at);
    if (lineEnd === -1) lineEnd = markdown.length;
    const line = markdown.slice(lineStart, lineEnd);
    const before = markdown.slice(lineStart, at);
    out.push({
      src: m[2] ?? '',
      alt: (m[1] ?? '').trim(),
      title: m[3],
      // [![](x.jpg)](url) — перед картинкой стоит открывающая скобка ссылки
      inLink: /\[$/.test(before),
      inTable: /^\s*\|/.test(line),
    });
  }
  return out;
}

/** [[slug#anchor|подпись]] -> { target: 'slug#anchor', label: 'подпись' } */
export function splitWikilink(inner: string): [target: string, label?: string] {
  const pipe = inner.indexOf('|');
  const raw = pipe === -1 ? inner : inner.slice(0, pipe);
  const label = pipe === -1 ? undefined : inner.slice(pipe + 1).trim();
  return [raw.trim(), label];
}

/** 'статья#якорь' -> { slug, anchor } */
export function splitAnchor(target: string): { slug: string; anchor: string | null } {
  const hash = target.indexOf('#');
  if (hash === -1) return { slug: target.trim(), anchor: null };
  return {
    slug: target.slice(0, hash).trim(),
    anchor: target.slice(hash + 1).trim() || null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Рендеринг                                                                 */
/* -------------------------------------------------------------------------- */

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'img', 'figure', 'figcaption', 'details', 'summary', 'mark', 'kbd', 'abbr',
  ],
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    '*': ['id', 'class', 'title', 'data-*'],
    a: ['href', 'name', 'target', 'rel', 'data-slug', 'data-anchor'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    td: ['colspan', 'rowspan', 'align'],
    th: ['colspan', 'rowspan', 'align', 'scope'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'data'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  // class разрешён, но опасен для атрибутных селекторов — оставляем как есть
  disallowedTagsMode: 'discard',
};

/**
 * Вики-ссылка как расширение Markdown: [[slug]], [[slug|текст]], [[slug#якорь]]
 * Превращается в <a href="/s/slug">, а клиент резолвит slug -> id статьи.
 */
const wikilinkExtension = {
  name: 'wikilink',
  level: 'inline' as const,
  start(src: string) {
    return src.indexOf('[[');
  },
  tokenizer(src: string) {
    const match = /^\[\[([^\]\n]+?)\]\]/.exec(src);
    if (!match) return undefined;
    return { type: 'wikilink', raw: match[0], text: match[1] ?? '' };
  },
  renderer(token: { text: string }) {
    const [target, label] = splitWikilink(token.text);
    const { slug, anchor } = splitAnchor(target);
    const href = `/s/${encodeURIComponent(slug)}${anchor ? '#' + encodeURIComponent(anchor) : ''}`;
    const text = escapeAttr(label ?? target);
    return `<a class="kb-wiki" href="${href}" data-slug="${escapeAttr(slug)}"${
      anchor ? ` data-anchor="${escapeAttr(anchor)}"` : ''
    }>${text}</a>`;
  },
};

/**
 * Рендерит Markdown в безопасный HTML и собирает оглавление.
 * Заголовки h2/h3 получают стабильные id, h1 не попадает в оглавление
 * (название статьи уже выводится отдельно).
 */
export function renderMarkdown(markdown: string): { html: string; toc: TocItem[] } {
  const toc: TocItem[] = [];
  const used = new Map<string, number>();

  const marked = new Marked({ gfm: true, breaks: false });

  marked.use({
    extensions: [wikilinkExtension],
    renderer: {
      heading(token: Tokens.Heading) {
        const label = this.parser.parseInline(token.tokens);
        const plain = stripTags(label);
        const depth = token.depth;
        const html = `<h${depth}>${label}</h${depth}>`;

        if (depth >= 2 && depth <= 4) {
          const id = uniqueAnchor(slugifyAnchor(plain), used);
          toc.push({ id, label: plain, level: depth });
          return `<h${depth} id="${id}">${label}</h${depth}>`;
        }
        return html;
      },
      image(token: Tokens.Image) {
        const title = token.title ? ` title="${escapeAttr(token.title)}"` : '';
        const alt = escapeAttr(token.text ?? '');
        return `<img src="${escapeAttr(token.href)}" alt="${alt}"${title} loading="lazy" />`;
      },
      table(token: Tokens.Table) {
        // В исходных материалах встречаются таблицы на 13 колонок. Без обёртки
        // они сжимаются в нечитаемую кашу, поэтому даём им горизонтальную
        // прокрутку, а сами — перенос по словам в ячейках.
        const head = token.header
          .map((cell, i) => {
            const align = token.align[i] ? ` align="${token.align[i]}"` : '';
            return `<th${align}>${this.parser.parseInline(cell.tokens)}</th>`;
          })
          .join('');
        const body = token.rows
          .map((row) => {
            const cells = row
              .map((cell, i) => {
                const align = token.align[i] ? ` align="${token.align[i]}"` : '';
                return `<td${align}>${this.parser.parseInline(cell.tokens)}</td>`;
              })
              .join('');
            return `<tr>${cells}</tr>`;
          })
          .join('');
        return `<div class="kb-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
      },
    },
  });

  const raw = marked.parse(markdown ?? '', { async: false });
  const html = sanitizeHtml(raw, SANITIZE_OPTIONS);
  return { html, toc };
}

export function sanitizeContent(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Оценка времени чтения: 180 слов/мин, минимум 1. */
export function readingMinutes(markdown: string): number {
  const words = (markdown.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  return Math.max(1, Math.round(words / 180));
}
