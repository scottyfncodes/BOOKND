import { type NextRequest } from 'next/server';
import { isAllowedEpubUrl } from '@/lib/catalog';
import { fetchUpstream } from '@/lib/fetch-upstream';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_BYTES = 100 * 1024 * 1024;

/**
 * Fetches a public-domain EPUB from an allow-listed catalog URL so the browser can store it.
 * The catalogs don't send CORS headers; this is not an open proxy, and nothing is stored server-side.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url') ?? '';
  if (!isAllowedEpubUrl(url)) return Response.json({ error: 'This download is not from a supported catalog.' }, { status: 400 });
  try {
    let res = await fetchUpstream(url, { timeoutMs: 45000, redirect: 'manual' });
    // Follow redirects only while they stay on allow-listed files.
    for (let hops = 0; res.status >= 300 && res.status < 400 && hops < 4; hops++) {
      const loc = res.headers.get('location');
      const next = loc ? new URL(loc, url).toString() : '';
      if (!isAllowedEpubUrl(next.split('?')[0])) return Response.json({ error: 'The catalog redirected somewhere unexpected.' }, { status: 502 });
      res = await fetchUpstream(next, { timeoutMs: 45000, redirect: 'manual' });
    }
    if (!res.ok || !res.body) return Response.json({ error: `The catalog returned ${res.status}.` }, { status: 502 });
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) return Response.json({ error: 'This book is too large to download.' }, { status: 413 });
    const type = res.headers.get('content-type') ?? '';
    if (/text\/html/i.test(type)) return Response.json({ error: 'The catalog did not return an EPUB file.' }, { status: 502 });
    return new Response(res.body, {
      headers: {
        'Content-Type': 'application/epub+zip',
        ...(len ? { 'Content-Length': String(len) } : {}),
        'Cache-Control': 'public, s-maxage=604800, immutable',
      },
    });
  } catch {
    return Response.json({ error: 'The catalog took too long to answer.' }, { status: 504 });
  }
}
