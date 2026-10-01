import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { SearchHit } from '../lib/types';

const DEBOUNCE_MS = 220;

export function SearchBar({ onNavigate }: { onNavigate?: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      api
        .search(q.trim())
        .then((res) => {
          setHits(res.results);
          setCursor(-1);
        })
        .catch(() => setHits([]))
        .finally(() => setBusy(false));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // "/" — быстрый переход к поиску, как в документации
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const go = (hit: SearchHit) => {
    setOpen(false);
    setQ('');
    onNavigate?.();
    void navigate(`/a/${hit.id}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!hits.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % hits.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter' && cursor >= 0) {
      e.preventDefault();
      const hit = hits[cursor];
      if (hit) go(hit);
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <label htmlFor="kb-search" className="sr-only">
        Поиск по базе знаний
      </label>
      <div className="relative">
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <circle cx="9" cy="9" r="6" />
          <path d="M13.5 13.5L17 17" strokeLinecap="round" />
        </svg>

        <input
          id="kb-search"
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={open && hits.length > 0}
          aria-controls="kb-search-list"
          aria-autocomplete="list"
          autoComplete="off"
          value={q}
          placeholder="Поиск по базе…  /"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="w-full rounded-lg border border-slate-200 bg-white py-2 pr-9 pl-9 text-sm text-slate-800
                     placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 focus:outline-none
                     dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500
                     dark:focus:border-blue-500 dark:focus:ring-blue-950"
        />

        {busy && (
          <span
            aria-hidden
            className="absolute top-1/2 right-3 size-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500 dark:border-slate-600"
          />
        )}
      </div>

      {open && q.trim().length >= 2 && (
        <div className="absolute z-30 mt-2 w-full min-w-[22rem] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          {hits.length === 0 ? (
            <p className="px-4 py-3 text-sm text-slate-500">
              {busy ? 'Ищу…' : 'Ничего не найдено. Попробуйте другую формулировку.'}
            </p>
          ) : (
            <ul id="kb-search-list" role="listbox" className="kb-scroll max-h-96 overflow-y-auto py-1">
              {hits.map((hit, i) => (
                <li key={hit.id} role="option" aria-selected={i === cursor}>
                  <button
                    type="button"
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => go(hit)}
                    className={[
                      'block w-full px-4 py-2 text-left',
                      i === cursor ? 'bg-blue-50 dark:bg-blue-950/50' : '',
                    ].join(' ')}
                  >
                    <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                      {hit.title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">
                      {hit.topicPath.join(' / ')}
                      {hit.excerpt ? ` — ${stripTags(hit.excerpt).slice(0, 90)}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, '');
