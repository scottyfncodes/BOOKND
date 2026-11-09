import { describe, expect, it } from 'vitest';
import { weightedRating } from '../scripts/catalog/lib.mjs';
import { buildIndex, fold, parseSearchParams, search, type SearchParams, type Snapshot, type SnapshotWork } from '@/lib/catalog-index';

function work(i: number, over: Partial<SnapshotWork> = {}): SnapshotWork {
  return {
    id: `gutenberg:${i}`,
    t: `Book ${i}`,
    a: [`Author ${i % 7}`],
    s: [],
    g: [],
    l: ['en'],
    d: '',
    dl: i,
    se: 0,
    pg: 1,
    e: [{ k: `gutenberg:${i}`, l: 'en', p: `https://www.gutenberg.org/ebooks/${i}`, u: `https://www.gutenberg.org/ebooks/${i}.epub3.images` }],
    ...over,
  };
}
const rating = (v: number, n: number) => ({ v, n, ws: weightedRating(v, n, 0.98, 3.8)!, src: 'openlibrary' as const, w: '/works/OL1W', c: 0.98, m: 'gutenberg-id' as const, at: '2026-11-01T00:00:00Z', via: 'x' });

// 1,000 works; the best-rated, the alphabetically first and the most popular are deliberately far from the start
const works: SnapshotWork[] = Array.from({ length: 1000 }, (_, i) => work(i + 1, i % 3 === 0 ? { r: rating(3.5 + (i % 10) / 10, 10 + i) } : {}));
works[990] = work(991, { t: 'Aaron’s Rod', a: ['D. H. Lawrence'], r: rating(4.9, 5000), g: ['romance'], s: ['Love stories'] });
works[500] = work(501, { t: 'Pride and Prejudice', a: ['Jane Austen'], se: 1, pg: 1, d: 'A novel of manners in Regency England.', g: ['romance'] });
works[200] = work(201, { t: 'Les Misérables', a: ['Victor Hugo'], l: ['fr'], dl: 999999 });
works[700] = work(701, { t: 'Five Perfect Ratings', r: rating(5, 2) });
const snap: Snapshot = { version: 1, generatedAt: '2026-11-09T00:00:00Z', ratingMean: 3.8, works };
const index = buildIndex(snap);
const base: SearchParams = { q: '', field: 'all', genre: null, language: null, source: null, rating: 'any', sort: 'popular', page: 1, per: 24 };
const run = (p: Partial<SearchParams>) => search(index, { ...base, ...p });

describe('full-catalog search', () => {
  it('counts every match and pages through all of them exactly once', () => {
    const first = run({ per: 60 });
    expect(first.total).toBe(1000);
    expect(first.pages).toBe(17);
    const seen = new Set<string>();
    for (let page = 1; page <= first.pages; page++) for (const w of run({ per: 60, page }).works) seen.add(w.id);
    expect(seen.size).toBe(1000);
  });
  it('sorts the whole catalog, not a loaded page', () => {
    expect(run({ sort: 'rating' }).works[0].title).toBe('Aaron’s Rod');
    expect(run({ sort: 'title' }).works[0].title).toBe('Aaron’s Rod');
    expect(run({ sort: 'popular' }).works[0].title).toBe('Les Misérables');
    expect(run({ sort: 'popular', language: 'en' }).works[0].title).not.toBe('Les Misérables');
  });
  it('ranks by the confidence-weighted score, so two perfect ratings don’t top the list', () => {
    const top = run({ sort: 'rating', per: 60 }).works.map((w) => w.title);
    expect(top.slice(0, 10)).not.toContain('Five Perfect Ratings');
    expect(run({ q: 'five perfect' }).works[0].rating?.value).toBe(5); // still shown with its real average
  });
  it('puts unrated works after rated ones in Top rated, and filters them', () => {
    const all = run({ sort: 'rating', per: 60, page: 17 });
    expect(all.works.at(-1)!.rating).toBeNull();
    const unrated = run({ rating: 'unrated' });
    expect(unrated.works.every((w) => w.rating === null)).toBe(true);
    const rated = run({ rating: 'rated' });
    expect(rated.total + unrated.total).toBe(1000);
    expect(run({}).facets).toMatchObject({ rated: rated.total, unrated: unrated.total });
  });
  it('searches title, author, subject and description, by field when asked', () => {
    expect(run({ q: 'pride prejudice', sort: 'relevance' }).works[0].title).toBe('Pride and Prejudice');
    expect(run({ q: 'austen', field: 'author' }).total).toBe(1);
    expect(run({ q: 'austen', field: 'title' }).total).toBe(0);
    expect(run({ q: 'regency', field: 'description' }).total).toBe(1);
    expect(run({ q: 'love', field: 'subject' }).total).toBe(1);
    expect(run({ q: 'miserables' }).total).toBe(1); // accents folded
    expect(run({ q: 'prid' }).total).toBe(1); // word prefixes
    expect(run({ q: 'ride' }).total).toBe(0); // …but not the middle of words
  });
  it('filters by genre, language and source with accurate counts', () => {
    expect(run({ genre: 'romance' }).total).toBe(2);
    expect(run({ language: 'fr' }).total).toBe(1);
    expect(run({ source: 'standard-ebooks' }).total).toBe(1);
    expect(run({}).facets.sources['standard-ebooks']).toBe(1);
  });
  it('shows the rating source and count, and none when there is none', () => {
    const w = run({ q: 'aaron' }).works[0];
    expect(w.rating).toMatchObject({ value: 4.9, count: 5000, source: 'Open Library', url: 'https://openlibrary.org/works/OL1W' });
    expect(run({ q: 'pride' }).works[0].rating).toBeNull();
  });
  it('clamps paging and reads request parameters safely', () => {
    expect(run({ page: 999 }).page).toBe(42);
    const p = parseSearchParams(new URLSearchParams('q=x&sort=evil&per=9999&page=-3&lang=all&rating=unrated&genre=nope&source=x'));
    expect(p).toMatchObject({ sort: 'relevance', per: 60, page: 1, language: null, rating: 'unrated', genre: null, source: null });
    expect(parseSearchParams(new URLSearchParams('q=hello')).sort).toBe('relevance');
    expect(parseSearchParams(new URLSearchParams('')).language).toBe('en');
  });
});

describe('text in every script', () => {
  const idx = buildIndex({
    version: 1,
    generatedAt: 'x',
    ratingMean: 3.8,
    works: [work(1, { t: '西海紀遊草' }), work(2, { t: 'Война и мир', a: ['Лев Толстой'] }), work(3, { t: 'The Odyssey' }), work(4, { t: '$1,000 a Plate' }), work(5, { t: 'Émile' })],
  });
  const s = (p: Partial<SearchParams>) => search(idx, { ...base, ...p });
  it('finds non-Latin titles and authors', () => {
    expect(s({ q: 'война' }).total).toBe(1);
    expect(s({ q: 'толстой', field: 'author' }).total).toBe(1);
    expect(s({ q: '西海紀遊草' }).total).toBe(1);
    expect(s({ q: 'emile' }).total).toBe(1);
  });
  it('sorts numbers and Latin titles first (punctuation and articles ignored), then other scripts', () => {
    expect(s({ sort: 'title' }).works.map((w) => w.title)).toEqual(['$1,000 a Plate', 'Émile', 'The Odyssey', 'Война и мир', '西海紀遊草']);
  });
});

describe('exact-title boost ignores an optional leading article', () => {
  // the commentary has more downloads than the novel, so only the exact-title boost can put the novel first
  const idx = buildIndex({
    version: 1,
    generatedAt: 'x',
    ratingMean: 3.8,
    works: [
      work(1, { t: 'Oscar Wilde, Art and Morality: A Defence of The Picture of Dorian Gray', a: ['Stuart Mason'], dl: 900 }),
      work(2, { t: 'The Picture of Dorian Gray', a: ['Oscar Wilde'], dl: 400 }),
      work(3, { t: 'Christmas Carols and Midsummer Songs', a: ['Various'], dl: 900 }),
      work(4, { t: 'A Christmas Carol', a: ['Charles Dickens'], dl: 300 }),
      work(5, { t: 'Odyssey of a hero', a: ['Someone'], dl: 900 }),
      work(6, { t: 'The Odyssey', a: ['Homer'], dl: 300 }),
      work(7, { t: 'Theory of the Leisure Class', a: ['Thorstein Veblen'], dl: 50 }),
      work(8, { t: 'An Inquiry into the Nature and Causes of the Wealth of Nations', a: ['Adam Smith'], dl: 50 }),
    ],
  });
  const first = (q: string) => search(idx, { ...base, q, sort: 'relevance' }).works[0].title;
  it('ranks the original novel ahead of commentary with or without the article', () => {
    expect(first('picture of dorian gray')).toBe('The Picture of Dorian Gray');
    expect(first('the picture of dorian gray')).toBe('The Picture of Dorian Gray');
    expect(first('christmas carol')).toBe('A Christmas Carol');
    expect(first('a christmas carol')).toBe('A Christmas Carol');
    expect(first('odyssey')).toBe('The Odyssey');
  });
  it('only strips a whole leading article word', () => {
    expect(first('theory of the leisure class')).toBe('Theory of the Leisure Class');
    expect(first('inquiry into the nature')).toBe('An Inquiry into the Nature and Causes of the Wealth of Nations');
  });
  it('keeps the prefix boost and match counts unchanged', () => {
    expect(first('christmas carols')).toBe('Christmas Carols and Midsummer Songs');
    expect(search(idx, { ...base, q: 'picture of dorian gray' }).total).toBe(2);
  });
});

describe('fold fast path', () => {
  // the original, Unicode-only fold: the fast path must give exactly the same result
  const slow = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  it.each([
    'Pride & Prejudice',
    'The “Picture” of Dorian Gray — a novel…',
    'Don’t panic!',
    'Les Misérables',
    'Résumé « naïve » café',
    'Война и мир',
    '源氏物語',
    'ﬁne ligature ½',
    '  ',
    '',
  ])('%j', (s) => expect(fold(s)).toBe(slow(s)));
});
