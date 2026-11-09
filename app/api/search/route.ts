import { NextResponse, type NextRequest } from 'next/server';
import { CatalogUnavailable, getCatalog, parseSearchParams, search } from '@/lib/catalog-index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Full-catalog search: every filter, count, sort and page is computed over the whole unified catalog
 * (Project Gutenberg + Standard Ebooks, editions grouped into works), never over a loaded page.
 *
 *   /api/search/?q=&in=all|title|author|subject|description&genre=&lang=en|all&source=&rating=any|rated|unrated
 *               &sort=relevance|popular|rating|title|author|newest&page=1&per=24
 */
export async function GET(req: NextRequest) {
  const params = parseSearchParams(req.nextUrl.searchParams);
  try {
    const { index } = await getCatalog();
    const result = search(index, params);
    // the catalog changes once a day: serve a cached answer at once and refresh it in the background, so a
    // visitor never waits on a cold server for a page someone has asked for within the last day
    return NextResponse.json(result, { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=86400' } });
  } catch (err) {
    if (err instanceof CatalogUnavailable) {
      return NextResponse.json({ error: 'The full catalog is still loading. Please try again in a moment.', unavailable: true }, { status: 503 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Search failed. Please try again.' }, { status: 500 });
  }
}
