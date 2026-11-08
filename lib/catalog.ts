import { DOMParser } from '@xmldom/xmldom';

/** A public-domain title from a catalog, as shown in Discover. */
export interface CatalogBook {
  /** Stable key, e.g. "gutenberg:1342" or "se:jane-austen/pride-and-prejudice". */
  key: string;
  source: 'gutenberg' | 'standard-ebooks';
  title: string;
  authors: string[];
  summary?: string;
  subjects: string[];
  language?: string;
  /** Proxied through /api/cover so no third-party requests leave the page. */
  cover?: string;
  /** The catalog's own page for attribution. */
  pageUrl: string;
  /** The EPUB to download (validated again by /api/download). */
  epubUrl: string;
  downloads?: number;
}

export interface CatalogPage {
  books: CatalogBook[];
  next?: number | null;
  source: CatalogBook['source'];
}

const GUTENBERG_HOST = 'www.gutenberg.org';
const SE_HOST = 'standardebooks.org';

/** Only these files may be fetched through BookNd's download proxy: it is not an open proxy. */
export function isAllowedEpubUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  if (u.hostname === GUTENBERG_HOST) {
    return (
      /^\/ebooks\/\d{1,6}\.epub3?\.(no)?images$/.test(u.pathname) ||
      /^\/cache\/epub\/\d{1,6}\/pg\d{1,6}(-images)?(-3)?\.epub$/.test(u.pathname)
    );
  }
  if (u.hostname === SE_HOST) {
    return /^\/ebooks\/[a-z0-9-]+(\/[a-z0-9-]+){1,4}\/downloads\/[a-z0-9_-]+\.epub$/.test(u.pathname);
  }
  return false;
}

export function isAllowedCoverUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  if (u.hostname === GUTENBERG_HOST) return /^\/cache\/epub\/\d{1,6}\/pg\d{1,6}\.cover\.(medium|small)\.jpg$/.test(u.pathname);
  if (u.hostname === SE_HOST) return /^\/(images\/covers|ebooks)\/[a-z0-9/_.@-]+\.(jpg|jpeg|png|avif|webp)$/.test(u.pathname) && !u.pathname.includes('..');
  return false;
}

export function coverProxy(url: string | undefined) {
  return url && isAllowedCoverUrl(url) ? `/api/cover?url=${encodeURIComponent(url)}` : undefined;
}

/** Gutendex author names are "Last, First"; show them the way a reader expects. */
export function displayName(name: string) {
  const m = name.match(/^([^,]+),\s*(.+?)(\s*\(.*\))?$/);
  return m ? `${m[2]} ${m[1]}`.replace(/\s+/g, ' ').trim() : name.trim();
}

interface GutendexBook {
  id: number;
  title: string;
  authors?: { name: string }[];
  subjects?: string[];
  bookshelves?: string[];
  languages?: string[];
  copyright?: boolean | null;
  media_type?: string;
  formats?: Record<string, string>;
  download_count?: number;
  summaries?: string[];
}

/** Maps a Gutendex response, keeping only US public-domain texts that have an EPUB. */
export function mapGutendex(json: { results?: GutendexBook[]; next?: string | null }, page: number): CatalogPage {
  const books: CatalogBook[] = [];
  for (const b of json.results ?? []) {
    if (b.copyright !== false || (b.media_type && b.media_type !== 'Text')) continue;
    const formats = b.formats ?? {};
    const hasEpub = Object.keys(formats).some((k) => k.startsWith('application/epub+zip'));
    if (!hasEpub) continue;
    books.push({
      key: `gutenberg:${b.id}`,
      source: 'gutenberg',
      title: b.title.replace(/\s+/g, ' ').trim(),
      authors: (b.authors ?? []).map((a) => displayName(a.name)),
      summary: b.summaries?.[0]?.replace(/\s*\(This is an automatically generated summary\.\)\s*$/i, ''),
      subjects: [...(b.subjects ?? [])].slice(0, 4).map((s) => s.split(' -- ')[0]),
      language: b.languages?.[0],
      cover: coverProxy(formats['image/jpeg']?.replace('.cover.small.', '.cover.medium.')),
      pageUrl: `https://${GUTENBERG_HOST}/ebooks/${b.id}`,
      epubUrl: `https://${GUTENBERG_HOST}/ebooks/${b.id}.epub3.images`,
      downloads: b.download_count,
    });
  }
  return { books, next: json.next ? page + 1 : null, source: 'gutenberg' };
}

function el(doc: Document | Element, tag: string): Element[] {
  return Array.from(doc.getElementsByTagName(tag) as unknown as ArrayLike<Element>);
}
function txt(e: Element | undefined) {
  return (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Parses Standard Ebooks' public Atom/OPDS feed into catalog books. */
export function parseStandardEbooksFeed(xml: string): CatalogPage {
  const doc = new DOMParser({ errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} } }).parseFromString(
    xml,
    'application/xml',
  );
  const books: CatalogBook[] = [];
  for (const entry of el(doc, 'entry')) {
    const id = txt(el(entry, 'id')[0]);
    const links = el(entry, 'link').map((l) => ({
      rel: l.getAttribute('rel') ?? '',
      type: l.getAttribute('type') ?? '',
      href: new URL(l.getAttribute('href') ?? '', `https://${SE_HOST}/`).toString(),
    }));
    const epubs = links.filter((l) => l.type.startsWith('application/epub+zip') && isAllowedEpubUrl(l.href.split('?')[0]));
    // The "compatible" EPUB works in the most readers; avoid the kepub and advanced variants when possible.
    const epub =
      epubs.find((l) => !/_advanced\.epub|\.kepub/.test(l.href)) ?? epubs.find((l) => !/\.kepub/.test(l.href)) ?? epubs[0];
    if (!epub) continue;
    const image =
      links.find((l) => l.rel === 'http://opds-spec.org/image') ??
      links.find((l) => l.rel === 'http://opds-spec.org/image/thumbnail') ??
      links.find((l) => l.type.startsWith('image/'));
    const page = links.find((l) => l.rel === 'alternate' && l.type.includes('html'))?.href ?? (id.startsWith('http') ? id : undefined);
    const slug = new URL(epub.href).pathname.replace(/^\/ebooks\//, '').replace(/\/downloads\/.*$/, '');
    const thumb = el(entry, 'media:thumbnail')[0]?.getAttribute('url') ?? undefined;
    // Every Standard Ebooks release publishes its cover next to its downloads.
    const coverUrl =
      [image?.href, thumb && new URL(thumb, `https://${SE_HOST}/`).toString()].map((u) => u?.split('?')[0]).find((u) => u && isAllowedCoverUrl(u)) ??
      `https://${SE_HOST}/ebooks/${slug}/downloads/cover-thumbnail.jpg`;
    books.push({
      key: `se:${slug}`,
      source: 'standard-ebooks',
      title: txt(el(entry, 'title')[0]),
      authors: el(entry, 'author').map((a) => txt(el(a, 'name')[0])).filter(Boolean),
      summary: txt(el(entry, 'summary')[0]) || undefined,
      subjects: (() => {
        const cats = el(entry, 'category');
        // Standard Ebooks' own subject vocabulary reads best; fall back to library subject headings.
        const own = cats.filter((c) => (c.getAttribute('scheme') ?? '').includes('standardebooks.org'));
        const list = (own.length ? own : cats).map((c) => (c.getAttribute('label') || c.getAttribute('term') || '').split(' -- ')[0].trim());
        return [...new Set(list.filter((s) => s && !/^https?:/.test(s)))].slice(0, 4);
      })(),
      language: txt(el(entry, 'dc:language')[0]) || undefined,
      cover: coverProxy(coverUrl),
      pageUrl: page ?? `https://${SE_HOST}/ebooks/${slug}`,
      epubUrl: epub.href.split('?')[0],
    });
  }
  return { books, next: null, source: 'standard-ebooks' };
}

/**
 * Parses Project Gutenberg's official OPDS search feed (used when Gutendex is unavailable).
 * Entries link to /ebooks/<id>.opds; covers and EPUBs follow Gutenberg's stable URL scheme.
 */
export function parseGutenbergOpds(xml: string, page: number): CatalogPage {
  const doc = new DOMParser({ errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} } }).parseFromString(
    xml,
    'application/xml',
  );
  const books: CatalogBook[] = [];
  const seen = new Set<string>();
  for (const entry of el(doc, 'entry')) {
    const hrefs = [txt(el(entry, 'id')[0]), ...el(entry, 'link').map((l) => l.getAttribute('href') ?? '')];
    const idMatch = hrefs.map((h) => h.match(/\/ebooks\/(\d{1,6})(?:\.opds)?$/)).find(Boolean);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const content = txt(el(entry, 'content')[0]);
    const author = el(entry, 'author').map((a) => txt(el(a, 'name')[0])).find(Boolean) || (content && !/downloads?$/i.test(content) ? content : '');
    books.push({
      key: `gutenberg:${id}`,
      source: 'gutenberg',
      title: txt(el(entry, 'title')[0]),
      authors: author ? [displayName(author)] : [],
      subjects: [],
      cover: coverProxy(`https://${GUTENBERG_HOST}/cache/epub/${id}/pg${id}.cover.medium.jpg`),
      pageUrl: `https://${GUTENBERG_HOST}/ebooks/${id}`,
      epubUrl: `https://${GUTENBERG_HOST}/ebooks/${id}.epub3.images`,
    });
  }
  const hasNext = el(doc, 'link').some((l) => l.getAttribute('rel') === 'next');
  return { books, next: hasNext ? page + 1 : null, source: 'gutenberg' };
}
