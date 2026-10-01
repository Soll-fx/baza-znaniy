import { money, pct } from '../format';
import { num as field } from '../types';
import type { Calculator } from '../types';

const FOT = {
  key: 'fot',
  label: 'Фонд оплаты труда',
  kind: 'money' as const,
  default: 50_000_000,
  role: 'amount' as const,
  hint: 'Расходы юрлица в виде оплаты труда (ч. 1 ст. 404 НК)',
};

const RATE = (key: string, label: string, value: number, hint?: string) => ({
  key,
  label,
  kind: 'percent' as const,
  default: value,
  role: 'rate' as const,
  hint,
});

/** Ставка применяется ко всему ФОТ, а не к части выплат. */
function singleRateConfig(id: string, label: string, rate: number, hint?: string) {
  return {
    id,
    label,
    hint: hint ?? 'Ставка применяется ко всему фонду оплаты труда.',
    fields: [FOT, RATE('rate', 'Ставка налога', rate, 'Ставку можно изменить: редактируйте поле выше')],
    compute: (v: Record<string, number>) => {
      const n = (k: string) => field(v, k);
      const tax = (n('fot') * n('rate')) / 100;
      return {
        headline: { label: 'К уплате', value: money(tax) },
        rows: [
          { label: 'Налоговая база (ФОТ)', value: money(n('fot')), tone: 'muted' as const },
          { label: `Ставка ${pct(n('rate'))}`, value: pct(n('rate')), tone: 'muted' as const },
          { label: 'Итого налог', value: money(tax), tone: 'accent' as const },
        ],
        notes: ['Ставки установлены ст. 405 НК и могут быть изменены по решению Президента.'],
      };
    },
  };
}

export const social: Calculator = {
  id: 'socnalog',
  title: 'Социальный налог',
  summary: 'Расчёт от фонда оплаты труда по ставкам ст. 405 НК',
  glyph: '§',
  sources: [
    {
      label: 'Как рассчитать социальный налог юридическому лицу',
      slug: 'kak-rasschitat-socialnyy-nalog-yuridicheskomu-licu',
    },
    {
      label: 'Как составить и сдать расчёт по НДФЛ и социальному налогу',
      slug: 'kak-sostavit-i-sdat-raschet-po-ndfl-i-socialnomu-nalogu',
    },
    { label: 'Какие льготы по социальному налогу можно применять в 2026 году', slug: 'kakie-lgoty-po-socialnomu-nalogu-mozhno-primenyat-v-2026-godu' },
    { label: 'Кто платит социальный налог', slug: 'kto-platit-socialnyy-nalog' },
  ],
  configs: [
    singleRateConfig('oby', 'Общеустановленная — 12%', 12),
    singleRateConfig('byudzhet', 'Бюджетные организации — 25%', 25),
    singleRateConfig('sos', 'SOS — Детские деревни — 7%', 7),
    singleRateConfig(
      'invalidnost',
      'Работники с инвалидностью — 4,7%',
      4.7,
      'Только для специализированных цехов, участков и предприятий; ФОТ всех работников (ч. 1 ст. 405 НК).',
    ),
    singleRateConfig(
      'territorii',
      'Отдельные территории — 1%',
      1,
      'Компании, кроме бюджетных, ведущие деятельность на отдельных территориях РУз (ст. 480-2 НК).',
    ),
  ],
};
