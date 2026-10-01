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

export const vat: Calculator = {
  id: 'nds',
  title: 'НДС',
  summary: 'Начисление, выделение из суммы, экспорт, импорт и порог ставки 6 %',
  glyph: '%',
  sources: [
    { label: 'Кто платит НДС в 2026 году и как перейти на ставку 6 процентов', slug: 'kto-platit-nds-v-2026-godu-i-kak-pereyti-na-stavku-6-procentov' },
    { label: 'Как уплачивать НДС при экспорте и импорте услуг', slug: 'kak-uplachivat-nds-pri-eksporte-i-importe-uslug' },
  ],
  configs: [
    {
      id: 'nachyislit',
      label: 'Начислить сверху',
      hint: 'Сумма реализации указана без НДС',
      fields: [
        { key: 'amount', label: 'Сумма без НДС', kind: 'money', default: 10_000_000, role: 'amount' },
        RATE('rate', 'Ставка НДС', 12, 'Общеустановленная ставка — 12 %'),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const tax = (n('amount') * n('rate')) / 100;
        return {
          headline: { label: 'К уплате', value: money(n('amount') + tax) },
          rows: [
            { label: 'Сумма без НДС', value: money(n('amount')), tone: 'muted' },
            { label: `НДС ${pct(n('rate'))}`, value: money(tax), tone: 'accent' },
            { label: 'Всего с НДС', value: money(n('amount') + tax) },
          ],
        };
      },
    },
    {
      id: 'vydelit',
      label: 'Выделить из суммы',
      hint: 'Сумма указана с НДС — типично для счёта и УПД',
      fields: [
        { key: 'amount', label: 'Сумма с НДС', kind: 'money', default: 11_200_000, role: 'amount' },
        RATE('rate', 'Ставка НДС', 12),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const net = (n('amount') * 100) / (100 + n('rate'));
        const tax = n('amount') - net;
        return {
          headline: { label: 'К уплате', value: money(tax) },
          rows: [
            { label: 'Сумма без НДС', value: money(net), tone: 'muted' },
            { label: `НДС ${pct(n('rate'))}`, value: money(tax), tone: 'accent' },
            { label: 'Сумма с НДС', value: money(n('amount')) },
          ],
        };
      },
    },
    {
      id: 'eksport',
      label: 'Экспорт услуг',
      hint: 'Место реализации определяет, платится ли НДС',
      fields: [
        { key: 'amount', label: 'Стоимость услуг', kind: 'money', default: 50_000_000, role: 'amount' },
        RATE('rate', 'Ставка', 0, 'Экспорт облагается по нулевой ставке'),
        RATE('refund', 'Ставка при неподтверждённом экспорте', 12, 'Если подтверждение не получено в срок'),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const tax = (n('amount') * n('rate')) / 100;
        const fallback = (n('amount') * n('refund')) / 100;
        return {
          headline: { label: 'К уплате', value: money(tax) },
          rows: [
            { label: `НДС ${pct(n('rate'))}`, value: money(tax), tone: 'accent' },
            {
              label: `Если ставка ${pct(n('refund'))}`,
              value: money(fallback),
              tone: 'muted',
              note: 'потеря вычета',
            },
          ],
          notes: ['Место реализации услуг определяется по договору, а не по факту оплаты.'],
        };
      },
    },
    {
      id: 'import',
      label: 'Импорт товаров',
      hint: 'ТС + пошлина + акциз; таможенный сбор в базу не входит',
      fields: [
        { key: 'customs', label: 'Таможенная стоимость', kind: 'money', default: 100_000_000, role: 'amount' },
        RATE('duty', 'Таможенная пошлина', 5),
        { key: 'excise', label: 'Акцизный налог', kind: 'money', default: 0, role: 'amount', hint: '0, если товар не подакцизный' },
        RATE('rate', 'Ставка НДС', 12),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const duty = (n('customs') * n('duty')) / 100;
        const base = n('customs') + duty + n('excise');
        const tax = (base * n('rate')) / 100;
        return {
          headline: { label: 'К уплате на таможне', value: money(tax) },
          rows: [
            { label: 'Таможенная стоимость', value: money(n('customs')), tone: 'muted' },
            { label: `Пошлина ${pct(n('duty'))}`, value: money(duty), tone: 'muted' },
            ...(n('excise') > 0
              ? [{ label: 'Акциз', value: money(n('excise')), tone: 'muted' as const }]
              : []),
            { label: 'Налоговая база', value: money(base) },
            { label: `НДС ${pct(n('rate'))}`, value: money(tax), tone: 'accent' },
          ],
          notes: [
            'Сбор за таможенное оформление в базу по НДС не включается.',
            'Если товар освобождён от пошлин или от акциза, соответствующее слагаемое из базы исключают.',
            'Стоимость в валюте пересчитывают в сумы по курсу ЦБ на день принятия ГТД к оформлению.',
          ],
        };
      },
    },
    {
      id: 'porog',
      label: 'Порог 12 000 БРВ',
      hint: 'Порог выручки для перехода на НДС (УП Президента от 26.05.2026 № УП-100)',
      fields: [
        { key: 'brv', label: 'Совокупный доход, БРВ', kind: 'number', default: 12_000, role: 'amount' },
        { key: 'threshold', label: 'Порог, БРВ', kind: 'number', default: 12_000, role: 'rate' },
        RATE('low', 'Ставка упрощённого НДС', 6, 'добровольно, с 01.06.2026 по 01.01.2030'),
        RATE('base', 'Общеустановленная ставка', 12),
        { key: 'turnover', label: 'Выручка в сумах', kind: 'money', default: 0, role: 'amount', hint: 'для расчёта НДС в рублях' },
        RATE('turnoverRate', 'Ставка налога с оборота', 1, 'для варианта ниже порога'),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const over = n('brv') > n('threshold');
        const turnoverTax = (n('turnover') * n('turnoverRate')) / 100;
        const vatLow = (n('turnover') * n('low')) / 100;
        return {
          headline: { label: 'Порог превышен', value: over ? 'да' : 'нет' },
          rows: [
            { label: 'Совокупный доход', value: `${num(n('brv'))} БРВ`, tone: 'muted' },
            { label: 'Порог', value: `${num(n('threshold'))} БРВ`, tone: 'muted' },
            {
              label: 'Запас до порога',
              value: `${num(n('threshold') - n('brv'))} БРВ`,
              tone: over ? ('warn' as const) : ('default' as const),
            },
            ...(n('turnover') > 0
              ? [
                  { label: `НДС ${pct(n('low'))} (добровольно)`, value: money(vatLow), tone: 'muted' as const },
                  { label: `Налог с оборота ${pct(n('turnoverRate'))}`, value: money(turnoverTax), tone: 'muted' as const },
                ]
              : []),
          ],
          notes: over
            ? [
                'Доход превысил 12 000 БРВ — применяется общеустановленный НДС 12 %.',
                'Добровольно можно перейти на упрощённый НДС 6 % (п. 5 УП-100, действует по 01.01.2030).',
              ]
            : [
                'Доход не превысил 12 000 БРВ — юрлица платят налог с оборота, а не НДС.',
                'Упрощённый НДС 6 % — добровольный режим, а не автоматическое следствие низкого дохода.',
              ],
        };
      },
    },
  ],
};
