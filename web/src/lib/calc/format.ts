const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

export function num(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return nf.format(Math.round(value * 100) / 100);
}

export function money(value: number, suffix = 'сум'): string {
  if (!Number.isFinite(value)) return '—';
  return `${num(value)} ${suffix}`;
}

export function pct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${num(value)} %`;
}

export function sign(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value < 0 ? `−${num(Math.abs(value))}` : num(value);
}
