import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { findCalculator } from '../lib/calc/registry';
import { useRates } from '../lib/calc/rates';
import type { Field, Result, Tone, Values } from '../lib/calc/types';

export function CalculatorPage() {
  const { id = '' } = useParams();
  const calc = findCalculator(id);

  if (!calc) {
    return (
      <div className="px-6 py-16 text-center">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Калькулятор не найден</h1>
        <Link to="/kalkulyatory" className="mt-2 inline-block text-sm text-blue-700 hover:underline dark:text-blue-300">
          К списку калькуляторов
        </Link>
      </div>
    );
  }

  return <CalculatorBody calc={calc} />;
}

function CalculatorBody({ calc }: { calc: NonNullable<ReturnType<typeof findCalculator>> }) {
  // Конфигурация живёт в адресе: ссылку на конкретный сценарий можно переслать.
  const [params, setParams] = useSearchParams();
  const wanted = params.get('c');
  const config = calc.configs.find((c) => c.id === wanted) ?? calc.configs[0]!;
  const { rates, save, reset, isCustom } = useRates(calc.id, config);

  const selectConfig = (id: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('c', id);
      return next;
    });
  };

  const values = useMemo<Values>(() => {
    const out: Values = {};
    for (const f of config.fields) out[f.key] = rates[f.key] ?? f.default;
    return out;
  }, [config, rates]);

  const set = (key: string, value: number) => save({ ...values, [key]: value });
  const result = config.compute(values);

  const amounts = config.fields.filter((f) => f.role === 'amount');
  const rateFields = config.fields.filter((f) => f.role === 'rate');

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <nav className="text-[13px] text-slate-500 dark:text-slate-400">
        <Link to="/kalkulyatory" className="hover:underline">
          Калькуляторы
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-slate-700 dark:text-slate-200">{calc.title}</span>
      </nav>

      <header className="mt-3 flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-blue-600 text-lg font-bold text-white">
          {calc.glyph}
        </span>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">{calc.title}</h1>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{calc.summary}</p>
        </div>
      </header>

      {calc.configs.length > 1 && (
        <div className="mt-5 flex flex-wrap gap-2">
          {calc.configs.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => selectConfig(c.id)}
              className={`rounded-lg border px-3 py-1.5 text-[13px] transition ${
                c.id === config.id
                  ? 'border-blue-500 bg-blue-50 font-medium text-blue-800 dark:border-blue-400 dark:bg-blue-950/50 dark:text-blue-200'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {config.hint && <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">{config.hint}</p>}

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1.1fr]">
        <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Данные</h2>
          <div className="mt-3 space-y-3">
            {amounts.map((f) => (
              <FieldInput key={f.key} field={f} value={values[f.key] ?? f.default} onChange={(v) => set(f.key, v)} />
            ))}
          </div>

          {rateFields.length > 0 && (
            <>
              <div className="mt-5 flex items-baseline justify-between border-t border-slate-200 pt-3 dark:border-slate-800">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Ставки и пороги</h2>
                {isCustom && (
                  <button type="button" onClick={reset} className="text-[12px] text-blue-700 hover:underline dark:text-blue-300">
                    Вернуть значения по умолчанию
                  </button>
                )}
              </div>
              <p className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">
                Ставки меняются законодательством. Проверьте их по НК и укажите актуальные — они сохранятся в браузере.
              </p>
              <div className="mt-3 space-y-3">
                {rateFields.map((f) => (
                  <FieldInput key={f.key} field={f} value={values[f.key] ?? f.default} onChange={(v) => set(f.key, v)} />
                ))}
              </div>
            </>
          )}
        </section>

        <ResultPanel result={result} calcTitle={calc.title} sources={calc.sources} />
      </div>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: number;
  onChange: (v: number) => void;
}) {
  const step = field.step ?? (field.kind === 'percent' ? 0.1 : 1);
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-[13px] text-slate-700 dark:text-slate-300">
        <span>{field.label}</span>
        {field.kind !== 'money' && <span className="text-[11px] text-slate-400">{field.kind === 'percent' ? '%' : ''}</span>}
      </span>
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={field.min ?? 0}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm tabular-nums
                   focus:border-blue-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
      />
      {field.hint && <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">{field.hint}</span>}
    </label>
  );
}

const TONES: Record<Tone, string> = {
  default: 'text-slate-900 dark:text-white',
  muted: 'text-slate-500 dark:text-slate-400',
  accent: 'text-blue-700 dark:text-blue-300',
  warn: 'text-amber-700 dark:text-amber-400',
};

function ResultPanel({
  result,
  calcTitle,
  sources,
}: {
  result: Result;
  calcTitle: string;
  sources: { label: string; slug?: string }[];
}) {
  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 dark:border-blue-900 dark:bg-blue-950/30">
        {result.headline && (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-slate-700 dark:text-slate-300">{result.headline.label}</span>
            <span className="text-2xl font-semibold tabular-nums text-blue-900 dark:text-blue-100">
              {result.headline.value}
            </span>
          </div>
        )}
        <dl className="mt-3 space-y-1.5 border-t border-blue-200/70 pt-3 dark:border-blue-900/70">
          {result.rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-[13px] text-slate-600 dark:text-slate-400">
                {r.label}
                {r.note && <span className="ml-1.5 text-[11px] text-slate-400">({r.note})</span>}
              </dt>
              <dd className={`text-[13px] font-medium tabular-nums ${TONES[r.tone ?? 'default']}`}>{r.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {result.notes && result.notes.length > 0 && (
        <ul className="space-y-1.5 rounded-xl border border-slate-200 bg-white p-4 text-[12px] text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          {result.notes.map((n) => (
            <li key={n} className="flex gap-2">
              <span aria-hidden>—</span>
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4 text-[12px] dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-[13px] font-semibold text-slate-900 dark:text-white">Источники</h2>
        <ul className="mt-1.5 space-y-1">
          {sources.map((s) => (
            <li key={s.slug ?? s.label}>
              {s.slug ? (
                <WikiLink slug={s.slug} label={s.label} />
              ) : (
                <span className="text-slate-500 dark:text-slate-400">{s.label}</span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-slate-200 pt-2 text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {`«${calcTitle}» — вспомогательный расчёт, а не нормативный акт. Сверяйте результат с НК и с действующими ставками.`}
        </p>
      </div>
    </section>
  );
}

function WikiLink({ slug, label }: { slug: string; label: string }) {
  return (
    <Link to={`/s/${encodeURIComponent(slug)}`} className="text-blue-700 hover:underline dark:text-blue-300">
      {label}
    </Link>
  );
}
