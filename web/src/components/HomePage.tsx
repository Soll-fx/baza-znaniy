import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { CALCULATORS } from '../lib/calc/registry';
import type { ReviewQueueItem, Stats } from '../lib/types';

export function HomePage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [queue, setQueue] = useState<ReviewQueueItem[]>([]);
  const [counts, setCounts] = useState<{ total: number; known: number; due: number } | null>(null);

  useEffect(() => {
    void api.stats().then(setStats).catch(() => setStats(null));
    void api
      .reviewQueue('local', true)
      .then((r) => {
        setQueue(r.queue);
        setCounts(r.stats);
      })
      .catch(() => undefined);
  }, []);

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px] dark:text-white">
        База знаний по бухгалтерии
      </h1>
      <p className="mt-2 max-w-2xl text-[15px] text-slate-600 dark:text-slate-400">
        Выберите раздел в меню слева или воспользуйтесь поиском. Статьи можно отмечать как «учу» и
        «знаю» — система вернёт их к повторению через интервальные сроки.
      </p>

      {stats && (
        <dl className="mt-6 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Рубрик" value={stats.topics} />
          <Stat label="Статей" value={stats.articles} />
          <Stat label="Слов" value={stats.words} />
          <Stat label="Файлов" value={stats.assets} />
        </dl>
      )}

      <section className="mt-10 max-w-2xl">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Калькуляторы</h2>
          <Link to="/kalkulyatory" className="text-xs text-blue-700 hover:underline dark:text-blue-300">
            Все сценарии
          </Link>
        </div>
        <p className="mt-1 text-[13px] text-slate-600 dark:text-slate-400">
          Ставки редактируются и сохраняются в браузере — вводите актуальные значения по НК.
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {CALCULATORS.map((c) => (
            <li key={c.id}>
              <Link
                to={`/k/${c.id}`}
                className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm hover:border-blue-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-blue-700"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-blue-600 text-xs font-bold text-white">
                  {c.glyph}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-slate-800 dark:text-slate-100">{c.title}</span>
                  <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{c.summary}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {queue.length > 0 && (
        <section className="mt-10 max-w-2xl">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
            К повторению сегодня {counts ? `(${queue.length})` : ''}
          </h2>
          <ul className="mt-2 space-y-1.5">
            {queue.slice(0, 8).map((q) => (
              <li key={q.id}>
                <Link
                  to={`/a/${q.id}`}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm hover:border-blue-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-blue-700"
                >
                  <ConfidenceDot confidence={q.confidence} />
                  <span className="min-w-0 flex-1 truncate text-slate-800 dark:text-slate-100">{q.title}</span>
                  <span className="shrink-0 text-xs text-slate-400">{q.topicPath.join(' / ')}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-800 dark:bg-slate-900">
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="text-lg font-semibold text-slate-900 tabular-nums dark:text-white">
        {new Intl.NumberFormat('ru-RU').format(value ?? 0)}
      </dd>
    </div>
  );
}

function ConfidenceDot({ confidence }: { confidence: number }) {
  const color =
    confidence >= 4
      ? 'bg-emerald-500'
      : confidence >= 2
        ? 'bg-amber-500'
        : 'bg-rose-500';
  return <span aria-label={`уверенность ${confidence} из 5`} className={`size-2 shrink-0 rounded-full ${color}`} />;
}
