'use client';
import { useState } from 'react';
import { BookCover } from './BookCover';
import { Sheet } from './Sheet';
import { useToast } from './Toasts';
import { deleteBook, type Book } from '@/lib/db';
import { formatBytes } from '@/lib/library';

const SOURCE: Record<Book['source'], string> = {
  import: 'Imported from this device',
  gutenberg: 'Project Gutenberg (public domain in the USA)',
  'standard-ebooks': 'Standard Ebooks (public domain in the USA)',
  backup: 'Restored from a backup',
};

export function BookDetails({ book, onClose, onOpen }: { book: Book; onClose: () => void; onOpen: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  return (
    <Sheet title={book.title} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '96px 1fr', gap: 20, alignItems: 'start' }}>
        <BookCover cover={book.cover} title={book.title} author={book.author} />
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0 }}>{book.author}</p>
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 14 }}>
            {Math.round((book.progress ?? 0) * 100)}% read · {formatBytes(book.size)}
          </p>
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 14 }}>
            {SOURCE[book.source]}
          </p>
          {book.publisher ? (
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 14 }}>
              {book.publisher}
            </p>
          ) : null}
        </div>
      </div>
      {book.description ? (
        <p className="serif" style={{ fontSize: 15, lineHeight: 1.7, marginTop: 20 }}>
          {book.description}
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 24 }}>
        <button className="btn btn-primary" onClick={onOpen} data-autofocus>
          {(book.progress ?? 0) > 0 ? 'Continue reading' : 'Start reading'}
        </button>
        {confirm ? (
          <button
            className="btn btn-danger"
            onClick={async () => {
              await deleteBook(book.id);
              toast(`Removed “${book.title}”.`);
              onClose();
            }}
          >
            Remove book, bookmarks and highlights
          </button>
        ) : (
          <button className="btn btn-quiet" onClick={() => setConfirm(true)}>
            Remove from library
          </button>
        )}
      </div>
    </Sheet>
  );
}
