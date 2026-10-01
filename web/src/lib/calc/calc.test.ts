import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CALCULATORS, findCalculator } from './registry';
import type { Configuration, Values } from './types';

function run(id: string, configId: string, values: Record<string, number>) {
  const calc = findCalculator(id);
  if (!calc) throw new Error(`нет калькулятора ${id}`);
  const config = calc.configs.find((c) => c.id === configId);
  if (!config) throw new Error(`нет конфигурации ${configId}`);
  return config.compute(withDefaults(config, values));
}

function withDefaults(config: Configuration, values: Record<string, number>): Values {
  const out: Values = {};
  for (const f of config.fields) out[f.key] = values[f.key] ?? f.default;
  return out;
}

/**
 * Intl.NumberFormat разделяет разряды неразрывным пробелом, поэтому сравниваем
 * по нормализованной строке — иначе ожидания в тестах выглядят одинаково, но не равны.
 */
function plain(text: string): string {
  return text.replace(/[  ]/g, ' ');
}

function rowValue(rows: { label: string; value: string }[], label: string): string {
  const row = rows.find((r) => r.label === label);
  if (!row) throw new Error(`нет строки «${label}». Есть: ${rows.map((r) => r.label).join(' | ')}`);
  return plain(row.value);
}

function headlineValue(r: { headline?: { value: string } }): string {
  if (!r.headline) throw new Error('нет итоговой строки');
  return plain(r.headline.value);
}

describe('реестр калькуляторов', () => {
  it('идентификаторы уникальны', () => {
    const ids = CALCULATORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('у каждого калькулятора есть поля, ссылки на источники и конфигурации', () => {
    for (const c of CALCULATORS) {
      expect(c.configs.length, c.id).toBeGreaterThan(0);
      expect(c.sources.length, c.id).toBeGreaterThan(0);
      for (const cfg of c.configs) {
        expect(cfg.fields.length, `${c.id}/${cfg.id}`).toBeGreaterThan(0);
        expect(cfg.compute, `${c.id}/${cfg.id}`).toBeTypeOf('function');
      }
    }
  });

  it('в каждой конфигурации есть хотя бы одно поле для суммы', () => {
    for (const c of CALCULATORS) {
      for (const cfg of c.configs) {
        expect(cfg.fields.some((f) => f.role === 'amount'), `${c.id}/${cfg.id}`).toBe(true);
      }
    }
  });

  it('у всех источников задан слаг', () => {
    for (const c of CALCULATORS) {
      for (const s of c.sources) {
        expect(s.slug, `${c.id}: ${s.label}`).toBeTruthy();
      }
    }
  });

  it('ссылки на источники ведут в существующие статьи корпуса', () => {
    const contentDir = path.resolve(__dirname, '../../../../content');
    const slugs = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'images') walk(full);
        } else if (entry.name.endsWith('.md') && entry.name !== '_topic.md') {
          slugs.add(entry.name.slice(0, -3));
        }
      }
    };
    walk(contentDir);

    const missing: string[] = [];
    for (const c of CALCULATORS) {
      for (const s of c.sources) {
        if (!slugs.has(s.slug!)) missing.push(`${c.id} → ${s.slug} (${s.label})`);
      }
    }
    expect(missing, `нет таких статей:\n${missing.join('\n')}`).toEqual([]);
  });
});

describe('НДС', () => {
  it('начисляет 12 % сверху', () => {
    const r = run('nds', 'nachyislit', { amount: 10_000_000, rate: 12 });
    expect(rowValue(r.rows, 'НДС 12 %')).toBe('1 200 000 сум');
    expect(headlineValue(r)).toBe('11 200 000 сум');
  });

  it('выделяет НДС из суммы с НДС', () => {
    const r = run('nds', 'vydelit', { amount: 11_200_000, rate: 12 });
    expect(rowValue(r.rows, 'Сумма без НДС')).toBe('10 000 000 сум');
    expect(rowValue(r.rows, 'НДС 12 %')).toBe('1 200 000 сум');
  });

  it('выделение НДС обратно начислению даёт ту же сумму', () => {
    const base = 7_350_000;
    const up = run('nds', 'nachyislit', { amount: base, rate: 12 });
    const gross = Number(rowValue(up.rows, 'Всего с НДС').replace(/[^\d,-]/g, ''));
    const down = run('nds', 'vydelit', { amount: gross, rate: 12 });
    expect(rowValue(down.rows, 'Сумма без НДС')).toBe(`${plain(base.toLocaleString('ru-RU'))} сум`);
  });

  it('на импорте база включает пошлину и акциз', () => {
    const r = run('nds', 'import', { customs: 100_000_000, duty: 5, excise: 3_000_000, rate: 12 });
    expect(rowValue(r.rows, 'Налоговая база')).toBe('108 000 000 сум');
    expect(rowValue(r.rows, 'НДС 12 %')).toBe('12 960 000 сум');
  });

  it('без акциза база — стоимость с пошлиной', () => {
    const r = run('nds', 'import', { customs: 100_000_000, duty: 5, excise: 0, rate: 12 });
    expect(rowValue(r.rows, 'Налоговая база')).toBe('105 000 000 сум');
  });

  it('определяет превышение порога малого бизнеса', () => {
    expect(run('nds', 'porog', { brv: 13_000, threshold: 12_000 }).headline?.value).toBe('да');
    expect(run('nds', 'porog', { brv: 11_000, threshold: 12_000 }).headline?.value).toBe('нет');
  });

  it('ниже порога предлагает налог с оборота, а не автоматически 6 %', () => {
    const r = run('nds', 'porog', { brv: 10_000, threshold: 12_000, turnover: 4_000_000_000, turnoverRate: 1 });
    expect(headlineValue(r)).toBe('нет');
    expect(rowValue(r.rows, 'Налог с оборота 1 %')).toBe('40 000 000 сум');
    expect(plain(r.notes?.join(' ') ?? '')).toContain('добровольный режим');
  });

  it('над порогом показывает запас со знаком минус', () => {
    const r = run('nds', 'porog', { brv: 13_500, threshold: 12_000 });
    expect(headlineValue(r)).toBe('да');
    expect(rowValue(r.rows, 'Запас до порога')).toBe('-1 500 БРВ');
  });
});

describe('зарплата', () => {
  it('удерживает НДФЛ из начисленного', () => {
    const r = run('zarp', 'gross', { amount: 5_000_000, months: 1, pdfl: 12, social: 25 });
    expect(headlineValue(r)).toBe('4 400 000 сум');
    expect(rowValue(r.rows, 'Расходы работодателя')).toBe('6 250 000 сум');
  });

  it('умножает начисленное на число месяцев', () => {
    const r = run('zarp', 'gross', { amount: 5_000_000, months: 3, pdfl: 12, social: 25 });
    expect(headlineValue(r)).toBe('13 200 000 сум');
  });

  it('обратный расчёт под сумму на руки сходится с прямым', () => {
    const net = 4_400_000;
    const back = run('zarp', 'net', { net, pdfl: 12 });
    const gross = Number(rowValue(back.rows, 'Начислено').replace(/[^\d,-]/g, ''));
    const forward = run('zarp', 'gross', { amount: gross, months: 1, pdfl: 12, social: 25 });
    expect(headlineValue(forward)).toBe(`${plain(net.toLocaleString('ru-RU'))} сум`);
  });
});

describe('налог на прибыль', () => {
  it('считает налог с базы', () => {
    const r = run('pribyl', 'base', { income: 500_000_000, expense: 300_000_000, rate: 15 });
    expect(headlineValue(r)).toBe('30 000 000 сум');
  });

  it('при убытке налог равен нулю', () => {
    const r = run('pribyl', 'base', { income: 100_000_000, expense: 140_000_000, rate: 15 });
    expect(headlineValue(r)).toBe('0 сум');
  });

  it('льгота снижает ставку вдвое', () => {
    const r = run('pribyl', 'preference', { income: 200_000_000, expense: 140_000_000, rate: 15, discount: 50 });
    expect(rowValue(r.rows, 'По ставке 7,5 %')).toBe('4 500 000 сум');
    expect(rowValue(r.rows, 'Экономия')).toBe('4 500 000 сум');
  });
});

describe('специальные режимы', () => {
  it('налог с оборота по ставке 4 % (ч. 4 ст. 468 НК)', () => {
    const r = run('rezh', 'oborot', { income: 300_000_000, rate: 4 });
    expect(headlineValue(r)).toBe('12 000 000 сум');
  });

  it('раздельный учёт суммирует налог по видам деятельности', () => {
    const r = run('rezh', 'razdelno', { a1: 200_000_000, r1: 1, a2: 100_000_000, r2: 4 });
    expect(headlineValue(r)).toBe('6 000 000 сум');
    expect(rowValue(r.rows, 'Средняя ставка')).toBe('2 %');
  });

  it('раздельный учёт игнорирует пустые виды', () => {
    const r = run('rezh', 'razdelno', { a1: 100_000_000, r1: 2, a2: 0, r2: 4 });
    expect(headlineValue(r)).toBe('2 000 000 сум');
  });
});

describe('социальный налог', () => {
  it('общеустановленная ставка 12 % (ст. 405 НК)', () => {
    const r = run('socnalog', 'oby', { fot: 50_000_000, rate: 12 });
    expect(headlineValue(r)).toBe('6 000 000 сум');
  });

  it('бюджетные организации — 25 %', () => {
    const r = run('socnalog', 'byudzhet', { fot: 40_000_000, rate: 25 });
    expect(headlineValue(r)).toBe('10 000 000 сум');
  });

  it('работники с инвалидностью — 4,7 %', () => {
    const r = run('socnalog', 'invalidnost', { fot: 20_000_000, rate: 4.7 });
    expect(headlineValue(r)).toBe('940 000 сум');
  });

  it('отдельные территории — 1 %', () => {
    const r = run('socnalog', 'territorii', { fot: 30_000_000, rate: 1 });
    expect(headlineValue(r)).toBe('300 000 сум');
  });

  it('ставка применяется ко всему ФОТ, а не к части выплат', () => {
    const r = run('socnalog', 'oby', { fot: 10_000_000, rate: 12 });
    expect(rowValue(r.rows, 'Ставка 12 %')).toBe('12 %');
  });
});

describe('уставной фонд', () => {
  it('складывает увеличение', () => {
    expect(headlineValue(run('uf', 'increase', { current: 10_000_000, add: 5_000_000 }))).toBe(
      '15 000 000 сум',
    );
  });

  it('вычитает уменьшение', () => {
    expect(headlineValue(run('uf', 'decrease', { current: 10_000_000, take: 3_000_000, min: 0 }))).toBe(
      '7 000 000 сум',
    );
  });

  it('предупреждает, когда остаток ниже минимального размера', () => {
    const r = run('uf', 'decrease', { current: 1_000_000, take: 900_000, min: 500_000 });
    expect(rowValue(r.rows, 'Минимум по закону')).toBe('500 000 сум');
    expect(plain(r.notes?.join(' ') ?? '')).toContain('максимум 500 000 сум');
  });

  it('без минимума предупреждения нет', () => {
    const r = run('uf', 'decrease', { current: 1_000_000, take: 900_000, min: 0 });
    expect(plain(r.notes?.join(' ') ?? '')).toContain('не требуется');
  });

  it('предупреждает, когда чистые активы меньше уставного фонда', () => {
    const r = run('uf', 'decrease', { current: 10_000_000, take: 1_000_000, min: 0, netAssets: 5_000_000 });
    expect(plain(r.notes?.join(' ') ?? '')).toContain('Стоимость чистых активов меньше уставного фонда');
  });
});

describe('акциз', () => {
  it('фиксированная ставка: количество × ставка за единицу', () => {
    const r = run('aktsiz', 'tverdaya', { qty: 10, perUnit: 402_000 });
    expect(headlineValue(r)).toBe('4 020 000 сум');
  });

  it('адвалорная ставка считается от стоимости без акциза и НДС', () => {
    const r = run('aktsiz', 'advalornaya', { value: 100_000_000, rate: 10, cost: 0 });
    expect(rowValue(r.rows, 'База акциза')).toBe('100 000 000 сум');
    expect(headlineValue(r)).toBe('10 000 000 сум');
  });

  it('при продаже ниже себестоимости база — фактическая себестоимость', () => {
    const r = run('aktsiz', 'advalornaya', { value: 80_000_000, rate: 10, cost: 100_000_000 });
    expect(rowValue(r.rows, 'База акциза')).toBe('100 000 000 сум');
    expect(headlineValue(r)).toBe('10 000 000 сум');
  });

  it('на импорте база — только таможенная стоимость, без пошлины', () => {
    const r = run('aktsiz', 'import', { customs: 10_000_000, rate: 70 });
    expect(headlineValue(r)).toBe('7 000 000 сум');
    expect(plain(r.notes?.join(' ') ?? '')).toContain('Пошлины и сборы в базу по адвалорному акцизу при импорте не включаются');
  });

  it('комбинированная ставка складывает адвалорную и фиксированную части', () => {
    const r = run('aktsiz', 'kombinirovannaya', { customs: 1_000_000, adv: 10, qty: 1000, perUnit: 325 });
    expect(headlineValue(r)).toBe('425 000 сум');
  });
});

describe('минимальные величины', () => {
  it('пересчитывает сумму в БРВ', () => {
    const r = run('minimumy', 'convert', { amount: 12_000_000, brv: 440_000, mrot: 1_360_000 });
    expect(headlineValue(r)).toBe('27,27 БРВ');
  });

  it('показывает порог 12 000 БРВ в суммах', () => {
    const r = run('minimumy', 'convert', { amount: 1, brv: 440_000, mrot: 1_360_000 });
    expect(rowValue(r.rows, 'Порог 12 000 БРВ в сум')).toBe('5 280 000 000 сум');
  });
});
