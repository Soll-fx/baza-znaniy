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

/**
 * Фиксированная часть ставки задана в сумах за единицу, а не в процентах,
 * поэтому kind = money. По role остаётся ставкой — форма разделяет поля
 * на суммы и ставки именно по role.
 */
const RATE_MONEY = (key: string, label: string, value: number, hint?: string) => ({
  key,
  label,
  kind: 'money' as const,
  default: value,
  role: 'rate' as const,
  hint,
});

const SOURCE = {
  label: 'Как рассчитать акцизный налог при производстве подакцизных товаров',
  slug: 'kak-rasschitat-akciznyy-nalog-pri-proizvodstve-podakciznyh-tovarov',
};
const SOURCE_IMPORT = {
  label: 'Как рассчитать акцизный налог при импорте подакцизных товаров',
  slug: 'kak-rasschitat-akciznyy-nalog-pri-importe-podakciznyh-tovarov',
};

export const excise: Calculator = {
  id: 'aktsiz',
  title: 'Акциз',
  summary: 'Фиксированная и адвалорная ставки при производстве и импорте',
  glyph: '◆',
  sources: [
    { label: 'Кто платит акцизный налог', slug: 'kto-platit-akciznyy-nalog' },
    SOURCE,
    SOURCE_IMPORT,
  ],
  configs: [
    {
      id: 'tverdaya',
      label: 'Фиксированная ставка',
      hint: 'А = Кт × Сф — налог за единицу в натуральном выражении (ч. 2 ст. 285 НК)',
      fields: [
        { key: 'qty', label: 'Количество', kind: 'number', default: 10, role: 'amount', min: 0, step: 1 },
        RATE_MONEY('perUnit', 'Ставка за единицу', 402_000, 'например, бензин АИ-80 — 402 000 сум за тонну с апреля 2026'),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const tax = n('qty') * n('perUnit');
        return {
          headline: { label: 'К уплате', value: money(tax) },
          rows: [
            { label: 'Количество', value: `${num(n('qty'))} ед.`, tone: 'muted' },
            { label: 'Ставка за единицу', value: money(n('perUnit')), tone: 'muted' },
            { label: 'Акциз', value: money(tax), tone: 'accent' },
            { label: 'На единицу товара', value: money(tax / (n('qty') || 1)), tone: 'muted' },
          ],
          notes: [
            'Фиксированная ставка не зависит от цены реализации.',
            'Сумму акциза не включают в выручку: её отражают отдельно как обязательство перед бюджетом.',
          ],
        };
      },
    },
    {
      id: 'advalornaya',
      label: 'Адвалорная ставка',
      hint: 'А = Ст × Са — от стоимости без акциза и НДС, но не ниже фактической себестоимости (ч. 3 ст. 285 НК)',
      fields: [
        { key: 'value', label: 'Стоимость реализации', kind: 'money', default: 100_000_000, role: 'amount', hint: 'без учёта акциза и НДС' },
        RATE('rate', 'Ставка акциза', 10, 'например, полиэтиленовые гранулы — 10 % в 2026 году'),
        { key: 'cost', label: 'Фактическая себестоимость', kind: 'money', default: 0, role: 'amount', hint: 'заполните, если продаёте ниже себестоимости' },
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const base = Math.max(n('value'), n('cost'));
        const tax = (base * n('rate')) / 100;
        const belowCost = n('cost') > 0 && n('value') < n('cost');
        return {
          headline: { label: 'К уплате', value: money(tax) },
          rows: [
            { label: 'Стоимость реализации', value: money(n('value')), tone: 'muted' },
            ...(belowCost
              ? [
                  {
                    label: 'Себестоимость',
                    value: money(n('cost')),
                    tone: 'warn' as const,
                    note: 'ниже себестоимости',
                  },
                ]
              : []),
            { label: 'База акциза', value: money(base) },
            { label: `Акциз ${pct(n('rate'))}`, value: money(tax), tone: 'accent' },
          ],
          notes: [
            'Если товар реализован ниже себестоимости или передан безвозмездно, адвалорную ставку считают от фактической себестоимости.',
            'Акциз включается в цену и входит в базу по НДС, но не признаётся доходом.',
          ],
        };
      },
    },
    {
      id: 'import',
      label: 'Импорт — адвалорная',
      hint: 'НБ — таможенная стоимость по ст. 302 ТК (ч. 7 ст. 285 НК)',
      fields: [
        { key: 'customs', label: 'Таможенная стоимость', kind: 'money', default: 10_000_000, role: 'amount' },
        RATE('rate', 'Ставка акциза', 70, 'например, спирт этиловый ректификованный — 70 %'),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const tax = (n('customs') * n('rate')) / 100;
        return {
          headline: { label: 'К уплате на таможне', value: money(tax) },
          rows: [
            { label: 'Таможенная стоимость', value: money(n('customs')), tone: 'muted' },
            { label: `Ставка ${pct(n('rate'))}`, value: money(tax), tone: 'accent' },
          ],
          notes: [
            'Пошлины и сборы в базу по адвалорному акцизу при импорте не включаются — база это таможенная стоимость.',
            'Акциз при импорте включается в состав таможенных платежей; контроль ведут таможенные органы.',
          ],
        };
      },
    },
    {
      id: 'kombinirovannaya',
      label: 'Импорт — комбинированная',
      hint: 'Комбинированная ставка = адвалорная часть + фиксированная часть за единицу',
      fields: [
        { key: 'customs', label: 'Таможенная стоимость', kind: 'money', default: 1_000_000, role: 'amount' },
        RATE('adv', 'Адвалорная часть', 10, 'например, сигареты с фильтром — 10 % от таможенной стоимости'),
        { key: 'qty', label: 'Количество', kind: 'number', default: 1000, role: 'amount', min: 0, step: 1 },
        RATE_MONEY('perUnit', 'Фиксированная часть', 325, 'например, сигареты — 325 000 сум за 1 000 штук'),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const adv = (n('customs') * n('adv')) / 100;
        const spec = n('qty') * n('perUnit');
        return {
          headline: { label: 'К уплате на таможне', value: money(adv + spec) },
          rows: [
            { label: 'Адвалорная часть', value: money(adv), tone: 'muted' },
            { label: 'Фиксированная часть', value: money(spec), tone: 'muted' },
            { label: 'Итого акциз', value: money(adv + spec), tone: 'accent' },
            { label: 'В том числе на единицу', value: money((adv + spec) / (n('qty') || 1)), tone: 'muted' },
          ],
          notes: [
            'Бывает и другой вид комбинированной ставки: берут наибольшее из адвалорной и фиксированной, а не сумму.',
            'Вид комбинированной ставки зависит от вида подакцизного товара (ст. 289-1, 289-2 НК).',
          ],
        };
      },
    },
  ],
};
