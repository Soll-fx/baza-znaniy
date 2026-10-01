import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './lib/api';
import { buildTree, filterTree, type TreeItem } from './lib/tree';
import { buildWikiIndex, WikiProvider, WikiResolver } from './lib/wiki';
import type { ArticleStub, TopicNode } from './lib/types';
import { Sidebar } from './components/Sidebar';
import { SearchBar } from './components/SearchBar';
import { ThemeToggle } from './components/ThemeToggle';
import { HomePage } from './components/HomePage';
import { ArticlePage } from './components/ArticlePage';
import { TopicPage } from './components/TopicPage';
import { CalculatorIndex } from './components/CalculatorIndex';
import { CalculatorPage } from './components/CalculatorPage';

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}

function Shell() {
  const [data, setData] = useState<{ nodes: TopicNode[]; articles: ArticleStub[] } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [filter, setFilter] = useState('');
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();

  useEffect(() => {
    api
      .tree()
      .then((res) => {
        setData({ nodes: res.nodes, articles: res.articles });
        setStatus('ready');
      })
      .catch((e: Error) => {
        console.error(e);
        setStatus('error');
      });
  }, []);

  useEffect(() => {
    setDrawer(false);
  }, [location.pathname]);

  useEffect(() => {
    document.body.style.overflow = drawer ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [drawer]);

  const roots = useMemo(
    () => (data ? buildTree(data.nodes, data.articles) : []),
    [data],
  );
  const wikiIndex = useMemo(
    () => (data ? buildWikiIndex(data.nodes, data.articles) : buildWikiIndex([], [])),
    [data],
  );

  // Активные элементы сайдбара вычисляются из маршрута
  const { activeTopicId, activeArticleId, matchedArticles } = useMemo(
    () => resolveActive(roots, location.pathname, filter),
    [roots, location.pathname, filter],
  );

  const filtered = useMemo(() => filterTree(roots, filter), [roots, filter]);
  const closeDrawer = useCallback(() => setDrawer(false), []);

  return (
    <WikiProvider value={wikiIndex}>
      <div className="flex h-full">
      {/* ---------- Сайдбар (десктоп) ---------- */}
      <aside className="hidden w-80 shrink-0 flex-col border-r border-slate-200 bg-slate-100/70 lg:flex dark:border-slate-800 dark:bg-slate-900/40">
        <div className="flex items-center gap-2 px-4 py-3">
          <Logo />
          <ThemeToggle />
        </div>
        <div className="px-4 pb-3">
          <SearchBar />
        </div>
        <div className="px-4 pb-2">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Фильтр рубрик…"
            aria-label="Фильтр рубрик"
            className="w-full rounded-lg border border-transparent bg-white/70 px-3 py-1.5 text-[13px]
                       placeholder:text-slate-400 focus:border-blue-300 focus:outline-none dark:bg-slate-800/60"
          />
        </div>
        {status === 'loading' && <TreeSkeleton />}
        {status === 'error' && <ErrorHint />}
        {status === 'ready' && (
          <Sidebar
            roots={filtered.roots}
            activeTopicId={activeTopicId}
            activeArticleId={activeArticleId}
            matchedArticles={matchedArticles}
          />
        )}
        <div className="border-t border-slate-200 px-4 py-2 text-[11px] text-slate-400 dark:border-slate-800">
          ↑↓ — навигация, → раскрыть, ← свернуть
        </div>
      </aside>

      {/* ---------- Мобильный drawer ---------- */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Закрыть меню"
            className="absolute inset-0 bg-slate-900/50"
            onClick={closeDrawer}
          />
          <aside className="relative flex h-full w-[85%] max-w-sm flex-col bg-slate-100 shadow-2xl dark:bg-slate-900">
            <div className="flex items-center gap-2 px-4 py-3">
              <Logo />
              <button
                type="button"
                onClick={closeDrawer}
                className="ml-auto grid size-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
                aria-label="Закрыть меню"
              >
                <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="px-4 pb-3">
              <SearchBar onNavigate={closeDrawer} />
            </div>
            <Sidebar
              roots={filtered.roots}
              activeTopicId={activeTopicId}
              activeArticleId={activeArticleId}
              matchedArticles={matchedArticles}
              onNavigate={closeDrawer}
            />
          </aside>
        </div>
      )}

      {/* ---------- Контент ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 lg:hidden dark:border-slate-800 dark:bg-slate-900">
          <button
            type="button"
            onClick={() => setDrawer(true)}
            aria-label="Открыть меню"
            className="grid size-9 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 6h14M3 10h14M3 14h14" strokeLinecap="round" />
            </svg>
          </button>
          <span className="truncate text-sm font-medium">База знаний</span>
          <ThemeToggle />
        </header>

        <main className="kb-scroll flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/a/:id" element={<ArticlePage />} />
            <Route path="/t/*" element={<TopicPage />} />
            <Route path="/s/:slug" element={<WikiResolver />} />
            <Route path="/kalkulyatory" element={<CalculatorIndex />} />
            <Route path="/k/:id" element={<CalculatorPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
        </div>
      </div>
    </WikiProvider>
  );
}

/* -------------------------------------------------------------------------- */

function resolveActive(roots: TreeItem[], pathname: string, filter: string) {
  const flat = flatten(roots);
  const byPath = new Map(flat.map((i) => [i.path.join('/'), i]));

  let activeTopicId: string | null = null;
  let activeArticleId: string | null = null;

  const articleMatch = /^\/a\/([0-9a-f-]{36})$/i.exec(pathname);
  if (articleMatch) {
    activeArticleId = articleMatch[1]!.toLowerCase();
    const owner = flat.find((i) => i.articles.some((a) => a.id === activeArticleId));
    activeTopicId = owner?.id ?? null;
  } else {
    const topicMatch = /^\/t\/(.*)$/.exec(pathname);
    if (topicMatch) {
      activeTopicId = byPath.get(topicMatch[1]!.split('/').filter(Boolean).join('/'))?.id ?? null;
    }
  }

  const matchedArticles = new Set<string>();
  if (filter.trim()) {
    for (const item of flat) {
      for (const a of item.articles) {
        if (a.title.toLowerCase().includes(filter.toLowerCase())) matchedArticles.add(a.id);
      }
    }
  }

  return { activeTopicId, activeArticleId, matchedArticles };
}

function flatten(items: TreeItem[], out: TreeItem[] = []): TreeItem[] {
  for (const i of items) {
    out.push(i);
    flatten(i.children, out);
  }
  return out;
}

function Logo() {
  return (
    <a href="/" className="flex min-w-0 items-center gap-2 text-slate-900 dark:text-white">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-blue-600 text-sm font-bold text-white">
        Б
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">База знаний</span>
        <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">бухгалтерия</span>
      </span>
    </a>
  );
}

function TreeSkeleton() {
  return (
    <div className="animate-pulse space-y-2 px-4 pt-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="h-6 rounded bg-slate-200/70 dark:bg-slate-800/70"
          style={{ marginLeft: (i % 3) * 12 }}
        />
      ))}
    </div>
  );
}

function ErrorHint() {
  return (
    <div className="m-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
      <strong>Нет связи с API.</strong>
      <p className="mt-1">Проверьте, что бэкенд запущен: <code>npm run dev:api</code></p>
    </div>
  );
}

function NotFound() {
  return (
    <div className="px-6 py-16 text-center">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Страница не найдена</h1>
      <a href="/" className="mt-2 inline-block text-sm text-blue-700 hover:underline dark:text-blue-300">
        На главную
      </a>
    </div>
  );
}
