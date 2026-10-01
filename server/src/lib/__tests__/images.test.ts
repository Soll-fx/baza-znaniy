import { describe, expect, it } from 'vitest';

import { extractImages } from '../markdown.js';
import { isDecorativeImage, LOGO_MAX_SIDE, THIN_IMAGE_HEIGHT } from '../images.js';

describe('isDecorativeImage', () => {
  it('считает декоративной картинку, обёрнутую в ссылку', () => {
    expect(
      isDecorativeImage({ inLink: true, inTable: false, width: 730, height: 300 }),
    ).toBe(true);
  });

  it('считает декоративной иконку и полоску-баннер по высоте', () => {
    expect(isDecorativeImage({ inLink: false, inTable: false, width: 80, height: 80 })).toBe(true);
    expect(isDecorativeImage({ inLink: false, inTable: false, width: 730, height: 49 })).toBe(true);
    expect(THIN_IMAGE_HEIGHT).toBe(110);
  });

  it('считает декоративным логотип в ячейке таблицы', () => {
    expect(
      isDecorativeImage({ inLink: false, inTable: true, width: 200, height: 60 }),
    ).toBe(true);
  });

  it('не считает декоративной большую картинку в таблице', () => {
    expect(isDecorativeImage({ inLink: false, inTable: true, width: 900, height: 700 })).toBe(false);
    expect(LOGO_MAX_SIDE).toBe(320);
  });

  it('не считает декоративным содержательный скриншот в тексте', () => {
    expect(isDecorativeImage({ inLink: false, inTable: false, width: 1241, height: 1755 })).toBe(
      false,
    );
  });

  it('вложению alt не требуется', () => {
    expect(
      isDecorativeImage({ inLink: false, inTable: false, width: 1241, height: 1755, role: 'attachment' }),
    ).toBe(true);
  });
});

describe('extractImages определяет контекст', () => {
  it('видит картинку внутри ссылки', () => {
    const md = '[![](images/a.jpg)](https://1gb.uz/#/document/16/1)';
    const imgs = extractImages(md);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.inLink).toBe(true);
    expect(imgs[0]!.inTable).toBe(false);
  });

  it('видит картинку в строке таблицы', () => {
    const md = '| ![](images/a.png) | Текст |';
    const imgs = extractImages(md);
    expect(imgs[0]!.inTable).toBe(true);
    expect(imgs[0]!.inLink).toBe(false);
  });

  it('обычная картинка в абзаце — ни ссылка, ни таблица', () => {
    const imgs = extractImages('Текст\n\n![](images/a.jpg)\n');
    expect(imgs[0]!.inLink).toBe(false);
    expect(imgs[0]!.inTable).toBe(false);
  });

  it('не путает обычную картинку с картинкой в ссылке на соседней строке', () => {
    const imgs = extractImages('[![](images/a.jpg)](https://site)\n\n![](images/b.jpg)\n');
    expect(imgs[0]!.inLink).toBe(true);
    expect(imgs[1]!.inLink).toBe(false);
  });
});
