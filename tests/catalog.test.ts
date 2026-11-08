import { describe, expect, it } from 'vitest';
import { displayName, isAllowedCoverUrl, isAllowedEpubUrl, mapGutendex, parseStandardEbooksFeed } from '@/lib/catalog';

describe('download allow-list (not an open proxy)', () => {
  it.each([
    ['https://www.gutenberg.org/ebooks/1342.epub3.images', true],
    ['https://www.gutenberg.org/ebooks/1342.epub.noimages', true],
    ['https://www.gutenberg.org/cache/epub/1342/pg1342-images-3.epub', true],
    ['https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.epub', true],
    ['http://www.gutenberg.org/ebooks/1342.epub3.images', false],
    ['https://evil.example/ebooks/1342.epub3.images', false],
    ['https://www.gutenberg.org.evil.example/ebooks/1342.epub3.images', false],
    ['https://www.gutenberg.org/../etc/passwd', false],
    ['https://user:pw@www.gutenberg.org/ebooks/1342.epub3.images', false],
    ['https://standardebooks.org/ebooks/x/y/downloads/../../secret.epub', false],
    ['not a url', false],
  ])('%s → %s', (url, ok) => expect(isAllowedEpubUrl(url)).toBe(ok));

  it('allows only catalog cover images', () => {
    expect(isAllowedCoverUrl('https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg')).toBe(true);
    expect(isAllowedCoverUrl('https://standardebooks.org/images/covers/jane-austen_pride-and-prejudice-1a2b3c-cover.jpg')).toBe(true);
    expect(isAllowedCoverUrl('https://example.com/a.jpg')).toBe(false);
  });
});

describe('Gutendex mapping', () => {
  const sample = {
    next: 'https://gutendex.com/books/?page=2',
    results: [
      {
        id: 1342,
        title: 'Pride and Prejudice',
        authors: [{ name: 'Austen, Jane', birth_year: 1775, death_year: 1817 }],
        subjects: ['Courtship -- Fiction', 'England -- Fiction'],
        languages: ['en'],
        copyright: false,
        media_type: 'Text',
        formats: {
          'application/epub+zip': 'https://www.gutenberg.org/ebooks/1342.epub3.images',
          'image/jpeg': 'https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg',
        },
        download_count: 50000,
      },
      { id: 9, title: 'Still in copyright', authors: [], copyright: true, media_type: 'Text', formats: { 'application/epub+zip': 'x' } },
      { id: 10, title: 'Audio', authors: [], copyright: false, media_type: 'Sound', formats: {} },
    ],
  };
  it('keeps public-domain texts with EPUBs and builds safe URLs', () => {
    const page = mapGutendex(sample as unknown as Parameters<typeof mapGutendex>[0], 1);
    expect(page.books).toHaveLength(1);
    const b = page.books[0];
    expect(b.key).toBe('gutenberg:1342');
    expect(b.authors).toEqual(['Jane Austen']);
    expect(b.subjects).toEqual(['Courtship', 'England']);
    expect(b.cover).toBe('/api/cover?url=' + encodeURIComponent('https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg'));
    expect(isAllowedEpubUrl(b.epubUrl)).toBe(true);
    expect(page.next).toBe(2);
  });
  it('formats names', () => {
    expect(displayName('Austen, Jane')).toBe('Jane Austen');
    expect(displayName('Plato')).toBe('Plato');
  });
});

describe('Standard Ebooks feed', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/">
  <title>Standard Ebooks - New Releases</title>
  <entry>
    <id>https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice</id>
    <title>Pride and Prejudice</title>
    <author><name>Jane Austen</name><uri>https://standardebooks.org/ebooks/jane-austen</uri></author>
    <summary type="text">A witty novel of manners.</summary>
    <category scheme="http://purl.org/dc/terms/LCSH" term="Courtship -- Fiction"/>
    <category scheme="https://standardebooks.org/vocab/subjects" term="Fiction" label="Fiction"/>
    <link href="https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice" rel="alternate" title="This ebook’s page at Standard Ebooks" type="application/xhtml+xml"/>
    <link href="https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.epub" rel="enclosure" title="Recommended compatible epub" type="application/epub+zip"/>
    <link href="https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice_advanced.epub" rel="enclosure" type="application/epub+zip"/>
    <link href="https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.kepub.epub" rel="enclosure" type="application/kepub+zip"/>
    <link href="https://standardebooks.org/images/covers/jane-austen_pride-and-prejudice-a1b2c3d4-cover.jpg" rel="http://opds-spec.org/image" type="image/jpeg"/>
  </entry>
  <entry><id>https://standardebooks.org/ebooks/x/no-epub</id><title>No epub</title></entry>
</feed>`;
  it('parses entries and prefers the compatible EPUB', () => {
    const page = parseStandardEbooksFeed(xml);
    expect(page.books).toHaveLength(1);
    const b = page.books[0];
    expect(b.key).toBe('se:jane-austen/pride-and-prejudice');
    expect(b.title).toBe('Pride and Prejudice');
    expect(b.authors).toEqual(['Jane Austen']);
    expect(b.epubUrl).toMatch(/jane-austen_pride-and-prejudice\.epub$/);
    expect(b.subjects).toEqual(['Fiction']);
    expect(b.cover).toContain('/api/cover?url=');
    expect(b.pageUrl).toBe('https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice');
  });
});
