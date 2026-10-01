import { useEffect, useState } from 'react';

const KEY = 'baza-theme';

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem(KEY, dark ? 'dark' : 'light');
    } catch {
      /* приватный режим */
    }
  }, [dark]);

  return (
    <button
      type="button"
      onClick={() => setDark((d) => !d)}
      aria-label={dark ? 'Включить светлую тему' : 'Включить тёмную тему'}
      title={dark ? 'Светлая тема' : 'Тёмная тема'}
      className="grid size-9 place-items-center rounded-lg text-slate-500 transition-colors
                 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-400
                 dark:hover:bg-slate-800 dark:hover:text-slate-100"
    >
      {dark ? (
        <svg viewBox="0 0 20 20" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="1.7">
          <circle cx="10" cy="10" r="3.5" />
          <path
            d="M10 1.5v2M10 16.5v2M3.5 3.5l1.4 1.4M15.1 15.1l1.4 1.4M1.5 10h2M16.5 10h2M3.5 16.5l1.4-1.4M15.1 4.9l1.4-1.4"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M16 12.2A7 7 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2Z" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}
