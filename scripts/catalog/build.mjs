#!/usr/bin/env node
/**
 * Builds BookNd's catalog snapshot (run by .github/workflows/catalog.yml).
 *
 *   node scripts/catalog/build.mjs --prev prev/ --out out/
 *
 * Reads the previous run's state (if any) from --prev so every source updates incrementally, then writes
 *   out/catalog.json.gz  works served by /api/search (one record per work, editions inside)
 *   out/state.json.gz    what the next run needs: editions per source, rating matches, fetch times
 *   out/meta.json        counts and run observability (served by /api/catalog/status)
 *
 * Environment: GITHUB_TOKEN (repository listing), RATINGS_BUDGET, SEARCH_BUDGET (default 4500), RATINGS_MINUTES, SKIP_RATINGS=1, SKIP_SE=1,
 * GUTENBERG_RDF=<local .tar.bz2> (tests / local runs).
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  SNAPSHOT_VERSION,
  groupEditions,
  gutenbergEdition,
  isReadableGutenberg,
  MATCHER_VERSION,
  judgeIdentifierCandidates,
  judgeSearchMatch,
  sameWorkTitle,
  searchTitle,
  parseGutenbergRdf,
  parseStandardEbooksOpf,
  readTar,
  seSlugFromHomepage,
  toWorkRecord,
  workRating,
  weightedRating,
} from './lib.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const PREV = args.prev ?? 'prev';
const OUT = args.out ?? 'out';
const UA = 'BookNd-catalog/1.0 (+https://github.com/scottyfncodes/BOOKND; scheduled metadata sync)';
const RDF_URL = 'https://www.gutenberg.org/cache/epub/feeds/rdf-files.tar.bz2';
// Bump when parsing changes, so stored editions are rebuilt even if the upstream file has not changed.
const PARSER_VERSION = 3; // 3: MARC subfield markers removed from titles
const DAY = 86400000;
const started = Date.now();
const now = new Date().toISOString();

const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const meta = {
  version: SNAPSHOT_VERSION,
  generatedAt: now,
  run: process.env.GITHUB_RUN_ID
    ? { id: process.env.GITHUB_RUN_ID, url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` }
    : undefined,
  sources: {},
  counts: {},
  warnings: [],
  durationsMs: {},
};

function readPrev(name) {
  const p = `${PREV}/${name}`;
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p);
    return JSON.parse((name.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
  } catch (err) {
    meta.warnings.push(`Could not read previous ${name}: ${err.message}`);
    return null;
  }
}
const prevState = readPrev('state.json.gz') ?? {};
const prevMeta = readPrev('meta.json');

/** fetch with timeout, retries on network errors, 429 and 5xx (Retry-After honoured, exponential backoff). */
async function fetchRetry(url, init = {}, { tries = 5, timeoutMs = 30000, stats } = {}) {
  let delay = 2000;
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { 'User-Agent': UA, ...(init.headers ?? {}) } });
      if (res.status === 429 || res.status >= 500) {
        if (stats && res.status === 429) stats.rateLimited = (stats.rateLimited ?? 0) + 1;
        if (attempt >= tries) return res;
        const ra = Number(res.headers.get('retry-after'));
        await res.body?.cancel();
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 120000) : delay);
        delay *= 2;
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(delay);
      delay *= 2;
    } finally {
      clearTimeout(t);
    }
  }
}

/** Spaces requests out so a host never sees more than one every `ms` from this job. */
function pacer(ms) {
  let next = 0;
  return async () => {
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    next = Date.now() + ms;
  };
}

// ---------------------------------------------------------------------------------------------
// Project Gutenberg

async function gutenberg() {
  const t0 = Date.now();
  const stats = { source: RDF_URL, records: 0, readable: 0, excluded: {} };
  const prev = prevState.gutenberg;
  let input;
  if (process.env.GUTENBERG_RDF) {
    input = createReadStream(process.env.GUTENBERG_RDF);
    stats.source = process.env.GUTENBERG_RDF;
  } else {
    const head = await fetchRetry(RDF_URL, { method: 'HEAD' }).catch(() => null);
    const lastModified = head?.headers.get('last-modified') ?? null;
    stats.lastModified = lastModified;
    if (prev?.editions?.length && lastModified && prev.lastModified === lastModified && prev.parser === PARSER_VERSION) {
      log(`Gutenberg: catalog unchanged since ${lastModified}; reusing ${prev.editions.length} editions`);
      return { editions: prev.editions, stats: { ...prevMetaSource('gutenberg'), lastModified, reused: true }, lastModified, parser: prev.parser };
    }
    const res = await fetchRetry(RDF_URL, {}, { timeoutMs: 15 * 60000 });
    if (!res.ok || !res.body) throw new Error(`Gutenberg catalog download returned ${res.status}`);
    input = Readable.fromWeb(res.body);
  }
  const bz = spawn('bzip2', ['-dc'], { stdio: ['pipe', 'pipe', 'inherit'] });
  input.pipe(bz.stdin);
  const editions = [];
  await readTar(bz.stdout, async (name, body) => {
    if (!name.endsWith('.rdf')) return;
    const rec = parseGutenbergRdf(body.toString('utf8'));
    if (!rec) return;
    stats.records++;
    const verdict = isReadableGutenberg(rec);
    if (!verdict.ok) {
      stats.excluded[verdict.reason] = (stats.excluded[verdict.reason] ?? 0) + 1;
      return;
    }
    stats.readable++;
    editions.push(gutenbergEdition(rec));
    if (stats.records % 10000 === 0) log(`Gutenberg: ${stats.records} records read`);
  });
  const code = await new Promise((r) => bz.on('close', r));
  if (code !== 0) throw new Error(`bzip2 exited with ${code}`);
  stats.durationMs = Date.now() - t0;
  log(`Gutenberg: ${stats.records} records, ${stats.readable} readable ebooks`, stats.excluded);
  return { editions, stats, lastModified: stats.lastModified };
}

function prevMetaSource(name) {
  return prevMeta?.sources?.[name] ?? {};
}

// ---------------------------------------------------------------------------------------------
// Standard Ebooks (public CC0 source repositories; the OPDS/Atom bulk feeds are for Patrons Circle members)

async function standardEbooks() {
  const t0 = Date.now();
  const stats = { repos: 0, released: 0, fetched: 0, reused: 0, failed: 0, skipped: 0 };
  if (process.env.SKIP_SE === '1') return { repos: prevState.standardEbooks?.repos ?? {}, stats: { ...stats, skipped: 1 } };
  const prev = prevState.standardEbooks?.repos ?? {};
  const token = process.env.GITHUB_TOKEN;
  const gh = { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const repos = [];
  for (let page = 1; page < 60; page++) {
    const res = await fetchRetry(`https://api.github.com/orgs/standardebooks/repos?type=public&per_page=100&page=${page}&sort=full_name`, { headers: gh });
    if (!res.ok) throw new Error(`GitHub repository listing returned ${res.status}`);
    const list = await res.json();
    repos.push(...list);
    if (list.length < 100) break;
  }
  stats.repos = repos.length;
  const released = repos
    .filter((r) => !r.archived && !r.fork)
    .map((r) => ({ r, slug: seSlugFromHomepage(r.homepage) }))
    .filter((x) => x.slug);
  stats.released = released.length;
  const out = {};
  const pace = pacer(150);
  let i = 0;
  const worker = async () => {
    while (i < released.length) {
      const { r, slug } = released[i++];
      const old = prev[r.name];
      if (old && old.pushedAt === r.pushed_at && old.edition && old.parser === PARSER_VERSION) {
        out[r.name] = old;
        stats.reused++;
        continue;
      }
      await pace();
      try {
        const res = await fetchRetry(`https://raw.githubusercontent.com/standardebooks/${r.name}/${r.default_branch}/src/epub/content.opf`);
        if (!res.ok) throw new Error(String(res.status));
        const edition = parseStandardEbooksOpf(await res.text(), slug);
        if (!edition.title) throw new Error('no title');
        out[r.name] = { pushedAt: r.pushed_at, parser: PARSER_VERSION, edition };
        stats.fetched++;
      } catch (err) {
        stats.failed++;
        if (old?.edition) out[r.name] = old; // keep last good metadata
        meta.warnings.push(`Standard Ebooks ${r.name}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  stats.durationMs = Date.now() - t0;
  stats.editions = Object.keys(out).length;
  log(`Standard Ebooks: ${stats.repos} repositories, ${stats.released} released ebooks (${stats.fetched} fetched, ${stats.reused} unchanged, ${stats.failed} failed)`);
  return { repos: out, stats };
}

// ---------------------------------------------------------------------------------------------
// Ratings (Open Library). Work-level averages; matched by Project Gutenberg id first.

const OL_FIELDS =
  'key,title,alternative_title,author_name,author_alternative_name,ratings_average,ratings_count,readinglog_count,id_project_gutenberg,edition_count';

/**
 * Per edition the state keeps at most one match: { w, v, n, c, m, at } plus bookkeeping — idAt/mv (last id lookup,
 * matcher version) and sAt/smv (last title/author search). Only real Open Library averages and counts are stored.
 */
async function openLibrary(editions) {
  const t0 = Date.now();
  const stats = {
    matcherVersion: MATCHER_VERSION,
    requests: 0,
    rateLimited: 0,
    errors: 0,
    idBatches: 0,
    matchedById: 0,
    matchedBySearch: 0,
    noMatch: 0,
    searched: 0,
    standardEbooksSearched: 0,
    standardEbooksMatched: 0,
    revalidated: 0,
    revalidationChanged: 0,
    revalidationDropped: 0,
    rejected: {},
  };
  const ratings = { ...(prevState.ratings ?? {}) };
  if (process.env.SKIP_RATINGS === '1') return { ratings, stats: { ...stats, skipped: true } };
  const pace = pacer(1100); // ≤ 1 request a second, as Open Library asks of unauthenticated clients
  const budget = Number(process.env.RATINGS_BUDGET ?? 900);
  const searchBudget = Number(process.env.SEARCH_BUDGET ?? 4500);
  const deadline = started + Number(process.env.RATINGS_MINUTES ?? 170) * 60000;
  const pg = editions.filter((e) => e.source === 'gutenberg');
  const reject = (why) => (stats.rejected[why] = (stats.rejected[why] ?? 0) + 1);
  const changes = [];
  const note = (e, from, to) => changes.length < 200 && changes.push({ key: e.key, title: e.title, from, to });
  const describe = (r) => (r?.w ? `${r.w} ${r.v ?? '-'}/${r.n} ${r.m}` : 'unrated');
  const MATCH_FIELDS = ['w', 'v', 'n', 'c', 'm', 'at'];
  const withoutMatch = (r) => Object.fromEntries(Object.entries(r ?? {}).filter(([k]) => !MATCH_FIELDS.includes(k)));
  const match = (doc, j, at) => ({ w: doc.key, v: doc.ratings_average ?? null, n: doc.ratings_count ?? 0, c: j.confidence, m: j.method, at });
  const rated = (r) => !!r?.w && r.n > 0 && r.v != null;

  async function olSearch(params) {
    await pace();
    stats.requests++;
    const res = await fetchRetry(`https://openlibrary.org/search.json?${params}`, { headers: { Accept: 'application/json' } }, { stats, timeoutMs: 45000 });
    if (!res.ok) throw new Error(`Open Library returned ${res.status}`);
    return (await res.json()).docs ?? [];
  }

  // 1) by Project Gutenberg id, 100 ids a request: never checked, checked under older rules, then the stalest
  const idDue = (r) => !r || r.mv !== MATCHER_VERSION || Date.now() - Date.parse(r.idAt ?? 0) > 14 * DAY;
  const due = pg
    .filter((e) => idDue(ratings[e.key]))
    .sort((a, b) => Date.parse(ratings[a.key]?.idAt ?? 0) - Date.parse(ratings[b.key]?.idAt ?? 0) || b.downloads - a.downloads);
  for (let i = 0; i < due.length && stats.idBatches < budget && Date.now() < deadline; i += 100) {
    const batch = due.slice(i, i + 100);
    const ids = batch.map((e) => e.gutenbergIds[0]);
    let docs;
    try {
      docs = await olSearch(new URLSearchParams({ q: `id_project_gutenberg:(${ids.join(' OR ')})`, fields: OL_FIELDS, limit: '300' }));
      stats.idBatches++;
    } catch (err) {
      stats.errors++;
      meta.warnings.push(`Open Library id batch: ${err.message}`);
      if (stats.errors > 20) break;
      continue;
    }
    const at = new Date().toISOString();
    for (const e of batch) {
      const id = String(e.gutenbergIds[0]);
      const j = judgeIdentifierCandidates(e, docs.filter((d) => (d.id_project_gutenberg ?? []).map(String).includes(id)));
      j.rejected.forEach(reject);
      const prev = ratings[e.key] ?? {};
      const base = { ...withoutMatch(prev), idAt: at, mv: MATCHER_VERSION };
      let next;
      if (j.ok && ((j.doc.ratings_count ?? 0) > 0 || !(prev.m === 'title-author' && rated(prev)))) {
        next = { ...base, ...match(j.doc, j, at) };
        stats.matchedById++;
      } else if (prev.m === 'title-author') {
        next = { ...prev, idAt: at, mv: MATCHER_VERSION }; // a search match stays until the search re-checks it
      } else {
        if (!j.ok) reject(j.reason);
        next = base;
        stats.noMatch++;
      }
      if (describe(prev) !== describe(next) && rated(prev)) note(e, describe(prev), describe(next));
      ratings[e.key] = next;
    }
    if (stats.idBatches % 50 === 0) log(`Open Library: ${stats.idBatches} id batches, ${stats.matchedById} matched`);
  }

  // 2) title + author search. Order: re-check existing search matches under the current rules, then Standard
  //    Ebooks titles with no Gutenberg edition (no id to look up), then the most-read unrated books.
  const pgByKey = new Map(pg.map((e) => [e.key, e]));
  const seSolo = new Set(
    editions
      .filter((e) => e.source === 'standard-ebooks')
      .filter((e) => !e.gutenbergIds.some((id) => {
        const p = pgByKey.get(`gutenberg:${id}`);
        return p && p.language === e.language && sameWorkTitle(e.title, p.title);
      }))
      .map((e) => e.key),
  );
  stats.standardEbooksOnly = seSolo.size;
  const searchDue = editions
    .filter((e) => {
      const r = ratings[e.key];
      if (!e.authorKeys.length) return false;
      if (e.source === 'standard-ebooks' ? !seSolo.has(e.key) : !r?.idAt) return false; // Gutenberg: id lookup first
      if (r?.m === 'gutenberg-id' && rated(r)) return false;
      return r?.smv !== MATCHER_VERSION || Date.now() - Date.parse(r.sAt ?? 0) > 60 * DAY;
    })
    .map((e) => {
      const r = ratings[e.key];
      const tier = r?.m === 'title-author' && rated(r) ? 0 : seSolo.has(e.key) ? 1 : 2;
      return { e, tier };
    })
    .sort((a, b) => a.tier - b.tier || b.e.downloads - a.e.downloads)
    .slice(0, searchBudget);
  for (const { e, tier } of searchDue) {
    if (Date.now() >= deadline || stats.errors > 40) break;
    const at = new Date().toISOString();
    const prev = ratings[e.key] ?? {};
    try {
      const surname = e.authorKeys[0].split(' ')[0];
      const docs = await olSearch(new URLSearchParams({ title: searchTitle(e.title), author: surname, fields: OL_FIELDS, limit: '20' }));
      stats.searched++;
      if (e.source === 'standard-ebooks') stats.standardEbooksSearched++;
      if (tier === 0) stats.revalidated++;
      const j = judgeSearchMatch(e, docs);
      let next;
      if (j.ok && (j.doc.ratings_count ?? 0) > 0) {
        next = { ...withoutMatch(prev), ...match(j.doc, j, at), sAt: at, smv: MATCHER_VERSION };
        stats.matchedBySearch++;
        if (e.source === 'standard-ebooks') stats.standardEbooksMatched++;
      } else {
        reject(j.ok ? 'match-has-no-ratings' : j.reason);
        // an earlier search match that no longer passes is removed; an id match (even unrated) is kept
        next = prev.m === 'title-author' ? { ...withoutMatch(prev), sAt: at, smv: MATCHER_VERSION } : { ...prev, sAt: at, smv: MATCHER_VERSION };
      }
      if (tier === 0 && describe(prev) !== describe(next)) {
        stats.revalidationChanged++;
        if (!rated(next)) stats.revalidationDropped++;
        note(e, describe(prev), describe(next));
      }
      ratings[e.key] = next;
    } catch (err) {
      stats.errors++; // keep whatever was there
      meta.warnings.push(`Open Library search: ${err.message}`);
    }
  }
  stats.durationMs = Date.now() - t0;
  meta.ratingsChanges = changes;
  log('Open Library:', JSON.stringify(stats));
  return { ratings, stats };
}

// ---------------------------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true });
  let pg;
  try {
    pg = await gutenberg();
  } catch (err) {
    if (!prevState.gutenberg?.editions?.length) throw err;
    meta.warnings.push(`Project Gutenberg unavailable (${err.message}); kept the previous catalog`);
    pg = { editions: prevState.gutenberg.editions, stats: { ...prevMetaSource('gutenberg'), reused: true, error: err.message }, lastModified: prevState.gutenberg.lastModified, parser: prevState.gutenberg.parser };
  }
  meta.sources.gutenberg = pg.stats;
  const prevReadable = prevState.gutenberg?.editions?.length ?? 0;
  if (prevReadable && pg.editions.length < prevReadable * 0.9) {
    throw new Error(`Gutenberg readable count fell from ${prevReadable} to ${pg.editions.length}; refusing to publish`);
  }

  let se;
  try {
    se = await standardEbooks();
  } catch (err) {
    if (!prevState.standardEbooks?.repos) throw err;
    meta.warnings.push(`Standard Ebooks listing unavailable (${err.message}); kept the previous list`);
    se = { repos: prevState.standardEbooks.repos, stats: { ...prevMetaSource('standardEbooks'), reused: true, error: err.message } };
  }
  meta.sources.standardEbooks = se.stats;
  const seEditions = Object.values(se.repos).map((x) => x.edition);
  const editions = [...seEditions, ...pg.editions];

  const ol = await openLibrary(editions);
  meta.sources.openLibrary = ol.stats;

  // Group: Standard Ebooks ↔ Gutenberg sources, same title/author/language, then same Open Library work.
  const solid = (e) => {
    const r = ol.ratings[e.key];
    return r?.w && r.c >= 0.9 ? r.w : null;
  };
  const groups = groupEditions(editions, solid);

  // A work's rating: among its editions' matches that carry real ratings, the best-supported one (highest
  // confidence, then most ratings). An unrated match never hides a rated one. Nothing is invented.
  const rated = [];
  const works = groups.map((g) => {
    const rating = workRating(g, ol.ratings);
    const rec = toWorkRecord(g, rating);
    if (rating) rated.push(rec);
    return rec;
  });
  const mean = rated.length ? rated.reduce((s, w) => s + w.r.v * w.r.n, 0) / rated.reduce((s, w) => s + w.r.n, 0) : 3.8;
  for (const w of rated) w.r.ws = weightedRating(w.r.v, w.r.n, w.r.c, mean);

  meta.counts = {
    editions: editions.length,
    gutenbergEditions: pg.editions.length,
    standardEbooksEditions: seEditions.length,
    works: works.length,
    multiEditionWorks: works.filter((w) => w.e.length > 1).length,
    standardEbooksWorksWithGutenberg: works.filter((w) => w.se && w.pg).length,
    ratedWorks: rated.length,
    unratedWorks: works.length - rated.length,
    ratingMean: Math.round(mean * 1000) / 1000,
    ratingPrior: 25,
  };
  meta.durationsMs.total = Date.now() - started;

  const catalog = { version: SNAPSHOT_VERSION, generatedAt: now, ratingMean: meta.counts.ratingMean, works };
  writeFileSync(`${OUT}/catalog.json.gz`, gzipSync(JSON.stringify(catalog), { level: 9 }));
  writeFileSync(
    `${OUT}/state.json.gz`,
    gzipSync(
      JSON.stringify({
        version: SNAPSHOT_VERSION,
        gutenberg: { lastModified: pg.lastModified ?? pg.stats.lastModified ?? null, parser: pg.parser ?? PARSER_VERSION, editions: pg.editions },
        standardEbooks: { repos: se.repos },
        ratings: ol.ratings,
      }),
    ),
  );
  writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 1));
  log('Done', JSON.stringify(meta.counts));

  if (process.env.GITHUB_STEP_SUMMARY) {
    const c = meta.counts;
    const o = meta.sources.openLibrary ?? {};
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '## BookNd catalog',
        '| | |',
        '|---|---|',
        `| Project Gutenberg records read | ${meta.sources.gutenberg.records ?? 'reused'} |`,
        `| Readable Gutenberg ebooks (Text + EPUB, public domain) | ${c.gutenbergEditions} |`,
        `| Standard Ebooks released ebooks | ${c.standardEbooksEditions} |`,
        `| Works after grouping editions | ${c.works} (${c.multiEditionWorks} with several editions) |`,
        `| Works with an Open Library rating | ${c.ratedWorks} |`,
        `| Open Library requests / rate-limited / errors | ${o.requests ?? 0} / ${o.rateLimited ?? 0} / ${o.errors ?? 0} |`,
        `| Warnings | ${meta.warnings.length} |`,
        '',
        ...meta.warnings.slice(0, 30).map((w) => `- ${w}`),
        '',
      ].join('\n'),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
