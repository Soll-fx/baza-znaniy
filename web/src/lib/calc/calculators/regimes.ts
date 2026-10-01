import { money, num, pct } from '../format';
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

export const regimes: Calculator = {
  id: 'rezh',
  title: 'Налог с оборота',
  summary: 'Альтернатива НДС и налогу на прибыль для малых компаний, ИП и самозанятых',
  glyph: '≡',
  sources: [
    {
      label: 'Как перечислить в бюджет налог с оборота',
      slug: 'kak-perechislit-v-byudzhet-nalog-s-oborota',
    },
    {
      label: 'Кто платит НДС в 2026 году и как перейти на ставку 6 процентов',
      slug: 'kto-platit-nds-v-2026-godu-i-kak-pereyti-na-stavku-6-procentov',
    },
    { label: 'Какие права и льготы имеют малые предприятия', slug: 'kakie-prava-i-lgoty-imeyut-malye-predpriyatiya' },
  ],
  configs: [
    {
      id: 'oborot',
      label: 'Расчёт налога',
      hint: 'Налог с оборота — альтернатива НДС и налогу на прибыль (ст. 466–468 НК).',
      fields: [
        { key: 'income', label: 'Оборот за период', kind: 'money', default: 300_000_000, role: 'amount' },
        RATE(
          'rate',
          'Ставка',
          4,
          'Ставка зависит от вида деятельности и места. Укажите свою — по умолчанию 4 % для доходов из ч. 3 ст. 468 НК.',
        ),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const tax = (n('income') * n('rate')) / 100;
        return {
          headline: { label: 'К уплате', value: money(tax) },
          rows: [
            { label: 'Оборот', value: money(n('income')), tone: 'muted' },
            { label: `Ставка ${pct(n('rate'))}`, value: money(tax), tone: 'accent' },
            { label: 'Останется', value: money(n('income') - tax) },
          ],
          notes: [
            'Если у налогоплательщика несколько видов деятельности с разными ставками, нужен раздельный учёт (ч. 1 ст. 468 НК).',
            'Преобладающий вид деятельности определяется нарастающим итогом.',
          ],
        };
      },
    },
    {
      id: 'razdelno',
      label: 'Раздельный учёт',
      hint: 'Оборот по каждому виду деятельности и своя ставка',
      fields: [
        { key: 'a1', label: 'Оборот: вид 1', kind: 'money', default: 200_000_000, role: 'amount' },
        RATE('r1', 'Ставка: вид 1', 1),
        { key: 'a2', label: 'Оборот: вид 2', kind: 'money', default: 100_000_000, role: 'amount' },
        RATE('r2', 'Ставка: вид 2', 4),
        { key: 'a3', label: 'Оборот: вид 3', kind: 'money', default: 0, role: 'amount' },
        RATE('r3', 'Ставка: вид 3', 0),
        { key: 'a4', label: 'Оборот: вид 4', kind: 'money', default: 0, role: 'amount' },
        RATE('r4', 'Ставка: вид 4', 0),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const kinds = ['1', '2', '3', '4'].filter((i) => n(`a${i}`) > 0);
        const total = kinds.reduce((s, i) => s + n(`a${i}`), 0);
        const tax = kinds.reduce((s, i) => s + (n(`a${i}`) * n(`r${i}`)) / 100, 0);
        const rows = kinds.map((i) => ({
          label: `Вид ${i}: ${pct(n(`r${i}`))}`,
          value: money((n(`a${i}`) * n(`r${i}`)) / 100),
          tone: 'muted' as const,
        }));
        return {
          headline: { label: 'К уплате', value: money(tax) },
          rows: [
            { label: 'Оборот всего', value: money(total), tone: 'muted' as const },
            ...rows,
            { label: 'Итого налог', value: money(tax), tone: 'accent' as const },
            {
              label: 'Средняя ставка',
              value: total ? pct((tax / total) * 100) : '—',
              note: total ? `с ${num(kinds.length)} видов` : undefined,
            },
          ],
          notes: ['Раздельный учёт обязателен, если ставки по видам деятельности различаются (ч. 1 ст. 468 НК).'],
        };
      },
    },
  ],
};
