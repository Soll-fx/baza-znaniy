/**
 * Сборка дерева из плоского ответа API + фильтрация для поиска по сайдбару.
 */
import type { ArticleStub, TopicNode } from './types';

export interface TreeArticle extends ArticleStub {
  nodeId: string;
}

export interface TreeItem {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  kind: 'branch' | 'leaf';
  depth: number;
  path: string[];
  sortOrder: number;
  subtreeArticles: number;
  articles: TreeArticle[];
  children: TreeItem[];
  /** id активной статьи, если эта ветка содержит текущую (для подсветки предков) */
}

export function buildTree(nodes: TopicNode[], articles: ArticleStub[]): TreeItem[] {
  const byId = new Map<string, TreeItem>();

  for (const n of nodes) {
    byId.set(n.id, {
      id: n.id,
      slug: n.slug,
      title: n.title,
      summary: n.summary,
      kind: n.kind,
      depth: n.depth,
      path: n.path,
      sortOrder: n.sortOrder,
      subtreeArticles: n.subtreeArticles,
      articles: [],
      children: [],
    });
  }

  for (const a of articles) {
    byId.get(a.topicId)?.articles.push({ ...a, nodeId: a.topicId });
  }

  const roots: TreeItem[] = [];
  for (const n of nodes) {
    const item = byId.get(n.id)!;
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    if (parent) parent.children.push(item);
    else roots.push(item);
  }

  const sortRec = (list: TreeItem[]) => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, 'ru'));
    list.forEach((i) => sortRec(i.children));
  };
  sortRec(roots);

  return roots;
}

export function flatten(items: TreeItem[], out: TreeItem[] = []): TreeItem[] {
  for (const item of items) {
    out.push(item);
    flatten(item.children, out);
  }
  return out;
}

export interface TreeIndex {
  byId: Map<string, TreeItem>;
  /** topicId -> цепочка предков от корня (включая саму тему) */
  ancestorsOf: (id: string) => TreeItem[];
  all: TreeItem[];
}

export function indexTree(roots: TreeItem[]): TreeIndex {
  const all = flatten(roots);
  const byId = new Map(all.map((i) => [i.id, i]));
  const byPath = new Map(all.map((i) => [i.path.join('/'), i]));

  const ancestorsOf = (id: string): TreeItem[] => {
    const item = byId.get(id);
    if (!item) return [];
    return item.path.map((_slug, i) => byPath.get(item.path.slice(0, i + 1).join('/'))).filter((x): x is TreeItem => !!x);
  };

  return { byId, ancestorsOf, all };
}

/* -------------------------------------------------------------------------- */
/*  Фильтрация                                                                */
/* -------------------------------------------------------------------------- */

export interface FilterResult {
  roots: TreeItem[];
  /** id рубрик, которые нужно раскрыть, чтобы были видны совпадения */
  expand: Set<string>;
  matchedArticles: Set<string>;
}

const normalize = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim();

/**
 * Оставляет рубрики, у которых совпадение в названии, в подрубриках
 * или в статьях, и поднимает к корню. Остальное скрывается.
 */
export function filterTree(roots: TreeItem[], rawQuery: string): FilterResult {
  const q = normalize(rawQuery);
  const expand = new Set<string>();
  const matchedArticles = new Set<string>();

  if (!q) return { roots, expand, matchedArticles };

  const visit = (item: TreeItem): boolean => {
    const selfMatch = normalize(item.title).includes(q) || item.slug.includes(q);
    const articleMatches = item.articles.filter(
      (a) => normalize(a.title).includes(q) || a.slug.includes(q),
    );
    for (const a of articleMatches) matchedArticles.add(a.id);

    const childMatches = item.children.map(visit);
    const hasChildMatch = childMatches.some(Boolean);

    if (selfMatch || articleMatches.length > 0 || hasChildMatch) {
      expand.add(item.id);
      return true;
    }
    return false;
  };

  const filtered = roots.filter(visit);
  return { roots: filtered, expand, matchedArticles };
}

/** Уникальные подсказки для выпадающего списка поиска. */
export function collectSuggestions(items: TreeItem[], limit = 200): { id: string; title: string; pathText: string; kind: 'topic' | 'article' }[] {
  const out: { id: string; title: string; pathText: string; kind: 'topic' | 'article' }[] = [];
  for (const item of flatten(items).slice(0, limit)) {
    out.push({ id: item.id, title: item.title, pathText: item.path.join(' / '), kind: 'topic' });
    for (const a of item.articles) {
      out.push({ id: a.id, title: a.title, pathText: item.path.join(' / '), kind: 'article' });
    }
  }
  return out;
}
