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

/** Removes MARC subfield markers that leak into catalog titles ("The silent Baltic : $b or, Detained…"). */
export function cleanTitle(t) {
  return (t ?? '')
    .replace(/\s*:\s*\$[a-z]\s*/g, ': ')
    .replace(/\s*\$[a-z]\s+/g, ' ')
    .replace(/\s+:/g, ':')
    .trim();
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
    title: cleanTitle(clean(inner(body, 'dcterms:title')).replace(/\s*\r?\n\s*/g, ': ')),
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
    cover: rec.cover, // only when the record lists one; older ebooks have none and get BookNd's typeset cover
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
      // …and only when it is the same text: a collection ("Dialogues", "Short Fiction") cites many sources
      if (pg && pg.language === e.language && sameWorkTitle(e.title, pg.title)) uf.union(e.key, pg.key);
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
    const first = byWork.get(k);
    if (!first) byWork.set(k, e.key);
    // provider works are crowd-edited and sometimes lump separate texts together; require matching titles too
    else if (sameWorkTitle(byKey.get(first).title, e.title)) uf.union(first, e.key);
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

/** Two edition titles name the same work: equal main titles, or most of their words in common. */
export function sameWorkTitle(a, b) {
  const ka = mainTitleKey(a);
  const kb = mainTitleKey(b);
  if (!ka || !kb) return false;
  // "The Iliad" / "The Iliad of Homer": one title extends the other
  // "The Powerhouse" / "The Power-House": spacing and hyphenation differ between editions
  if (ka.replace(/ /g, '') === kb.replace(/ /g, '')) return true;
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (long.startsWith(`${short} `)) {
    // "The Count of Monte-Cristo [3/5]", "Don Quixote, Part 2": one volume of the work, not the work
    return !VOLUME_ONLY.test(long.slice(short.length + 1));
  }
  return titleSimilarity(a, b) >= 0.5;
}
const VOLUME_ONLY = /^((vol|volume|part|book|tome|tomo|band|no|number)\s*)?(\d+|[ivxlc]+)(\s+(of\s+)?(\d+|[ivxlc]+))*$/;

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

/** Bump when matching rules change: every stored match is re-checked under the new rules. */
export const MATCHER_VERSION = 5;

/** Surname without vowels and soft letters, so transliterations agree: Dostoevsky / Dostoyevsky / Dostoievski. */
function surnameSkeleton(s) {
  return s.replace(/[aeiouyjhw]/g, '');
}
export function surnamesAgree(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a[0] !== b[0]) return false;
  const sa = surnameSkeleton(a);
  return sa.length >= 3 && sa === surnameSkeleton(b);
}

/** Every name Open Library gives the work's authors: display names plus alternative names (other scripts, spellings). */
export function providerAuthorNames(doc) {
  return [...(doc?.author_name ?? []), ...(doc?.author_alternative_name ?? [])];
}

/** true / false, or null when either side has no author to compare. */
export function authorsAgree(editionKeys, providerNames) {
  if (!editionKeys.length || !providerNames?.length) return null;
  const want = editionKeys.map((k) => k.split(' ')[0]).filter(Boolean);
  const have = providerNames.map((n) => authorKey(n).split(' ')[0]).filter(Boolean);
  if (!have.length) return null; // only names in scripts we can't compare
  return want.some((w) => have.some((h) => surnamesAgree(w, h)));
}

function hasLatin(s) {
  return /[a-z]/i.test((s ?? '').normalize('NFKD'));
}

/** Title used to query Open Library: main title only, without translator notes, brackets or MARC markers. */
export function searchTitle(title) {
  return cleanTitle(title)
    .split(/\s*[:;]\s*|\s+—\s+|\s+--\s+/)[0]
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s+(rendered|translated|done|englished)\s+(into|from|by)\b.*$/i, '')
    .replace(/,\s*$/, '')
    .trim();
}

/** Reader activity: supporting evidence for choosing between already-identified duplicates, never proof of identity. */
export function readerActivity(doc) {
  return (doc.ratings_count ?? 0) * 10 + (doc.readinglog_count ?? 0);
}

/** Ratings below this are thin evidence: fine for a lone record, not enough to pick between duplicate records. */
export const WELL_SUPPORTED = 5;

/**
 * Picks the work among candidates that ALL passed the identity checks (so every one is a record of this work).
 * Rating counts and reading-log activity only rank them:
 *  - well-supported records (≥ 5 ratings) come first, then by activity (ratings × 10 + reading-log entries);
 *  - a record with 1–4 ratings is accepted only when no other active record exists — a small duplicate is how a
 *    wrong 1-rating "Count of Monte Cristo" got in, while the real work was filed under its French title;
 *  - a record with no ratings is returned as an unrated match (nothing is shown).
 */
function choose(cands) {
  if (!cands.length) return { ok: false, reason: 'no-match' };
  const tier = (d) => ((d.ratings_count ?? 0) >= WELL_SUPPORTED ? 0 : (d.ratings_count ?? 0) > 0 ? 1 : 2);
  const ranked = [...cands].sort((a, b) => tier(a.doc) - tier(b.doc) || readerActivity(b.doc) - readerActivity(a.doc) || b.confidence - a.confidence);
  const [top, ...rest] = ranked;
  if (tier(top.doc) === 1 && rest.some((c) => readerActivity(c.doc) > 0)) return { ok: false, reason: 'weak-among-duplicates' };
  return { ok: true, doc: top.doc, confidence: top.confidence };
}

/**
 * Open Library works that list this Project Gutenberg number. The number is strong evidence but comes from
 * crowd-edited records, so each work must also agree on author (any of its names) and on title — except that a
 * title in another script (the original-language title, e.g. "Преступление и наказание") is accepted when the
 * author agrees, at lower confidence.
 */
export function judgeIdentifierCandidates(edition, docs) {
  const rejected = [];
  const pass = [];
  for (const doc of docs) {
    const authors = authorsAgree(edition.authorKeys, providerAuthorNames(doc));
    if (authors === false) {
      rejected.push('author-mismatch');
      continue;
    }
    const titles = [doc.title ?? '', ...(doc.alternative_title ?? [])];
    const exact = titles.some((t) => mainTitleKey(t) && mainTitleKey(t) === mainTitleKey(edition.title));
    if (exact) pass.push({ doc, confidence: authors ? 0.98 : 0.9 });
    else if (titles.some((t) => sameWorkTitle(edition.title, t))) pass.push({ doc, confidence: authors ? 0.9 : 0.8 });
    else if (authors === true && !hasLatin(doc.title)) pass.push({ doc, confidence: 0.85 });
    else rejected.push('title-mismatch');
  }
  return { ...choose(pass), method: 'gutenberg-id', rejected };
}

/** Kept for single-document checks (tests, diagnostics). */
export function judgeIdentifierMatch(edition, doc) {
  const j = judgeIdentifierCandidates(edition, [doc]);
  return j.ok ? { ok: true, confidence: j.confidence, method: j.method } : { ok: false, reason: j.rejected[0] ?? j.reason };
}

/**
 * Title-and-author search fallback: the work's main title (or an alternative title) must equal the edition's and
 * one of its authors must agree (any of their names); among the works that pass, one must clearly dominate (see choose()).
 */
/**
 * Open Library files some translations as works of their own, listing the translator among the authors
 * ("The Odyssey" by Homer and Emily R. Wilson). For a translated edition, a work that names other people and not
 * this edition's own translator describes another translation. (The main work record often lists many
 * translators, including ours – Ovid's "Ars Amatoria" lists Henry T. Riley – and stays acceptable.)
 */
function namesAnotherTranslator(edition, doc) {
  if (!edition.translators?.length) return false;
  const authors = edition.authorKeys.map((k) => k.split(' ')[0]).filter(Boolean);
  const translators = edition.translators.map((t) => authorKey(t).split(' ')[0]).filter(Boolean);
  const names = (doc.author_name ?? []).map((n) => authorKey(n).split(' ')[0]).filter(Boolean);
  const others = names.filter((s) => !authors.some((a) => surnamesAgree(a, s)));
  if (!others.length) return false;
  return !others.some((s) => translators.some((t) => surnamesAgree(t, s)));
}

/**
 * Languages each (first) author's editions are in, counting only editions that credit no translator — mostly
 * originals. Gutenberg often omits the translator of an English translation ("A Journey to the Centre of the
 * Earth" credits none), so this is how such a translation is recognised.
 */
export function authorLanguageProfile(editions) {
  const profile = new Map();
  for (const e of editions) {
    const a = e.authorKeys?.[0];
    if (!a || e.translators?.length) continue;
    const m = profile.get(a) ?? {};
    m[e.language] = (m[e.language] ?? 0) + 1;
    profile.set(a, m);
  }
  return profile;
}

/**
 * A translation: it credits a translator, or its author's untranslated editions are mostly in another language
 * (at least 3 of them, and more than in this edition's language) – Jules Verne: 44 French, 33 English.
 */
export function isLikelyTranslation(edition, profile) {
  if (edition.translators?.length) return true;
  const m = profile?.get(edition.authorKeys?.[0]);
  if (!m) return false;
  const [lang, n] = Object.entries(m).sort((a, b) => b[1] - a[1])[0];
  return lang !== edition.language && n >= 3 && n > (m[edition.language] ?? 0);
}

/**
 * A stored title-author match with thin evidence (1–4 ratings) for a translation: the pattern of a small
 * English-titled record standing in for a work filed under its original title. Id-linked and well-supported
 * matches are never affected.
 */
export function isThinTranslationMatch(r, translated) {
  return !!translated && r?.m === 'title-author' && r.n > 0 && r.n < WELL_SUPPORTED;
}

export function judgeSearchMatch(edition, docs, { translated = !!edition.translators?.length } = {}) {
  if (!edition.authorKeys.length) return { ok: false, reason: 'no-author' };
  const want = mainTitleKey(searchTitle(edition.title));
  if (want.split(' ').length < 2 && want.length < 6) return { ok: false, reason: 'title-too-generic' };
  // a search is weaker evidence than an id link: the main title must be the same (spacing aside), so
  // "Pride and Prejudice and Zombies" is not "Pride and Prejudice"
  const same = (t) => {
    const k = mainTitleKey(searchTitle(t));
    return !!k && (k === want || k.replace(/ /g, '') === want.replace(/ /g, ''));
  };
  const pass = docs
    .filter((d) => [d.title ?? '', ...(d.alternative_title ?? [])].some(same))
    .filter((d) => authorsAgree(edition.authorKeys, providerAuthorNames(d)) === true)
    .filter((d) => !namesAnotherTranslator(edition, d))
    .map((doc) => ({ doc, confidence: 0.75 }));
  const j = { ...choose(pass), method: 'title-author' };
  // A translation searched by its English title often finds a small English-titled record while the real work is
  // filed under the original title (Das Schloss, Le Comte de Monte-Cristo): thin evidence is not enough there.
  const n = j.doc?.ratings_count ?? 0;
  if (j.ok && translated && n > 0 && n < WELL_SUPPORTED) return { ok: false, reason: 'translation-weak-match', method: 'title-author' };
  return j;
}

/**
 * A work's rating from its editions' stored matches: only matches with real Open Library ratings count, and the
 * best-supported one wins (highest confidence, then most ratings). An unrated match never hides a rated one, and
 * a work with no rated match has no rating.
 */
export function workRating(group, ratings) {
  const best = group
    .map((e) => ({ e, r: ratings[e.key] }))
    .filter((x) => x.r?.w && x.r.n > 0 && x.r.v != null)
    .sort((a, b) => b.r.c - a.r.c || b.r.n - a.r.n)[0];
  if (!best) return undefined;
  const { r, e } = best;
  return { v: Math.round(r.v * 100) / 100, n: r.n, src: 'openlibrary', w: r.w, c: r.c, m: r.m, at: r.at, via: e.key };
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
