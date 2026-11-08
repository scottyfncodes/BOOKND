import { type NextRequest } from 'next/server';
import { isAllowedCoverUrl } from '@/lib/catalog';
import { fetchUpstream } from '@/lib/fetch-upstream';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url') ?? '';
  if (!isAllowedCoverUrl(url)) return new Response('Not found', { status: 404 });
  try {
    const res = await fetchUpstream(url, { timeoutMs: 10000, revalidate: 604800 });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) return new Response('Not found', { status: 404 });
    return new Response(res.body, {
      headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400, s-maxage=2592000, immutable' },
    });
  } catch {
    return new Response('Unavailable', { status: 504 });
  }
}
