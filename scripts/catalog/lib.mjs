/**
 * BookNd catalog pipeline: pure functions shared by the build script and the tests.
 *
 * Sources (all bulk, all public, no credentials):
 *  - Project Gutenberg's official offline catalog (rdf-files.tar.bz2), one RDF file per ebook.
 *  - Standard Ebooks' CC0 source repositories on GitHub (one content.opf per released ebook).
 *  - Open Library's search API for work-level ratings (batched by Project Gutenberg id).
 */

export const SNAPSHOT_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Text helpers

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function clean(s) {
  return decodeEntities(s ?? '').replace(/\s+/g, ' ').trim();
}

export function stripHtml(s) {
  return clean(decodeEntities(s ?? '').replace(/<[^>]+>/g, ' '));
}

function fold(s) {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Normalised title used to compare editions: case, accents, punctuation, a leading article and an
 * alternative title ("Frankenstein; or, The Modern Prometheus") are ignored. Volume numbers are kept.
 */
export function titleKey(title) {
  let t = fold(title).replace(/&/g, ' and ');
  t = t.split(/\r?\n/)[0];
  // "X; or, Y" / "X, or Y" / "X: or, Y" alternative titles
  t = t.replace(/[;:,]\s*or,?\s+.*$/, '');
  t = t.replace(/[^a-z0-9]+/g, ' ').trim();
  t = t.replace(/^(the|a|an) /, '');
  return t;
}

/** Main title only (subtitle after ":" or ";" dropped): for comparing a catalog title with a ratings provider's title. */
export function mainTitleKey(title) {
  return titleKey(fold(title).split(/\s*[:;]\s*|\s+--\s+|\s+—\s+/)[0]);
}

/** "Austen, Jane" or "Jane Austen" → "austen j". Empty for "Anonymous"/"Unknown"/"Various". */
export function authorKey(name) {
  let n = fold(name).replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').trim();
  if (!n || /^(anonymous|unknown|various)\b/.test(n)) return '';
  let first = '';
  let last = '';
  if (n.includes(',')) {
    const [l, f] = n.split(',', 2);
    last = l;
    first = f ?? '';
  } else {
    const parts = n.split(/\s+/);
    last = parts.pop() ?? '';
    first = parts[0] ?? '';
  }
  last = last.replace(/[^a-z]+/g, ' ').trim().split(' ').pop() ?? '';
  first = first.replace(/[^a-z]+/g, ' ').trim();
  return last ? `${last} ${first[0] ?? ''}`.trim() : '';
}

/** Gutenberg names are "Last, First (alias)"; show them the way a reader expects. */
export function displayName(name) {
  const n = clean(name);
  const m = n.match(/^([^,]+),\s*(.+?)(\s*\(.*\))?$/);
  return m ? `${m[2]} ${m[1]}`.replace(/\s+/g, ' ').trim() : n;
}

export function lang2(code) {
  const c = (code ?? '').toLowerCase().trim();
  return c ? c.split(/[-_]/)[0] : '';
}

// ---------------------------------------------------------------------------------------------
// Genres: a shared vocabulary over LCSH subjects, Gutenberg bookshelves and Standard Ebooks genres.
// The ids match lib/browse.ts (a test checks they stay in step).

export const GENRE_PATTERNS = {
  adventure: /\b(adventure|adventures|sea stories|pirates|western stories|westerns)\b/,
  mystery: /\b(mystery|mysteries|detective|detectives|crime|suspense|thrillers?)\b/,
  romance: /\b(love stories|romance fiction|romances?|courtship|man-woman relationships)\b/,
  'science-fiction': /\bscience[- ]fiction\b/,
  fantasy: /\b(fantasy|fantasies|fairy tales|fantastic fiction)\b/,
  horror: /\b(horror|ghost stories|vampires|supernatural)\b/,
  humor: /\b(humor|humour|humorous|comedy|wit and humor|satire)\b/,
  poetry: /\b(poetry|poems|sonnets|ballads)\b/,
  drama: /\b(drama|plays|tragedies|tragedy|comedies)\b/,
  children: /\b(children|childrens|juvenile|young adult)\b/,
  philosophy: /\b(philosophy|ethics|metaphysics)\b/,
  history: /\bhistory\b/,
  biography: /\b(biography|biographies|autobiography|autobiographies|memoirs?)\b/,
  travel: /\b(travel|travels|voyages)\b/,
};

export function genresOf(labels) {
  const hay = labels.map((l) => fold(l).replace(/[’']/g, '').replace(/category:\s*/g, '')).join(' | ');
  return Object.keys(GENRE_PATTERNS).filter((g) => GENRE_PATTERNS[g].test(hay));
}

// ---------------------------------------------------------------------------------------------
// Tar stream reader (for rdf-files.tar.bz2 piped through bzip2 -dc) – avoids unpacking 75k files.

/** Calls onFile(name, Buffer) for every regular file in a tar stream. */
export async function readTar(stream, onFile) {
  let buf = Buffer.alloc(0);
  let longName = null;
  let pending = null; // { name, size, padded, type }
  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (!pending) {
        if (buf.length < 512) break;
        const header = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (header.every((b) => b === 0)) continue;
        const str = (o, l) => header.subarray(o, o + l).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(str(124, 12).trim() || '0', 8);
        const type = String.fromCharCode(header[156] || 48);
        const prefix = str(345, 155);
        let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
        longName = null;
        pending = { name, size, padded: Math.ceil(size / 512) * 512, type };
      }
      if (buf.length < pending.padded) break;
      const body = buf.subarray(0, pending.size);
      buf = buf.subarray(pending.padded);
      const p = pending;
      pending = null;
      if (p.type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
      else if (p.type === '0' || p.type === '\0') await onFile(p.name, Buffer.from(body));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Project Gutenberg RDF

function blocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(m[0]);
  return out;
}
function inner(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : '';
}
function values(xml, tag) {
  return blocks(xml, tag).map((b) => clean(inner(b, 'rdf:value'))).filter(Boolean);
}

/**
 * Parses one Project Gutenberg RDF record. Returns null when the file isn't an ebook record.
 * The result says what the record is; isReadableGutenberg() decides whether BookNd lists it.
 */
export function parseGutenbergRdf(xml) {
  const ebook = xml.match(/<pgterms:ebook rdf:about="ebooks\/(\d+)">([\s\S]*?)<\/pgterms:ebook>/);
  if (!ebook) return null;
  const id = Number(ebook[1]);
  const body = ebook[2];
  const role = (tag) =>
    blocks(body, tag)
      .map((b) => clean(inner(b, 'pgterms:name')))
      .filter(Boolean);
  const subjects = blocks(body, 'dcterms:subject')
    .filter((b) => b.includes('/LCSH"'))
    .map((b) => clean(inner(b, 'rdf:value')));
  const files = blocks(body, 'pgterms:file').map((f) => ({
    url: (f.match(/rdf:about="([^"]+)"/) ?? [])[1] ?? '',
    type: clean(inner(f, 'rdf:value')),
  }));
  const epub = files.find((f) => f.type.startsWith('application/epub+zip'));
  const cover = files.find((f) => /\.cover\.medium\.jpg$/.test(f.url))?.url;
  const summary = clean(inner(body, 'pgterms:marc520')).replace(/\s*\(This is an automatically generated summary\.\)\s*$/i, '');
  const issued = clean(inner(body, 'dcterms:issued'));
  return {
    id,
    title: clean(inner(body, 'dcterms:title')).replace(/\s*\r?\n\s*/g, ': '),
    authors: role('dcterms:creator').map(displayName),
    authorKeys: role('dcterms:creator').map(authorKey).filter(Boolean),
    translators: role('marcrel:trl').map(displayName),
    subjects: [...new Set(subjects.map((s) => s.split(' -- ')[0].trim()).filter(Boolean))],
    bookshelves: values(body, 'pgterms:bookshelf'),
    language: lang2(values(body, 'dcterms:language')[0]),
    types: values(body, 'dcterms:type'),
    rights: clean(inner(body, 'dcterms:rights')),
    downloads: Number(clean(inner(body, 'pgterms:downloads'))) || 0,
    issued: /^\d{4}-\d{2}-\d{2}$/.test(issued) ? issued : '',
    summary,
    hasEpub: !!epub,
    cover,
  };
}

/** What BookNd can open: public-domain Text with an EPUB. Audiobooks, other media and copyrighted titles are left out. */
export function isReadableGutenberg(rec) {
  if (!rec || !rec.hasEpub) return { ok: false, reason: 'no-epub' };
  if (rec.types.length && !rec.types.includes('Text')) return { ok: false, reason: 'not-text' };
  if (/copyright/i.test(rec.rights) && !/public domain/i.test(rec.rights)) return { ok: false, reason: 'copyrighted' };
  if (!rec.title) return { ok: false, reason: 'no-title' };
  return { ok: true };
}

export function gutenbergEdition(rec) {
  return {
    key: `gutenberg:${rec.id}`,
    source: 'gutenberg',
    title: rec.title,
    authors: rec.authors,
    authorKeys: rec.authorKeys,
    translators: rec.translators,
    subjects: rec.subjects.slice(0, 8),
    genres: genresOf([...rec.subjects, ...rec.bookshelves]),
    language: rec.language || 'en',
    description: rec.summary.slice(0, 1200),
    issued: rec.issued,
    downloads: rec.downloads,
    cover: rec.cover || `https://www.gutenberg.org/cache/epub/${rec.id}/pg${rec.id}.cover.medium.jpg`,
    pageUrl: `https://www.gutenberg.org/ebooks/${rec.id}`,
    epubUrl: `https://www.gutenberg.org/ebooks/${rec.id}.epub3.images`,
    gutenbergIds: [rec.id],
  };
}

// ---------------------------------------------------------------------------------------------
// Standard Ebooks content.opf

/** A Standard Ebooks repository is a released ebook when its homepage points at the ebook's page. */
export function seSlugFromHomepage(homepage) {
  const m = (homepage ?? '').match(/^https:\/\/standardebooks\.org\/ebooks\/([a-z0-9_-]+(?:\/[a-z0-9_-]+){1,4})\/?$/);
  return m ? m[1] : null;
}

export function parseStandardEbooksOpf(xml, slug) {
  const meta = xml.match(/<metadata[\s\S]*?<\/metadata>/)?.[0] ?? '';
  const metas = [...meta.matchAll(/<meta\b([^>]*)>([\s\S]*?)<\/meta>/g)].map((m) => ({
    property: (m[1].match(/property="([^"]+)"/) ?? [])[1] ?? '',
    refines: (m[1].match(/refines="#([^"]+)"/) ?? [])[1] ?? '',
    value: clean(m[2]),
  }));
  const dc = (tag) => [...meta.matchAll(new RegExp(`<dc:${tag}\\b([^>]*)>([\\s\\S]*?)</dc:${tag}>`, 'g'))].map((m) => ({ id: (m[1].match(/id="([^"]+)"/) ?? [])[1] ?? '', value: m[2] }));
  const roleOf = (id) => metas.filter((m) => m.refines === id && m.property === 'role').map((m) => m.value);
  const fileAs = (id) => metas.find((m) => m.refines === id && m.property === 'file-as')?.value;
  const creators = dc('creator').filter((c) => {
    const r = roleOf(c.id);
    return !r.length || r.includes('aut');
  });
  const translators = dc('contributor').filter((c) => roleOf(c.id).includes('trl'));
  const titles = dc('title');
  const title = clean(titles.find((t) => t.id === 'title')?.value ?? titles[0]?.value ?? '');
  const genres = metas.filter((m) => m.property === 'schema:genre' || m.property === 'se:subject').map((m) => m.value);
  const subjects = dc('subject').map((s) => clean(s.value).split('--')[0].trim());
  const longDesc = metas.find((m) => m.property === 'se:long-description')?.value;
  const descriptions = dc('description').map((d) => stripHtml(d.value));
  const abstract = metas.find((m) => m.property === 'schema:abstract')?.value;
  // Newer releases put the long description in dc:description and the one-liner in schema:abstract.
  const description = stripHtml(longDesc ?? '') || descriptions.sort((a, b) => b.length - a.length)[0] || abstract || '';
  const gutenbergIds = dc('source')
    .map((s) => clean(s.value).match(/gutenberg\.org\/(?:ebooks|files)\/(\d+)/)?.[1])
    .filter(Boolean)
    .map(Number);
  const date = clean(dc('date')[0]?.value ?? '').slice(0, 10);
  const authorsRaw = creators.map((c) => ({ name: clean(c.value), fileAs: fileAs(c.id) }));
  return {
    key: `se:${slug}`,
    source: 'standard-ebooks',
    title,
    authors: authorsRaw.map((a) => a.name),
    authorKeys: authorsRaw.map((a) => authorKey(a.fileAs ?? a.name)).filter(Boolean),
    translators: translators.map((t) => clean(t.value)),
    subjects: [...new Set([...genres, ...subjects])].slice(0, 8),
    genres: genresOf([...genres, ...subjects]),
    language: lang2(clean(dc('language')[0]?.value ?? 'en')) || 'en',
    description: description.slice(0, 1200),
    issued: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    downloads: 0,
    cover: `https://standardebooks.org/ebooks/${slug}/downloads/cover-thumbnail.jpg`,
    pageUrl: `https://standardebooks.org/ebooks/${slug}`,
    epubUrl: `https://standardebooks.org/ebooks/${slug}/downloads/${slug.replace(/\//g, '_')}.epub`,
    gutenbergIds,
    wordCount: Number(metas.find((m) => m.property === 'schema:wordCount' || m.property === 'se:word-count')?.value) || undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Grouping editions into works

class UnionFind {
  constructor() {
    this.p = new Map();
  }
  find(x) {
    if (!this.p.has(x)) this.p.set(x, x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(x) !== r) {
      const n = this.p.get(x);
      this.p.set(x, r);
      x = n;
    }
    return r;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(rb, ra);
  }
}

/** Same work, same language: exact normalised title and the same first author. */
export function editionMatchKey(e) {
  const t = titleKey(e.title);
  const a = e.authorKeys[0] ?? '';
  // Anonymous works with generic titles ("Poems", "Letters") are too ambiguous to group by title alone.
  if (!t || (!a && t.split(' ').length < 3)) return null;
  return `${e.language}|${t}|${a}`;
}

/**
 * Groups editions into works:
 *  1. a Standard Ebooks edition joins the Gutenberg transcriptions it names as its source;
 *  2. editions with the same normalised title, first author and language are one work;
 *  3. editions an identifier-matched ratings provider files under the same work (same language) are one work.
 * The preferred edition is Standard Ebooks when there is one, then the most-downloaded transcription.
 */
export function groupEditions(editions, providerWorkOf = () => null) {
  const uf = new UnionFind();
  const byKey = new Map(editions.map((e) => [e.key, e]));
  for (const e of editions) uf.find(e.key);
  for (const e of editions) {
    if (e.source !== 'standard-ebooks') continue;
    for (const id of e.gutenbergIds) {
      const pg = byKey.get(`gutenberg:${id}`);
      // the cited transcription may be in another language (a translation's source); keep those apart
      if (pg && pg.language === e.language) uf.union(e.key, pg.key);
    }
  }
  const byMatch = new Map();
  for (const e of editions) {
    const k = editionMatchKey(e);
    if (!k) continue;
    if (byMatch.has(k)) uf.union(byMatch.get(k), e.key);
    else byMatch.set(k, e.key);
  }
  const byWork = new Map();
  for (const e of editions) {
    const w = providerWorkOf(e);
    if (!w) continue;
    const k = `${e.language}|${w}`;
    if (byWork.has(k)) uf.union(byWork.get(k), e.key);
    else byWork.set(k, e.key);
  }
  const groups = new Map();
  for (const e of editions) {
    const r = uf.find(e.key);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(e);
  }
  return [...groups.values()].map((list) =>
    list.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'standard-ebooks' ? -1 : 1;
      return b.downloads - a.downloads || a.key.localeCompare(b.key, 'en', { numeric: true });
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Ratings: Open Library work matching

function tokens(s) {
  return new Set(mainTitleKey(s).split(' ').filter((w) => w.length > 1 || /\d/.test(w)));
}

/** Title similarity on main titles (0..1): Jaccard over words, 1 for an exact match. */
export function titleSimilarity(a, b) {
  const ka = mainTitleKey(a);
  const kb = mainTitleKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  return both / (ta.size + tb.size - both || 1);
}

export function authorsAgree(editionKeys, providerNames) {
  if (!editionKeys.length || !providerNames?.length) return null; // unknown
  const surnames = new Set(editionKeys.map((k) => k.split(' ')[0]));
  return providerNames.some((n) => surnames.has(authorKey(n).split(' ')[0]));
}

/**
 * Decides whether an Open Library work found by Project Gutenberg id really is this edition's work.
 * The identifier comes from Open Library's edition records, which are crowd-edited, so the title
 * and author are checked too: a mismatch is rejected rather than shown.
 */
export function judgeIdentifierMatch(edition, doc) {
  const sim = titleSimilarity(edition.title, doc.title ?? '');
  const authors = authorsAgree(edition.authorKeys, doc.author_name);
  if (authors === false) return { ok: false, reason: 'author-mismatch' };
  if (sim >= 0.999) return { ok: true, confidence: authors ? 0.98 : 0.9, method: 'gutenberg-id' };
  if (sim >= 0.5) return { ok: true, confidence: authors ? 0.9 : 0.8, method: 'gutenberg-id' };
  return { ok: false, reason: 'title-mismatch' };
}

/**
 * Title-and-author search fallback: only an exact main-title match by the same author counts, and
 * only when one work clearly dominates (otherwise the match is ambiguous and nothing is stored).
 */
export function judgeSearchMatch(edition, docs) {
  if (!edition.authorKeys.length) return { ok: false, reason: 'no-author' };
  const want = mainTitleKey(edition.title);
  if (want.split(' ').length < 2 && want.length < 6) return { ok: false, reason: 'title-too-generic' };
  const hits = docs.filter((d) => mainTitleKey(d.title ?? '') === want && authorsAgree(edition.authorKeys, d.author_name) === true);
  if (!hits.length) return { ok: false, reason: 'no-match' };
  hits.sort((a, b) => (b.edition_count ?? 0) - (a.edition_count ?? 0));
  if (hits.length > 1 && (hits[0].edition_count ?? 0) < 3 * (hits[1].edition_count ?? 0)) return { ok: false, reason: 'ambiguous' };
  return { ok: true, doc: hits[0], confidence: 0.75, method: 'title-author' };
}

/**
 * Confidence-weighted rating for sorting (a Bayesian average): the observed average is pulled towards
 * the catalog-wide mean by a prior worth `prior` ratings, and each rating counts in proportion to the
 * match confidence. Few ratings or a less certain match therefore move a work less far from the mean.
 */
export function weightedRating(value, count, confidence, mean, prior = 25) {
  if (!count || value == null) return null;
  const n = count * confidence;
  return Math.round(((n * value + prior * mean) / (n + prior)) * 1000) / 1000;
}

// ---------------------------------------------------------------------------------------------
// Snapshot

/** Compact per-work record served to Discover. Keys are short to keep the snapshot small. */
export function toWorkRecord(group, rating) {
  const pref = group[0];
  const languages = [...new Set(group.map((e) => e.language))];
  const genres = [...new Set(group.flatMap((e) => e.genres))];
  const subjects = [...new Set(group.flatMap((e) => e.subjects))].slice(0, 10);
  const description = group.map((e) => e.description).find((d) => d && d.length > 40) ?? pref.description ?? '';
  return {
    id: pref.key,
    t: pref.title,
    a: pref.authors,
    tr: pref.translators?.length ? pref.translators : undefined,
    s: subjects,
    g: genres,
    l: languages,
    d: description,
    y: group.map((e) => e.issued).filter(Boolean).sort()[0] || undefined,
    dl: group.reduce((n, e) => n + (e.downloads || 0), 0),
    se: group.some((e) => e.source === 'standard-ebooks') ? 1 : 0,
    pg: group.some((e) => e.source === 'gutenberg') ? 1 : 0,
    e: group.map((e) => ({
      k: e.key,
      t: e.title !== pref.title ? e.title : undefined,
      l: e.language,
      tr: e.translators?.length ? e.translators : undefined,
      c: e.cover,
      p: e.pageUrl,
      u: e.epubUrl,
      dl: e.downloads || undefined,
    })),
    r: rating ?? undefined,
  };
}
