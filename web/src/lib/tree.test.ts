import { describe, expect, it } from 'vitest';
import { buildTree, filterTree, flatten, indexTree, type TreeItem } from './tree';
import type { ArticleStub, TopicNode } from './types';

/** Плоский ответ API: 4 рубрики, 3 статьи. */
const nodes: TopicNode[] = [
  {
    id: 't1',
    parentId: null,
    slug: 'nalogovyy-kodeks',
    title: 'Налоговый кодекс',
    summary: null,
    kind: 'branch',
    depth: 0,
    path: ['nalogovyy-kodeks'],
    pathText: 'nalogovyy-kodeks',
    sortOrder: 0,
    isPublished: true,
    directArticles: 0,
    subtreeArticles: 2,
  },
  {
    id: 't2',
    parentId: 't1',
    slug: 'nds',
    title: 'НДС',
    summary: null,
    kind: 'leaf',
    depth: 1,
    path: ['nalogovyy-kodeks', 'nds'],
    pathText: 'nalogovyy-kodeks / nds',
    sortOrder: 0,
    isPublished: true,
    directArticles: 2,
    subtreeArticles: 2,
  },
  {
    id: 't3',
    parentId: null,
    slug: 'uchetnaya-politika',
    title: 'Учётная политика',
    summary: null,
    kind: 'branch',
    depth: 0,
    path: ['uchetnaya-politika'],
    pathText: 'uchetnaya-politika',
    sortOrder: 1,
    isPublished: true,
    directArticles: 1,
    subtreeArticles: 1,
  },
  {
    id: 't4',
    parentId: null,
    slug: 'otchetnost',
    title: 'Отчётность',
    summary: null,
    kind: 'branch',
    depth: 0,
    path: ['otchetnost'],
    pathText: 'otchetnost',
    sortOrder: 2,
    isPublished: true,
    directArticles: 0,
    subtreeArticles: 0,
  },
];

const articles: ArticleStub[] = [
  { id: 'a1', topicId: 't2', slug: 'nds-st-12', title: 'НДС: ставка 12 %', status: 'published' },
  { id: 'a2', topicId: 't2', slug: 'nds-st-15', title: 'НДС: льготы', status: 'draft' },
  { id: 'a3', topicId: 't3', slug: 'p6-1', title: 'Приказ об учётной политике', status: 'published' },
];

const tree = buildTree(nodes, articles);

describe('buildTree', () => {
  it('собирает корни в порядке sort_order', () => {
    expect(tree.map((t) => t.slug)).toEqual(['nalogovyy-kodeks', 'uchetnaya-politika', 'otchetnost']);
  });

  it('подвешивает рубрики к родителю', () => {
    expect(tree[0]!.children.map((c) => c.slug)).toEqual(['nds']);
  });

  it('развешивает статьи по рубрикам', () => {
    const nds = tree[0]!.children[0]!;
    expect(nds.articles.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('потерянные статьи не роняют сборку', () => {
    const orphan: ArticleStub = { id: 'x', topicId: 'нет-такой', slug: 's', title: 't', status: 'published' };
    expect(() => buildTree(nodes, [...articles, orphan])).not.toThrow();
    expect(flatten(buildTree(nodes, [...articles, orphan])).flatMap((i) => i.articles)).toHaveLength(3);
  });
});

describe('indexTree', () => {
  const index = indexTree(tree);

  it('находит рубрику по id', () => {
    expect(index.byId.get('t2')?.title).toBe('НДС');
  });

  it('возвращает цепочку предков от корня', () => {
    expect(index.ancestorsOf('t2').map((i) => i.slug)).toEqual(['nalogovyy-kodeks', 'nds']);
  });

  it('для корня возвращает только его самого', () => {
    expect(index.ancestorsOf('t1').map((i) => i.slug)).toEqual(['nalogovyy-kodeks']);
  });

  it('для неизвестного id — пустой массив', () => {
    expect(index.ancestorsOf('нет')).toEqual([]);
  });
});

describe('filterTree', () => {
  it('пустой запрос не фильтрует', () => {
    const result = filterTree(tree, '   ');
    expect(result.roots).toHaveLength(3);
    expect(result.expand.size).toBe(0);
  });

  it('находит рубрику по названию без учёта регистра и «ё»', () => {
    const result = filterTree(tree, 'УЧЕТНАЯ');
    expect(result.roots.map((t) => t.slug)).toEqual(['uchetnaya-politika']);
  });

  it('находит по «ё» и «е» как по одному символу', () => {
    expect(filterTree(tree, 'учет').roots).toHaveLength(1);
    expect(filterTree(tree, 'учёт').roots).toHaveLength(1);
  });

  it('поднимает к корню рубрику, совпавшую глубже', () => {
    const result = filterTree(tree, 'НДС');
    expect(result.roots.map((t) => t.slug)).toEqual(['nalogovyy-kodeks']);
    // рубрика «НДС» и её родитель должны быть раскрыты
    expect(result.expand.has('t1')).toBe(true);
    expect(result.expand.has('t2')).toBe(true);
  });

  it('подсвечивает совпавшие статьи', () => {
    const result = filterTree(tree, 'льготы');
    expect([...result.matchedArticles]).toEqual(['a2']);
  });

  it('находит по slug рубрики', () => {
    expect(filterTree(tree, 'p6-1').roots.map((t) => t.slug)).toEqual(['uchetnaya-politika']);
  });

  it('не находит — пустой результат', () => {
    const result = filterTree(tree, 'абракадабра');
    expect(result.roots).toHaveLength(0);
    expect(result.matchedArticles.size).toBe(0);
  });

  it('не ломает исходное дерево', () => {
    const before = tree.length;
    filterTree(tree, 'НДС');
    expect(tree).toHaveLength(before);
  });
});

describe('инварианты дерева', () => {
  it('глубина узла совпадает с длиной path', () => {
    for (const item of flatten(tree)) {
      expect(item.depth).toBe(item.path.length - 1);
    }
  });

  it('родитель всегда в path[0..n-1]', () => {
    const byPath = new Map(flatten(tree).map((i) => [i.path.join('/'), i]));
    for (const item of flatten(tree)) {
      if (item.depth === 0) continue;
      const parentPath = item.path.slice(0, -1).join('/');
      expect(byPath.get(parentPath)?.path.join('/')).toBe(parentPath);
    }
  });
});

/** Проверка, что TreeItem — переиспользуемая структура, а не any. */
const _typeCheck: TreeItem = tree[0]!;
void _typeCheck;
