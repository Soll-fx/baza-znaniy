export type FieldKind = 'money' | 'percent' | 'number';

export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  default: number;
  role: 'amount' | 'rate';
  hint?: string;
  min?: number;
  step?: number;
}

export type Values = Record<string, number>;

/**
 * Чтение поля расчёта. Значения приходят из формы, поэтому могут быть
 * пустыми, NaN или отсутствовать — здесь это сводится к корректному числу.
 */
export function num(values: Values, key: string): number {
  const v = values[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** То же, но с запасным значением на случай отсутствующего поля. */
export function numOr(values: Values, key: string, fallback: number): number {
  const v = values[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export type Tone = 'default' | 'muted' | 'accent' | 'warn';

export interface ResultRow {
  label: string;
  value: string;
  note?: string;
  tone?: Tone;
}

export interface Result {
  headline?: { label: string; value: string };
  rows: ResultRow[];
  notes?: string[];
}

export interface Configuration {
  id: string;
  label: string;
  hint?: string;
  fields: Field[];
  compute: (v: Values) => Result;
}

export interface Source {
  label: string;
  slug?: string;
}

export interface Calculator {
  id: string;
  title: string;
  summary: string;
  glyph: string;
  sources: Source[];
  configs: Configuration[];
}
