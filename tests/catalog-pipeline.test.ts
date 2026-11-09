import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GENRES } from '@/lib/browse';
import {
  GENRE_PATTERNS,
  authorKey,
  genresOf,
  groupEditions,
  gutenbergEdition,
  isReadableGutenberg,
  judgeIdentifierMatch,
  judgeSearchMatch,
  parseGutenbergRdf,
  parseStandardEbooksOpf,
  readTar,
  seSlugFromHomepage,
  titleKey,
  toWorkRecord,
  weightedRating,
  type PipelineEdition,
} from '../scripts/catalog/lib.mjs';

const fx = (f: string) => readFileSync(path.join(__dirname, 'fixtures/catalog', f), 'utf8');

function pg(over: Partial<PipelineEdition>): PipelineEdition {
  return {
    key: 'gutenberg:1',
    source: 'gutenberg',
    title: 'T',
    authors: [],
    authorKeys: [],
    translators: [],
    subjects: [],
    genres: [],
    language: 'en',
    description: '',
    issued: '',
    downloads: 0,
    pageUrl: '',
    epubUrl: '',
    gutenbergIds: [1],
    ...over,
  };
}

describe('Project Gutenberg RDF (official bulk catalog record)', () => {
  const rec = parseGutenbergRdf(fx('pg76310.rdf'));
  it('reads the fields Discover needs', () => {
    expect(rec.id).toBe(76310);
    expect(rec.title).toBe('Cindrulino');
    expect(rec.authors).toEqual(['L. Milho']);
    expect(rec.language).toBe('eo');
    expect(rec.types).toEqual(['Text']);
    expect(rec.downloads).toBe(222);
    expect(rec.hasEpub).toBe(true);
    expect(rec.subjects).toContain('Fairy tales');
    expect(rec.bookshelves).toContain('Category: Children & Young Adult Reading');
    expect(rec.summary).toMatch(/^"Cindrulino by L\. Milho"/);
    expect(rec.summary).not.toMatch(/automatically generated/);
    expect(rec.cover).toBe('https://www.gutenberg.org/cache/epub/76310/pg76310.cover.medium.jpg');
  });
  it('lists only readable public-domain text', () => {
    expect(isReadableGutenberg(rec).ok).toBe(true);
    expect(isReadableGutenberg({ ...rec, types: ['Sound'] }).reason).toBe('not-text');
    expect(isReadableGutenberg({ ...rec, hasEpub: false }).reason).toBe('no-epub');
    expect(isReadableGutenberg({ ...rec, rights: 'Copyrighted. Read the copyright notice inside this book for details.' }).reason).toBe('copyrighted');
  });
  it('maps genres and an allow-listed EPUB', () => {
    const e = gutenbergEdition(rec);
    expect(e.genres).toEqual(expect.arrayContaining(['fantasy', 'children']));
    expect(e.epubUrl).toBe('https://www.gutenberg.org/ebooks/76310.epub3.images');
  });
  it('streams records out of a tar.bz2 without unpacking it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rdf-'));
    mkdirSync(path.join(dir, 'cache/epub/76310'), { recursive: true });
    copyFileSync(path.join(__dirname, 'fixtures/catalog/pg76310.rdf'), path.join(dir, 'cache/epub/76310/pg76310.rdf'));
    execFileSync('tar', ['-cf', path.join(dir, 'x.tar'), '-C', dir, 'cache']);
    const names: string[] = [];
    await readTar(createReadStream(path.join(dir, 'x.tar'), { highWaterMark: 1000 }), (n, b) => {
      names.push(n);
      expect(parseGutenbergRdf(b.toString('utf8')).id).toBe(76310);
    });
    expect(names).toEqual(['cache/epub/76310/pg76310.rdf']);
  });
});

describe('Standard Ebooks source (content.opf from its CC0 repository)', () => {
  const pp = parseStandardEbooksOpf(fx('se-pride-and-prejudice.opf'), 'jane-austen/pride-and-prejudice');
  const hound = parseStandardEbooksOpf(fx('se-hound.opf'), 'arthur-conan-doyle/the-hound-of-the-baskervilles');
  it('reads title, author, language, description and the Gutenberg source', () => {
    expect(pp.title).toBe('Pride and Prejudice');
    expect(pp.authors).toEqual(['Jane Austen']);
    expect(pp.authorKeys).toEqual(['austen j']);
    expect(pp.language).toBe('en');
    expect(pp.gutenbergIds).toEqual([42671]);
    expect(pp.description).toMatch(/^Pride and Prejudice may today be one of Jane Austen’s/);
    expect(pp.description).not.toMatch(/<|&lt;/);
    expect(pp.epubUrl).toBe('https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.epub');
    expect(hound.genres).toContain('mystery');
    expect(hound.gutenbergIds).toEqual([2852]);
  });
  it('treats only repositories whose homepage is an ebook page as released', () => {
    expect(seSlugFromHomepage('https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice')).toBe('jane-austen/pride-and-prejudice');
    expect(seSlugFromHomepage('https://standardebooks.org/ebooks/leo-tolstoy/war-and-peace/louise-maude_aylmer-maude')).toBe('leo-tolstoy/war-and-peace/louise-maude_aylmer-maude');
    expect(seSlugFromHomepage('https://standardebooks.org')).toBeNull();
    expect(seSlugFromHomepage('')).toBeNull();
    expect(seSlugFromHomepage('https://evil.example/ebooks/a/b')).toBeNull();
  });
});

describe('genres', () => {
  it('uses the same ids as Discover', () => expect(Object.keys(GENRE_PATTERNS).sort()).toEqual(Object.keys(GENRES).sort()));
  it('matches on whole words', () => {
    expect(genresOf(['Detective and mystery stories'])).toContain('mystery');
    expect(genresOf(['Universe'])).toEqual([]);
    expect(genresOf(['Category: Science-Fiction & Fantasy'])).toEqual(expect.arrayContaining(['science-fiction', 'fantasy']));
  });
});

describe('grouping editions into works', () => {
  const se = parseStandardEbooksOpf(fx('se-pride-and-prejudice.opf'), 'jane-austen/pride-and-prejudice');
  it('normalises titles and authors', () => {
    expect(titleKey('Frankenstein; Or, The Modern Prometheus')).toBe('frankenstein');
    expect(titleKey('The Adventures of Tom Sawyer, Part 1.')).toBe('adventures of tom sawyer part 1');
    expect(authorKey('Austen, Jane')).toBe('austen j');
    expect(authorKey('Jane Austen')).toBe('austen j');
    expect(authorKey('Anonymous')).toBe('');
  });
  it('puts the Standard Ebooks edition first and joins its Gutenberg sources and same-title transcriptions', () => {
    const a = pg({ key: 'gutenberg:42671', title: 'Pride and Prejudice', authorKeys: ['austen j'], gutenbergIds: [42671], downloads: 900 });
    const b = pg({ key: 'gutenberg:1342', title: 'Pride and Prejudice', authorKeys: ['austen j'], gutenbergIds: [1342], downloads: 50000 });
    const fr = pg({ key: 'gutenberg:9', title: 'Pride and Prejudice', authorKeys: ['austen j'], language: 'fr' });
    const groups = groupEditions([b, se, a, fr]);
    const main = groups.find((g) => g.some((e) => e.key === se.key))!;
    expect(main.map((e) => e.key)).toEqual([se.key, 'gutenberg:1342', 'gutenberg:42671']);
    expect(groups.find((g) => g[0].key === 'gutenberg:9')).toHaveLength(1); // other language stays separate
  });
  it('keeps different volumes, different authors and generic anonymous titles apart', () => {
    const g = groupEditions([
      pg({ key: 'gutenberg:1', title: 'Poems, Series One', authorKeys: ['dickinson e'] }),
      pg({ key: 'gutenberg:2', title: 'Poems, Series Two', authorKeys: ['dickinson e'] }),
      pg({ key: 'gutenberg:3', title: 'Poems', authorKeys: ['keats j'] }),
      pg({ key: 'gutenberg:4', title: 'Poems', authorKeys: ['shelley p'] }),
      pg({ key: 'gutenberg:5', title: 'Letters', authorKeys: [] }),
      pg({ key: 'gutenberg:6', title: 'Letters', authorKeys: [] }),
    ]);
    expect(g).toHaveLength(6);
  });
  it('merges editions an identifier-matched provider files under one work', () => {
    const g = groupEditions(
      [pg({ key: 'gutenberg:1', title: 'The Iliad', authorKeys: ['homer'] }), pg({ key: 'gutenberg:2', title: 'The Iliad of Homer', authorKeys: ['homer'] })],
      () => '/works/OL1W',
    );
    expect(g).toHaveLength(1);
  });
  it('builds a compact work record', () => {
    const w = toWorkRecord([se, pg({ key: 'gutenberg:1342', title: 'Pride and Prejudice', downloads: 5 })]);
    expect(w).toMatchObject({ id: se.key, t: 'Pride and Prejudice', se: 1, pg: 1, dl: 5, l: ['en'] });
    expect(w.e).toHaveLength(2);
    expect(w.r).toBeUndefined();
  });
});

describe('rating matches (work-level, never guessed)', () => {
  const e = pg({ title: 'Pride and Prejudice', authorKeys: ['austen j'] });
  it('accepts an identifier match whose title and author agree', () => {
    expect(judgeIdentifierMatch(e, { title: 'Pride and Prejudice', author_name: ['Jane Austen'] })).toMatchObject({ ok: true, confidence: 0.98 });
    expect(judgeIdentifierMatch(e, { title: 'Pride & Prejudice: An Annotated Edition', author_name: ['Jane Austen'] }).ok).toBe(true);
  });
  it('rejects an identifier match with the wrong title or author', () => {
    expect(judgeIdentifierMatch(e, { title: 'Emma', author_name: ['Jane Austen'] })).toMatchObject({ ok: false, reason: 'title-mismatch' });
    expect(judgeIdentifierMatch(e, { title: 'Pride and Prejudice and Zombies', author_name: ['Seth Grahame-Smith'] })).toMatchObject({ ok: false, reason: 'author-mismatch' });
  });
  it('accepts a title/author search only for an exact, unambiguous match', () => {
    const docs = [
      { key: '/works/OL1W', title: 'Pride and Prejudice', author_name: ['Jane Austen'], edition_count: 900 },
      { key: '/works/OL2W', title: 'Pride and Prejudice', author_name: ['Jane Austen'], edition_count: 3 },
    ];
    expect(judgeSearchMatch(e, docs)).toMatchObject({ ok: true, confidence: 0.75 });
    expect(judgeSearchMatch(e, [docs[0], { ...docs[1], edition_count: 500 }]).reason).toBe('ambiguous');
    expect(judgeSearchMatch(e, [{ ...docs[0], title: 'Pride and Prejudice and Zombies' }]).reason).toBe('no-match');
    expect(judgeSearchMatch(pg({ title: 'Poems', authorKeys: ['keats j'] }), docs).reason).toBe('title-too-generic');
    expect(judgeSearchMatch(pg({ title: 'Pride and Prejudice' }), docs).reason).toBe('no-author');
  });
  it('weights ratings by count and confidence, and never invents one', () => {
    expect(weightedRating(null, 0, 1, 3.8)).toBeNull();
    expect(weightedRating(4.5, 0, 1, 3.8)).toBeNull();
    const few = weightedRating(5, 2, 1, 3.8)!;
    const many = weightedRating(4.5, 2000, 1, 3.8)!;
    expect(many).toBeGreaterThan(few); // 2 perfect ratings don't beat 2,000 strong ones
    expect(weightedRating(4.5, 100, 0.75, 3.8)!).toBeLessThan(weightedRating(4.5, 100, 0.98, 3.8)!);
  });
});

describe('collections and crowd-edited works do not swallow separate books', () => {
  it('links a Standard Ebooks collection only to the cited source with the same title', () => {
    const dialogues = pg({ key: 'se:plato/dialogues/benjamin-jowett', source: 'standard-ebooks', title: 'Dialogues', authorKeys: ['plato'], gutenbergIds: [1497, 1656, 9999] });
    const groups = groupEditions([
      dialogues,
      pg({ key: 'gutenberg:1497', title: 'The Republic', authorKeys: ['plato'], gutenbergIds: [1497] }),
      pg({ key: 'gutenberg:1656', title: 'Apology', authorKeys: ['plato'], gutenbergIds: [1656] }),
      pg({ key: 'gutenberg:9999', title: 'Dialogues', authorKeys: ['plato'], gutenbergIds: [9999] }),
    ]);
    expect(groups.find((g) => g[0].key === dialogues.key)!.map((e) => e.key)).toEqual([dialogues.key, 'gutenberg:9999']);
    expect(groups).toHaveLength(3);
  });
  it('treats spacing and hyphenation variants as the same title', () => {
    const se = pg({ key: 'se:x/the-powerhouse', source: 'standard-ebooks', title: 'The Powerhouse', authorKeys: ['buchan j'], gutenbergIds: [7] });
    expect(groupEditions([se, pg({ key: 'gutenberg:7', title: 'The Power-House', authorKeys: ['buchan j'], gutenbergIds: [7] })])).toHaveLength(1);
  });
  it('ignores a provider work that lumps differently titled books together', () => {
    const g = groupEditions(
      [pg({ key: 'gutenberg:1', title: 'Euthyphro', authorKeys: ['plato'] }), pg({ key: 'gutenberg:2', title: 'Crito', authorKeys: ['plato'] })],
      () => '/works/OL1W',
    );
    expect(g).toHaveLength(2);
  });
});
