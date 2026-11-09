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
  cleanTitle,
  judgeIdentifierCandidates,
  judgeIdentifierMatch,
  judgeSearchMatch,
  searchTitle,
  surnamesAgree,
  workRating,
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
      { key: '/works/OL1W', title: 'Pride and Prejudice', author_name: ['Jane Austen'], ratings_count: 416, readinglog_count: 9000 },
      { key: '/works/OL2W', title: 'Pride and Prejudice', author_name: ['Jane Austen'], ratings_count: 28, readinglog_count: 300 },
    ];
    expect(judgeSearchMatch(e, docs)).toMatchObject({ ok: true, confidence: 0.75, doc: { key: '/works/OL1W' } });
    // two well-supported records of the same work: the better-supported one is shown
    expect(judgeSearchMatch(e, [docs[1], { ...docs[0] }]).doc.key).toBe('/works/OL1W');
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

// Shapes below are taken from real Open Library search responses (November 2026).
describe('matching against real Open Library data', () => {
  const jane = pg({ key: 'gutenberg:1260', title: 'Jane Eyre: An Autobiography', authorKeys: ['bronte c'] });
  const janeDocs = [
    { key: '/works/OL1095427W', title: 'Jane Eyre', author_name: ['Charlotte Brontë'], ratings_average: 4.04, ratings_count: 191, readinglog_count: 1504, edition_count: 1170 },
    { key: '/works/OL37840844W', title: 'Jane Eyre', author_name: ['Charlotte Brontë', 'Naunerle C. Farr'], ratings_average: 5, ratings_count: 1, readinglog_count: 9, edition_count: 558 },
    { key: '/works/OL36754933W', title: 'Jane Eyre', author_name: ['Charlotte Brontë'], ratings_average: 4, ratings_count: 1, readinglog_count: 3, edition_count: 85 },
  ];
  it('chooses between duplicates by reader activity, not edition count (Jane Eyre)', () => {
    expect(judgeSearchMatch(jane, janeDocs)).toMatchObject({ ok: true, doc: { key: '/works/OL1095427W' } });
  });
  it('never picks a better-rated work that fails the identity checks', () => {
    const imposter = { key: '/works/OLX', title: 'Jane Eyre: A Graphic Novel', author_name: ['Amy Corzine'], ratings_count: 5000, readinglog_count: 90000 };
    const wrongTitle = { key: '/works/OLY', title: 'Villette', author_name: ['Charlotte Brontë'], ratings_count: 5000, readinglog_count: 90000 };
    expect(judgeSearchMatch(jane, [imposter, wrongTitle, ...janeDocs]).doc.key).toBe('/works/OL1095427W');
  });
  it('matches authors through alternative names and transliterations (War and Peace)', () => {
    const wp = pg({ key: 'gutenberg:2600', title: 'War and Peace', authorKeys: ['tolstoy l'] });
    const docs = [
      { key: '/works/OL267171W', title: 'War and Peace', author_name: ['Лев Толстой'], author_alternative_name: ['Leo Tolstoy', 'Lev Nikolaevich Tolstoi'], ratings_average: 4.23, ratings_count: 43, readinglog_count: 748 },
      { key: '/works/OL36765642W', title: 'War and Peace', author_name: ['Лев Толстой'], author_alternative_name: ['Tolstoj'], ratings_average: 3.75, ratings_count: 4, readinglog_count: 91 },
    ];
    expect(judgeSearchMatch(wp, docs)).toMatchObject({ ok: true, doc: { key: '/works/OL267171W' } });
    expect(surnamesAgree('dostoyevsky', 'dostoievski')).toBe(true);
    expect(surnamesAgree('tolstoy', 'tolstoj')).toBe(true);
    expect(surnamesAgree('austen', 'alston')).toBe(false);
    expect(surnamesAgree('poe', 'pye')).toBe(false); // short names must match exactly
  });
  it('accepts an id-linked work titled in its original script when the author agrees (Crime and Punishment)', () => {
    const cp = pg({ key: 'gutenberg:2554', title: 'Crime and Punishment', authorKeys: ['dostoyevsky f'] });
    const docs = [
      { key: '/works/OL166894W', title: 'Преступление и наказание', author_name: ['Fiódor Dostoievski'], author_alternative_name: ['Fyodor Dostoyevsky'], ratings_average: 4.3, ratings_count: 163, readinglog_count: 3107 },
      { key: '/works/OL46164005W', title: 'Crime and Punishment', author_name: ['Fyodor Dostoyevsky'], ratings_count: 0, readinglog_count: 0 },
    ];
    const j = judgeIdentifierCandidates(cp, docs);
    expect(j).toMatchObject({ ok: true, doc: { key: '/works/OL166894W' }, confidence: 0.85 });
    // …but a Latin-script title that names another book is still rejected
    expect(judgeIdentifierCandidates(cp, [{ ...docs[0], title: 'The Idiot' }]).ok).toBe(false);
    // …and a non-Latin title with a different author is rejected
    expect(judgeIdentifierCandidates(cp, [{ ...docs[0], author_name: ['Лев Толстой'], author_alternative_name: ['Leo Tolstoy'] }]).ok).toBe(false);
  });
  it('rejects small duplicate records instead of guessing (The Count of Monte Cristo)', () => {
    const mc = pg({ key: 'gutenberg:1184', title: 'The Count of Monte Cristo', authorKeys: ['dumas a'] });
    const docs = [
      { key: '/works/OL43161739W', title: 'The Count of Monte Cristo', author_name: ['Alexandre Dumas'], ratings_count: 0, readinglog_count: 13 },
      { key: '/works/OL20201553W', title: 'The Count of Monte Cristo', author_name: ['Alexandre Dumas'], ratings_average: 4, ratings_count: 1, readinglog_count: 3 },
      { key: '/works/OL36277W', title: 'The Count of Monte-Cristo [3/5]', author_name: ['Alexandre Dumas'], ratings_count: 0, readinglog_count: 5 },
      { key: '/works/OL41849988W', title: 'Count of Monte Cristo', author_name: ['Alexandre Dumas'], ratings_average: 5, ratings_count: 1, readinglog_count: 2 },
    ];
    expect(judgeSearchMatch(mc, docs).ok).toBe(false);
    // one clearly dominant small record is still refused while other active duplicates exist
    expect(judgeSearchMatch(mc, [{ ...docs[1], readinglog_count: 400 }, docs[3]]).reason).toBe('weak-among-duplicates');
  });
  it('keeps a valid rating when Open Library has two real records of the same work (Peter Pan, Utilitarianism)', () => {
    const pp = pg({ key: 'gutenberg:16', title: 'Peter Pan: [Peter and Wendy]', authorKeys: ['barrie j'] });
    const docs = [
      { key: '/works/OL462007W', title: 'Peter Pan', author_name: ['J. M. Barrie'], ratings_average: 3.63, ratings_count: 49, readinglog_count: 779 },
      { key: '/works/OL462072W', title: 'Peter Pan', author_name: ['J. M. Barrie'], ratings_average: 3.8, ratings_count: 26, readinglog_count: 196 },
      { key: '/works/OL23017347W', title: 'Peter Pan', author_name: ['J. M. Barrie', 'Pierre Couronne'], ratings_count: 1, readinglog_count: 7 },
    ];
    expect(judgeSearchMatch(pp, docs).doc.key).toBe('/works/OL462007W');
    const u = pg({ key: 'gutenberg:11224', title: 'Utilitarianism', authorKeys: ['mill j'] });
    const udocs = [
      { key: '/works/OL1068228W', title: 'Utilitarianism', author_name: ['John Stuart Mill'], ratings_count: 3, readinglog_count: 36 },
      { key: '/works/OL1068100W', title: 'Utilitarianism', author_name: ['John Stuart Mill'], ratings_average: 4.2, ratings_count: 5, readinglog_count: 106 },
    ];
    expect(judgeSearchMatch(u, udocs).doc.key).toBe('/works/OL1068100W');
  });
  it('refuses thin English-title records for translated editions (The Castle)', () => {
    const castle = pg({ key: 'se:franz-kafka/the-castle', source: 'standard-ebooks', title: 'The Castle', authorKeys: ['kafka f'], translators: ['Willa Muir', 'Edwin Muir'] });
    const doc = { key: '/works/OL29274029W', title: 'The Castle', author_name: ['Franz Kafka'], ratings_average: 4, ratings_count: 1, readinglog_count: 4 };
    expect(judgeSearchMatch(castle, [doc]).reason).toBe('translation-weak-match');
    expect(judgeSearchMatch(castle, [{ ...doc, ratings_count: 40 }]).ok).toBe(true);
    // an untranslated book with a single, lone record keeps its real (small) rating
    expect(judgeSearchMatch(pg({ title: 'Arrowsmith', authorKeys: ['lewis s'] }), [{ key: '/works/OL51147W', title: 'Arrowsmith', author_name: ['Sinclair Lewis'], ratings_average: 3, ratings_count: 1, readinglog_count: 40 }]).ok).toBe(true);
  });
  it("never gives a translation another translation's rating (The Odyssey, Butler vs Wilson)", () => {
    const butler = pg({ key: 'gutenberg:1727', title: 'The Odyssey Rendered into English prose for the use of those who cannot read the original', authorKeys: ['homer'], translators: ['Samuel Butler'] });
    const wilson = { key: '/works/OL17812254W', title: 'The Odyssey', author_name: ['Ὅμηρος', 'Emily R. Wilson'], author_alternative_name: ['Homer'], ratings_average: 3.89, ratings_count: 9, readinglog_count: 69 };
    const homerOnly = { key: '/works/OL26446888W', title: 'The Odyssey', author_name: ['Ὅμηρος'], author_alternative_name: ['Homer'], ratings_average: 4, ratings_count: 1, readinglog_count: 171 };
    expect(judgeSearchMatch(butler, [wilson]).ok).toBe(false);
    // the remaining Homer-only record has a single rating: too thin for a translation
    expect(judgeSearchMatch(butler, [wilson, homerOnly]).ok).toBe(false);
    // the edition's own translator on the work is fine
    const garnett = pg({ title: 'Crime and Punishment', authorKeys: ['dostoyevsky f'], translators: ['Constance Garnett'] });
    expect(judgeSearchMatch(garnett, [{ key: '/works/X', title: 'Crime and Punishment', author_name: ['Fyodor Dostoyevsky', 'Constance Garnett'], ratings_count: 30, readinglog_count: 10 }]).ok).toBe(true);
    expect(judgeSearchMatch(garnett, [{ key: '/works/Y', title: 'Crime and Punishment', author_name: ['Michael R. Katz', 'Фёдор Михайлович Достоевский'], author_alternative_name: ['Dostoyevsky'], ratings_count: 30, readinglog_count: 10 }]).ok).toBe(false);
  });
  it('does not rate a single volume through a title search', () => {
    const vol = pg({ title: 'A Tramp Abroad — Volume 07', authorKeys: ['twain m'] });
    expect(judgeSearchMatch(vol, [{ key: '/works/OL53918W', title: 'A Tramp Abroad', author_name: ['Mark Twain'], ratings_count: 12, readinglog_count: 50 }]).reason).toBe('volume-of-work');
    const play = pg({ title: 'King Henry IV, Part 1', authorKeys: ['shakespeare w'] });
    expect(judgeSearchMatch(play, [{ key: '/works/OL1W', title: 'King Henry IV, Part 1', author_name: ['William Shakespeare'], ratings_count: 12, readinglog_count: 50 }]).ok).toBe(true);
  });
  it('treats volumes as different books and cleans titles for searching', () => {
    expect(searchTitle('The Odyssey Rendered into English prose for the use of those who cannot read the original')).toBe('The Odyssey');
    expect(searchTitle('The Adventures of Sherlock Holmes [12 stories]')).toBe('The Adventures of Sherlock Holmes');
    expect(cleanTitle('The silent Baltic : $b or, Detained near Kiel')).toBe('The silent Baltic: or, Detained near Kiel');
  });
});

describe("a work's rating", () => {
  const ed = (key: string) => pg({ key });
  it('is never hidden by an unrated match with higher confidence (King Henry IV, Part 1)', () => {
    const group = [ed('gutenberg:1516'), ed('gutenberg:1115'), ed('gutenberg:1780')];
    const ratings = {
      'gutenberg:1516': { w: '/works/OL1W', v: 3.83, n: 12, c: 0.9, m: 'gutenberg-id', at: 't' },
      'gutenberg:1115': { w: '/works/OL2W', v: null, n: 0, c: 0.98, m: 'gutenberg-id', at: 't' },
      'gutenberg:1780': { w: '/works/OL3W', v: 0, n: 0, c: 0.98, m: 'gutenberg-id', at: 't' },
    };
    expect(workRating(group, ratings)).toMatchObject({ v: 3.83, n: 12, w: '/works/OL1W', via: 'gutenberg:1516' });
  });
  it('prefers the more certain of two rated matches, and is undefined when nothing is rated', () => {
    const group = [ed('gutenberg:1'), ed('gutenberg:2')];
    expect(
      workRating(group, {
        'gutenberg:1': { w: '/works/A', v: 4, n: 300, c: 0.75, m: 'title-author', at: 't' },
        'gutenberg:2': { w: '/works/B', v: 3.9, n: 40, c: 0.98, m: 'gutenberg-id', at: 't' },
      }),
    ).toMatchObject({ w: '/works/B' });
    expect(workRating(group, { 'gutenberg:1': { w: '/works/A', v: null, n: 0, c: 0.98 } })).toBeUndefined();
    expect(workRating(group, {})).toBeUndefined();
  });
});

describe('search matches need the same main title', () => {
  it('does not take a mash-up that shares an author', () => {
    const e = pg({ title: 'Pride and Prejudice', authorKeys: ['austen j'] });
    const zombies = { key: '/works/OL15093171W', title: 'Pride and Prejudice and Zombies', author_name: ['Seth Grahame-Smith', 'Jane Austen'], ratings_count: 16, readinglog_count: 107 };
    expect(judgeSearchMatch(e, [zombies]).ok).toBe(false);
  });
});
