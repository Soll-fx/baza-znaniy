import { describe, expect, it } from 'vitest';
import { slugify, slugifyAnchor, uniqueAnchor } from '../slug.js';
import {
  extractImages,
  extractLinks,
  renderMarkdown,
  splitAnchor,
  splitWikilink,
  readingMinutes,
} from '../markdown.js';
import { storageKeyFor, resolveOnDisk, kindFor, mimeFor, sha256, imageSize } from '../storage.js';

describe('slugify', () => {
  it('транслитерирует кириллицу', () => {
    expect(slugify('Налоговый кодекс')).toBe('nalogovyy-kodeks');
    expect(slugify('Учётная политика')).toBe('uchetnaya-politika');
    expect(slugify('Отчётность')).toBe('otchetnost');
  });

  it('оставляет латиницу и цифры, схлопывает разделители', () => {
    expect(slugify('  НДС 12 % и 0%  ')).toBe('nds-12-i-0');
    expect(slugify('Раздел / Подраздел')).toBe('razdel-podrazdel');
  });

  it('не падает на пустой строке', () => {
    expect(slugify('   ')).toBe('untitled');
  });
});

describe('slugifyAnchor', () => {
  it('сохраняет кириллицу — якоря читаемы', () => {
    expect(slugifyAnchor('Момент возникновения налога')).toBe('момент-возникновения-налога');
  });

  it('убирает markdown-разметку', () => {
    expect(slugifyAnchor('Ставка **12 %**')).toBe('ставка-12');
  });

  it('уникализирует повторы', () => {
    const used = new Map<string, number>();
    expect(uniqueAnchor('итог', used)).toBe('итог');
    expect(uniqueAnchor('итог', used)).toBe('итог-1');
    expect(uniqueAnchor('итог', used)).toBe('итог-2');
  });
});

describe('splitWikilink / splitAnchor', () => {
  it('разбирает цель и подпись', () => {
    expect(splitWikilink('nds-st-12')).toEqual(['nds-st-12', undefined]);
    expect(splitWikilink('nds-st-12|НДС 12 %')).toEqual(['nds-st-12', 'НДС 12 %']);
  });

  it('разбирает якорь', () => {
    expect(splitAnchor('nds-st-12#момент-возникновения')).toEqual({
      slug: 'nds-st-12',
      anchor: 'момент-возникновения',
    });
    expect(splitAnchor('nds-st-12')).toEqual({ slug: 'nds-st-12', anchor: null });
  });
});

describe('extractLinks', () => {
  it('находит вики-ссылки и обычные ссылки', () => {
    const links = extractLinks('См. [[p6-1]] и [внешний](https://lex.uz) и [[nds-st-12|НДС]].');
    expect(links).toEqual([
      { kind: 'internal', rawTarget: 'p6-1', label: 'p6-1' },
      { kind: 'internal', rawTarget: 'nds-st-12', label: 'НДС' },
      { kind: 'external', rawTarget: 'https://lex.uz', label: 'внешний' },
    ]);
  });

  it('не путает изображения со ссылками', () => {
    const links = extractLinks('![схема](images/a.png) и [[b]]');
    expect(links.map((l) => l.kind)).toEqual(['internal']);
  });

  it('дедуплицирует одинаковые цели', () => {
    const links = extractLinks('[[a]] и [[a]] и [[a|A]]');
    expect(links).toHaveLength(1);
  });
});

describe('extractImages', () => {
  it('достаёт src и alt', () => {
    expect(extractImages('![Схема НДС](images/nds.png "Заголовок")')).toEqual([
      {
        src: 'images/nds.png',
        alt: 'Схема НДС',
        title: 'Заголовок',
        inLink: false,
        inTable: false,
      },
    ]);
  });

  it('пустой alt — пустая строка, а не undefined', () => {
    expect(extractImages('![](a.png)')[0]!.alt).toBe('');
  });
});

describe('renderMarkdown', () => {
  it('строит оглавление из h2/h3 и проставляет id', () => {
    const { html, toc } = renderMarkdown('# Заголовок\n\n## Первый\n\n### Вложенный\n');
    expect(html).toContain('<h2 id="первый">Первый</h2>');
    expect(html).toContain('<h3 id="вложенный">Вложенный</h3>');
    expect(toc).toEqual([
      { id: 'первый', label: 'Первый', level: 2 },
      { id: 'вложенный', label: 'Вложенный', level: 3 },
    ]);
  });

  it('h1 не попадает в оглавление', () => {
    const { toc } = renderMarkdown('# Название статьи\n');
    expect(toc).toHaveLength(0);
  });

  it('рендерит вики-ссылку в ссылку на /s/<slug>', () => {
    const { html } = renderMarkdown('См. [[nds-st-12|НДС]] и [[balans]].');
    expect(html).toContain('href="/s/nds-st-12"');
    expect(html).toContain('>НДС</a>');
    expect(html).toContain('data-slug="balans"');
  });

  it('вики-ссылка с якорем сохраняет якорь', () => {
    const { html } = renderMarkdown('[[nds-st-12#момент-возникновения-налога]]');
    expect(html).toContain('#момент-возникновения-налога');
    expect(html).toContain('data-anchor="момент-возникновения-налога"');
  });

  it('вырезает опасный HTML', () => {
    const { html } = renderMarkdown('<script>alert(1)</script>\n\nок');
    expect(html).not.toContain('<script');
  });

  it('сохраняет таблицы', () => {
    const { html } = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th');
  });

  it('одинаковые заголовки получают разные id', () => {
    const { html } = renderMarkdown('## Итог\n\n## Итог\n');
    expect(html).toContain('id="итог"');
    expect(html).toContain('id="итог-1"');
  });
});

describe('readingMinutes', () => {
  it('минимум одна минута', () => {
    expect(readingMinutes('коротко')).toBe(1);
  });

  it('считает по 180 слов в минуту', () => {
    expect(readingMinutes(Array.from({ length: 360 }, () => 'слово').join(' '))).toBe(2);
  });
});

describe('storage', () => {
  it('контент-адресный ключ детерминирован', () => {
    const checksum = 'a'.repeat(64);
    expect(storageKeyFor(checksum, 'Схема НДС.png')).toBe(`assets/aa/aa/${checksum}.png`);
  });

  it('одинаковое содержимое даёт одинаковый ключ', () => {
    const buf = Buffer.from('одинаково');
    expect(sha256(buf)).toBe(sha256(Buffer.from('одинаково')));
  });

  it('блокирует выход за пределы storage', () => {
    expect(() => resolveOnDisk('../../etc/passwd')).toThrow(/Недопустимый/);
    expect(() => resolveOnDisk('assets/a/b/c.png')).not.toThrow();
  });

  it('определяет тип по mime', () => {
    expect(kindFor(mimeFor('a.png'))).toBe('image');
    expect(kindFor(mimeFor('a.pdf'))).toBe('document');
    expect(kindFor(mimeFor('a.xlsx'))).toBe('spreadsheet');
    expect(kindFor(mimeFor('a.zip'))).toBe('archive');
  });

  it('читает размеры PNG', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(8),
      (() => {
        const b = Buffer.alloc(8);
        b.writeUInt32BE(640, 0);
        b.writeUInt32BE(480, 4);
        return b;
      })(),
    ]);
    return expect(imageSize(png)).resolves.toEqual({ width: 640, height: 480 });
  });
});
