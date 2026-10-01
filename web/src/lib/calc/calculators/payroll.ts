import { money, pct } from '../format';
import { num as field } from '../types';
import type { Calculator } from '../types';

const RATE = (key: string, label: string, value: number, hint?: string) => ({
  key,
  label,
  kind: 'percent' as const,
  default: value,
  role: 'rate' as const,
  hint,
});

export const payroll: Calculator = {
  id: 'zarp',
  title: 'Зарплата и НДФЛ',
  summary: 'Перевод начисленного в выплаченное и обратный расчёт под нужную сумму',
  glyph: '%',
  sources: [
    { label: 'Как составить и сдать расчет по НДФЛ и социальному налогу', slug: 'kak-sostavit-i-sdat-raschet-po-ndfl-i-socialnomu-nalogu' },
    { label: 'Как налоговому агенту рассчитать НДФЛ', slug: 'kak-nalogovomu-agentu-rasschitat-ndfl' },
    { label: 'Как оформить и отразить в учете начисление и выплату зарплаты', slug: 'kak-oformit-i-otrazit-v-buhuchete-nachislenie-i-vyplatu-zarplaty' },
    { label: 'Как рассчитать социальный налог юридическому лицу', slug: 'kak-rasschitat-socialnyy-nalog-yuridicheskomu-licu' },
  ],
  configs: [
    {
      id: 'gross',
      label: 'От начисленного',
      hint: 'Сумма указана до удержания налога',
      fields: [
        { key: 'amount', label: 'Начислено', kind: 'money', default: 5_000_000, role: 'amount' },
        { key: 'months', label: 'Месяцев', kind: 'number', default: 1, role: 'amount', min: 1, step: 1 },
        RATE('pdfl', 'Ставка НДФЛ', 12),
        RATE('social', 'Социальный налог (сверх)', 12, 'ст. 405 НК; начисляется сверх, работник не платит'),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const total = n('amount') * n('months');
        const pdfl = (total * n('pdfl')) / 100;
        const net = total - pdfl;
        const social = (total * n('social')) / 100;
        return {
          headline: { label: 'К выплате на руки', value: money(net) },
          rows: [
            { label: 'Начислено', value: money(total), tone: 'muted' },
            { label: `НДФЛ ${pct(n('pdfl'))}`, value: `− ${money(pdfl)}`, tone: 'warn' },
            { label: 'На руки', value: money(net), tone: 'accent' },
            { label: `Соцналог ${pct(n('social'))} сверху`, value: money(social), tone: 'muted' },
            { label: 'Расходы работодателя', value: money(total + social) },
          ],
        };
      },
    },
    {
      id: 'net',
      label: 'Под сумму на руки',
      hint: 'Сумма указана «в конверте» — считаем начисленную',
      fields: [
        { key: 'net', label: 'Нужно на руки', kind: 'money', default: 4_400_000, role: 'amount' },
        RATE('pdfl', 'Ставка НДФЛ', 12),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const gross = (n('net') * 100) / (100 - n('pdfl'));
        const pdfl = gross - n('net');
        return {
          headline: { label: 'Начислить', value: money(gross) },
          rows: [
            { label: 'На руки', value: money(n('net')), tone: 'muted' },
            { label: `НДФЛ ${pct(n('pdfl'))}`, value: money(pdfl), tone: 'warn' },
            { label: 'Начислено', value: money(gross), tone: 'accent' },
          ],
        };
      },
    },
    {
      id: 'neresident',
      label: 'Доход нерезидента',
      hint: 'Ставка зависит от вида дохода (ст. 382 НК)',
      fields: [
        { key: 'amount', label: 'Доход', kind: 'money', default: 3_000_000, role: 'amount' },
        RATE(
          'rate',
          'Ставка',
          12,
          'Трудовые и ГПХ — 12 %; дивиденды и проценты — 10 %; фрахт — 6 %',
        ),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const tax = (n('amount') * n('rate')) / 100;
        return {
          headline: { label: 'К удержанию', value: money(tax) },
          rows: [
            { label: 'Доход', value: money(n('amount')), tone: 'muted' },
            { label: `НДФЛ ${pct(n('rate'))}`, value: money(tax), tone: 'accent' },
            { label: 'К выплате', value: money(n('amount') - tax) },
          ],
          notes: [
            'Ставка 12 % не применяется к дивидендам, процентам и доходам от фрахта.',
            'Если международным соглашением установлена иная ставка, применяется она.',
          ],
        };
      },
    },
  ],
};
