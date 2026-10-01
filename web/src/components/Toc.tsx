import { useEffect, useRef, useState } from 'react';
import type { TocItem } from '../lib/types';

/**
 * Оглавление статьи со скролл-спаем: подсвечивает текущий раздел.
 * IntersectionObserver вместо обработчика scroll — не вызывает reflow.
 */
export function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState<string | null>(items[0]?.id ?? null);
  const visible = useRef(new Set<string>());

  useEffect(() => {
    if (items.length === 0) return;
    const headings = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          if (entry.isIntersecting) visible.current.add(id);
          else visible.current.delete(id);
        }
        // Берём самый верхний из видимых — это и есть текущий раздел
        const first = items.find((i) => visible.current.has(i.id));
        if (first) setActive(first.id);
      },
      { rootMargin: '-72px 0px -70% 0px', threshold: 0 },
    );

    for (const h of headings) io.observe(h);
    return () => io.disconnect();
  }, [items]);

  if (items.length < 2) return null;

  return (
    <nav aria-label="Содержание статьи" className="text-sm">
      <p className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
        На странице
      </p>
      <ul className="kb-scroll max-h-[60vh] space-y-0.5 overflow-y-auto border-l border-slate-200 dark:border-slate-800">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                history.replaceState(null, '', `#${item.id}`);
                setActive(item.id);
              }}
              className={[
                '-ml-px block border-l-2 py-1 pr-2 leading-snug transition-colors',
                item.level === 3 ? 'pl-6' : item.level === 4 ? 'pl-9' : 'pl-3',
                active === item.id
                  ? 'border-blue-500 font-medium text-blue-700 dark:text-blue-300'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100',
              ].join(' ')}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
