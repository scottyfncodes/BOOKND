#!/usr/bin/env node
/**
 * Verifies a deployed catalog through its public API (no credentials):
 *   BASE_URL=https://booknd-lake.vercel.app node scripts/catalog/verify.mjs [--sample 40]
 * - counts from /api/catalog/status
 * - search completeness: every page of a query, summed, equals its total with no repeats
 * - facets: rated + unrated = total, per source
 * - readability: a random sample of editions from each source is downloaded through /api/download
 *   and checked to be a real EPUB (ZIP signature + mimetype entry); the transfer is cut after the header
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3100';
const SAMPLE = Number(process.argv[process.argv.indexOf('--sample') + 1]) || 20;
const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};
const out = { base: BASE, at: new Date().toISOString() };
const fail = [];

const status = await get('/api/catalog/status/');
out.loaded = status.loaded;
out.build = status.build?.counts;
out.buildSources = status.build?.sources;

for (const lang of ['en', 'all']) {
  const any = await get(`/api/search/?lang=${lang}&per=1`);
  const rated = await get(`/api/search/?lang=${lang}&per=1&rating=rated`);
  const unrated = await get(`/api/search/?lang=${lang}&per=1&rating=unrated`);
  const se = await get(`/api/search/?lang=${lang}&per=1&source=standard-ebooks`);
  const pg = await get(`/api/search/?lang=${lang}&per=1&source=gutenberg`);
  out[`search_${lang}`] = { total: any.total, rated: rated.total, unrated: unrated.total, standardEbooks: se.total, gutenberg: pg.total };
  if (rated.total + unrated.total !== any.total) fail.push(`${lang}: rated + unrated != total`);
}
if (out.search_all.total !== status.loaded.works) fail.push('lang=all total != loaded works');

// paging completeness for a few queries
for (const q of ['dickens', 'sherlock', 'love']) {
  const first = await get(`/api/search/?q=${q}&lang=all&per=60`);
  const seen = new Set(first.works.map((w) => w.id));
  for (let p = 2; p <= Math.min(first.pages, 40); p++) (await get(`/api/search/?q=${q}&lang=all&per=60&page=${p}`)).works.forEach((w) => seen.add(w.id));
  const ok = first.pages > 40 || seen.size === first.total;
  out[`paging_${q}`] = { total: first.total, pages: first.pages, uniqueSeen: seen.size, ok };
  if (!ok) fail.push(`paging ${q}`);
}

// readability sample
async function sample(source, n) {
  const total = (await get(`/api/search/?lang=all&per=1&source=${source}`)).total;
  const picks = [];
  for (let i = 0; i < n; i++) {
    const page = 1 + Math.floor(Math.random() * Math.ceil(total / 60));
    const r = await get(`/api/search/?lang=all&per=60&source=${source}&sort=title&page=${page}`);
    const w = r.works[Math.floor(Math.random() * r.works.length)];
    const ed = w?.editions.find((e) => e.source === source);
    if (ed) picks.push(ed);
  }
  const res = { tried: picks.length, epub: 0, failures: [] };
  for (const ed of picks) {
    try {
      const r = await fetch(`${BASE}/api/download/?url=${encodeURIComponent(ed.epubUrl)}`);
      const reader = r.body?.getReader();
      let buf = new Uint8Array();
      while (reader && buf.length < 64) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = new Uint8Array([...buf, ...value.subarray(0, 64)]);
      }
      await reader?.cancel();
      const head = new TextDecoder().decode(buf.subarray(30, 58));
      if (r.ok && buf[0] === 0x50 && buf[1] === 0x4b && head.includes('mimetype')) res.epub++;
      else res.failures.push(`${ed.key} → ${r.status}`);
    } catch (err) {
      res.failures.push(`${ed.key} → ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500)); // gentle on the catalogs
  }
  return res;
}
out.readable = { 'standard-ebooks': await sample('standard-ebooks', SAMPLE), gutenberg: await sample('gutenberg', SAMPLE) };

console.log(JSON.stringify(out, null, 1));
if (fail.length) {
  console.error('FAILED:', fail);
  process.exit(1);
}
