import { memo, useCallback, useEffect, useMemo, useRef, useState, createContext, useContext } from 'react';
import { Link } from 'react-router-dom';
import type { TreeItem } from '../lib/tree';

/* ========================================================================== */
/*  Контекст: раскрытие + навигация                                          */
/* ========================================================================== */

export interface SidebarContextValue {
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  close: (id: string) => void;
  isOnTrail: (id: string) => boolean;
  isActiveTopic: (id: string) => boolean;
  isActiveArticle: (id: string) => boolean;
  isArticleMatch: (id: string) => boolean;
  register: (key: string, el: HTMLElement | null) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);
export const useSidebar = (): SidebarContextValue => {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar вызван вне <Sidebar>');
  return ctx;
};

const STORAGE_KEY = 'baza-sidebar-open';

function loadPersisted(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/* ========================================================================== */
/*  Порядок обхода для клавиатуры                                             */
/* ========================================================================== */

export type FocusKey = string; // `t:<topicId>` | `a:<articleId>`

interface FocusEntry {
  key: FocusKey;
  topicId: string;
  isTopic: boolean;
}

/** Визуальный порядок: рубрика -> её статьи -> дочерние рубрики. */
function visibleOrder(roots: TreeItem[], isOpen: (id: string) => boolean): FocusEntry[] {
  const out: FocusEntry[] = [];
  const visit = (item: TreeItem) => {
    out.push({ key: `t:${item.id}`, topicId: item.id, isTopic: true });
    if (!isOpen(item.id)) return;
    for (const a of item.articles) out.push({ key: `a:${a.id}`, topicId: item.id, isTopic: false });
    for (const c of item.children) visit(c);
  };
  roots.forEach(visit);
  return out;
}

export function flattenAll(items: TreeItem[], out: TreeItem[] = []): TreeItem[] {
  for (const i of items) {
    out.push(i);
    flattenAll(i.children, out);
  }
  return out;
}

/* ========================================================================== */
/*  Sidebar                                                                    */
/* ========================================================================== */

export interface SidebarProps {
  roots: TreeItem[];
  activeTopicId: string | null;
  activeArticleId: string | null;
  matchedArticles?: Set<string>;
  /** вызывается после перехода — мобильный сайдбар закрывается */
  onNavigate?: () => void;
}

export function Sidebar({ roots, activeTopicId, activeArticleId, matchedArticles, onNavigate }: SidebarProps) {
  const [open, setOpen] = useState<Set<string>>(loadPersisted);
  const registry = useRef(new Map<FocusKey, HTMLElement>());

  const index = useMemo(() => {
    const flat = flattenAll(roots);
    const byPath = new Map(flat.map((i) => [i.path.join('/'), i]));
    const byId = new Map(flat.map((i) => [i.id, i]));
    return { byPath, byId };
  }, [roots]);

  /** Предки активной страницы: подсвечиваем ветку и раскрываем её. */
  const trail = useMemo(() => {
    const set = new Set<string>();
    if (!activeTopicId) return set;
    let node = index.byId.get(activeTopicId);
    while (node) {
      set.add(node.id);
      const parentPath = node.path.slice(0, -1).join('/');
      node = parentPath ? index.byPath.get(parentPath) : undefined;
    }
    return set;
  }, [index, activeTopicId]);

  useEffect(() => {
    if (trail.size === 0) return;
    setOpen((prev) => {
      const next = new Set(prev);
      for (const id of trail) next.add(id);
      return next;
    });
  }, [trail]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...open]));
    } catch {
      /* приватный режим — просто не сохраняем */
    }
  }, [open]);

  const isOpen = useCallback(
    (id: string) => open.has(id) || trail.has(id),
    [open, trail],
  );

  const value = useMemo<SidebarContextValue>(
    () => ({
      isOpen,
      toggle: (id) =>
        setOpen((prev) => {
          const next = new Set(prev);
          next.has(id) ? next.delete(id) : next.add(id);
          return next;
        }),
      close: (id) =>
        setOpen((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        }),
      isOnTrail: (id) => trail.has(id),
      isActiveTopic: (id) => id === activeTopicId,
      isActiveArticle: (id) => id === activeArticleId,
      isArticleMatch: (id) => matchedArticles?.has(id) ?? false,
      register: (key, el) => {
        if (el) registry.current.set(key, el);
        else registry.current.delete(key);
      },
    }),
    [isOpen, trail, activeTopicId, activeArticleId, matchedArticles],
  );

  const order = useMemo(() => visibleOrder(roots, isOpen), [roots, isOpen]);
  const activeKey: FocusKey | null = activeArticleId
    ? `a:${activeArticleId}`
    : activeTopicId
      ? `t:${activeTopicId}`
      : null;

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const keys = order.map((o) => o.key);
      const pos = Math.max(0, keys.indexOf(activeKey ?? ''));
      const current = order[pos];
      const focus = (key: FocusKey) => registry.current.get(key)?.focus();
      const next = (delta: number) => {
        const target = keys[(pos + delta + keys.length) % keys.length];
        if (target) focus(target);
      };

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          next(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          next(-1);
          break;
        case 'ArrowRight': {
          if (!current) return;
          const topic = index.byId.get(current.topicId);
          if (current.isTopic && topic && topic.children.length + topic.articles.length > 0) {
            e.preventDefault();
            if (!isOpen(current.topicId)) value.toggle(current.topicId);
            else next(1);
          } else {
            e.preventDefault();
            next(1);
          }
          break;
        }
        case 'ArrowLeft': {
          if (!current) return;
          e.preventDefault();
          if (isOpen(current.topicId)) {
            value.close(current.topicId);
          } else {
            const topic = index.byId.get(current.topicId);
            const parentPath = topic?.path.slice(0, -1).join('/') ?? '';
            if (parentPath) {
              const parent = index.byPath.get(parentPath);
              if (parent) focus(`t:${parent.id}`);
            }
          }
          break;
        }
        case 'Home':
          e.preventDefault();
          if (keys[0]) focus(keys[0]);
          break;
        case 'End':
          e.preventDefault();
          if (keys.length) focus(keys[keys.length - 1]!);
          break;
        default:
          break;
      }
    },
    [order, activeKey, index, isOpen, value],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        role="tree"
        aria-label="Рубрики базы знаний"
        onKeyDown={onKeyDown}
        className="kb-scroll flex-1 overflow-y-auto overscroll-contain px-2 pb-10"
      >
        {roots.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-slate-500">Ничего не найдено</p>
        ) : (
          <ul role="none">
            {roots.map((root) => (
              <TreeNode key={root.id} item={root} level={0} onNavigate={onNavigate} />
            ))}
          </ul>
        )}
      </div>
    </SidebarContext.Provider>
  );
}

/* ========================================================================== */
/*  Узел дерева                                                                */
/* ========================================================================== */

export const TreeNode = memo(function TreeNode({
  item,
  level,
  onNavigate,
}: {
  item: TreeItem;
  level: number;
  onNavigate?: () => void;
}) {
  const ctx = useSidebar();
  const expanded = ctx.isOpen(item.id);
  const hasChildren = item.children.length > 0;
  const hasArticles = item.articles.length > 0;
  const isBranch = hasChildren || hasArticles;
  const onTrail = ctx.isOnTrail(item.id);
  const active = ctx.isActiveTopic(item.id);
  const key: FocusKey = `t:${item.id}`;
  const pad = 8 + level * 13;

  return (
    <li role="none" className="relative">
      <div
        className={[
          'kb-item group',
          active ? 'kb-item-active' : onTrail ? 'kb-item-ancestor' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingLeft: pad }}
      >
        {/* Шеверон: раскрытие, не навигация */}
        {isBranch ? (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={() => ctx.toggle(item.id)}
            className="grid size-4 shrink-0 place-items-center rounded text-slate-400 transition-transform hover:text-slate-700 dark:hover:text-slate-200"
            style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
          >
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          <span aria-hidden className="size-4 shrink-0" />
        )}

        <Link
          to={`/t/${item.path.join('/')}`}
          role="treeitem"
          aria-expanded={isBranch ? expanded : undefined}
          aria-current={active ? 'page' : undefined}
          tabIndex={-1}
          ref={(el) => ctx.register(key, el)}
          onClick={onNavigate}
          title={item.title}
          className="min-w-0 flex-1 truncate"
        >
          {item.title}
        </Link>

        {item.subtreeArticles > 0 && (
          <span
            className="shrink-0 rounded-full bg-slate-200/80 px-1.5 text-[11px] leading-4 font-medium text-slate-600 tabular-nums dark:bg-slate-800 dark:text-slate-400"
            title={`${item.subtreeArticles} статей в разделе`}
          >
            {item.subtreeArticles}
          </span>
        )}
      </div>

      {expanded && hasArticles && (
        <ul role="group" className="relative">
          {item.articles.map((a) => {
            const aKey: FocusKey = `a:${a.id}`;
            const aActive = ctx.isActiveArticle(a.id);
            const match = ctx.isArticleMatch(a.id);
            return (
              <li key={a.id} role="none" className="relative">
                <span aria-hidden className="kb-tree-line" style={{ left: pad + 7 }} />
                <Link
                  to={`/a/${a.id}`}
                  role="treeitem"
                  aria-current={aActive ? 'page' : undefined}
                  tabIndex={-1}
                  ref={(el) => ctx.register(aKey, el)}
                  onClick={onNavigate}
                  title={a.title}
                  className={[
                    'kb-item text-[13.5px]',
                    aActive
                      ? 'kb-item-active'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
                    match && !aActive ? 'bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ paddingLeft: pad + 22 }}
                >
                  <span className="min-w-0 flex-1 truncate">{a.title}</span>
                  {a.status !== 'published' && (
                    <span
                      className="shrink-0 rounded border border-amber-300 px-1 text-[10px] text-amber-700 dark:border-amber-700 dark:text-amber-400"
                      title={`Статус: ${a.status}`}
                    >
                      {a.status}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {expanded && hasChildren && (
        <ul role="group" className="relative">
          {item.children.map((child) => (
            <TreeNode key={child.id} item={child} level={level + 1} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </li>
  );
});
