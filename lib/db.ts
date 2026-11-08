import Dexie, { type Table } from 'dexie';

export type BookSource = 'import' | 'gutenberg' | 'standard-ebooks' | 'backup';

export interface Book {
  id: string;
  title: string;
  author: string;
  language?: string;
  description?: string;
  publisher?: string;
  /** SHA-256 of the EPUB bytes; used to detect duplicate imports. */
  hash: string;
  size: number;
  cover?: Blob;
  source: BookSource;
  /** Catalog key (e.g. "gutenberg:1342") for books added from Discover. */
  sourceKey?: string;
  addedAt: number;
  lastOpenedAt?: number;
  /** EPUB CFI of the last reading position. */
  location?: string;
  /** 0..1 */
  progress?: number;
  chapter?: string;
  /** Serialized epub.js locations, so progress is accurate on reopen without regenerating. */
  locations?: string;
}

export interface BookFile {
  id: string;
  data: Blob;
}

export interface Bookmark {
  id?: number;
  bookId: string;
  cfi: string;
  label: string;
  progress?: number;
  createdAt: number;
}

export interface Highlight {
  id?: number;
  bookId: string;
  cfi: string;
  text: string;
  color: HighlightColor;
  chapter?: string;
  createdAt: number;
}

export type HighlightColor = 'oxide' | 'sage' | 'stone';

export interface Pref {
  key: string;
  value: unknown;
}

export class BookndDB extends Dexie {
  books!: Table<Book, string>;
  files!: Table<BookFile, string>;
  bookmarks!: Table<Bookmark, number>;
  highlights!: Table<Highlight, number>;
  prefs!: Table<Pref, string>;

  constructor(name = 'booknd') {
    super(name);
    this.version(1).stores({
      books: 'id, hash, sourceKey, addedAt, lastOpenedAt, title, author',
      files: 'id',
      bookmarks: '++id, bookId, [bookId+cfi]',
      highlights: '++id, bookId, [bookId+cfi]',
      prefs: 'key',
    });
  }
}

let instance: BookndDB | null = null;
export function db(): BookndDB {
  if (!instance) instance = new BookndDB();
  return instance;
}

/** True for the browser's "storage is full" errors, whichever layer raised them. */
export function isQuotaError(err: unknown): boolean {
  const e = err as { name?: string; inner?: { name?: string }; message?: string } | null;
  if (!e) return false;
  const names = [e.name, e.inner?.name];
  return names.includes('QuotaExceededError') || /quota/i.test(e.message ?? '');
}

export async function deleteBook(id: string) {
  const d = db();
  await d.transaction('rw', [d.books, d.files, d.bookmarks, d.highlights], async () => {
    await d.books.delete(id);
    await d.files.delete(id);
    await d.bookmarks.where('bookId').equals(id).delete();
    await d.highlights.where('bookId').equals(id).delete();
  });
}

export async function getPref<T>(key: string, fallback: T): Promise<T> {
  const row = await db().prefs.get(key);
  return row ? (row.value as T) : fallback;
}

export async function setPref(key: string, value: unknown) {
  await db().prefs.put({ key, value });
}
