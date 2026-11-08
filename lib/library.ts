import { db, isQuotaError, type Book, type BookSource } from './db';
import { EpubError, inspectEpub, sha256 } from './epub';

export type ImportResult = { status: 'added'; book: Book } | { status: 'duplicate'; book: Book };

export class StorageFullError extends Error {
  constructor() {
    super('Your browser has run out of storage for BookNd. Remove a few books, or export a backup and free some space, then try again.');
    this.name = 'StorageFullError';
  }
}

function newId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Asks the browser to keep BookNd's storage (so books aren't evicted under pressure). Best effort. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) {
      await navigator.storage.persist?.();
    }
  } catch {
    /* not supported */
  }
}

/** Validates, de-duplicates and stores an EPUB. Never uploads anything. */
export async function importEpub(
  bytes: ArrayBuffer,
  opts: { source: BookSource; sourceKey?: string; fallbackTitle?: string; fallbackAuthor?: string } = { source: 'import' },
): Promise<ImportResult> {
  const d = db();
  const hash = await sha256(bytes);
  const existing =
    (await d.books.where('hash').equals(hash).first()) ??
    (opts.sourceKey ? await d.books.where('sourceKey').equals(opts.sourceKey).first() : undefined);
  if (existing) return { status: 'duplicate', book: existing };

  const meta = await inspectEpub(bytes);
  const book: Book = {
    id: newId(),
    title: meta.title === 'Untitled' && opts.fallbackTitle ? opts.fallbackTitle : meta.title,
    author: meta.author === 'Unknown author' && opts.fallbackAuthor ? opts.fallbackAuthor : meta.author,
    language: meta.language,
    description: meta.description,
    publisher: meta.publisher,
    hash,
    size: bytes.byteLength,
    cover: meta.cover ? new Blob([meta.cover.data as BlobPart], { type: meta.cover.type }) : undefined,
    source: opts.source,
    sourceKey: opts.sourceKey,
    addedAt: Date.now(),
    progress: 0,
  };
  try {
    await d.transaction('rw', d.books, d.files, async () => {
      await d.books.add(book);
      await d.files.add({ id: book.id, data: new Blob([bytes], { type: 'application/epub+zip' }) });
    });
  } catch (err) {
    if (isQuotaError(err)) throw new StorageFullError();
    throw err;
  }
  void requestPersistence();
  return { status: 'added', book };
}

export function describeImportError(err: unknown): string {
  if (err instanceof EpubError || err instanceof StorageFullError) return err.message;
  if (isQuotaError(err)) return new StorageFullError().message;
  return 'Something went wrong while adding this book. Please try again.';
}

export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const persisted = (await navigator.storage.persisted?.()) ?? false;
    return { usage, quota, persisted };
  } catch {
    return null;
  }
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
