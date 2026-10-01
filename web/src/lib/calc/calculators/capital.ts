import { money, pct } from '../format';
import { num as field } from '../types';
import type { Calculator } from '../types';

const SUM = (key: string, label: string, value: number, hint?: string) => ({
  key,
  label,
  kind: 'money' as const,
  default: value,
  role: 'amount' as const,
  hint,
});

export const capital: Calculator = {
  id: 'uf',
  title: 'Уставной фонд',
  summary: 'Увеличение и уменьшение с проверкой минимального размера',
  glyph: '⌂',
  sources: [
    { label: 'Уменьшаем уставной фонд: чек-лист', slug: 'umenshaem-ustavnoy-fond-chek-list' },
    { label: 'Увеличиваем уставной фонд: чек-лист', slug: 'uvelichivaem-ustavnoy-fond-chek-list' },
    { label: 'Как учесть уменьшение уставного фонда', slug: 'kak-uchest-umenshenie-ustavnogo-fonda' },
    { label: 'Как увеличить уставный фонд ООО', slug: 'kak-uvelichit-ustavnyy-fond-ooo' },
  ],
  configs: [
    {
      id: 'increase',
      label: 'Увеличение',
      hint: 'Увеличить УФ ООО можно только после его полной оплаты',
      fields: [
        SUM('current', 'Текущий уставной фонд', 10_000_000),
        SUM('add', 'Сумма увеличения', 5_000_000),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const total = n('current') + n('add');
        return {
          headline: { label: 'Новый уставной фонд', value: money(total) },
          rows: [
            { label: 'Было', value: money(n('current')), tone: 'muted' },
            { label: 'Добавили', value: money(n('add')), tone: 'muted' },
            { label: 'Стало', value: money(total), tone: 'accent' },
            { label: 'Прирост', value: pct(n('current') ? (n('add') / n('current')) * 100 : 0) },
          ],
          notes: [
            'За увеличение УФ должно проголосовать не менее 2/3 голосов от общего числа участников (ч. 1, 2 ст. 16 Закона об ООО).',
            'Оплата уставного фонда принимается только в безналичной форме.',
            'Неденежный вклад стоимостью свыше 10 000 БРВ оценивает оценочная организация (п. 4 ПП-415).',
          ],
        };
      },
    },
    {
      id: 'decrease',
      label: 'Уменьшение',
      hint: 'Проверка минимально допустимого размера на дату госрегистрации изменений',
      fields: [
        SUM('current', 'Текущий уставной фонд', 10_000_000),
        SUM('take', 'Сумма уменьшения', 3_000_000),
        SUM('min', 'Минимально установленный размер УФ', 0, 'на дату госрегистрации изменений в уставe'),
        SUM('netAssets', 'Стоимость чистых активов', 0, 'для АО: если меньше УФ, уменьшение обязательно'),
      ],
      compute: (v) => {
        const n = (k: string) => field(v, k);
        const left = n('current') - n('take');
        const belowMin = n('min') > 0 && left < n('min');
        const belowNetAssets = n('netAssets') > 0 && n('current') > n('netAssets');
        return {
          headline: { label: 'Остаток', value: money(left) },
          rows: [
            { label: 'Было', value: money(n('current')), tone: 'muted' },
            { label: 'Списать', value: money(n('take')), tone: 'muted' },
            { label: 'Остаток', value: money(left), tone: belowMin ? ('warn' as const) : ('accent' as const) },
            { label: 'Доля в составе фонда', value: pct(n('current') ? (n('take') / n('current')) * 100 : 0) },
            ...(belowMin
              ? [
                  {
                    label: 'Минимум по закону',
                    value: money(n('min')),
                    tone: 'warn' as const,
                    note: 'остаток ниже',
                  },
                ]
              : []),
          ],
          notes: [
            ...(belowMin
              ? [
                  'Уменьшать УФ нельзя, если после уменьшения его размер станет меньше минимально установленного размера на дату госрегистрации изменений.',
                  `Чтобы остаток был не меньше минимума, уменьшить можно максимум ${money(n('current') - n('min'))}.`,
                ]
              : [
                  'Уменьшение оформляется решением участников и новой редакцией устава.',
                  'Уведомлять кредиторов об уменьшении УФ с 1 января 2023 года не требуется (п. 3 УП-244).',
                ]),
            ...(belowNetAssets
              ? [
                  'Стоимость чистых активов меньше уставного фонда — АО обязано уменьшить УФ до размера, не превышающего стоимость чистых активов (ч. 6 ст. 32 Закона об АО).',
                ]
              : []),
          ],
        };
      },
    },
  ],
};
