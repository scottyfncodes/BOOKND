/** Server-side fetch with a timeout and an honest User-Agent for the public-domain catalogs. */
export async function fetchUpstream(url: string, init: RequestInit & { timeoutMs?: number; revalidate?: number } = {}) {
  const { timeoutMs = 15000, revalidate, ...rest } = init;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...rest,
      signal: ctrl.signal,
      headers: { 'User-Agent': 'BookNd/0.1 (personal e-reader; reader-initiated requests)', ...(rest.headers ?? {}) },
      ...(revalidate !== undefined ? { next: { revalidate } } : { cache: 'no-store' as const }),
    });
  } finally {
    clearTimeout(t);
  }
}
