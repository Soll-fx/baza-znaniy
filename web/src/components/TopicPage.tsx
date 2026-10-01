import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate } from '../lib/api';
import type { Topic } from '../lib/types';
import { Breadcrumbs, type Crumb } from './Breadcrumbs';
import { ErrorCard } from './ArticlePage';

const PAGE_SIZE = 40;

export function TopicPage() {
  const params = useParams();
  const path = (params['*'] ?? '').split('/').filter(Boolean);
  const [topic, setTopic] = useState<Topic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'date' | 'title'>('date');
  const [visible, setVisible] = useState(PAGE_SIZE);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .topicByPath(path)
      .then((t) => {
        if (!alive) return;
        setTopic(t);
        document.title = `${t.title} — База знаний`;
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path.join('/')]);

  // Новый раздел — сбрасываем фильтр и прокрутку списка
  useEffect(() => {
    setQuery('');
    setVisible(PAGE_SIZE);
  }, [path.join('/')]);

  // В разделе сотни статей: показываем порциями, иначе браузер встаёт
  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [query, sortBy]);

  const filtered = useMemo(() => {
    if (!topic) return [];
    const q = query.trim().toLowerCase();
    const list = q
      ? topic.articles.filter(
          (a) =>
            a.title.toLowerCase().includes(q) ||
            (a.summary ?? '').toLowerCase().includes(q),
        )
      : topic.articles;
    if (sortBy === 'title') {
      return [...list].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    }
    return [...list].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }, [topic, query, sortBy]);

  // Внутри раздела материалы лежат подразделами — и их тоже надо фильтровать
  const filteredChildren = useMemo(() => {
    if (!topic) return [];
    const q = query.trim().toLowerCase();
    const list = q ? topic.children.filter((c) => c.title.toLowerCase().includes(q)) : topic.children;
    if (sortBy === 'title') {
      return [...list].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    }
    return [...list].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  }, [topic, query, sortBy]);

  const total = topic?.articles.length ?? 0;
  const totalChildren = topic?.children.length ?? 0;
  const shown = filtered.length + filteredChildren.length;
  const totalShown = total + totalChildren;

  if (error) return <ErrorCard message={error} />;
  if (!topic) {
    return (
      <div className="animate-pulse space-y-3 p-8">
        <div className="h-8 w-1/2 rounded bg-slate-200 dark:bg-slate-800" />
        <div className="h-4 w-full rounded bg-slate-200 dark:bg-slate-800" />
      </div>
    );
  }

  const crumbs: Crumb[] = topic.breadcrumbs.map((b, i) => ({
    id: b.id,
    slug: b.slug,
    title: b.title,
    depth: b.depth,
    path: topic.breadcrumbs.slice(0, i + 1).map((x) => x.slug),
  }));

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-slate-200 bg-white/70 px-4 py-2 backdrop-blur sm:px-6 dark:border-slate-800 dark:bg-slate-900/50">
        <Breadcrumbs items={crumbs} />
      </div>

      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px] dark:text-white">
            {topic.title}
          </h1>
          {topic.summary && (
            <p className="mt-2 max-w-3xl text-[15px] text-slate-600 dark:text-slate-400">{topic.summary}</p>
          )}
          <div className="mt-3 flex items-center gap-4 text-[13px] text-slate-500 dark:text-slate-400">
            <span>Статей: {topic.directArticles}</span>
            {topic.subtreeArticles > topic.directArticles && (
              <span>в разделе: {topic.subtreeArticles}</span>
            )}
            {topic.sourceUrl && (
              <a
                href={topic.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-blue-700 hover:underline dark:text-blue-300"
              >
                Первоисточник раздела
              </a>
            )}
          </div>
        </header>

        {topic.slug === 'instrumenty-i-kalkulyatory' && <CalculatorsCard />}

        {totalShown > PAGE_SIZE && (
          <div className="mb-6 flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Фильтр по названию…"
              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <button
              type="button"
              onClick={() => setSortBy(sortBy === 'date' ? 'title' : 'date')}
              className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-blue-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              {sortBy === 'date' ? 'По дате' : 'По алфавиту'}
            </button>
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="shrink-0 rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
              >
                Сбросить
              </button>
            )}
            <span className="w-full text-xs text-slate-400 sm:w-auto">
              {query
                ? `Найдено: ${shown} из ${totalShown}`
                : `Показано: ${Math.min(visible, shown)} из ${totalShown}`}
            </span>
          </div>
        )}

        {total > 0 && (
          <section className="mb-8">
            <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
              Статьи
              {query && (
                <span className="ml-1.5 font-normal text-slate-400">
                  {filtered.length} из {total}
                </span>
              )}
            </h2>

            {filtered.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                Ничего не найдено. Попробуйте другое слово.
              </p>
            ) : (
              <>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {filtered.slice(0, visible).map((a) => (
                    <li key={a.id}>
                      <Link
                        to={`/a/${a.id}`}
                        className="block rounded-lg border border-slate-200 bg-white p-3 transition-colors hover:border-blue-300 hover:bg-blue-50/40 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-blue-700 dark:hover:bg-blue-950/20"
                      >
                        <span className="flex items-start gap-2">
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                              {a.title}
                            </span>
                            {a.summary && (
                              <span className="mt-0.5 line-clamp-2 block text-[13px] text-slate-500 dark:text-slate-400">
                                {a.summary}
                              </span>
                            )}
                            <span className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                              <span>{formatDate(a.updatedAt)}</span>
                              {a.readingMinutes && <span>· {a.readingMinutes} мин</span>}
                              {a.assetsCount > 0 && <span>· {a.assetsCount} файл(ов)</span>}
                            </span>
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        {totalChildren > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
              Подразделы
              {query && (
                <span className="ml-1.5 font-normal text-slate-400">
                  {filteredChildren.length} из {totalChildren}
                </span>
              )}
            </h2>
            {filteredChildren.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                Ничего не найдено. Попробуйте другое слово.
              </p>
            ) : (
              <>
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {filteredChildren.slice(0, visible).map((c) => (
                    <li key={c.id}>
                      <Link
                        to={`/t/${[...topic.path, c.slug].join('/')}`}
                        className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm transition-colors hover:border-blue-300 hover:bg-blue-50/40 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-blue-700 dark:hover:bg-blue-950/20"
                      >
                        <span className="truncate text-slate-800 dark:text-slate-100">{c.title}</span>
                        <span className="shrink-0 rounded-full bg-slate-200/80 px-1.5 text-[11px] text-slate-600 tabular-nums dark:bg-slate-800 dark:text-slate-400">
                          {c.subtreeArticles}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {visible < filteredChildren.length && (
                  <div className="mt-4 flex justify-center">
                    <button
                      type="button"
                      onClick={() => setVisible((v) => v + PAGE_SIZE * 2)}
                      className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 hover:border-blue-300 hover:bg-blue-50/40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                    >
                      Показать ещё ({filteredChildren.length - visible})
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function CalculatorsCard() {
  return (
    <Link
      to="/kalkulyatory"
      className="mb-6 flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50/60 px-4 py-3 transition hover:border-blue-400 dark:border-blue-900 dark:bg-blue-950/30 dark:hover:border-blue-700"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-blue-600 text-base font-bold text-white">
        %
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-blue-900 dark:text-blue-100">Калькуляторы</span>
        <span className="block text-[13px] text-blue-800/80 dark:text-blue-200/80">
          НДС, зарплата, прибыль, спецрежимы, соцналог, акциз, уставной фонд — со сменяемыми ставками
        </span>
      </span>
    </Link>
  );
}
