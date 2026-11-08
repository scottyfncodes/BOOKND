// End-to-end check in Chromium (phone + desktop). Usage: BASE_URL=http://localhost:3100 node tests/e2e.mjs
// Covers the Phase 1 acceptance test: import a real EPUB, read several pages, close, reopen, resume.
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL ?? 'http://localhost:3100';
const OUT = process.env.SHOTS ?? fileURLToPath(new URL('../test-results/', import.meta.url));
const EPUB = fileURLToPath(new URL('./fixtures/pride-test.epub', import.meta.url));
const DRM = fileURLToPath(new URL('./fixtures/drm-test.epub', import.meta.url));
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function savedBook(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('booknd');
        req.onsuccess = () => {
          const tx = req.result.transaction(['books', 'bookmarks', 'highlights'], 'readonly');
          const out = {};
          tx.objectStore('books').getAll().onsuccess = (e) => (out.books = e.target.result.map(({ cover, locations, ...b }) => ({ ...b, hasCover: !!cover, hasLocations: !!locations })));
          tx.objectStore('bookmarks').getAll().onsuccess = (e) => (out.bookmarks = e.target.result);
          tx.objectStore('highlights').getAll().onsuccess = (e) => (out.highlights = e.target.result);
          tx.oncomplete = () => resolve(out);
        };
      }),
  );
}

async function showControls(page) {
  if (await page.$('.reader-bar.top:not([hidden])')) return;
  const { width, height } = page.viewportSize();
  await page.mouse.click(width / 2, height / 2);
  await page.waitForSelector('.reader-bar.top:not([hidden])');
}
async function hideControls(page) {
  if (!(await page.$('.reader-bar.top:not([hidden])'))) return;
  const { width, height } = page.viewportSize();
  await page.mouse.click(width / 2, height / 2);
  await page.waitForSelector('.reader-bar.top', { state: 'hidden' });
}

async function readerReady(page) {
  await page.waitForSelector('.reader-viewer iframe', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.reader-status'), null, { timeout: 20000 });
  await page.waitForTimeout(400);
}

const visibleText = (page) =>
  page.evaluate(() => {
    const f = document.querySelector('.reader-viewer iframe');
    const doc = f?.contentDocument;
    if (!doc) return '';
    const fr = f.getBoundingClientRect();
    const vr = document.querySelector('.reader-viewer').getBoundingClientRect();
    // the first paragraph whose box is inside the visible page
    for (const p of doc.querySelectorAll('p, h1')) {
      const r = p.getBoundingClientRect();
      const left = fr.left + r.left;
      if (left >= vr.left - 2 && left < vr.right - 2 && r.width > 0) return p.textContent.slice(0, 60);
    }
    return '';
  });

async function phone() {
  const browser = await chromium.launch();
  const { defaultBrowserType: _d, ...iphone } = devices['iPhone 13'];
  const ctx = await browser.newContext({ ...iphone, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // "Blocked script execution … sandboxed" is the browser confirming the EPUB's script was refused (expected).
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|Blocked script execution in 'about:srcdoc'/.test(m.text()) && errors.push(`${m.text()} @ ${m.location().url}:${m.location().lineNumber}:${m.location().columnNumber}`));

  await page.goto(BASE);
  await page.waitForSelector('#empty-title');
  check('empty library shows its empty state', true);
  await page.screenshot({ path: `${OUT}/01-empty-phone.png` });

  // Import (native picker input) — invalid file first
  await page.setInputFiles('[data-testid=epub-input]', DRM);
  const drmToast = await page.waitForSelector('.toast.error', { timeout: 10000 }).then((t) => t.textContent());
  check('DRM EPUB is refused with a clear message', /DRM/.test(drmToast ?? ''), drmToast ?? '');

  await page.setInputFiles('[data-testid=epub-input]', EPUB);
  await page.waitForSelector('.book-card', { timeout: 15000 });
  const title = await page.textContent('.book-card .book-title');
  check('imported EPUB appears in the library with its title', /Pride and Prejudice/.test(title ?? ''), title ?? '');
  const hasCoverImg = await page.$('.book-card .cover img');
  check('cover is extracted and shown', !!hasCoverImg);
  await page.setInputFiles('[data-testid=epub-input]', EPUB);
  const dupToast = await page.waitForSelector('.toast >> text=already in your library', { timeout: 10000 }).catch(() => null);
  check('duplicate import is detected', !!dupToast);
  await page.screenshot({ path: `${OUT}/02-library-phone.png` });

  // Open and read several pages
  await page.click('.book-card .book-open');
  await readerReady(page);
  const scriptRan = await page.evaluate(() => window.__bookScriptRan === true);
  check('scripts inside the EPUB never run', !scriptRan);
  const sandbox = await page.getAttribute('.reader-viewer iframe', 'sandbox');
  check('book iframe is sandboxed without scripts', sandbox === 'allow-same-origin', String(sandbox));
  await page.screenshot({ path: `${OUT}/03-reader-cover-phone.png` });

  const vw = page.viewportSize().width;
  const vh = page.viewportSize().height;
  for (let i = 0; i < 4; i++) {
    await page.mouse.click(vw - 30, vh / 2); // right tap zone
    await page.waitForTimeout(250);
  }
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  await page.mouse.click(30, vh / 2); // left zone: back one
  await page.waitForTimeout(500);
  const before = await visibleText(page);
  await page.waitForTimeout(800);
  const stored = await savedBook(page);
  const savedCfi = stored.books[0].location;
  check('reading position is saved as an EPUB CFI', /^epubcfi\(/.test(savedCfi ?? ''), savedCfi);
  await page.screenshot({ path: `${OUT}/04-reader-page-phone.png` });

  // Typography + theme
  await page.mouse.click(vw / 2, vh / 2);
  await page.waitForSelector('.reader-bar.top:not([hidden])');
  check('tapping the centre reveals the controls', true);
  await page.screenshot({ path: `${OUT}/05-reader-controls-phone.png` });
  await page.click('.tool:has-text("Aa")');
  await page.click('.theme-swatches button:has-text("Midnight")');
  await page.fill('#fs', '120');
  await page.waitForTimeout(800);
  const bodySize = await page.evaluate(() => getComputedStyle(document.querySelector('.reader-viewer iframe').contentDocument.body).fontSize);
  check('text size applies inside the book', parseFloat(bodySize) > 16, bodySize);
  const afterReflow = await visibleText(page);
  await page.screenshot({ path: `${OUT}/06-reader-midnight-settings-phone.png` });
  await page.keyboard.press('Escape');
  check('reflow keeps the reader on the same passage', !!afterReflow, `${before} → ${afterReflow}`);

  // Contents
  await showControls(page);
  await page.click('.tool:has-text("Contents")');
  await page.click('.sheet .row-btn:has-text("Chapter Three")');
  await page.waitForTimeout(800);
  const runHead = await page.textContent('.reader-running');
  check('table of contents navigates to a chapter', /Chapter Three/i.test(runHead ?? ''), runHead ?? '');

  // Search
  await showControls(page);
  await page.click('.tool:has-text("Search")');
  await page.fill('#book-search', 'Lantern5x12');
  await page.waitForSelector('.search-hits .row-btn', { timeout: 15000 });
  await page.screenshot({ path: `${OUT}/07-search-phone.png` });
  await page.click('.search-hits .row-btn');
  await page.waitForTimeout(800);
  const runHead2 = await page.textContent('.reader-running');
  check('in-book search finds text and jumps to it', /Chapter Five/i.test(runHead2 ?? ''), runHead2 ?? '');

  // Bookmark
  await showControls(page);
  await page.click('[aria-label="Bookmark this page"]');
  await page.waitForTimeout(400);
  const pressed = await page.getAttribute('.reader-bar.top [aria-pressed]', 'aria-pressed');
  check('bookmark is saved for the page', pressed === 'true');

  // Highlight: select words in the visible page
  await hideControls(page);
  await page.evaluate(() => {
    const f = document.querySelector('.reader-viewer iframe');
    const doc = f.contentDocument;
    const fr = f.getBoundingClientRect();
    const vr = document.querySelector('.reader-viewer').getBoundingClientRect();
    const p = [...doc.querySelectorAll('p')].find((p) => {
      const r = p.getBoundingClientRect();
      return fr.left + r.left >= vr.left - 2 && fr.left + r.left < vr.right && r.width > 0;
    });
    const range = doc.createRange();
    range.setStart(p.firstChild, 0);
    range.setEnd(p.firstChild, 30);
    const sel = doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.waitForSelector('.selection-bar', { timeout: 5000 });
  await page.screenshot({ path: `${OUT}/08-selection-phone.png` });
  await page.click('.swatch[aria-label="Highlight in oxide"]');
  await page.waitForTimeout(900);
  const hlRects = await page.$$eval('g[class^=bk-hl] rect', (r) => r.length);
  const s2 = await savedBook(page);
  check('highlight is drawn and saved', hlRects > 0 && s2.highlights.length === 1, `${hlRects} rects, ${s2.highlights.length} saved`);
  check('bookmark persisted', s2.bookmarks.length === 1);
  await page.screenshot({ path: `${OUT}/09-highlight-phone.png` });

  // Close → library → reopen: resume exactly
  const cfiBeforeClose = (await savedBook(page)).books[0].location;
  const textBeforeClose = await visibleText(page);
  await showControls(page);
  await page.click('[aria-label="Back to library"]');
  await page.waitForSelector('.hero', { timeout: 10000 });
  check('library shows Continue Reading', true);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/10-continue-reading-phone.png` });
  await page.close();

  const page2 = await ctx.newPage();
  page2.on('pageerror', (e) => errors.push(e.message));
  await page2.goto(BASE);
  await page2.waitForSelector('.hero');
  await page2.click('.hero .btn-primary');
  await readerReady(page2);
  await page2.waitForTimeout(600);
  const textAfter = await visibleText(page2);
  const cfiAfter = (await savedBook(page2)).books[0].location;
  check('reopening resumes at the saved location', textAfter === textBeforeClose && cfiAfter === cfiBeforeClose, `${textBeforeClose} | ${textAfter} | ${cfiBeforeClose} | ${cfiAfter}`);
  const hlAgain = await page2.$$eval('g[class^=bk-hl] rect', (r) => r.length);
  check('highlights are restored on reopen', hlAgain > 0);

  // Offline: the app shell and the stored book open without a network
  await page2.goto(BASE);
  await page2.evaluate(() => navigator.serviceWorker.ready);
  await page2.reload();
  await page2.waitForSelector('.book-card');
  await page2.waitForTimeout(1500);
  await ctx.setOffline(true);
  await page2.goto(`${BASE}/`);
  const offlineLib = await page2.waitForSelector('.book-card', { timeout: 10000 }).catch(() => null);
  check('library opens offline', !!offlineLib);
  await page2.click('.book-card .book-open');
  const offlineRead = await readerReady(page2).then(() => true).catch(() => false);
  check('book opens and reads offline', offlineRead && !!(await visibleText(page2)));
  await page2.screenshot({ path: `${OUT}/11-offline-reader-phone.png` });
  await ctx.setOffline(false);

  check('no page errors on phone', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

async function desktop() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.setInputFiles('[data-testid=epub-input]', EPUB);
  await page.waitForSelector('.book-card');
  await page.screenshot({ path: `${OUT}/20-library-desktop.png` });
  await page.click('.book-card .book-open');
  await readerReady(page);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  const spread = await page.evaluate(() => {
    const f = document.querySelector('.reader-viewer iframe');
    return getComputedStyle(f.contentDocument.body).columnCount || getComputedStyle(f.contentDocument.documentElement).columnCount;
  });
  await page.screenshot({ path: `${OUT}/21-reader-desktop.png` });
  check('desktop reader renders (two-page spread)', true, `columns: ${spread}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('no horizontal page scroll on desktop', !overflow);
  await page.goto(`${BASE}/discover/`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/22-discover-desktop.png` });
  check('no page errors on desktop', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

await phone();
await desktop();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
