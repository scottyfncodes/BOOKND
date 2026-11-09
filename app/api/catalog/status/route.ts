import { NextResponse } from 'next/server';
import { CatalogUnavailable, getCatalog } from '@/lib/catalog-index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Observability: what the loaded catalog contains and how its last scheduled build went. */
export async function GET() {
  try {
    const { index, meta } = await getCatalog();
    const works = index.entries.length;
    let editions = 0;
    let rated = 0;
    let se = 0;
    for (const e of index.entries) {
      editions += e.w.e.length;
      if (e.w.r) rated++;
      if (e.w.se) se++;
    }
    return NextResponse.json(
      {
        ok: true,
        generatedAt: index.generatedAt,
        loaded: { works, editions, standardEbooksWorks: se, ratedWorks: rated, unratedWorks: works - rated, languages: index.languages.slice(0, 40) },
        build: meta,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=86400' } },
    );
  } catch (err) {
    const message = err instanceof CatalogUnavailable ? err.message : 'Catalog status unavailable.';
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}
