'use client';
import { useState } from 'react';
import { Sheet } from '../Sheet';
import { IconTrash } from '../Icons';
import { db, type Bookmark, type Highlight } from '@/lib/db';
import { useLive } from '@/lib/hooks';
import { HIGHLIGHT_FILL } from '@/lib/reader-prefs';

export function NotesSheet({
  bookId,
  bookmarks,
  onDeleteBookmark,
  onDeleteHighlight,
  onPick,
  onClose,
}: {
  bookId: string;
  bookmarks: Bookmark[];
  onDeleteBookmark: (b: Bookmark) => void;
  onDeleteHighlight: (h: Highlight) => void;
  onPick: (cfi: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'highlights' | 'bookmarks'>('highlights');
  const highlights = useLive(() => db().highlights.where('bookId').equals(bookId).sortBy('createdAt'), [bookId], []) ?? [];
  const marks = [...bookmarks].sort((a, b) => (a.progress ?? 0) - (b.progress ?? 0));
  return (
    <Sheet title="Notes" onClose={onClose} side>
      <div className="seg" role="tablist" aria-label="Notes" style={{ marginBottom: 12 }}>
        <button role="tab" aria-selected={tab === 'highlights'} onClick={() => setTab('highlights')} data-autofocus>
          Highlights ({highlights.length})
        </button>
        <button role="tab" aria-selected={tab === 'bookmarks'} onClick={() => setTab('bookmarks')}>
          Bookmarks ({marks.length})
        </button>
      </div>
      {tab === 'highlights' ? (
        highlights.length ? (
          <ul className="list">
            {highlights.map((h) => (
              <li key={h.id} className="note-row">
                <button className="row-btn" onClick={() => onPick(h.cfi)}>
                  <span className="note-swatch" style={{ background: HIGHLIGHT_FILL[h.color] }} aria-hidden="true" />
                  <span style={{ minWidth: 0 }}>
                    <span className="serif clamp-3" style={{ fontSize: 14, lineHeight: 1.55 }}>
                      {h.text}
                    </span>
                    {h.chapter ? <small className="muted clamp-1" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>{h.chapter}</small> : null}
                  </span>
                </button>
                <button className="icon-btn" onClick={() => onDeleteHighlight(h)} aria-label="Delete highlight">
                  <IconTrash />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Select text in the book to highlight it.</p>
        )
      ) : marks.length ? (
        <ul className="list">
          {marks.map((b) => (
            <li key={b.id} className="note-row">
              <button className="row-btn" onClick={() => onPick(b.cfi)}>
                <span style={{ minWidth: 0 }}>
                  <span className="serif clamp-2" style={{ fontSize: 14 }}>
                    {b.label}
                  </span>
                  <small className="muted" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                    {Math.round((b.progress ?? 0) * 100)}% · {new Date(b.createdAt).toLocaleDateString()}
                  </small>
                </span>
              </button>
              <button className="icon-btn" onClick={() => onDeleteBookmark(b)} aria-label="Delete bookmark">
                <IconTrash />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Tap the bookmark icon at the top of a page to save it here.</p>
      )}
    </Sheet>
  );
}
