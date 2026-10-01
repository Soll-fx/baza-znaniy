/**
 * Общий разбор страницы базы знаний.
 *
 * Используется двумя входами:
 *   probe.mjs     — наш отдельный профиль Chrome (npm run probe)
 *   cdp-probe.mjs — ваш уже открытый Chrome с включённой отладкой
 *
 * Логика одна, чтобы выводы о селекторах не расходились между ними.
 */

/** Кандидаты на раскрытие узлов дерева. */
const EXPANDERS = [
  'button[aria-expanded="false"]',
  '[role="button"][aria-expanded="false"]',
  '[class*="expand"]',
  '[class*="collapse"]',
  '[class*="toggle"]',
  '[class*="arrow"]',
  '[class*="chevron"]',
  '[class*="caret"]',
  '[class*="plus"]',
  'summary',
  'details',
];

/** Слова, по которым опознаём кнопку выгрузки документа. */
const DOWNLOAD_WORDS = [
  'скачать',
  'выгрузить',
  'экспорт',
  'печать',
  'pdf',
  'документ',
];

const CLICKABLE = 'button, a, [role="button"], [onclick], [class*="btn"], [class*="download"]';

export const trim = (s, n = 100) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Раскрывает дерево в несколько проходов, пока число видимых ссылок
 * перестаёт расти. Без этого глубокие разделы остаются свёрнутыми.
 */
async function expandTree(page, log) {
  const count = () => page.evaluate(() => document.querySelectorAll('a[href]').length);

  let before = await count();
  log(`\n1. Раскрываю дерево (видно ссылок: ${before})`);

  for (let pass = 1; pass <= 8; pass += 1) {
    let clicked = 0;
    for (const sel of EXPANDERS) {
      const nodes = await page.$$(sel);
      for (const n of nodes.slice(0, 500)) {
        try {
          if (!(await n.isVisible())) continue;
          await n.scrollIntoViewIfNeeded({ timeout: 400 }).catch(() => {});
          await n.click({ timeout: 600 });
          clicked += 1;
          await page.waitForTimeout(110);
        } catch {
          /* узел не кликнулся — пропускаем */
        }
      }
      if (clicked) break;
    }
    await page.waitForTimeout(1200);
    const after = await count();
    log(`   проход ${pass}: нажато ${clicked}, ссылок ${before} → ${after}`);
    if (after === before) break;
    before = after;
  }
  return { passes: 8, visibleLinks: before };
}

/** Ссылки из DOM с их глубиной в списках и признаком «из сайдбара». */
async function collectDomLinks(page) {
  return page.$$eval('a[href]', (els) =>
    els
      .map((a) => {
        let depth = 0;
        for (let p = a.parentElement; p && p.tagName !== 'BODY'; p = p.parentElement) {
          if (/^(UL|OL)$/.test(p.tagName)) depth += 1;
        }
        return {
          href: a.href || '',
          text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140),
          depth,
          cls: (a.className || '').toString().slice(0, 80),
          inAside: !!a.closest(
            'aside, nav, [class*="side"], [class*="menu"], [class*="catalog"], [class*="tree"]',
          ),
        };
      })
      .filter((x) => x.href.startsWith('http')),
  );
}

/** Некоторые SPA отдают адреса только во встроенном JSON. */
async function collectScriptLinks(page) {
  return page.evaluate(() => {
    const out = new Set();
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      if (!/https?:/.test(t)) continue;
      for (const m of t.matchAll(/https?:\\?\/\\?\/[a-z0-9.:/_-]*mcfr[a-z0-9.:/_-]+/gi)) {
        out.add(m[0].replace(/\\\//g, '/'));
      }
    }
    return [...out];
  });
}

/** Ссылки во вложенных iframe. */
async function collectFrames(page) {
  const out = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const ls = await f.$$eval('a[href]', (as) =>
        as.map((a) => a.href).filter((h) => h.startsWith('http')),
      );
      out.push({ frame: f.url(), count: ls.length, sample: ls.slice(0, 5) });
    } catch {
      /* фрейм недоступен */
    }
  }
  return out;
}

async function collectClickables(page) {
  return page.$$eval(CLICKABLE, (els) =>
    els
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
        cls: (el.className || '').toString().slice(0, 100),
        id: el.id || '',
        title: el.getAttribute('title') || '',
        aria: el.getAttribute('aria-label') || '',
        href: el.getAttribute('href') || '',
      }))
      .filter((x) => (x.text || x.title || x.aria || x.href).length > 0),
  );
}

/**
 * Разбирает уже открытую страницу и возвращает отчёт.
 * Ничего не скачивает, но при наличии кнопки — делает один пробный клик,
 * чтобы посмотреть, что сервер отдаёт по сети.
 */
export async function analyzePage(page, { log = () => {}, clickDownload = true } = {}) {
  const netFileResponses = [];
  const apiCalls = [];
  const onResponse = (res) => {
    try {
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (/pdf|zip|rar|7z|docx?|xlsx?|csv|octet-stream|vnd\./.test(ct)) {
        netFileResponses.push({
          url: res.url(),
          status: res.status(),
          type: ct.split(';')[0],
          method: res.request().method(),
        });
      }
    } catch {
      /* ответ недоступен */
    }
  };
  const onRequest = (r) => {
    const u = r.url();
    if (/api|graphql|\/mi\//i.test(u) && !/\.(js|css|png|jpe?g|svg|woff2?)(\?|$)/i.test(u)) {
      apiCalls.push(`${r.method()} ${u.slice(0, 170)}`);
    }
  };
  page.on('response', onResponse);
  page.on('request', onRequest);

  const tree = await expandTree(page, log);

  log('\n2. Собираю ссылки');
  const domLinks = await collectDomLinks(page);
  const scriptLinks = await collectScriptLinks(page);
  const frames = await collectFrames(page);

  const all = new Map();
  for (const l of domLinks) all.set(l.href, l);
  for (const h of scriptLinks) {
    if (!all.has(h)) all.set(h, { href: h, text: '', depth: -1, cls: '', inAside: false });
  }
  const articleLinks = [...all.values()].filter(
    (l) => /\/fl\/uni\//.test(l.href) || /\/fl\/(?!uni)[a-z]/i.test(l.href),
  );

  log(`   в DOM: ${domLinks.length}, в <script>: ${scriptLinks.length}, уникальных: ${all.size}`);
  log(`   похожи на материалы: ${articleLinks.length}`);
  if (frames.length) log(`   iframe: ${JSON.stringify(frames)}`);

  log('\n3. Ищу кнопку скачивания');
  const clickables = await collectClickables(page);
  const downloadCandidates = clickables.filter((x) =>
    DOWNLOAD_WORDS.some((w) => `${x.text} ${x.title} ${x.aria} ${x.cls} ${x.href}`.toLowerCase().includes(w)),
  );
  log(`   интерактивных элементов: ${clickables.length}, кандидатов: ${downloadCandidates.length}`);
  downloadCandidates.slice(0, 10).forEach((c) => log(`     · <${c.tag} class="${c.cls}"> ${trim(c.text, 60)}`));

  const hasLoginButton = clickables.some((c) =>
    /вход|регистрац|войти|login|sign ?in/i.test(`${c.text} ${c.aria} ${c.cls}`),
  );
  const onPublicLanding = articleLinks.length === 0 && hasLoginButton;
  if (onPublicLanding) {
    log('\n⚠️  Мы на публичном лендинге: разделов нет, есть кнопка входа.');
    log('   Сессия не подхватилась — выгрузщик по этому отчёту работать не будет.');
  }

  let probeDownload = null;
  if (clickDownload && downloadCandidates.length && !onPublicLanding) {
    const c = downloadCandidates[0];
    log(`   пробую нажать: «${trim(c.text, 50)}»`);
    try {
      const target = await page.$(`${c.tag}:has-text("${trim(c.text, 25)}")`);
      const dl = page.waitForEvent('download', { timeout: 12_000 }).catch(() => null);
      await target?.click({ timeout: 6000 });
      const download = await dl;
      if (download) {
        probeDownload = download.suggestedFilename();
        log(`   ✓ файл: ${probeDownload}`);
      } else {
        await page.waitForTimeout(6000);
        log('   загрузки не было — смотрю сеть');
      }
    } catch (e) {
      log(`   нажать не вышло: ${trim(e.message, 90)}`);
    }
  }

  page.off('response', onResponse);
  page.off('request', onRequest);

  return {
    url: page.url(),
    title: await page.title(),
    onPublicLanding,
    structure: {
      ...tree,
      domLinks: domLinks.length,
      scriptLinks: scriptLinks.length,
      uniqueLinks: all.size,
      articleLikeLinks: articleLinks.length,
      frames,
    },
    downloadCandidates: downloadCandidates.slice(0, 40),
    allButtons: clickables.filter((c) => c.tag === 'button' || c.aria).slice(0, 80),
    netFileResponses: netFileResponses.slice(0, 40),
    apiCalls: apiCalls.slice(0, 40),
    articleLinkSample: articleLinks
      .slice(0, 60)
      .map((l) => ({ href: l.href, text: l.text, depth: l.depth, inAside: l.inAside })),
  };
}

/** Короткая выжимка — её удобно скопировать в чат. */
export function formatSummary(report, extra = []) {
  const s = report.structure;
  const out = [];
  out.push('=== РАЗВЕДКА id.mcfr.uz ===');
  out.push(`URL:       ${report.url}`);
  out.push(`Заголовок: ${report.title}`);
  if (report.onPublicLanding) {
    out.push('!!! ПУБЛИЧНЫЙ ЛЕНДИНГ — сессии нет, разделов нет');
  }
  out.push('');
  out.push(`Ссылок в DOM: ${s.domLinks} | в <script>: ${s.scriptLinks} | уникальных: ${s.uniqueLinks}`);
  out.push(`Похожи на материалы (/fl/…): ${s.articleLikeLinks}`);
  if (s.frames?.length) out.push(`iframe: ${JSON.stringify(s.frames)}`);
  out.push('');
  out.push(`Кандидатов на кнопку «Скачать»: ${report.downloadCandidates.length}`);
  report.downloadCandidates
    .slice(0, 12)
    .forEach((c) => out.push(`  <${c.tag} class="${c.cls}" href="${trim(c.href, 40)}"> ${trim(c.text, 70)}`));
  out.push('');
  out.push(`Ответов с файлами по сети: ${report.netFileResponses.length}`);
  report.netFileResponses
    .slice(0, 12)
    .forEach((n) => out.push(`  ${n.status} ${n.type} ${n.method} ${trim(n.url, 90)}`));
  if (report.apiCalls.length) {
    out.push('');
    out.push('API-запросы:');
    report.apiCalls.slice(0, 10).forEach((a) => out.push(`  ${a}`));
  }
  if (report.articleLinkSample.length) {
    out.push('');
    out.push('Примеры ссылок на материалы:');
    report.articleLinkSample
      .slice(0, 15)
      .forEach((l) => out.push(`  ${l.inAside ? '[в дереве] ' : ''}${trim(l.text, 50)} → ${trim(l.href, 80)}`));
  }
  if (extra.length) {
    out.push('');
    extra.forEach((e) => out.push(e));
  }
  return out.join('\n');
}
