import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CALCULATORS } from '../lib/calc/registry';

export function CalculatorIndex() {
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CALCULATORS;
    return CALCULATORS.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.summary.toLowerCase().includes(q) ||
        c.configs.some((x) => x.label.toLowerCase().includes(q)),
    );
  }, [query]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Калькуляторы</h1>
      <p className="mt-1 max-w-2xl text-sm text-slate-600 dark:text-slate-400">
        Расчёты по налогам и взносам Узбекистана. Выберите сценарий, внесите суммы и проверьте ставки — они
        редактируются и сохраняются в браузере.
      </p>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Найти калькулятор…"
        aria-label="Поиск калькулятора"
        className="mt-4 w-full max-w-sm rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm
                   placeholder:text-slate-400 focus:border-blue-400 focus:outline-none
                   dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
      />

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {list.map((c) => (
          <Link
            key={c.id}
            to={`/k/${c.id}`}
            className="flex gap-3 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-blue-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-blue-800"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-blue-600 text-base font-bold text-white">
              {c.glyph}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-slate-900 dark:text-white">{c.title}</span>
              <span className="mt-0.5 block text-[13px] text-slate-600 dark:text-slate-400">{c.summary}</span>
              <span className="mt-2 flex flex-wrap gap-1">
                {c.configs.map((x) => (
                  <span
                    key={x.id}
                    className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
                  >
                    {x.label}
                  </span>
                ))}
              </span>
            </span>
          </Link>
        ))}
        {list.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">Ничего не найдено.</p>
        )}
      </div>
    </div>
  );
}
