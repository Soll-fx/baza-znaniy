import { useEffect, useMemo, useState, createContext, useContext } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type { ArticleStub, TopicNode } from './types';

/** Индекс slug -> статья, построенный из дерева: нужен для резолва [[вики-ссылок]]. */
export interface WikiIndex {
  bySlug: Map<string, ArticleStub[]>;
  byTopicPath: Map<string, TopicNode>;
  byId: Map<string, TopicNode>;
}

const WikiContext = createContext<WikiIndex | null>(null);
export const WikiProvider = WikiContext.Provider;
export const useWiki = (): WikiIndex => {
  const ctx = useContext(WikiContext);
  if (!ctx) throw new Error('useWiki вне <WikiProvider>');
  return ctx;
};

export function buildWikiIndex(nodes: TopicNode[], articles: ArticleStub[]): WikiIndex {
  const bySlug = new Map<string, ArticleStub[]>();
  for (const a of articles) {
    bySlug.set(a.slug, [...(bySlug.get(a.slug) ?? []), a]);
  }
  return {
    bySlug,
    byTopicPath: new Map(nodes.map((n) => [n.path.join('/'), n])),
    byId: new Map(nodes.map((n) => [n.id, n])),
  };
}

/**
 * Страница-редирект для /s/<slug> — цель вики-ссылок [[slug]].
 * Если slug неоднозначен или не найден, показываем это явно, а не молча.
 */
export function WikiResolver() {
  const { slug = '' } = useParams();
  const index = useWiki();
  const [attempted, setAttempted] = useState(false);

  const candidates = useMemo(() => index.bySlug.get(decodeURIComponent(slug)) ?? [], [index, slug]);

  useEffect(() => setAttempted(true), []);

  if (candidates.length === 1) {
    const target = candidates[0]!;
    return <Navigate to={`/a/${target.id}${window.location.hash}`} replace />;
  }

  if (!attempted) return null;

  return (
    <div className="mx-auto max-w-xl px-6 py-16 text-center">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-white">
        {candidates.length === 0 ? 'Статья не найдена' : 'Неоднозначная ссылка'}
      </h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        {candidates.length === 0 ? (
          <>
            По ссылке <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">{slug}</code> статьи нет.
            Возможно, её ещё не импортировали.
          </>
        ) : (
          <>
            Под слагом <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">{slug}</code>{' '}
            числится {candidates.length} статей — уточните ссылку в тексте.
          </>
        )}
      </p>
      {candidates.length > 1 && (
        <ul className="mt-4 space-y-1 text-left">
          {candidates.map((c) => (
            <li key={c.id}>
              <Link to={`/a/${c.id}`} className="text-sm text-blue-700 hover:underline dark:text-blue-300">
                {c.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/" className="mt-6 inline-block text-sm text-slate-500 hover:underline">
        На главную
      </Link>
    </div>
  );
}
