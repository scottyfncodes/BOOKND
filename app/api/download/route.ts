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
  // Standard Ebooks serves a "download started" page unless the request says it is the download itself
  // (their own page refreshes to this same URL with ?source=download).
  const target = new URL(url);
  if (target.hostname === 'standardebooks.org') target.searchParams.set('source', 'download');
  try {
    let res = await fetchUpstream(target.toString(), { timeoutMs: 45000, redirect: 'manual' });
    // Follow redirects only while they stay on allow-listed files.
    for (let hops = 0; res.status >= 300 && res.status < 400 && hops < 4; hops++) {
      const loc = res.headers.get('location');
      const next = loc ? new URL(loc, url).toString() : '';
      if (!isAllowedEpubUrl(next.split('?')[0])) return Response.json({ error: 'The catalog redirected somewhere unexpected.' }, { status: 502 });
      res = await fetchUpstream(next, { timeoutMs: 45000, redirect: 'manual' });
    }
    if (res.status === 404) {
      return Response.json({ error: 'This title has no EPUB edition to download (it may be an audiobook). Try another edition.' }, { status: 404 });
    }
    if (!res.ok || !res.body) return Response.json({ error: `The catalog couldn’t send this book right now (error ${res.status}). Please try again.` }, { status: 502 });
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) return Response.json({ error: 'This book is too large to download.' }, { status: 413 });
    // An EPUB is a ZIP: check the signature before streaming, so a web page is never saved as a book.
    const reader = res.body.getReader();
    const first = await reader.read();
    const head = first.value ?? new Uint8Array();
    if (head.length < 2 || head[0] !== 0x50 || head[1] !== 0x4b) {
      await reader.cancel();
      return Response.json({ error: 'The catalog did not return an EPUB file.' }, { status: 502 });
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(head);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel() {
        void reader.cancel();
      },
    });
    return new Response(body, {
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
