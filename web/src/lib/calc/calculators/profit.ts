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

export const profit: Calculator = {
  id: 'pribyl',
  title: 'Налог на прибыль',
  summary: 'База, налог, льготная ставка и налоговый убыток',
  glyph: '∆',
  sources: [
    { label: 'Как рассчитать налог на прибыль коммерческой организации', slug: 'kak-rasschitat-nalog-na-pribyl-kommercheskoy-organizacii' },
    { label: 'Кто платит налог на прибыль юридических лиц', slug: 'kto-platit-nalog-na-pribyl-yuridicheskih-lic' },
  ],
  configs: [
    {
      id: 'base',
      label: 'Расчёт налога',
      hint: 'Расходы принимаются в том же периоде',
      fields: [
        { key: 'income', label: 'Совокупный доход', kind: 'money', default: 500_000_000, role: 'amount' },
        { key: 'expense', label: 'Расходы', kind: 'money', default: 300_000_000, role: 'amount' },
        RATE('rate', 'Ставка', 15),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const base = n('income') - n('expense');
        const loss = base < 0;
        return {
          headline: { label: 'К уплате', value: loss ? '0 сум' : money((base * n('rate')) / 100) },
          rows: [
            { label: 'Совокупный доход', value: money(n('income')), tone: 'muted' },
            { label: 'Расходы', value: money(n('expense')), tone: 'muted' },
            { label: 'Налоговая база', value: money(base), tone: base < 0 ? 'warn' : 'default' },
            {
              label: `Налог ${pct(n('rate'))}`,
              value: loss ? '0 сум' : money((base * n('rate')) / 100),
              tone: 'accent',
            },
            { label: 'Рентабельность', value: pct(n('income') ? (base / n('income')) * 100 : 0), tone: 'muted' },
          ],
          notes: loss ? ['Расходы превысили доход — налоговая база равна нулю.'] : undefined,
        };
      },
    },
    {
      id: 'preference',
      label: 'Льготная ставка',
      hint: 'Снижение ставки на 50 % — например, для предприятий общепита',
      fields: [
        { key: 'income', label: 'Совокупный доход', kind: 'money', default: 200_000_000, role: 'amount' },
        { key: 'expense', label: 'Расходы', kind: 'money', default: 140_000_000, role: 'amount' },
        RATE('rate', 'Обычная ставка', 15),
        RATE('discount', 'Снижение ставки', 50),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const base = Math.max(0, n('income') - n('expense'));
        const full = (base * n('rate')) / 100;
        const rate = n('rate') - (n('rate') * n('discount')) / 100;
        const reduced = (base * rate) / 100;
        return {
          headline: { label: 'Экономия', value: money(full - reduced) },
          rows: [
            { label: 'Налоговая база', value: money(base), tone: 'muted' },
            { label: `По ставке ${pct(n('rate'))}`, value: money(full), tone: 'muted' },
            { label: `По ставке ${pct(rate)}`, value: money(reduced), tone: 'accent' },
            { label: 'Экономия', value: money(full - reduced), tone: 'accent' },
          ],
          notes: ['Льгота требует подтверждения налоговыми органами.'],
        };
      },
    },
  ],
};
