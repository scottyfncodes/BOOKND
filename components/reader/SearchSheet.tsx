'use client';
import { useEffect, useRef, useState } from 'react';
import type { Book as EpubBook } from 'epubjs';
import { Sheet } from '../Sheet';

type Hit = { cfi: string; excerpt: string; chapter: number };
const MAX_HITS = 200;

/** Full-text search across every chapter, one chapter at a time to keep memory low. */
export function SearchSheet({ book, onPick, onClose }: { book: EpubBook; onPick: (cfi: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [state, setState] = useState<'idle' | 'searching' | 'done'>('idle');
  const run = useRef(0);

  useEffect(() => {
    const query = q.trim();
    const id = ++run.current;
    if (query.length < 2) {
      setHits([]);
      setState('idle');
      return;
    }
    const timer = setTimeout(async () => {
      setState('searching');
      setHits([]);
      const found: Hit[] = [];
      const items = (book.spine as unknown as { spineItems: Array<{ index: number; linear: boolean; load(r: unknown): Promise<unknown>; find(q: string): { cfi: string; excerpt: string }[]; unload(): void }> }).spineItems;
      for (const item of items) {
        if (run.current !== id) return;
        try {
          await item.load(book.load.bind(book));
          for (const r of item.find(query)) {
            found.push({ cfi: r.cfi, excerpt: r.excerpt.replace(/\s+/g, ' ').trim(), chapter: item.index });
            if (found.length >= MAX_HITS) break;
          }
        } catch {
          /* skip unreadable chapter */
        } finally {
          item.unload();
        }
        if (run.current === id) setHits([...found]);
        if (found.length >= MAX_HITS) break;
      }
      if (run.current === id) setState('done');
    }, 300);
    return () => clearTimeout(timer);
  }, [q, book]);

  const mark = (text: string) => {
    const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
    if (i < 0) return text;
    return (
      <>
        {text.slice(0, i)}
        <mark>{text.slice(i, i + q.trim().length)}</mark>
        {text.slice(i + q.trim().length)}
      </>
    );
  };

  return (
    <Sheet title="Search this book" onClose={onClose} side>
      <label className="sr-only" htmlFor="book-search">
        Search text
      </label>
      <input id="book-search" className="field" type="search" placeholder="Find a word or phrase" value={q} onChange={(e) => setQ(e.target.value)} data-autofocus autoComplete="off" enterKeyHint="search" />
      <p className="muted" role="status" style={{ fontSize: 13, margin: '12px 0' }}>
        {state === 'searching' ? `Searching… ${hits.length} found so far` : state === 'done' ? (hits.length ? `${hits.length}${hits.length >= MAX_HITS ? '+' : ''} ${hits.length === 1 ? 'result' : 'results'}` : 'No matches') : 'Type at least two letters.'}
      </p>
      <ul className="list search-hits">
        {hits.map((h, i) => (
          <li key={`${h.cfi}-${i}`}>
            <button className="row-btn" onClick={() => onPick(h.cfi)}>
              <span className="serif" style={{ fontSize: 14, lineHeight: 1.55 }}>
                …{mark(h.excerpt.replace(/^\.+|\.+$/g, ''))}…
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
