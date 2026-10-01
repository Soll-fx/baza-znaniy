import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, assetUrl, formatBytes, formatDate } from '../lib/api';
import type { Article, Progress } from '../lib/types';
import { Breadcrumbs, type Crumb } from './Breadcrumbs';
import { Toc } from './Toc';

export function ArticlePage() {
  const { id = '' } = useParams();
  const [article, setArticle] = useState<Article | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .article(id)
      .then((a) => {
        if (alive) {
          setArticle(a);
          document.title = `${a.title} — База знаний`;
        }
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id]);

  /** Подсвечиваем битые вики-ссылки прямо в отрендеренном тексте. */
  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !article) return;
    const broken = new Set(article.brokenLinks.map((l) => l.rawTarget.split('#')[0]));
    for (const a of root.querySelectorAll<HTMLAnchorElement>('a[data-slug]')) {
      a.classList.toggle('kb-link-broken', broken.has(a.dataset.slug ?? ''));
      a.title = broken.has(a.dataset.slug ?? '') ? 'Ссылка ведёт на несуществующую статью' : '';
    }
  }, [article]);

  if (error) return <ErrorCard message={error} />;
  if (!article) return <Skeleton />;

  const crumbs: Crumb[] = [
    ...article.breadcrumbs.map((b, i) => ({
      id: b.id,
      slug: b.slug,
      title: b.title,
      depth: b.depth,
      path: article.breadcrumbs.slice(0, i + 1).map((x) => x.slug),
    })),
    { id: article.id, slug: article.slug, title: article.title, depth: article.breadcrumbs.length, articleId: article.id },
  ];

  const attachments = article.assets.filter((a) => a.role === 'attachment' || a.kind === 'document');

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-slate-200 bg-white/70 px-4 py-2 backdrop-blur sm:px-6 dark:border-slate-800 dark:bg-slate-900/50">
        <Breadcrumbs items={crumbs} />
      </div>

      <div className="flex flex-1 gap-8 px-4 py-6 sm:px-6 lg:px-8">
        <article className="min-w-0 flex-1">
          <header className="mb-6">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              {article.status !== 'published' && (
                <span className="rounded border border-amber-300 px-1.5 py-0.5 text-amber-700 dark:border-amber-700 dark:text-amber-400">
                  {article.status}
                </span>
              )}
              <span className="rounded bg-slate-200/70 px-1.5 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                в. {article.version}
              </span>
              {article.readingMinutes && (
                <span className="text-slate-500 dark:text-slate-400">{article.readingMinutes} мин чтения</span>
              )}
            </div>

            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px] dark:text-white">
              {article.title}
            </h1>

            {article.summary && (
              <p className="mt-2 text-[15px] text-slate-600 dark:text-slate-400">{article.summary}</p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-200 pt-3 text-[13px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <span>Обновлено: {formatDate(article.updatedAt)}</span>
              {article.effectiveFrom && <span>Действует с {formatDate(article.effectiveFrom)}</span>}
              {article.sourceUrl && (
                <a
                  href={article.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-300"
                >
                  Первоисточник
                  <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M6 3h7v7M13 3L5 11" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </a>
              )}
              <span className="ml-auto flex items-center gap-1.5">
                <button type="button" onClick={() => window.print()} className="rounded px-2 py-1 hover:bg-slate-200/70 dark:hover:bg-slate-800">
                  Печать
                </button>
              </span>
            </div>
          </header>

          {article.brokenLinks.length > 0 && (
            <div className="mb-6 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
              <strong>Битые ссылки ({article.brokenLinks.length}):</strong>{' '}
              {article.brokenLinks.map((l) => l.rawTarget).join(', ')}. Запустите <code>npm run validate</code>.
            </div>
          )}

          <div ref={bodyRef} className="kb-prose" dangerouslySetInnerHTML={{ __html: article.bodyHtml }} />

          {attachments.length > 0 && (
            <section className="mt-10 border-t border-slate-200 pt-4 dark:border-slate-800">
              <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-300">Вложения</h2>
              <ul className="space-y-1.5">
                {attachments.map((a) => (
                  <li key={a.id}>
                    <a
                      href={assetUrl(a.id)}
                      download={a.filename}
                      className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm hover:border-blue-300 hover:bg-blue-50/50 dark:border-slate-800 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
                    >
                      <span className="truncate">{a.filename}</span>
                      <span className="ml-auto shrink-0 text-xs text-slate-400">{formatBytes(a.bytes)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <StudyControls article={article} onChange={setArticle} />

          <RelatedLinks article={article} />
        </article>

        <aside className="hidden w-60 shrink-0 xl:block">
          <div className="sticky top-6">
            <Toc items={article.toc} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function RelatedLinks({ article }: { article: Article }) {
  const internal = article.links.filter((l) => l.kind === 'internal' && l.toId);
  if (internal.length === 0) return null;

  return (
    <section className="mt-10 border-t border-slate-200 pt-4 dark:border-slate-800">
      <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-300">Упомянутые статьи</h2>
      <ul className="flex flex-wrap gap-2">
        {internal.map((l) => (
          <li key={l.rawTarget}>
            <Link
              to={`/a/${l.toId}`}
              className="inline-block rounded-full border border-slate-200 px-3 py-1 text-[13px] hover:border-blue-300 hover:bg-blue-50/50 dark:border-slate-800 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
            >
              {l.toTitle ?? l.rawTarget}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StudyControls({ article, onChange }: { article: Article; onChange: (a: Article) => void }) {
  const [saving, setSaving] = useState(false);
  const status = article.progress?.status;

  const set = async (next: 'learning' | 'known') => {
    setSaving(true);
    try {
      const res = await api.setProgress(article.id, next);
      const previous = article.progress;
      onChange({
        ...article,
        progress: {
          status: res.status as Progress['status'],
          confidence: res.confidence,
          reps: previous?.reps ?? 0,
          nextReviewAt: res.nextReviewAt,
        },
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-10 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Отметить как:</span>
      <button
        type="button"
        disabled={saving}
        onClick={() => void set('learning')}
        className={[
          'rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:opacity-50',
          status === 'learning'
            ? 'border-blue-400 bg-blue-50 text-blue-800 dark:border-blue-600 dark:bg-blue-950/60 dark:text-blue-200'
            : 'border-slate-200 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
        ].join(' ')}
      >
        Учу
      </button>
      <button
        type="button"
        disabled={saving}
        onClick={() => void set('known')}
        className={[
          'rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:opacity-50',
          status === 'known'
            ? 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-200'
            : 'border-slate-200 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
        ].join(' ')}
      >
        Знаю
      </button>
      {article.progress?.reps ? (
        <span className="ml-auto text-xs text-slate-500">
          повторений: {article.progress.reps} · следующее {formatDate(article.progress.nextReviewAt)}
        </span>
      ) : null}
    </div>
  );
}

export function ErrorCard({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-lg p-10 text-center">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Не удалось загрузить</h1>
      <p className="mt-2 text-sm text-slate-500">{message}</p>
      <Link to="/" className="mt-4 inline-block text-sm text-blue-700 hover:underline dark:text-blue-300">
        На главную
      </Link>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-3 p-8">
      <div className="h-4 w-40 rounded bg-slate-200 dark:bg-slate-800" />
      <div className="h-8 w-3/4 rounded bg-slate-200 dark:bg-slate-800" />
      <div className="h-4 w-full rounded bg-slate-200 dark:bg-slate-800" />
      <div className="h-4 w-5/6 rounded bg-slate-200 dark:bg-slate-800" />
      <div className="h-40 w-full rounded bg-slate-200 dark:bg-slate-800" />
    </div>
  );
}
