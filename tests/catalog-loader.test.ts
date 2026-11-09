import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogUnavailable, _expireCheckForTests, _resetLoaderForTests, _settleForTests, getCatalog, type Snapshot } from '@/lib/catalog-index';

const snap = (generatedAt: string, n = 3): Snapshot => ({
  version: 1,
  generatedAt,
  ratingMean: 3.8,
  works: Array.from({ length: n }, (_, i) => ({
    id: `gutenberg:${i}`,
    t: `Book ${i}`,
    a: ['A'],
    s: [],
    g: [],
    l: ['en'],
    d: '',
    dl: i,
    se: 0,
    pg: 1,
    e: [{ k: `gutenberg:${i}`, l: 'en', p: 'https://www.gutenberg.org/ebooks/1', u: 'https://www.gutenberg.org/ebooks/1.epub3.images' }],
  })),
});

/** A fake GitHub release: each path answers from a queue of statuses, then the current body. */
function release(state: { generatedAt: string; n?: number; queue: Record<string, (number | 'timeout')[]> }) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split('/').pop()!;
    calls.push(path);
    const next = state.queue[path]?.shift();
    if (next === 'timeout') {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    if (typeof next === 'number' && next !== 200) return new Response('Gateway Timeout', { status: next });
    if (path === 'meta.json') return new Response(JSON.stringify({ generatedAt: state.generatedAt }));
    return new Response(gzipSync(JSON.stringify(snap(state.generatedAt, state.n))));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

beforeEach(() => _resetLoaderForTests({ backoffMs: [5, 5], metaTimeoutMs: 50, catalogTimeoutMs: 50 }));
afterEach(() => vi.unstubAllGlobals());

describe('catalog loading survives transient GitHub failures', () => {
  it('retries 504s on a cold start and loads the catalog', async () => {
    const r = release({ generatedAt: 'A', queue: { 'meta.json': [504], 'catalog.json.gz': [504, 504] } });
    const { index } = await getCatalog();
    expect(index.entries).toHaveLength(3);
    expect(r.calls.filter((c) => c === 'catalog.json.gz')).toHaveLength(3);
  });
  it('loads the catalog directly when meta.json stays unreachable on a cold start', async () => {
    release({ generatedAt: 'A', queue: { 'meta.json': [504, 504, 504] } });
    expect((await getCatalog()).index.generatedAt).toBe('A');
  });
  it('retries timeouts', async () => {
    release({ generatedAt: 'A', queue: { 'catalog.json.gz': ['timeout'] } });
    expect((await getCatalog()).index.generatedAt).toBe('A');
  });
  it('gives up after a bounded number of attempts and says the catalog is unavailable', async () => {
    const r = release({ generatedAt: 'A', queue: { 'meta.json': [504, 504, 504], 'catalog.json.gz': [504, 504, 504] } });
    await expect(getCatalog()).rejects.toBeInstanceOf(CatalogUnavailable);
    expect(r.calls).toHaveLength(6);
  });
  it('keeps serving the loaded catalog when a refresh fails, and picks up a new build afterwards', async () => {
    const state = { generatedAt: 'A', n: 3, queue: {} as Record<string, (number | 'timeout')[]> };
    release(state);
    expect((await getCatalog()).index.generatedAt).toBe('A');
    // a new build is published, but GitHub is failing
    state.generatedAt = 'B';
    state.n = 5;
    state.queue = { 'meta.json': [504, 504, 504] };
    _expireCheckForTests();
    expect((await getCatalog()).index.generatedAt).toBe('A'); // served from memory while the refresh runs
    await _settleForTests();
    expect((await getCatalog()).index.generatedAt).toBe('A'); // still the last good catalog, never empty
    // GitHub recovers: the next check loads the new build
    _expireCheckForTests();
    await getCatalog();
    await _settleForTests();
    const { index } = await getCatalog();
    expect(index.generatedAt).toBe('B');
    expect(index.entries).toHaveLength(5);
  });
  it('keeps the old catalog if the new one fails to download midway', async () => {
    const state = { generatedAt: 'A', queue: {} as Record<string, (number | 'timeout')[]> };
    release(state);
    await getCatalog();
    state.generatedAt = 'B';
    state.queue = { 'catalog.json.gz': [504, 502, 503] };
    _expireCheckForTests();
    await getCatalog();
    await _settleForTests();
    expect((await getCatalog()).index.generatedAt).toBe('A');
  });
});
