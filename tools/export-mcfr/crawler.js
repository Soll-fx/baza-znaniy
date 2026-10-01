/* Сбор базы знаний изнутри вашего браузера.
 *
 * Запуск:
 *   1. Откройте базу знаний на id.mcfr.uz (не 1gb.uz!)
 *   2. Правая кнопка -> Просмотреть код -> Console
 *   3. Вставьте строку-загрузчик и нажмите Enter
 *   4. Нажмите «Диагностика»
 *
 * Скрипт выполняется на странице, поэтому запросы идут с вашими куками.
 * Пароль, ключи и копии профиля Chrome не нужны.
 */
(async () => {
  'use strict';

  /* Имя базы вынесено в начало области видимости: на неё ссылается
   * обработчик кнопки «Сброс», объявленный ниже. */
  const DB = 'kb-crawl';
  const DB_VERSION = 2;

  const STEPS = ['Готово', 'Наблюдение за сетью', 'Собираю адреса', 'Обхожу разделы', 'Скачиваю'];
  let step = 0;
  const setStep = (i) => { step = i; paint(); };

  /* ---------------- Панель ---------------- */
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed;z-index:2147483647;right:16px;bottom:16px;width:350px',
    'background:#12151a;color:#e6e9ef;border:1px solid #2b313b;border-radius:10px',
    'padding:14px;font:13px/1.45 -apple-system,BlinkMacSystemFont,sans-serif',
    'box-shadow:0 10px 40px rgba(0,0,0,.6)'
  ].join(';');
  panel.innerHTML = [
    '<div style="font-weight:600;margin-bottom:6px">Сбор базы знаний</div>',
    '<div id="st" style="color:#9aa4b2;margin-bottom:8px"></div>',
    '<div id="pg" style="height:4px;background:#2b313b;border-radius:2px;overflow:hidden;margin-bottom:8px">',
    '<div id="bar" style="height:100%;width:0;background:#4f9cf9"></div></div>',
    '<div id="log" style="max-height:200px;overflow:auto;font:11px/1.4 ui-monospace,monospace',
    ';color:#aeb7c4;white-space:pre-wrap;background:#0d1015;border:1px solid #232a33;',
    'border-radius:6px;padding:8px;margin-bottom:10px"></div>',
    '<div style="display:flex;gap:6px;flex-wrap:wrap">',
    '<button id="bDiag" style="flex:1;padding:7px;background:#1e242d;color:#e6e9ef;border:1px solid #2b313b;border-radius:6px;cursor:pointer">Диагностика</button>',
    '<button id="bApi" style="flex:1;padding:7px;background:#1e242d;color:#e6e9ef;border:1px solid #2b313b;border-radius:6px;cursor:pointer">Отчёт API</button>',
    '<button id="bRun" style="flex:1;padding:7px;background:#2d5fd6;color:#fff;border:1px solid #2d5fd6;border-radius:6px;cursor:pointer">Обход</button>',
    '<button id="bStop" style="padding:7px;background:#1e242d;color:#e6e9ef;border:1px solid #2b313b;border-radius:6px;cursor:pointer">Стоп</button>',
    '<button id="bReset" style="padding:7px;background:#3a2020;color:#e6a3a3;border:1px solid #5c2b2b;border-radius:6px;cursor:pointer">Сброс</button>',
    '</div>'
  ].join('');
  document.documentElement.appendChild(panel);

  const $ = (id) => panel.querySelector('#' + id);
  const logEl = $('log');
  const say = (m) => {
    logEl.textContent += m + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  };
  const paint = () => {
    $('st').textContent = STEPS[step] || '';
    $('pg').style.display = step >= 3 ? 'block' : 'none';
  };
  paint();

  let stop = false;
  $('bStop').onclick = () => { stop = true; say('— остановлено —'); };
  $('bReset').onclick = () => {
    if (!confirm('Удалить все скачанные файлы и метаданные? Обход начнётся заново.')) return;
    // Сначала закрываем собственное соединение, иначе deleteDatabase
    // упирается в блокировку и срабатывает onblocked.
    try { if (dbc) dbc.close(); } catch { /* уже закрыта */ }
    dbc = null;
    dbp = null;
    const r = indexedDB.deleteDatabase(DB);
    r.onsuccess = () => say('База очищена. Следующий «Обход» начнётся с нуля.');
    r.onerror = () => say('Не удалось удалить базу: ' + (r.error && r.error.message));
    r.onblocked = () => say('База занята другой вкладкой crawler\'а — закройте её и нажмите «Сброс» ещё раз.');
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const IGNORE = /\.(js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp4|webm)(\?|$)/i;
  const myFetch = window.fetch.bind(window);

  /* ---------------- Перехват сети: ищем API со статьями ---------------- */
  const api = [];
  const seenApi = new Set();
  const mine = new WeakSet();

  function noteApi(url, status, text) {
    let u;
    try { u = new URL(url, location.href); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    if (IGNORE.test(u.pathname)) return;
    if (seenApi.has(u.href)) return;
    seenApi.add(u.href);
    api.push({
      url: u.href,
      host: u.host,
      status,
      length: text ? text.length : 0,
      preview: text ? text.slice(0, 600) : ''
    });
    if (api.length > 400) return;
  }

  function looksLikeText(s) {
    return s && /"[^"]{40,}"|"text"|"content"|"body"|"title"|"html"/i.test(s.slice(0, 3000));
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = myFetch(input, init);
    if (!mine.has(input)) {
      p.then((r) => {
        const ct = (r.headers && r.headers.get('content-type')) || '';
        if (/json|text|html/.test(ct) && !IGNORE.test(url)) {
          const c = r.clone();
          c.text().then((t) => noteApi(url, r.status, looksLikeText(t) ? t : '')).catch(() => {});
        }
      }).catch(() => {});
    }
    return p;
  };

  const XHROpen = XMLHttpRequest.prototype.open;
  const XHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__kbUrl = u;
    return XHROpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        const t = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
        if (t && looksLikeText(t)) noteApi(this.__kbUrl, this.status, t);
      } catch { /* не текст */ }
    });
    return XHRSend.apply(this, arguments);
  };

  /* ---------------- IndexedDB ---------------- */
  let dbp = null;   // промис открытия
  let dbc = null;   // само соединение: его надо закрыть перед удалением базы
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, DB_VERSION);
      r.onupgradeneeded = (ev) => {
        const d = r.result;
        if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: 'url' });
        if (!d.objectStoreNames.contains('img')) d.createObjectStore('img', { keyPath: 'key' });
        // v2: байты файлов. Без них возобновление пропускает документы,
        // которые уже помечены в pages, и архив получается неполным.
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'url' });
        if (ev.oldVersion < 2) say('База обновлена до v2: добавлено хранилище файлов.');
      };
      r.onsuccess = () => {
        dbc = r.result;
        // Другая вкладка захотела обновить или удалить базу — освобождаем её,
        // иначе у неё сработает onblocked и операция не завершится.
        dbc.onversionchange = () => {
          try { dbc.close(); } catch { /* уже закрыта */ }
          dbc = null;
          dbp = null;
          say('Другая вкладка изменила базу — соединение закрыто.');
        };
        res(dbc);
      };
      r.onerror = () => rej(r.error);
      r.onblocked = () => say('Открытие базы заблокировано другой вкладкой crawler\'а — закройте её и нажмите ещё раз.');
    });
    return dbp;
  }
  async function put(store, val) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, 'readwrite');
      t.objectStore(store).put(val);
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('прервано'));
    });
  }
  async function get(store, key) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, 'readonly');
      const q = t.objectStore(store).get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function all(store) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, 'readonly');
      const q = t.objectStore(store).getAll();
      q.onsuccess = () => res(q.result || []);
      q.onerror = () => rej(q.error);
    });
  }
  async function del(store, key) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, 'readwrite');
      t.objectStore(store).delete(key);
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  }

  function download(name, blob) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 30000);
  }

  /* ---------------- Разбор HTML ---------------- */
  function abs(u, base) {
    try { return new URL(u, base).href; } catch { return u || ''; }
  }

  function htmlToMd(root, baseUrl) {
    const out = [];
    (function walk(node) {
      if (!node) return;
      for (const el of node.children) {
        const t = (el.tagName || '').toLowerCase();
        if (/^(script|style|noscript|svg|iframe|noscript)$/.test(t)) continue;
        if (/^h[1-6]$/.test(t)) {
          const txt = el.textContent.replace(/\s+/g, ' ').trim();
          if (txt) out.push('#'.repeat(Math.min(+t[1] + 1, 6)) + ' ' + txt);
          continue;
        }
        if (t === 'p') {
          const txt = el.textContent.replace(/\s+/g, ' ').trim();
          if (txt) out.push(txt);
          continue;
        }
        if (t === 'li') {
          const txt = el.textContent.replace(/\s+/g, ' ').trim();
          if (txt) out.push('- ' + txt);
          continue;
        }
        if (t === 'img') {
          const src = abs(el.getAttribute('src') || el.getAttribute('data-src') || '', baseUrl);
          const alt = (el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
          if (src) out.push('![' + (alt || 'рисунок') + '](' + src + ')');
          continue;
        }
        if (t === 'table') {
          const rows = [...el.querySelectorAll('tr')].map((tr) =>
            [...tr.querySelectorAll('th,td')].map((c) => c.textContent.replace(/\s+/g, ' ').trim())
          ).filter((r) => r.length);
          if (rows.length) {
            out.push(rows.map((r) => '| ' + r.join(' | ') + ' |').join('\n'));
            out.push('|' + rows[0].map(() => ' --- ').join('|') + '|');
          }
          continue;
        }
        if (t === 'a') {
          const txt = el.textContent.replace(/\s+/g, ' ').trim();
          const href = abs(el.getAttribute('href') || '', baseUrl);
          if (txt && href && !href.startsWith('javascript:')) {
            out.push((txt.length > 120 ? txt.slice(0, 117) + '…' : txt) + ' <' + href + '>');
            continue;
          }
        }
        if (t === 'br') { out.push(''); continue; }
        if (el.children.length) walk(el);
        else {
          const txt = el.textContent.replace(/\s+/g, ' ').trim();
          if (txt && txt.length > 2) out.push(txt);
        }
      }
    })(root);
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const CAND = [
    'article', 'main', '[class*="articleContent"]', '[class*="article-content"]',
    '[class*="content__inner"]', '[class*="post"]', '[class*="material"]',
    '[class*="document"]', '[class*="viewer"]', '[class*="reader"]',
    '[class*="richtext"]', '[class*="ProseMirror"]', '#content', '.content'
  ];

  function pickContent(doc) {
    for (const sel of CAND) {
      let el = null;
      try { el = doc.querySelector(sel); } catch { continue; }
      if (el && el.textContent.replace(/\s+/g, ' ').trim().length > 400) return el;
    }
    let best = null, bestLen = 0;
    for (const el of doc.querySelectorAll('div, section, article')) {
      const len = el.textContent.replace(/\s+/g, ' ').trim().length;
      if (len > bestLen) { bestLen = len; best = el; }
    }
    return best || doc.body;
  }

  function extract(doc, url) {
    const body = pickContent(doc);
    const h = doc.querySelector('h1');
    return {
      title: (h && h.textContent.trim()) || (doc.title || '').split(/[|\-–—]/)[0].trim() || 'Без названия',
      text: htmlToMd(body, url),
      images: [...doc.querySelectorAll('img')]
        .map((i) => abs(i.getAttribute('src') || i.getAttribute('data-src') || '', url))
        .filter((s) => s && /^https?:/.test(s))
    };
  }

  /* ---------------- Три способа прочитать страницу ---------------- */
  async function viaFetch(url) {
    const r = await myFetch(url, { credentials: 'include', redirect: 'follow' });
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Object.assign({ method: 'fetch', status: r.status }, extract(doc, url));
  }

  async function viaIframe(url) {
    return new Promise((res) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1400px;height:1200px;border:0';
      let settled = false;
      const fail = (why) => ({ method: 'iframe', blocked: true, text: '', title: '', images: [], error: why });
      const done = (v) => {
        if (settled) return;
        settled = true;
        f.remove();
        res(v);
      };
      f.onload = () => {
        let doc = null;
        try { doc = f.contentDocument; } catch { done(fail('нет доступа к документу фрейма')); return; }
        if (!doc) { done(fail('документ фрейма пуст')); return; }
        let tries = 0;
        const poll = () => {
          const links = doc.querySelectorAll ? doc.querySelectorAll('a[href]').length : 0;
          const len = doc.body ? doc.body.textContent.replace(/\s+/g, ' ').trim().length : 0;
          if (links > 0 || len > 400 || ++tries > 24) {
            done(Object.assign({ method: 'iframe', status: 200, __doc: doc }, extract(doc, url)));
          } else setTimeout(poll, 500);
        };
        setTimeout(poll, 700);
      };
      f.onerror = () => done(fail('ошибка загрузки фрейма'));
      f.src = url;
      document.body.appendChild(f);
      setTimeout(() => done(fail('превышено время ожидания')), 30000);
    });
  }

  async function readPage(url) {
    let a = null;
    let aErr = '';
    try {
      a = await viaFetch(url);
      if (a.text && a.text.length > 300) return a;
    } catch (e) {
      aErr = e && e.message ? e.message : String(e);
    }
    try {
      const b = await viaIframe(url);
      if (b.text && b.text.length > 300) return b;
      if (a && a.text) return a;
      return { method: 'fail', text: '', title: '', images: [], error: 'iframe: ' + (b.blocked ? 'заблокирован' : 'пусто') + (aErr ? '; fetch: ' + aErr : '') };
    } catch (e) {
      return { method: 'fail', text: '', title: '', images: [], error: aErr || String(e) };
    }
  }

  /* ---------------- Ссылки ---------------- */
  async function expandTree() {
    const here = location.href;
    const sels = [
      'button[aria-expanded="false"]', '[role="button"][aria-expanded="false"]',
      'summary', 'details > div[class*="head"]',
      '[class*="chevron"]', '[class*="caret"]', '[class*="arrow"]',
      '[class*="expand"]', '[class*="toggle"]'
    ];
    for (let pass = 1; pass <= 6; pass++) {
      let n = 0;
      for (const s of sels) {
        if (stop) return;
        for (const el of [...document.querySelectorAll(s)].slice(0, 300)) {
          if (stop) return;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (/^A$/.test(el.tagName) || el.closest('a[href]')) continue;
          el.click();
          n++;
          await sleep(100);
          if (location.href !== here) { say('  клик увёл со страницы, стоп'); return; }
        }
        if (n) break;
      }
      await sleep(900);
      say('  раскрытие, проход ' + pass + ': ' + n);
      if (!n) break;
    }
  }

  /* Штатная кнопка «Скачать»: /system/content/export/doc/<раздел>/<id>/
   * Отдаёт оригинал файла. Проверяем на публичном разделе, где нет платного доступа,
   * чтобы отличить «нужна подписка» от «сработало». */
  const EXPORT_RE = /\/system\/content\/export\/doc\/(\d+)\/(\d+)\/?$/;
  const DOC_RE = /#\/document\/(\d+)\/(\d+)\/?/;

  function exportUrl(articleUrl) {
    const m = articleUrl.match(DOC_RE);
    if (!m) return null;
    return new URL('/system/content/export/doc/' + m[1] + '/' + m[2] + '/', location.origin).href;
  }

  async function tryDownload(url, name) {
    try {
      const r = await myFetch(url, { credentials: 'include', redirect: 'follow' });
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!r.ok || /text\/html/.test(ct)) {
        return { ok: false, status: r.status, type: ct, reason: /text\/html/.test(ct) ? 'отдало страницу, не файл' : 'HTTP ' + r.status };
      }
      const buf = await r.arrayBuffer();
      if (buf.byteLength < 200) return { ok: false, status: r.status, type: ct, reason: 'слишком мало данных' };
      return { ok: true, status: r.status, type: ct, bytes: buf.byteLength, data: new Uint8Array(buf) };
    } catch (e) {
      return { ok: false, reason: e && e.message ? e.message : String(e) };
    }
  }

  /* Определяет расширение по content-type, затем по «магии» байтов.
   * Сервер 1gb.uz отдаёт статью как application/msword, но внутри это HTML
   * с вордовской разметкой — такой файл корректно открывается как .doc. */
  function extFromType(ct, url, data) {
    const t = (ct || '').toLowerCase();
    if (/application\/msword|\bdoc\b/.test(t)) return 'doc';
    if (/wordprocessingml/.test(t)) return 'docx';
    if (/spreadsheetml|ms-excel/.test(t)) return 'xlsx';
    if (/presentationml|ms-powerpoint/.test(t)) return 'pptx';
    if (/application\/pdf|\bpdf\b/.test(t)) return 'pdf';
    if (/opendocument\.text/.test(t)) return 'odt';
    if (/rtf/.test(t)) return 'rtf';
    if (/epub/.test(t)) return 'epub';
    if (/zip/.test(t)) return 'zip';

    const head = data && data.length ? data.subarray(0, 512) : null;
    if (head) {
      const b0 = head[0], b1 = head[1], b2 = head[2], b3 = head[3];
      if (b0 === 0xd0 && b1 === 0xcf && b2 === 0x11 && b3 === 0xe0) return 'doc';
      if (b0 === 0x50 && b1 === 0x4b && (b2 === 0x03 || b2 === 0x05)) {
        const s = String.fromCharCode.apply(null, head);
        if (/word\//i.test(s)) return 'docx';
        if (/sheet/i.test(s)) return 'xlsx';
        return 'zip';
      }
      if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return 'pdf';
      if (b0 === 0x89 && b1 === 0x50) return 'png';
      if (b0 === 0xff && b1 === 0xd8) return 'jpg';
      if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) return 'gif';
      // HTML под видом .doc — сохраняем как .doc, Word и LibreOffice его открывают
      const probe = String.fromCharCode.apply(null, head.subarray(0, 200)).trim().toLowerCase();
      if (probe.startsWith('<html') || probe.startsWith('<!doctype html')) return 'doc';
    }

    const m2 = (url || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
    if (m2) {
      const e = m2[1].toLowerCase();
      if (['doc', 'docx', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt', 'zip', 'epub'].includes(e)) return e;
      if (e === 'htm' || e === 'html') return 'doc';
    }
    return 'bin';
  }

  function safeName(s, max) {
    return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, max || 80) || 'file';
  }

  /* ---------------- Ссылки ---------------- */
  const RUBRIC_RE = /#\/rubric\/(\d+)\/(\d+)(?:\/(\d+))?/;

  function collectLinks() {
    const here = location.origin;
    const found = new Map();
    const stats = {};
    for (const a of document.querySelectorAll('a[href]')) {
      let u;
      try { u = new URL(a.href, location.href); } catch { continue; }
      if (u.origin !== here) continue;
      if (IGNORE.test(u.pathname)) continue;
      const txt = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length < 3) continue;
      const key = u.origin + u.pathname + (u.hash.startsWith('#/') ? u.hash : '');
      if (found.has(key)) continue;
      found.set(key, { url: key, hash: u.hash, title: txt, kind: DOC_RE.test(key) ? 'doc' : RUBRIC_RE.test(key) ? 'rubric' : 'other' });
      const seg = u.pathname.split('/').filter(Boolean)[0] || 'корень';
      stats[seg] = (stats[seg] || 0) + 1;
    }
    return { list: [...found.values()], stats };
  }

  /* Рубрика — это раздел базы. Внутри неё лежат статьи и вложенные рубрики.
   * Грузим её в скрытом iframe и достаём ссылки: так работает и для SPA. */
  async function harvest(url) {
    const r = await viaIframe(url);
    const doc = r.__doc;
    if (!doc) return { docs: [], rubrics: [], title: '' };
    const out = { docs: new Map(), rubrics: new Map(), title: (doc.querySelector('h1') || {}).textContent || '' };
    for (const a of doc.querySelectorAll('a[href]')) {
      let u;
      try { u = new URL(a.href, url); } catch { continue; }
      if (u.origin !== location.origin) continue;
      const txt = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length < 3) continue;
      if (DOC_RE.test(u.href)) {
        const k = u.origin + u.pathname + u.hash.replace(/\/$/, '/');
        if (!out.docs.has(k)) out.docs.set(k, { url: k, title: txt });
      } else if (RUBRIC_RE.test(u.href)) {
        const k = u.origin + u.pathname + u.hash;
        if (!out.rubrics.has(k)) out.rubrics.set(k, { url: k, title: txt });
      }
    }
    return { docs: [...out.docs.values()], rubrics: [...out.rubrics.values()], title: out.title.trim() };
  }

  /* ---------------- Диагностика ---------------- */
  async function diagnose() {
    setStep(1);
    say('— диагностика —');
    say('  страница: ' + location.origin + location.pathname);
    if (!/mcfr\.uz$/.test(new URL(location.href).hostname)) {
      say('  ⚠ это не домен базы знаний. Нужно id.mcfr.uz');
    }
    setStep(2);
    const { list, stats } = collectLinks();
    say('  внутренних ссылок: ' + list.length);
    const top = Object.entries(stats).sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [k, v] of top) say('    /' + k + ' — ' + v);
    say('  запросов API за сессию: ' + api.length);

    /* Проба: сперва штатное скачивание, потом текст страницы. */
    const docs = list.filter((x) => DOC_RE.test(x.url));
    const hasDl = list.filter((x) => EXPORT_RE.test(x.url));
    say('  статей: ' + docs.length + ', ссылок на скачивание: ' + hasDl.length);

    let probe = null;
    if (docs.length) {
      const du = exportUrl(docs[0].url);
      const d = await tryDownload(du, docs[0].title);
      say('  проба скачивания: ' + (d.ok ? 'да, ' + d.bytes + ' байт, ' + d.type : 'нет — ' + d.reason));
      probe = { kind: 'download', url: du, ok: d.ok, reason: d.reason || null, bytes: d.bytes || 0, type: d.type || null };
      if (!d.ok) {
        const g = await readPage(docs[0].url);
        say('  проба текста: ' + g.method + ', символов: ' + (g.text || '').length + (g.error ? ' (' + g.error + ')' : ''));
        probe.text = { method: g.method, length: (g.text || '').length, error: g.error || null };
      }
    } else if (list.length) {
      const g = await readPage(list[0].url);
      say('  проба: ' + list[0].url);
      say('  способ: ' + g.method + ', символов: ' + (g.text || '').length + (g.error ? ' (' + g.error + ')' : ''));
      probe = { kind: 'page', url: list[0].url, method: g.method, length: (g.text || '').length, error: g.error || null };
    }

    const rep = {
      page: location.href,
      host: location.origin,
      linksFound: list.length,
      articlesFound: docs.length,
      downloadLinks: hasDl.length,
      linkStats: stats,
      sampleLinks: list.slice(0, 30),
      apiCalls: api.slice(0, 60),
      apiHosts: [...new Set(api.map((a) => a.host))],
      probe: probe,
      fetchWorks: !!(probe && ((probe.ok) || (probe.length > 300)))
    };
    download('kb-diagnostic.json', new Blob([JSON.stringify(rep, null, 2)], { type: 'application/json' }));
    say('  сохранено: kb-diagnostic.json');
    setStep(0);
  }

  function apiReport() {
    const hosts = {};
    for (const a of api) hosts[a.host] = (hosts[a.host] || 0) + 1;
    download('kb-api.json', new Blob([JSON.stringify({
      hosts,
      calls: api
    }, null, 2)], { type: 'application/json' }));
    say('— отчёт API сохранён: kb-api.json, запросов: ' + api.length + ' —');
  }

  /* ---------------- ZIP без сжатия ---------------- */
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (u8) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  function zip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    const dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    const parts = [], cd = [];
    let off = 0;
    for (const f of files) {
      const nameB = enc.encode(f.name);
      const crc = crc32(f.data);
      const lf = new Uint8Array(30 + nameB.length);
      const dv = new DataView(lf.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
      dv.setUint16(10, dt, true); dv.setUint16(12, dd, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, f.data.length, true);
      dv.setUint32(22, f.data.length, true);
      dv.setUint16(26, nameB.length, true);
      dv.setUint16(28, 0, true); // extra length: иначе часть архиваторов ломает кириллицу
      lf.set(nameB, 30);
      parts.push(lf, f.data);
      const ch = new Uint8Array(46 + nameB.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dt, true); cv.setUint16(14, dd, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, f.data.length, true);
      cv.setUint32(24, f.data.length, true);
      cv.setUint16(28, nameB.length, true);
      cv.setUint16(30, 0, true); // extra length (must mirror local header)
      cv.setUint16(32, 0, true); // comment length
      cv.setUint16(34, 0, true); // disk number start
      cv.setUint16(36, 0, true); // internal attrs
      cv.setUint32(38, 0, true); // external attrs
      cv.setUint32(42, off, true);
      ch.set(nameB, 46);
      cd.push(ch);
      off += lf.length + f.data.length;
    }
    const cdSize = cd.reduce((a, b) => a + b.length, 0);
    const eo = new Uint8Array(22);
    const ev = new DataView(eo.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, off, true);
    return new Blob([...parts, ...cd, eo], { type: 'application/zip' });
  }

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h;
  }

  /* ---------------- Обход ---------------- */
  async function run() {
    setStep(1);
    await expandTree();
    setStep(2);

    /* Сначала обходим рубрики (разделы) и собираем статьи из них:
     * на лендинге видны не все, внутри раздела — все. */
    const root = collectLinks();
    const rubrics = root.list.filter((x) => x.kind === 'rubric');
    const docs = new Map();
    for (const x of root.list) if (x.kind === 'doc') docs.set(x.url, { url: x.url, title: x.title, section: [] });

    say('— разделов (рубрик): ' + rubrics.length + ', статей с лендинга: ' + docs.size);

    const seenRubrics = new Set();
    const queue = rubrics.slice();
    let rq = 0;
    while (queue.length && !stop) {
      const r = queue.shift();
      if (seenRubrics.has(r.url)) continue;
      seenRubrics.add(r.url);
      rq++;
      $('bar').style.width = Math.round((rq / Math.max(rubrics.length, 1)) * 40) + '%';
      const h = await harvest(r.url);
      const got = h.docs.length;
      for (const d of h.docs) {
        if (!docs.has(d.url)) docs.set(d.url, { url: d.url, title: d.title, section: [r.title] });
      }
      for (const sub of h.rubrics) if (!seenRubrics.has(sub.url)) queue.push(sub);
      say('  раздел ' + rq + ': ' + r.title.slice(0, 40) + ' → статей ' + got + (h.error ? ' (' + h.error + ')' : ''));
      await sleep(1500);
    }
    say('  всего уникальных статей: ' + docs.size);
    if (!docs.size) { say('статей не найдено. Проверьте, что открыта база знаний.'); setStep(0); return; }

    const list = [...docs.values()];

    /* Возобновление. Документ считаем сделанным только если в 'blobs'
     * действительно лежат его байты — иначе повторный запуск после обрыва
     * пропустит документ, которого в архиве нет. */
    const known = await all('pages');
    const done = new Set();
    const orphans = [];
    for (const p of known) {
      if (p.kind !== 'file') { done.add(p.url); continue; }
      const b = await get('blobs', p.url);
      if (b && b.data && b.data.byteLength > 0) done.add(p.url);
      else orphans.push(p);
    }
    if (orphans.length) {
      say('  без файла в архиве: ' + orphans.length + ' — перекачиваем');
      for (const o of orphans) await del('pages', o.url);
    }
    const todo = list.filter((x) => !done.has(x.url));
    say('  уже скачано: ' + done.size + ', осталось: ' + todo.length);
    if (done.size > todo.length) {
      say('  ⚠ уже скачанных больше, чем найдено сейчас. Если вы открыли другую базу —');
      say('    нажмите «Сброс», чтобы не смешать материалы разных баз.');
    }

    const usedNames = new Set();
    let ok = 0, bad = 0, n = 0;
    for (const item of todo) {
      if (stop) break;
      n++;
      $('bar').style.width = Math.round(40 + (n / todo.length) * 60) + '%';
      const dl = exportUrl(item.url);
      if (dl) {
        const d = await tryDownload(dl, item.title);
        if (d.ok) {
          const ext = extFromType(d.type, dl, d.data);
          let name = safeName(item.title) + '.' + ext;
          // Заголовки могут обрезаться и слипаться — добавляем id документа
          if (usedNames.has(name)) {
            const m = item.url.match(DOC_RE);
            name = safeName(item.title) + '-' + (m ? m[1] + '-' + m[2] : String(n)) + '.' + ext;
          }
          usedNames.add(name);
          // Сначала байты, потом метаданные: падение между шагами не оставит
          // запись в pages без файла.
          await put('blobs', { url: item.url, data: d.data, type: d.type, name: name });
          await put('pages', {
            url: item.url,
            source_url: item.url,
            title: item.title,
            section: item.section || [],
            capturedAt: new Date().toISOString(),
            kind: 'file',
            fileName: name,
            contentType: d.type,
            bytes: d.bytes
          });
          ok++;
        } else {
          bad++;
          say('  [' + n + '] файл не отдан (' + d.reason + '): ' + item.title.slice(0, 40));
        }
      } else {
        const g = await readPage(item.url);
        if (g.text && g.text.length > 80) {
          await put('pages', {
            url: item.url,
            source_url: item.url,
            title: item.title || g.title,
            pageTitle: g.title,
            capturedAt: new Date().toISOString(),
            kind: 'page',
            markdown: g.text,
            images: g.images
          });
          ok++;
        } else {
          bad++;
          say('  [' + n + '] пусто (' + (g.error || 'нет текста') + '): ' + item.title.slice(0, 40));
        }
      }
      if (n % 10 === 0) say('  …' + n + '/' + todo.length + ' норм ' + ok + ', пусто ' + bad);
      await sleep(1200);
    }

    setStep(4);
    const pages = await all('pages');
    const stamp = new Date().toISOString().slice(0, 10);
    const nd = pages.map((p) => JSON.stringify({
      url: p.url, source_url: p.source_url, title: p.title, kind: p.kind,
      section: p.section || [],
      pageTitle: p.pageTitle, capturedAt: p.capturedAt,
      fileName: p.fileName, contentType: p.contentType, bytes: p.bytes,
      images: p.images, markdown: p.markdown
    })).join('\n');
    download('kb-pages-' + stamp + '.ndjson', new Blob([nd], { type: 'application/x-ndjson;charset=utf-8' }));
    say('  записей ' + pages.length + ' -> kb-pages-' + stamp + '.ndjson');

    /* Архив собираем из IndexedDB, а не из памяти: так в него попадает всё,
     * что реально скачано, включая файлы предыдущих запусков. */
    const filePages = pages.filter((p) => p.kind === 'file').sort((a, b) => (a.fileName || '').localeCompare(b.fileName || '', 'ru'));
    const files = [];
    const usedZip = new Set();
    let idx = 0;
    for (const p of filePages) {
      const b = await get('blobs', p.url);
      if (!b || !b.data || !b.data.byteLength) { say('  ! нет байтов для ' + p.title.slice(0, 40)); continue; }
      let base = safeName(b.name || p.fileName || (p.title + '.doc'));
      if (usedZip.has(base)) base = base.replace(/(\.[a-z0-9]+)$/i, '-' + (++idx) + '$1');
      usedZip.add(base);
      files.push({ name: 'files/' + String(files.length + 1).padStart(4, '0') + '-' + base, data: b.data });
    }
    if (files.length) {
      download('kb-files-' + stamp + '.zip', zip(files));
      say('  архив оригиналов: kb-files-' + stamp + '.zip (' + files.length + ')');
    }

    const urls = [...new Set(pages.flatMap((p) => p.images || []))].filter((u) => /1gb|mcfr/i.test(u));
    const imgs = [];
    let ik = 0;
    for (const u of urls) {
      if (stop) break;
      try {
        const r = await myFetch(u, { credentials: 'include' });
        if (!r.ok) continue;
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length > 5 * 1024 * 1024) continue;
        const ext = (u.split('?')[0].match(/\.(png|jpe?g|gif|webp|svg)$/i) || [, 'bin'])[1].toLowerCase();
        imgs.push({ name: 'images/' + ik++ + '-' + Math.abs(hash(u)).toString(36) + '.' + ext, data: buf });
      } catch { /* не критично */ }
      if (ik % 25 === 0) say('  …картинок ' + ik);
      await sleep(350);
    }
    if (imgs.length) {
      download('kb-images-' + stamp + '.zip', zip(imgs));
      say('  архив картинок: kb-images-' + stamp + '.zip (' + imgs.length + ')');
    }
    say('— готово. Успешно: ' + ok + ', пусто: ' + bad + ' —');
    $('bar').style.width = '100%';
    setStep(0);
  }

  $('bDiag').onclick = () => diagnose().catch((e) => say('ошибка: ' + e.message));
  $('bApi').onclick = () => apiReport();
  $('bRun').onclick = () => run().catch((e) => say('ошибка: ' + e.message));
  say('Панель готова. Сначала «Диагностика».');
})();
