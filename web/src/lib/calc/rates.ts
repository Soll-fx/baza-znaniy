import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Configuration, Values } from './types';

const KEY = 'kb.calc.rates.v1';

type Store = Record<string, Values>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* приватный режим браузера — просто не сохраняем */
  }
}

function defaultsOf(config: Configuration): Values {
  const out: Values = {};
  for (const f of config.fields) out[f.key] = f.default;
  return out;
}

/** Ключ настройки: калькулятор + конфигурация, чтобы ставки разных сценариев не путались. */
function slotKey(calcId: string, configId: string): string {
  return `${calcId}.${configId}`;
}

/** Ставки хранятся в браузере: бухгалтер вводит актуальные значения один раз. */
export function useRates(calcId: string, config: Configuration) {
  const slot = useMemo(() => slotKey(calcId, config.id), [calcId, config.id]);
  const [rates, setRates] = useState<Values>(() => ({ ...defaultsOf(config), ...read()[slot] }));

  useEffect(() => {
    setRates({ ...defaultsOf(config), ...read()[slot] });
  }, [slot, config]);

  const save = useCallback(
    (next: Values) => {
      setRates(next);
      const store = read();
      store[slot] = next;
      write(store);
    },
    [slot],
  );

  const reset = useCallback(() => {
    const store = read();
    delete store[slot];
    write(store);
    setRates(defaultsOf(config));
  }, [slot, config]);

  return { rates, save, reset, isCustom: JSON.stringify(rates) !== JSON.stringify(defaultsOf(config)) };
}
