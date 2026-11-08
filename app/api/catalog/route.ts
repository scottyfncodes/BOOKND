import { NextResponse, type NextRequest } from 'next/server';
import { isReadableGutenbergBook, mapGutendex, parseGutenbergBook, parseGutenbergOpds, parseStandardEbooksFeed, type CatalogBook, type CatalogPage } from '@/lib/catalog';
import { CLASSICS_AUTHOR_YEAR_END, GENRES, isCollection, isGenre, matchesSeGenre, type Collection, type GenreId } from '@/lib/browse';
import { fetchUpstream } from '@/lib/fetch-upstream';

export const runtime = 'nodejs';

const SE_FEED = 'https://standardebooks.org/feeds/atom/new-releases';

interface Filters {
  collection: Collection;
  genre: GenreId | null;
}

async function gutendex(q: string, page: number, f: Filters): Promise<CatalogPage> {
  // Gutendex sorts by popularity (downloads) by default, which is what "Fan favorites" means.
  const params = new URLSearchParams({ languages: 'en', mime_type: 'application/epub', copyright: 'false', sort: 'popular', page: String(page) });
  if (q) params.set('search', q);
  if (f.genre) params.set('topic', GENRES[f.genre].gutenberg);
  if (f.collection === 'classics') params.set('author_year_end', String(CLASSICS_AUTHOR_YEAR_END));
  const res = await fetchUpstream(`https://gutendex.com/books/?${params}`, { revalidate: q ? 3600 : 86400, timeoutMs: 9000 });
  if (!res.ok) throw new Error(`Project Gutenberg catalog returned ${res.status}`);
  return mapGutendex(await res.json(), page);
}

/** Project Gutenberg's own OPDS feed: 25 results a page, sorted by popularity. */
async function gutenbergOpds(q: string, page: number, f: Filters): Promise<CatalogPage> {
  const params = new URLSearchParams({ sort_order: 'downloads', start_index: String((page - 1) * 25 + 1) });
  // Gutenberg's search understands "s." for subject; it has no author-era filter, so Classics falls back to popularity.
  const query = [q, f.genre ? `s.${GENRES[f.genre].gutenberg}` : ''].filter(Boolean).join(' ');
  if (query) params.set('query', query);
  const res = await fetchUpstream(`https://www.gutenberg.org/ebooks/search.opds/?${params}`, {
    revalidate: q ? 3600 : 86400,
    headers: { Accept: 'application/atom+xml' },
  });
  if (!res.ok) throw new Error(`Project Gutenberg catalog returned ${res.status}`);
  const result = parseGutenbergOpds(await res.text(), page);
  return { ...result, books: await onlyReadable(result.books) };
}

/**
 * Search results don't say what each title is, so each one's own feed is checked: audiobooks and
 * titles without an EPUB are left out. A book's type never changes, so the lookups are cached for 30 days.
 * If a lookup fails the title is kept (the download explains it if there is no EPUB).
 */
async function onlyReadable(books: CatalogBook[]): Promise<CatalogBook[]> {
  const out: (CatalogBook | null)[] = new Array(books.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < books.length) {
      const i = next++;
      const book = books[i];
      const id = book.key.replace('gutenberg:', '');
      try {
        const res = await fetchUpstream(`https://www.gutenberg.org/ebooks/${id}.opds`, {
          revalidate: 2592000,
          timeoutMs: 8000,
          headers: { Accept: 'application/atom+xml' },
        });
        if (!res.ok) throw new Error(String(res.status));
        const info = parseGutenbergBook(await res.text());
        if (!isReadableGutenbergBook(info)) continue;
        out[i] = { ...book, subjects: info.subjects.length ? info.subjects : book.subjects, language: info.language ?? book.language };
      } catch {
        out[i] = book;
      }
    }
  };
  // a few at a time, to be gentle with Project Gutenberg
  await Promise.all(Array.from({ length: Math.min(6, books.length) }, worker));
  return out.filter((b): b is CatalogBook => b !== null);
}

async function gutenberg(q: string, page: number, f: Filters): Promise<CatalogPage> {
  try {
    return await gutendex(q, page, f);
  } catch {
    return gutenbergOpds(q, page, f);
  }
}

async function seFeed(url: string) {
  const res = await fetchUpstream(url, { revalidate: 21600, headers: { Accept: 'application/atom+xml' } });
  if (!res.ok) throw new Error(`Standard Ebooks feed returned ${res.status}`);
  return parseStandardEbooksFeed(await res.text());
}

async function standardEbooks(q: string, f: Filters): Promise<CatalogPage> {
  let page: CatalogPage;
  const slug = f.genre ? GENRES[f.genre].se : null;
  if (f.genre && !slug) return { books: [], next: null, source: 'standard-ebooks' };
  if (f.genre && slug) {
    try {
      // The whole subject, when Standard Ebooks serves its subject feed…
      page = await seFeed(`https://standardebooks.org/feeds/atom/subjects/${slug}`);
    } catch {
      // …otherwise the newest releases in that subject.
      const latest = await seFeed(SE_FEED);
      page = { ...latest, books: latest.books.filter((b) => matchesSeGenre(b.subjects, f.genre!)) };
    }
  } else {
    page = await seFeed(SE_FEED);
  }
  if (!q) return page;
  const needle = q.toLowerCase();
  return { ...page, books: page.books.filter((b) => `${b.title} ${b.authors.join(' ')}`.toLowerCase().includes(needle)) };
}

export async function GET(req: NextRequest) {
  const source = req.nextUrl.searchParams.get('source') ?? 'gutenberg';
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 120);
  const page = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('page') ?? '1', 10) || 1, 1), 50);
  const list = req.nextUrl.searchParams.get('list');
  const genre = req.nextUrl.searchParams.get('genre');
  const filters: Filters = { collection: isCollection(list) ? list : 'favorites', genre: isGenre(genre) ? genre : null };
  try {
    const data = source === 'standard-ebooks' ? await standardEbooks(q, filters) : await gutenberg(q, page, filters);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' } });
  } catch (err) {
    const name = source === 'standard-ebooks' ? 'Standard Ebooks' : 'Project Gutenberg';
    const message =
      err instanceof Error && /returned \d+/.test(err.message)
        ? `${name} is having trouble right now (${err.message.replace(/^.*returned /, 'error ')}). Please try again shortly.`
        : `Couldn’t reach ${name}. Please try again in a moment.`;
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
