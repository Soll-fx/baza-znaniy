import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { validateTree, counts, type ValidationReport } from '../validator.js';
import { loadDirSource } from '../source.js';
import { ROOT } from '../config.js';
import type { IngestTopic } from '../ingest.js';

const codes = (r: ValidationReport, severity?: string) =>
  r.issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);

/** Минимальное валидное дерево, в которое тесты добавляют дефекты. */
function fixture(): IngestTopic[] {
  return [
    {
      slug: 'nalogovyy-kodeks',
      title: 'Налоговый кодекс',
      children: [
        {
          slug: 'nds-st-12',
          title: 'НДС 12 %',
          article: {
            slug: 'nds-st-12',
            title: 'НДС 12 %',
            status: 'published',
            sourceUrl: 'https://lex.uz',
            bodyMd: '## Область\n\nСм. [[nds-st-15]].\n',
          },
        },
        {
          slug: 'nds-st-15',
          title: 'НДС льготы',
          article: {
            slug: 'nds-st-15',
            title: 'НДС льготы',
            bodyMd: '## Льготы\n\nСм. [[nds-st-12]].\n',
          },
        },
      ],
    },
  ];
}

const opts = { baseDir: os.tmpdir(), requireAlt: true, maxDepth: 8 };

describe('валидатор дерева — чистый случай', () => {
  it('не находит ошибок на корректном дереве', async () => {
    const report = await validateTree(fixture(), opts);
    expect(codes(report, 'error')).toEqual([]);
  });

  it('считает рубрики, статьи и заголовки', async () => {
    const report = await validateTree(fixture(), opts);
    expect(report.stats.topics).toBe(3);
    expect(report.stats.articles).toBe(2);
    expect(report.stats.headings).toBe(2);
  });
});

describe('валидатор — битые ссылки', () => {
  it('ловит ссылку на несуществующую статью', async () => {
    const tree = fixture();
    tree[0]!.children![0]!.article!.bodyMd = 'См. [[nesushchestvuyushchaya]].';

    const report = await validateTree(tree, opts);
    const broken = report.issues.find((i) => i.code === 'LINK_BROKEN');
    expect(broken).toBeDefined();
    expect(broken!.severity).toBe('error');
    expect(broken!.message).toContain('nesushchestvuyushchaya');
  });

  it('подсказывает похожие статьи', async () => {
    const tree = fixture();
    tree[0]!.children![0]!.article!.bodyMd = 'См. [[nds-st-1]].';

    const report = await validateTree(tree, opts);
    const broken = report.issues.find((i) => i.code === 'LINK_BROKEN');
    expect(broken?.hint).toContain('nds-st-12');
  });

  it('ловит якорь, которого нет в целевой статье', async () => {
    const tree = fixture();
    tree[0]!.children![0]!.article!.bodyMd = 'См. [[nds-st-15#nesushchestvuyushchiy-yakor]].';

    const report = await validateTree(tree, opts);
    expect(codes(report, 'error')).toContain('ANCHOR_MISSING');
  });

  it('валидный якорь проходит', async () => {
    const tree = fixture();
    tree[0]!.children![0]!.article!.bodyMd = 'См. [[nds-st-15#льготы]].';

    const report = await validateTree(tree, opts);
    expect(codes(report, 'error')).toEqual([]);
  });

  it('сообщает о неоднозначном slug', async () => {
    const tree = fixture();
    tree.push({
      slug: 'otchetnost',
      title: 'Отчётность',
      children: [
        { slug: 'nds-st-12', title: 'Дубль', article: { slug: 'nds-st-12', title: 'Дубль', bodyMd: 'Текст подлиннее, чтобы не словить предупреждение о дубликате тела статьи.' } },
      ],
    });

    const report = await validateTree(tree, opts);
    const ambiguous = report.issues.find((i) => i.code === 'LINK_AMBIGUOUS');
    expect(ambiguous?.severity).toBe('warning');
    expect(ambiguous?.hint).toContain('рубрика/статья');
    // неоднозначность — это не «битая» ссылка
    expect(codes(report, 'error')).toEqual([]);
  });
});

describe('валидатор — изображения', () => {
  it('ловит файл, которого нет на диске', async () => {
    const tree = fixture();
    tree[0]!.children![0]!.article!.assets = [{ file: 'images/net-takogo.png', alt: 'Схема' }];

    const report = await validateTree(tree, opts);
    const missing = report.issues.find((i) => i.code === 'ASSET_FILE_MISSING');
    expect(missing?.severity).toBe('error');
    expect(missing?.message).toContain('net-takogo.png');
  });

  it('ловит картинку из текста, не описанную в assets[]', async () => {
    const tree = fixture();
    tree[0]!.children![0]!.article!.bodyMd = '![Схема](images/a.png)';

    const report = await validateTree(tree, opts);
    expect(codes(report, 'error')).toContain('IMAGE_NOT_DECLARED');
  });

  it('ругается на пустой alt', async () => {
    const tree = fixture();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-'));
    await fs.mkdir(path.join(dir, 'images'));
    await fs.writeFile(path.join(dir, 'images', 'a.png'), 'x');

    tree[0]!.children![0]!.article!.assets = [{ file: 'images/a.png', alt: '' }];
    const report = await validateTree(tree, { ...opts, baseDir: dir });

    const alt = report.issues.find((i) => i.code === 'ASSET_ALT_EMPTY');
    expect(alt?.severity).toBe('warning');
    expect(alt?.hint).toContain('скринридер');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('пропускает корректную картинку', async () => {
    const tree = fixture();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-'));
    await fs.mkdir(path.join(dir, 'images'));
    await fs.writeFile(path.join(dir, 'images', 'a.png'), 'x');

    tree[0]!.children![0]!.article!.bodyMd = '![Схема НДС](images/a.png)';
    tree[0]!.children![0]!.article!.assets = [{ file: 'images/a.png', alt: 'Схема НДС' }];
    const report = await validateTree(tree, { ...opts, baseDir: dir });

    expect(codes(report, 'error')).toEqual([]);
    expect(report.stats.images).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('валидатор — структура', () => {
  it('ловит некорректный slug', async () => {
    const tree = fixture();
    tree[0]!.children![0]!.slug = 'Плохой Слаг';
    const report = await validateTree(tree, opts);
    expect(codes(report, 'error')).toContain('TOPIC_SLUG_INVALID');
  });

  it('ловит пустое тело статьи', async () => {
    const tree = fixture();
    tree[0]!.children![0]!.article!.bodyMd = '   ';
    const report = await validateTree(tree, opts);
    expect(codes(report, 'error')).toContain('ARTICLE_BODY_EMPTY');
  });

  it('ловит дубликат пути рубрики', async () => {
    const tree = fixture();
    tree.push({ slug: 'nalogovyy-kodeks', title: 'Дубль корня', children: [] });
    const report = await validateTree(tree, opts);
    expect(codes(report, 'error')).toContain('TOPIC_PATH_DUPLICATE');
  });

  it('ловит рубрику без статей и подрубрик', async () => {
    const tree = fixture();
    tree.push({ slug: 'pustaya', title: 'Пустая', children: [] });
    const report = await validateTree(tree, opts);
    const empty = report.issues.find((i) => i.code === 'TOPIC_EMPTY');
    expect(empty?.severity).toBe('warning');
  });

  it('ловит дублирующиеся тексты статей', async () => {
    const long = 'Один и тот же достаточно длинный текст. '.repeat(12);
    const tree: IngestTopic[] = [
      { slug: 'a', title: 'А', article: { slug: 'a', title: 'А', bodyMd: long } },
      { slug: 'b', title: 'Б', article: { slug: 'b', title: 'Б', bodyMd: long } },
    ];
    const report = await validateTree(tree, opts);
    expect(codes(report, 'warning')).toContain('ARTICLE_DUPLICATE_BODY');
  });

  it('ловит слишком глубокую вложенность', async () => {
    let nodes: IngestTopic[] = [{ slug: 'l5', title: 'Пятый', article: { slug: 'l5', title: 'Пятый', bodyMd: 'Текст' } }];
    for (let i = 4; i >= 1; i -= 1) {
      nodes = [{ slug: `l${i}`, title: `Уровень ${i}`, children: nodes }];
    }
    const report = await validateTree(nodes, { ...opts, maxDepth: 3 });
    expect(codes(report, 'warning')).toContain('TOPIC_TOO_DEEP');
  });
});

// Блок работает на настоящем content/ (импорт «Системы Главбух», сотни мегабайт),
// поэтому validateTree занимает ~11 с — дефолтных 5 с не хватает. Abort по таймауту
// не прерывает уже запущенный обход, и его остаточная работа блокирует следующие
// тесты, поэтому таймаут здесь задан явно.
const HEAVY = 60_000;

describe('импортированный корпус', () => {
  it('проходит валидацию без ошибок', async () => {
    const dir = path.resolve(ROOT, 'content');
    const tree = await loadDirSource(dir);
    const report = await validateTree(tree, { baseDir: dir, requireAlt: true });

    const errors = codes(report, 'error');
    expect(errors).toEqual([]);
    expect(report.stats.articles).toBeGreaterThanOrEqual(5);
    // Раньше здесь было ровно 2 картинки из демо-разделов. Теперь в content/
    // лежит импорт базы «Система Главбух» с иллюстрациями, поэтому проверяем
    // не конкретное число, а то, что картинки вообще находятся и все лежат на диске.
    expect(report.stats.images).toBeGreaterThan(0);
  }, HEAVY);

  it('все вики-ссылки разрешаются', async () => {
    const dir = path.resolve(ROOT, 'content');
    const tree = await loadDirSource(dir);
    const report = await validateTree(tree, { baseDir: dir });
    expect(report.issues.filter((i) => i.code === 'LINK_BROKEN')).toHaveLength(0);
  }, HEAVY);

  it('иерархия строится по каталогам', async () => {
    const dir = path.resolve(ROOT, 'content');
    const tree = await loadDirSource(dir);
    const slugs = tree.map((t) => t.slug);
    expect(slugs).toContain('kodeksy-i-zakony');
    expect(slugs).toContain('nalogooblozhenie-i-buhgalterskiy-uchet');
    expect(slugs).toContain('blanki');
  }, HEAVY);

  it('подкаталог становится подрубрикой', async () => {
    const dir = path.resolve(ROOT, 'content');
    const tree = await loadDirSource(dir);
    const root = tree.find((t) => t.slug === 'nalogooblozhenie-i-buhgalterskiy-uchet');
    expect(root?.children?.some((c) => c.slug === 'nalogi-i-sbory')).toBe(true);
  }, HEAVY);

  it('статус из front matter попадает в дерево', async () => {
    const dir = path.resolve(ROOT, 'content');
    const tree = await loadDirSource(dir);
    const blanki = tree.find((t) => t.slug === 'blanki');
    const published = blanki?.children?.find((c) => c.article?.status === 'published');
    expect(published).toBeDefined();
    expect(published?.article?.sourceUrl).toContain('1gb.uz');
  }, HEAVY);
});
