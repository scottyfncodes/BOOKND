import { gunzipSync } from 'node:zlib';
import { after } from 'next/server';
import { isGenre, type GenreId } from '@/lib/browse';
import { coverProxy } from '@/lib/catalog';

/**
 * Full-catalog search over the snapshot built by scripts/catalog/build.mjs (published daily as
 * release assets). The whole catalog is held in memory by each server instance, so search, filters,
 * counts, sorting and pagination always run over every work, never over a loaded page.
 */

// ---- snapshot shape (see scripts/catalog/lib.mjs toWorkRecord) ----
export interface SnapshotEdition {
  k: string;
  t?: string;
  l: string;
  tr?: string[];
  c?: string;
  p: string;
  u: string;
  dl?: number;
}
export interface SnapshotRating {
  v: number;
  n: number;
  src: 'openlibrary';
  w: string;
  c: number;
  m: 'gutenberg-id' | 'title-author';
  at: string;
  ws: number;
  via: string;
}
export interface SnapshotWork {
  id: string;
  t: string;
  a: string[];
  tr?: string[];
  s: string[];
  g: string[];
  l: string[];
  d: string;
  y?: string;
  dl: number;
  se: 0 | 1;
  pg: 0 | 1;
  e: SnapshotEdition[];
  r?: SnapshotRating;
}
export interface Snapshot {
  version: number;
  generatedAt: string;
  ratingMean: number;
  works: SnapshotWork[];
}

// ---- public API shape ----
export type Source = 'gutenberg' | 'standard-ebooks';
export interface Edition {
  key: string;
  source: Source;
  title: string;
  language: string;
  translators: string[];
  cover?: string;
  pageUrl: string;
  epubUrl: string;
  downloads?: number;
}
export interface Rating {
  value: number;
  count: number;
  source: 'Open Library';
  url: string;
  /** 0..1: how sure the match to this work is. */
  confidence: number;
  method: 'gutenberg-id' | 'title-author';
  updatedAt: string;
  /** Confidence-weighted (Bayesian) score used by the Top rated sort. */
  weighted: number;
}
export interface Work {
  id: string;
  title: string;
  authors: string[];
  translators: string[];
  subjects: string[];
  genres: string[];
  languages: string[];
  description: string;
  year?: number;
  downloads: number;
  hasStandardEbooks: boolean;
  editions: Edition[];
  rating: Rating | null;
}

export const SORTS = ['relevance', 'popular', 'rating', 'title', 'author', 'newest'] as const;
export type Sort = (typeof SORTS)[number];
export const FIELDS = ['all', 'title', 'author', 'subject', 'description'] as const;
export type Field = (typeof FIELDS)[number];
export type RatingFilter = 'any' | 'rated' | 'unrated';

export interface SearchParams {
  q: string;
  field: Field;
  genre: GenreId | null;
  language: string | null;
  source: Source | null;
  rating: RatingFilter;
  sort: Sort;
  page: number;
  per: number;
}
export interface SearchResult {
  total: number;
  page: number;
  per: number;
  pages: number;
  sort: Sort;
  facets: { sources: Record<Source, number>; rated: number; unrated: number };
  works: Work[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------------------------

// Plain ASCII needs no Unicode normalisation, and its letters and digits are just [a-z0-9]: the same result,
// several times faster. Most catalog text is ASCII, and folding all of it is most of a cold start.
// Typographic punctuation (’ “ ” — … and no-break spaces) only ever becomes a word break, so mapping it to a space
// first lets most descriptions take the fast path too.
const ASCII = /^[\x00-\x7f]*$/;
const PUNCT = /[\u00a0\u00ab\u00bb\u2000-\u206f]/g;
/** Case- and accent-insensitive text for matching; letters and digits of every script are kept (Greek, Cyrillic, CJK…). */
export function fold(s: string) {
  if (!ASCII.test(s)) {
    const t = s.replace(PUNCT, ' ');
    if (ASCII.test(t)) s = t;
  }
  if (ASCII.test(s)) {
    return s
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
const hay = (s: string) => ` ${fold(s)} `;
/** "The Picture of Dorian Gray" and "picture of dorian gray" are the same title for the exact-title boost. */
export function withoutArticle(folded: string) {
  return folded.replace(/^(the|a|an) (?=\S)/, '');
}
/** Title sort key: leading article and punctuation ignored; numbers and Latin-script titles first, then other scripts. */
function sortTitle(t: string) {
  const k = fold(t).replace(/^(the|a|an) /, '');
  // numbers, then Latin script (accents folded), then other scripts
  return /^[a-z0-9]/.test(k) ? `0${k}` : /\p{L}/u.test(k) ? `1${k}` : `2${k}`;
}
function surname(name: string | undefined) {
  if (!name) return '￿';
  const parts = fold(name.replace(/\(.*?\)/g, ''))
    .split(' ')
    .filter(Boolean);
  return parts.length ? `${parts[parts.length - 1]} ${parts.slice(0, -1).join(' ')}` : '￿';
}

/**
 * Descriptions are ~95% of the catalog's text, and folding them was most of a cold start. Browsing (no search
 * terms, which is how Discover opens) never reads them, so each one is folded on first use instead.
 */
class Entry {
  private d: string | undefined;
  constructor(
    readonly w: SnapshotWork,
    readonly title: string,
    readonly author: string,
    readonly subject: string,
    readonly titleExact: string,
    readonly langs: Set<string>,
    readonly genres: Set<string>,
  ) {}
  get desc() {
    return (this.d ??= hay(this.w.d));
  }
}

export interface CatalogIndex {
  generatedAt: string;
  entries: Entry[];
  order: Record<Exclude<Sort, 'relevance'>, Uint32Array>;
  languages: { code: string; works: number }[];
}

export function buildIndex(snap: Snapshot): CatalogIndex {
  const entries = snap.works.map(
    (w) =>
      new Entry(
        w,
        hay([w.t, ...w.e.map((e) => e.t ?? '')].join(' ')),
        hay([...w.a, ...(w.tr ?? [])].join(' ')),
        hay([...w.s, ...w.g].join(' ')),
        withoutArticle(fold(w.t)),
        new Set(w.l),
        new Set(w.g),
      ),
  );
  const idx = entries.map((_, i) => i);
  const by = (cmp: (a: Entry, b: Entry) => number) => Uint32Array.from([...idx].sort((a, b) => cmp(entries[a], entries[b]) || a - b));
  const titles = entries.map((e) => sortTitle(e.w.t));
  const authors = entries.map((e) => surname(e.w.a[0]));
  const order = {
    popular: by((a, b) => b.w.dl - a.w.dl || (b.w.r?.n ?? 0) - (a.w.r?.n ?? 0) || b.w.se - a.w.se),
    rating: by((a, b) => (b.w.r?.ws ?? -1) - (a.w.r?.ws ?? -1) || (b.w.r?.n ?? 0) - (a.w.r?.n ?? 0) || b.w.dl - a.w.dl),
    title: Uint32Array.from([...idx].sort((a, b) => (titles[a] < titles[b] ? -1 : titles[a] > titles[b] ? 1 : a - b))),
    author: Uint32Array.from([...idx].sort((a, b) => (authors[a] < authors[b] ? -1 : authors[a] > authors[b] ? 1 : titles[a] < titles[b] ? -1 : 1))),
    newest: by((a, b) => (b.w.y ?? '').localeCompare(a.w.y ?? '') || b.w.dl - a.w.dl),
  };
  const langCount = new Map<string, number>();
  for (const e of entries) for (const l of e.langs) langCount.set(l, (langCount.get(l) ?? 0) + 1);
  const languages = [...langCount].map(([code, works]) => ({ code, works })).sort((a, b) => b.works - a.works);
  return { generatedAt: snap.generatedAt, entries, order, languages };
}

function terms(q: string) {
  const quoted = q.match(/^\s*"(.+)"\s*$/);
  if (quoted) return [fold(quoted[1])].filter(Boolean);
  return [...new Set(fold(q).split(' ').filter(Boolean))].slice(0, 12);
}

/** Every term must match the start of a word in the chosen field(s). Returns a relevance score, or -1. */
function score(e: Entry, ts: string[], field: Field, whole: string): number {
  let s = 0;
  for (const t of ts) {
    const needle = ` ${t}`;
    const inTitle = (field === 'all' || field === 'title') && e.title.includes(needle);
    const inAuthor = (field === 'all' || field === 'author') && e.author.includes(needle);
    const inSubject = (field === 'all' || field === 'subject') && e.subject.includes(needle);
    const inDesc = (field === 'all' || field === 'description') && e.desc.includes(needle);
    if (!inTitle && !inAuthor && !inSubject && !inDesc) return -1;
    s += (inTitle ? 10 : 0) + (inAuthor ? 8 : 0) + (inSubject ? 3 : 0) + (inDesc ? 1 : 0);
  }
  if (field === 'all' || field === 'title') {
    // a leading The/A/An is optional on both sides: the novel itself outranks books about it
    const wanted = withoutArticle(whole);
    if (wanted && e.titleExact === wanted) s += 40;
    else if (wanted && ` ${e.titleExact}`.startsWith(` ${wanted}`)) s += 15;
  }
  // well-read works and carefully produced editions first among equally good matches
  return s + Math.log10(e.w.dl + 1) * 2 + (e.w.r ? Math.log10(e.w.r.n + 1) : 0) + e.w.se * 2;
}

function toWork(w: SnapshotWork): Work {
  return {
    id: w.id,
    title: w.t,
    authors: w.a,
    translators: w.tr ?? [],
    subjects: w.s,
    genres: w.g,
    languages: w.l,
    description: w.d,
    year: w.y ? Number(w.y.slice(0, 4)) : undefined,
    downloads: w.dl,
    hasStandardEbooks: !!w.se,
    editions: w.e.map((e) => ({
      key: e.k,
      source: e.k.startsWith('se:') ? 'standard-ebooks' : 'gutenberg',
      title: e.t ?? w.t,
      language: e.l,
      translators: e.tr ?? [],
      cover: coverProxy(e.c),
      pageUrl: e.p,
      epubUrl: e.u,
      downloads: e.dl,
    })),
    rating: w.r
      ? {
          value: w.r.v,
          count: w.r.n,
          source: 'Open Library',
          url: `https://openlibrary.org${w.r.w}`,
          confidence: w.r.c,
          method: w.r.m,
          updatedAt: w.r.at,
          weighted: w.r.ws,
        }
      : null,
  };
}

export function search(index: CatalogIndex, p: SearchParams): SearchResult {
  const ts = terms(p.q);
  const whole = fold(p.q.replace(/"/g, ''));
  const sort: Sort = p.sort === 'relevance' && !ts.length ? 'popular' : p.sort;
  const facets = { sources: { gutenberg: 0, 'standard-ebooks': 0 } as Record<Source, number>, rated: 0, unrated: 0 };
  const hits: { i: number; s: number }[] = [];
  const order = sort === 'relevance' ? null : index.order[sort];
  const n = index.entries.length;
  for (let k = 0; k < n; k++) {
    const i = order ? order[k] : k;
    const e = index.entries[i];
    if (p.language && !e.langs.has(p.language)) continue;
    if (p.genre && !e.genres.has(p.genre)) continue;
    let s = 0;
    if (ts.length) {
      s = score(e, ts, p.field, whole);
      if (s < 0) continue;
    }
    // facets count every match before the source and rating filters, so the chips can show their totals
    const rated = !!e.w.r;
    const inSource = !p.source || (p.source === 'standard-ebooks' ? e.w.se : e.w.pg);
    const inRating = p.rating === 'any' || (p.rating === 'rated' ? rated : !rated);
    if (inRating) {
      if (e.w.se) facets.sources['standard-ebooks']++;
      if (e.w.pg) facets.sources.gutenberg++;
    }
    if (inSource) facets[rated ? 'rated' : 'unrated']++;
    if (inSource && inRating) hits.push({ i, s });
  }
  if (sort === 'relevance') hits.sort((a, b) => b.s - a.s || index.entries[b.i].w.dl - index.entries[a.i].w.dl || a.i - b.i);
  const total = hits.length;
  const pages = Math.max(1, Math.ceil(total / p.per));
  const page = Math.min(Math.max(1, p.page), pages);
  const works = hits.slice((page - 1) * p.per, page * p.per).map((h) => toWork(index.entries[h.i].w));
  return { total, page, per: p.per, pages, sort, facets, works, generatedAt: index.generatedAt };
}

export function parseSearchParams(sp: URLSearchParams): SearchParams {
  const get = (k: string) => (sp.get(k) ?? '').trim();
  const q = get('q').slice(0, 160);
  const field = (FIELDS as readonly string[]).includes(get('in')) ? (get('in') as Field) : 'all';
  const genre = isGenre(get('genre')) ? (get('genre') as GenreId) : null;
  const lang = get('lang').toLowerCase();
  const language = lang === 'all' ? null : /^[a-z]{2,3}$/.test(lang) ? lang : 'en';
  const src = get('source');
  const source = src === 'gutenberg' || src === 'standard-ebooks' ? src : null;
  const r = get('rating');
  const rating: RatingFilter = r === 'rated' || r === 'unrated' ? r : 'any';
  const s = get('sort');
  const sort: Sort = (SORTS as readonly string[]).includes(s) ? (s as Sort) : q ? 'relevance' : 'popular';
  const page = Math.min(Math.max(parseInt(get('page'), 10) || 1, 1), 100000);
  const per = Math.min(Math.max(parseInt(get('per'), 10) || 24, 1), 60);
  return { q, field, genre, language, source, rating, sort, page, per };
}

// ---------------------------------------------------------------------------------------------
// Loading: each server instance keeps one index and checks the small meta.json for a newer build.
// GitHub's release downloads occasionally answer 5xx or time out, so every fetch is retried a bounded number of
// times, and an instance never drops the catalog it already has because a refresh failed.

const BASE = process.env.CATALOG_BASE_URL || 'https://github.com/scottyfncodes/BOOKND/releases/download/catalog-latest';
const CHECK_EVERY_MS = 10 * 60 * 1000;
/** After a failed refresh a running instance tries again sooner, still serving the catalog it has. */
const RETRY_FAILED_CHECK_MS = 60 * 1000;
const opts = { attempts: 3, backoffMs: [600, 2000], metaTimeoutMs: 8000, catalogTimeoutMs: 40000 };

export class CatalogUnavailable extends Error {}

let current: { index: CatalogIndex; meta: CatalogMeta | null } | null = null;
let checkedAt = 0;
let inflight: Promise<void> | null = null;
let warming: Promise<void> | null = null;

export interface CatalogMeta {
  generatedAt: string;
  counts?: Record<string, number>;
  sources?: Record<string, unknown>;
  warnings?: string[];
  run?: { id: string; url: string };
}

class FetchFailed extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

async function getOnce(path: string, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${path}`, { cache: 'no-store', signal: ctrl.signal, headers: { 'User-Agent': 'BookNd/1.0' } });
    // 404 is retried too: a release asset is briefly missing while the nightly build replaces it
    if (!res.ok) throw new FetchFailed(`${path}: ${res.status}`, res.status >= 500 || res.status === 429 || res.status === 404);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof FetchFailed) throw err;
    throw new FetchFailed(`${path}: ${err instanceof Error ? err.message : String(err)}`, true); // network error or timeout
  } finally {
    clearTimeout(t);
  }
}

/** Fetches a release asset with bounded retries and backoff on transient failures (5xx, 429, 404, timeouts). */
async function get(path: string, timeoutMs: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await getOnce(path, timeoutMs);
    } catch (err) {
      const retry = err instanceof FetchFailed && err.retryable && attempt < opts.attempts;
      if (!retry) throw err;
      console.warn(`catalog fetch retry ${attempt}/${opts.attempts - 1}:`, (err as Error).message);
      await new Promise((r) => setTimeout(r, opts.backoffMs[attempt - 1] ?? opts.backoffMs.at(-1)));
    }
  }
}

async function loadCatalog(): Promise<CatalogIndex> {
  const raw = await get('catalog.json.gz', opts.catalogTimeoutMs);
  const json = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const snap = JSON.parse(json.toString('utf8')) as Snapshot;
  if (!Array.isArray(snap.works) || !snap.works.length) throw new Error('empty catalog');
  return buildIndex(snap);
}

async function refresh() {
  let meta: CatalogMeta | null = null;
  try {
    meta = JSON.parse((await get('meta.json', opts.metaTimeoutMs)).toString('utf8')) as CatalogMeta;
  } catch (err) {
    // With a catalog in hand, an unreachable meta.json just means "check again later".
    if (current) throw err;
    // Without one, meta.json is not required: go straight for the catalog.
    console.warn('catalog meta unavailable; loading the catalog directly', (err as Error).message);
  }
  if (current && meta && current.index.generatedAt === meta.generatedAt) return;
  const index = await loadCatalog();
  // never replace a newer catalog with an older one (e.g. a stale CDN copy)
  if (current && index.generatedAt < current.index.generatedAt) return;
  current = { index, meta: meta && meta.generatedAt === index.generatedAt ? meta : (current?.meta ?? meta) };
  // fold descriptions ahead of the first search (browsing never needs them, so nothing waits for this)
  warming = warmDescriptions(index).catch(() => {});
}

/** The loaded index; loads it on first use and refreshes in the background when a newer build is published. */
export async function getCatalog(): Promise<{ index: CatalogIndex; meta: CatalogMeta | null }> {
  const stale = Date.now() - checkedAt > CHECK_EVERY_MS;
  if (stale && !inflight) {
    checkedAt = Date.now();
    inflight = refresh()
      .catch((err) => {
        console.error('catalog refresh failed', err);
        // keep serving the catalog we have; look again soon. With none, the next request tries again.
        checkedAt = current ? Date.now() - CHECK_EVERY_MS + RETRY_FAILED_CHECK_MS : 0;
      })
      .finally(() => {
        inflight = null;
      });
    // A serverless function is frozen once its response is sent; keep it alive until a background refresh finishes.
    if (current) {
      const pending = inflight;
      keepAlive(() => pending.then(() => warming));
    }
  }
  if (!current && inflight) {
    await inflight;
    // the first response no longer waits for descriptions; keep the instance awake while they are folded
    keepAlive(() => warming);
  }
  if (!current) throw new CatalogUnavailable('The catalog index is not available yet.');
  return current;
}

function keepAlive(task: () => Promise<unknown> | null) {
  try {
    after(() => task());
  } catch {
    // outside a request (tests, scripts): the promise simply runs
  }
}

/** Folds every description in small slices, yielding between them so searches arriving meanwhile still answer. */
async function warmDescriptions(index: CatalogIndex) {
  for (let i = 0; i < index.entries.length; i += 2000) {
    for (const e of index.entries.slice(i, i + 2000)) void e.desc;
    await new Promise((r) => setImmediate(r));
  }
}

/** Test hooks. */
export function _setCatalogForTests(snap: Snapshot | null) {
  current = snap ? { index: buildIndex(snap), meta: { generatedAt: snap.generatedAt } } : null;
  checkedAt = snap ? Date.now() : 0;
}
export function _resetLoaderForTests(o: Partial<typeof opts> = {}) {
  current = null;
  checkedAt = 0;
  inflight = null;
  warming = null;
  Object.assign(opts, { attempts: 3, backoffMs: [600, 2000], metaTimeoutMs: 8000, catalogTimeoutMs: 40000 }, o);
}
export function _expireCheckForTests() {
  checkedAt = 0;
}
export async function _settleForTests() {
  while (inflight) await inflight;
}
