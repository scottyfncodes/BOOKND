import { NextResponse, type NextRequest } from 'next/server';
import { mapGutendex, parseGutenbergOpds, parseStandardEbooksFeed, type CatalogPage } from '@/lib/catalog';
import { fetchUpstream } from '@/lib/fetch-upstream';

export const runtime = 'nodejs';

const SE_FEED = 'https://standardebooks.org/feeds/atom/new-releases';

async function gutendex(q: string, page: number): Promise<CatalogPage> {
  const params = new URLSearchParams({ languages: 'en', mime_type: 'application/epub', copyright: 'false', page: String(page) });
  if (q) params.set('search', q);
  const res = await fetchUpstream(`https://gutendex.com/books/?${params}`, { revalidate: q ? 3600 : 86400, timeoutMs: 9000 });
  if (!res.ok) throw new Error(`Project Gutenberg catalog returned ${res.status}`);
  return mapGutendex(await res.json(), page);
}

/** Project Gutenberg's own OPDS feed: 25 results a page, sorted by popularity. */
async function gutenbergOpds(q: string, page: number): Promise<CatalogPage> {
  const params = new URLSearchParams({ sort_order: 'downloads', start_index: String((page - 1) * 25 + 1) });
  if (q) params.set('query', q);
  const res = await fetchUpstream(`https://www.gutenberg.org/ebooks/search.opds/?${params}`, {
    revalidate: q ? 3600 : 86400,
    headers: { Accept: 'application/atom+xml' },
  });
  if (!res.ok) throw new Error(`Project Gutenberg catalog returned ${res.status}`);
  return parseGutenbergOpds(await res.text(), page);
}

async function gutenberg(q: string, page: number): Promise<CatalogPage> {
  try {
    return await gutendex(q, page);
  } catch {
    return gutenbergOpds(q, page);
  }
}

async function standardEbooks(q: string): Promise<CatalogPage> {
  const res = await fetchUpstream(SE_FEED, { revalidate: 21600, headers: { Accept: 'application/atom+xml' } });
  if (!res.ok) throw new Error(`Standard Ebooks feed returned ${res.status}`);
  const page = parseStandardEbooksFeed(await res.text());
  if (!q) return page;
  const needle = q.toLowerCase();
  return { ...page, books: page.books.filter((b) => `${b.title} ${b.authors.join(' ')}`.toLowerCase().includes(needle)) };
}

export async function GET(req: NextRequest) {
  const source = req.nextUrl.searchParams.get('source') ?? 'gutenberg';
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 120);
  const page = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('page') ?? '1', 10) || 1, 1), 50);
  try {
    const data = source === 'standard-ebooks' ? await standardEbooks(q) : await gutenberg(q, page);
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
