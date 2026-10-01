import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CalculatorIndex } from './CalculatorIndex';
import { CalculatorPage } from './CalculatorPage';
import { HomePage } from './HomePage';
import { CALCULATORS } from '../lib/calc/registry';

function render(node: React.ReactNode, path: string) {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={node} />
        <Route path="/kalkulyatory" element={node} />
        <Route path="/k/:id" element={node} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('рендер калькуляторов', () => {
  it('индекс показывает все калькуляторы', () => {
    const html = render(<CalculatorIndex />, '/kalkulyatory');
    for (const c of CALCULATORS) {
      expect(html, c.id).toContain(c.title);
    }
    expect(html).toContain('Калькуляторы');
  });

  it('каждая конфигурация каждого калькулятора рендерится по своей ссылке', () => {
    for (const c of CALCULATORS) {
      for (const cfg of c.configs) {
        const html = render(<CalculatorPage />, `/k/${c.id}?c=${cfg.id}`);
        expect(html, `${c.id}/${cfg.id} должен открываться`).not.toContain('Калькулятор не найден');
        // поля именно этой конфигурации, а не первой по умолчанию
        for (const f of cfg.fields) {
          expect(html, `${c.id}/${cfg.id}: нет поля «${f.label}»`).toContain(f.label);
        }
      }
    }
  });

  it('на странице калькулятора видны поля и результат', () => {
    const html = render(<CalculatorPage />, '/k/nds');
    expect(html).toContain('Сумма без НДС');
    expect(html).toContain('Ставка НДС');
    expect(html).toContain('К уплате');
    expect(html).toContain('Источники');
  });

  it('источники ведут на статьи базы знаний', () => {
    const html = render(<CalculatorPage />, '/k/socnalog');
    expect(html).toContain('/s/');
    expect(html).toContain('kak-rasschitat-socialnyy-nalog-yuridicheskomu-licu');
  });

  it('неизвестный калькулятор не роняет страницу', () => {
    const html = render(<CalculatorPage />, '/k/takogo-net');
    expect(html).toContain('Калькулятор не найден');
  });

  it('подсказка о сверке ставок присутствует', () => {
    const html = render(<CalculatorPage />, '/k/nds');
    expect(html).toContain('Проверьте их по НК');
  });
});

describe('калькуляторы на главной', () => {
  it('главная перечисляет все калькуляторы со ссылками', () => {
    const html = render(<HomePage />, '/');
    for (const c of CALCULATORS) {
      expect(html, `нет ${c.id} на главной`).toContain(c.title);
      expect(html, `нет ссылки на ${c.id}`).toContain(`/k/${c.id}`);
    }
  });

  it('на главной есть переход в полный раздел', () => {
    const html = render(<HomePage />, '/');
    expect(html).toContain('Все сценарии');
    expect(html).toContain('/kalkulyatory');
  });

  it('главная предупреждает, что ставки нужно сверять', () => {
    const html = render(<HomePage />, '/');
    expect(html).toContain('актуальные значения по НК');
  });
});
