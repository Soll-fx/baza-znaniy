import { money, num, pct } from '../format';
import { num as field } from '../types';
import type { Calculator } from '../types';

export const minimums: Calculator = {
  id: 'minimumy',
  title: 'БРВ, МРОТ и минимумы',
  summary: 'Пересчёт сумм в базовые единицы и производные величины',
  glyph: '⌗',
  sources: [
    { label: 'Сводная таблица минимальных величин: МРОТ, БРВ, БВИП, пенсии и пособия', slug: 'svodnaya-tablica-minimalnyh-velichin-mrot-brv-bvip-pensii-i-posobiya' },
  ],
  configs: [
    {
      id: 'convert',
      label: 'Пересчёт в БРВ',
      fields: [
        { key: 'amount', label: 'Сумма', kind: 'money', default: 12_000_000, role: 'amount' },
        { key: 'brv', label: 'БРВ', kind: 'money', default: 440_000, role: 'rate', hint: 'с 01.09.2026 — УП Президента № УП-115' },
        { key: 'mrot', label: 'МРОТ', kind: 'money', default: 1_360_000, role: 'rate' },
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const brvCount = n('brv') ? n('amount') / n('brv') : 0;
        const brv12000 = n('brv') * 12_000;
        return {
          headline: { label: 'В базовых единицах', value: `${num(brvCount)} БРВ` },
          rows: [
            { label: 'Сумма', value: money(n('amount')), tone: 'muted' },
            { label: 'БРВ', value: money(n('brv')), tone: 'muted' },
            { label: 'В БРВ', value: `${num(brvCount)} БРВ`, tone: 'accent' },
            { label: 'В МРОТ', value: `${num(n('mrot') ? n('amount') / n('mrot') : 0)}`, tone: 'muted' },
            { label: 'Порог 12 000 БРВ в сум', value: money(brv12000), tone: 'muted' },
            { label: 'До порога', value: pct(n('brv12000') ? (n('amount') / brv12000) * 100 : 0) },
          ],
        };
      },
    },
    {
      id: 'shares',
      label: 'Доли и ФОТ',
      hint: 'Сколько ставок социального налога уходит на выплаты',
      fields: [
        { key: 'fot', label: 'ФОТ за месяц', kind: 'money', default: 20_000_000, role: 'amount' },
        { key: 'brv', label: 'БРВ', kind: 'money', default: 440_000, role: 'rate' },
        { key: 'mrot', label: 'МРОТ', kind: 'money', default: 1_360_000, role: 'rate' },
        { key: 'rate', label: 'Ставка социального налога', kind: 'percent', default: 25, role: 'rate' },
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const tax = (n('fot') * n('rate')) / 100;
        return {
          headline: { label: 'К уплате', value: money(tax) },
          rows: [
            { label: 'ФОТ', value: money(n('fot')), tone: 'muted' },
            { label: 'Соцналог', value: money(tax), tone: 'accent' },
            { label: 'Ставок в БРВ', value: `${num(n('brv') ? tax / n('brv') : 0)} БРВ`, tone: 'muted' },
            { label: 'Ставок в МРОТ', value: `${num(n('mrot') ? tax / n('mrot') : 0)}`, tone: 'muted' },
            { label: 'Средняя выплата', value: money(n('fot') / 10) },
          ],
        };
      },
    },
  ],
};
