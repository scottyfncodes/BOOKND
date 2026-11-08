import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { inspectEpub, plainText, resolveZipPath, sha256 } from '@/lib/epub';

const load = (name: string) => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('inspectEpub', () => {
  it('extracts title, author, language, description and the cover', async () => {
    const meta = await inspectEpub(load('pride-test.epub'));
    expect(meta.title).toBe('Pride and Prejudice (BookNd test edition)');
    expect(meta.author).toBe('Jane Austen');
    expect(meta.language).toBe('en');
    expect(meta.publisher).toBe('BookNd fixtures');
    expect(meta.description).toBe('A test edition with chapters , an image and long-form text.');
    expect(meta.cover?.type).toBe('image/png');
    expect(meta.cover?.data.byteLength).toBeGreaterThan(1000);
  });

  it('refuses DRM-protected books', async () => {
    await expect(inspectEpub(load('drm-test.epub'))).rejects.toMatchObject({ code: 'drm' });
  });

  it('refuses files that are not EPUBs', async () => {
    await expect(inspectEpub(load('broken.epub'))).rejects.toMatchObject({ code: 'not-zip' });
  });

  it('hashes bytes stably for duplicate detection', async () => {
    const a = await sha256(load('pride-test.epub'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256(load('pride-test.epub'))).toBe(a);
  });
});

describe('helpers', () => {
  it('resolves paths inside the zip', () => {
    expect(resolveZipPath('OEBPS', '../images/a%20b.png')).toBe('images/a b.png');
    expect(resolveZipPath('', 'cover.jpg#x')).toBe('cover.jpg');
    expect(resolveZipPath('OEBPS/text', './img/c.jpg')).toBe('OEBPS/text/img/c.jpg');
  });
  it('strips markup from descriptions', () => {
    expect(plainText('<p>Hello &amp; <script>x</script>world</p>')).toBe('Hello & x world');
  });
});
