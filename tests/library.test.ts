import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db, deleteBook } from '@/lib/db';
import { importEpub } from '@/lib/library';
import { exportBackup, importBackup } from '@/lib/backup';

const load = (name: string) => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('library storage', () => {
  it('imports once, detects duplicates, and stores the file locally', async () => {
    const first = await importEpub(load('pride-test.epub'), { source: 'import' });
    expect(first.status).toBe('added');
    const again = await importEpub(load('pride-test.epub'), { source: 'import' });
    expect(again.status).toBe('duplicate');
    expect(again.book.id).toBe(first.book.id);
    expect(await db().books.count()).toBe(1);
    const file = await db().files.get(first.book.id);
    expect(file?.data.size).toBe(load('pride-test.epub').byteLength);
    expect(first.book.cover?.type).toBe('image/png');
  });

  it('rejects DRM books without storing anything', async () => {
    await expect(importEpub(load('drm-test.epub'), { source: 'import' })).rejects.toMatchObject({ code: 'drm' });
    expect(await db().books.count()).toBe(1);
  });

  it('round-trips a backup with progress, bookmarks and highlights', async () => {
    const book = (await db().books.toArray())[0];
    await db().books.update(book.id, { location: 'epubcfi(/6/4!/4/2/1:0)', progress: 0.42 });
    await db().bookmarks.add({ bookId: book.id, cfi: 'epubcfi(/6/4!/4/2/1:0)', label: 'It is a truth', createdAt: 1 });
    await db().highlights.add({ bookId: book.id, cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:20)', text: 'It is a truth', color: 'oxide', createdAt: 2 });
    const blob = await exportBackup();
    await deleteBook(book.id);
    expect(await db().books.count()).toBe(0);
    expect(await db().highlights.count()).toBe(0);
    const res = await importBackup(blob);
    expect(res).toEqual({ added: 1, skipped: 0 });
    const restored = await db().books.get(book.id);
    expect(restored?.progress).toBe(0.42);
    expect(restored?.location).toBe('epubcfi(/6/4!/4/2/1:0)');
    expect(await db().bookmarks.where('bookId').equals(book.id).count()).toBe(1);
    expect(await db().highlights.where('bookId').equals(book.id).count()).toBe(1);
    expect((await db().files.get(book.id))?.data.size).toBe(load('pride-test.epub').byteLength);
    expect((await importBackup(blob)).skipped).toBe(1);
  });
});
