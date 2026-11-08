import JSZip from 'jszip';
import { db, isQuotaError, type Book, type Bookmark, type Highlight, type Pref } from './db';
import { StorageFullError } from './library';

const FORMAT = 'booknd-backup';
const VERSION = 1;

type BookRecord = Omit<Book, 'cover'> & { coverFile?: string; coverType?: string };

interface Manifest {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  books: BookRecord[];
  bookmarks: Bookmark[];
  highlights: Highlight[];
  prefs: Pref[];
}

/** Builds a .zip with every book, its reading position, bookmarks, highlights and preferences. */
export async function exportBackup(): Promise<Blob> {
  const d = db();
  const zip = new JSZip();
  const books = await d.books.toArray();
  const records: BookRecord[] = [];
  for (const b of books) {
    const { cover, ...rest } = b;
    const rec: BookRecord = { ...rest };
    if (cover) {
      rec.coverFile = `covers/${b.id}`;
      rec.coverType = cover.type;
      zip.file(rec.coverFile, cover);
    }
    const file = await d.files.get(b.id);
    if (file) zip.file(`books/${b.id}.epub`, file.data);
    records.push(rec);
  }
  const manifest: Manifest = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    books: records,
    bookmarks: await d.bookmarks.toArray(),
    highlights: await d.highlights.toArray(),
    prefs: await d.prefs.toArray(),
  };
  zip.file('booknd.json', JSON.stringify(manifest, null, 2));
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

/** Restores a backup. Books already in the library (same file) are kept and not duplicated. */
export async function importBackup(file: Blob): Promise<{ added: number; skipped: number }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error("This file isn't a BookNd backup.");
  }
  const manifestFile = zip.file('booknd.json');
  if (!manifestFile) throw new Error("This file isn't a BookNd backup.");
  const manifest = JSON.parse(await manifestFile.async('string')) as Manifest;
  if (manifest.format !== FORMAT) throw new Error("This file isn't a BookNd backup.");

  const d = db();
  let added = 0;
  let skipped = 0;
  try {
    for (const rec of manifest.books) {
      const exists = (await d.books.get(rec.id)) ?? (await d.books.where('hash').equals(rec.hash).first());
      if (exists) {
        skipped++;
        continue;
      }
      const epub = zip.file(`books/${rec.id}.epub`);
      if (!epub) {
        skipped++;
        continue;
      }
      const { coverFile, coverType, ...book } = rec;
      const coverEntry = coverFile ? zip.file(coverFile) : null;
      const cover = coverEntry ? new Blob([await coverEntry.async('uint8array') as BlobPart], { type: coverType }) : undefined;
      const data = new Blob([await epub.async('uint8array') as BlobPart], { type: 'application/epub+zip' });
      await d.transaction('rw', [d.books, d.files, d.bookmarks, d.highlights], async () => {
        await d.books.add({ ...book, cover });
        await d.files.add({ id: rec.id, data });
        const marks = manifest.bookmarks.filter((m) => m.bookId === rec.id).map(({ id: _id, ...m }) => m);
        const hls = manifest.highlights.filter((h) => h.bookId === rec.id).map(({ id: _id, ...h }) => h);
        if (marks.length) await d.bookmarks.bulkAdd(marks);
        if (hls.length) await d.highlights.bulkAdd(hls);
      });
      added++;
    }
    for (const p of manifest.prefs ?? []) {
      if (!(await d.prefs.get(p.key))) await d.prefs.put(p);
    }
  } catch (err) {
    if (isQuotaError(err)) throw new StorageFullError();
    throw err;
  }
  return { added, skipped };
}
