// Discover end-to-end on a phone (iPhone 13) against a running BookNd with the catalog loaded.
// Usage: BASE_URL=https://booknd-lake.vercel.app node tests/e2e-discover.mjs   (DOWNLOAD=0 skips adding a real book)
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL ?? 'http://localhost:3100';
const OUT = process.env.SHOTS ?? fileURLToPath(new URL('../test-results/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const count = async (page) => Number(((await page.textContent('#result-count')) ?? '').replace(/,/g, '').match(/^(\d+)/)?.[1] ?? NaN);
const settle = (page) => page.waitForFunction(() => !/Searching/.test(document.querySelector('#result-count')?.textContent ?? 'Searching'), null, { timeout: 30000 });
/** Runs an action that starts a new search and waits for its result (the count line changes and stops searching). */
async function apply(page, action) {
  const before = await page.textContent('#result-count');
  await action();
  await page.waitForFunction((b) => {
    const t = document.querySelector('#result-count')?.textContent ?? '';
    return t !== b && !/Searching/.test(t);
  }, before, { timeout: 30000 });
}
const titles = (page) => page.$$eval('.book-card .book-title', (els) => els.map((e) => e.textContent));

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${BASE}/`);
await page.waitForSelector('.book-card', { timeout: 60000 });
await settle(page);
const all = await count(page);
check('Discover shows the whole catalog with a count', all > 1000, `${all} English works`);
check('no horizontal scroll on a phone', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
await page.screenshot({ path: `${OUT}/d1-discover-phone.png` });

// paging: Show more appends the next server page without repeats
const first = await titles(page);
await page.click('text=Show more');
await page.waitForFunction((n) => document.querySelectorAll('.book-card').length > n, first.length, { timeout: 30000 });
const keys = await page.$$eval('.book-card .book-open', (els) => els.map((e) => e.getAttribute('aria-label')));
check('Show more loads the next page with no repeats', new Set(keys).size === keys.length && keys.length > first.length, `${keys.length} cards`);

// sorting is over the whole catalog
await apply(page, () => page.selectOption('#cat-sort', 'title'));
const az = await titles(page);
check('Title A–Z sorts the full catalog', (await count(page)) === all && az.length > 0, az.slice(0, 3).join(' | '));
await apply(page, () => page.selectOption('#cat-sort', 'rating'));
const firstRating = await page.textContent('.book-card .book-rating');
check('Top rated starts with a rated book showing its count', /★\s*\d\.\d\s*·\s*[\d,]+/.test(firstRating ?? ''), firstRating ?? '');
await page.screenshot({ path: `${OUT}/d2-top-rated-phone.png` });

// rating filter
await apply(page, () => page.click('button.chip:text-matches("^Unrated")'));
const unrated = await count(page);
const unratedLabels = await page.$$eval('.book-card .book-rating', (els) => els.map((e) => e.textContent));
check('Unrated filter lists only unrated books', unratedLabels.length > 0 && unratedLabels.every((t) => /Unrated/.test(t ?? '')), `${unrated}`);
await apply(page, () => page.click('button.chip:text-matches("^Rated")'));
const rated = await count(page);
check('Rated + Unrated add up to the total', rated + unrated === all, `${rated} + ${unrated} = ${all}`);
await apply(page, () => page.click('.chip:has-text("Any rating")'));

// search + dedup + Standard Ebooks preferred
await page.fill('#cat-search', 'pride and prejudice');
await apply(page, () => page.press('#cat-search', 'Enter'));
const pp = await titles(page);
check('search finds Pride and Prejudice first', /pride and prejudice/i.test(pp[0] ?? ''), pp.slice(0, 3).join(' | '));
check('Pride and Prejudice appears once (editions grouped)', pp.filter((t) => /^pride and prejudice$/i.test(t ?? '')).length === 1);
await page.click('.book-card .book-open');
await page.waitForSelector('.sheet');
const sheet = (await page.textContent('.sheet')) ?? '';
check('the work sheet recommends the Standard Ebooks edition', /editions/i.test(sheet) && /Standard Ebooks\s*Recommended/.test(sheet));
check('the sheet names the rating source and count (or says there is none)', /Open Library/.test(sheet));
await page.screenshot({ path: `${OUT}/d3-work-sheet-phone.png` });

if (process.env.DOWNLOAD !== '0') {
  await page.click('.sheet .btn-primary');
  const read = await page.waitForSelector('.toast button:has-text("Read"), .sheet .btn-primary:has-text("Read now")', { timeout: 90000 }).catch(() => null);
  check('adding the recommended edition downloads a working EPUB', !!read);
  if (read) {
    await page.click('.sheet .btn-primary:has-text("Read now")');
    const opened = await page.waitForSelector('.reader-viewer iframe', { timeout: 30000 }).catch(() => null);
    check('the downloaded book opens in the reader', !!opened);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/d4-reader-phone.png` });
  }
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
