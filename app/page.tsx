'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BookCover } from '@/components/BookCover';
import { Byline } from '@/components/Byline';
import { IconLibrary, IconSearch, Mark } from '@/components/Icons';
import { Sheet } from '@/components/Sheet';
import { useToast } from '@/components/Toasts';
import { COLLECTIONS, GENRES, genresFor, type Collection, type GenreId } from '@/lib/browse';
import type { CatalogBook, CatalogPage } from '@/lib/catalog';
import { db } from '@/lib/db';
import { useLive } from '@/lib/hooks';
import { ink, rectOf } from '@/lib/ink';
import { describeImportError, importEpub } from '@/lib/library';

type Source = CatalogBook['source'];

const SOURCES: Record<Source, { label: string; blurb: string; site: string }> = {
  'standard-ebooks': {
    label: 'Standard Ebooks',
    blurb: 'Carefully typeset, proofread editions of public-domain classics. Showing their newest releases.',
    site: 'https://standardebooks.org',
  },
  gutenberg: {
    label: 'Project Gutenberg',
    blurb: 'Over 70,000 free ebooks. Search by title or author, or browse by collection and genre.',
    site: 'https://www.gutenberg.org',
  },
};

export default function DiscoverPage() {
  const router = useRouter();
  const toast = useToast();
  const [source, setSource] = useState<Source>('standard-ebooks');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [collection, setCollection] = useState<Collection>('favorites');
  const [genre, setGenre] = useState<GenreId | null>(null);
  const [books, setBooks] = useState<CatalogBook[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'offline'>('loading');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<CatalogBook | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const req = useRef(0);
  const owned = useLive(async () => new Map((await db().books.toArray()).filter((b) => b.sourceKey).map((b) => [b.sourceKey!, b.id])), [], new Map());

  const load = useCallback(async (src: Source, q: string, list: Collection, g: GenreId | null, page = 1) => {
    const id = ++req.current;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setState('offline');
      return;
    }
    if (page === 1) {
      setState('loading');
      setBooks([]);
    }
    try {
      const params = new URLSearchParams({ source: src, q, page: String(page) });
      if (src === 'gutenberg') params.set('list', list);
      if (g) params.set('genre', g);
      const res = await fetch(`/api/catalog/?${params}`);
      const data = (await res.json()) as CatalogPage & { error?: string };
      if (id !== req.current) return;
      if (!res.ok) throw new Error(data.error || 'The catalog is unavailable right now.');
      setBooks((b) => (page === 1 ? data.books : [...b, ...data.books]));
      setNext(data.next ?? null);
      setState('ready');
    } catch (err) {
      if (id !== req.current) return;
      setError(err instanceof Error ? err.message : 'The catalog is unavailable right now.');
      setState(navigator.onLine ? 'error' : 'offline');
    }
  }, []);

  useEffect(() => {
    // fetching the catalog is the effect's job; load() updates state as results arrive
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(source, query, collection, genre);
  }, [source, query, collection, genre, load]);

  useEffect(() => {
    const on = () => void load(source, query, collection, genre);
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [source, query, collection, genre, load]);

  function pickSource(s: Source) {
    setSource(s);
    // Standard Ebooks doesn't have every genre; drop one it can't filter by.
    if (genre && !genresFor(s).includes(genre)) setGenre(null);
  }

  async function add(book: CatalogBook) {
    setAdding(book.key);
    try {
      const res = await fetch(`/api/download/?url=${encodeURIComponent(book.epubUrl)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || 'The download failed.');
      }
      const bytes = await res.arrayBuffer();
      const result = await importEpub(bytes, { source: book.source, sourceKey: book.key, fallbackTitle: book.title, fallbackAuthor: book.authors[0] });
      toast(result.status === 'duplicate' ? `“${result.book.title}” is already in your library.` : `“${result.book.title}” is on your shelf and ready offline.`, {
        action: { label: 'Read', run: () => openBook(result.book.id) },
      });
    } catch (err) {
      toast(err instanceof Error && !(err.name === 'EpubError' || err.name === 'StorageFullError') ? err.message : describeImportError(err), { tone: 'error' });
    }
    setAdding(null);
  }

  function openBook(id: string, el?: Element | null) {
    ink.play({ kind: 'open', origin: rectOf(el ?? undefined) });
    router.push(`/read/?book=${encodeURIComponent(id)}`);
  }

  const info = SOURCES[source];

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/" className="wordmark grow" aria-label="BookNd home: Discover">
          <Mark />
          <span>booknd</span>
        </Link>
        <Link href="/library/" className="btn btn-quiet hide-narrow" aria-label="Your library">
          <IconLibrary width={18} height={18} /> <span className="label-wide">Your library</span>
        </Link>
      </header>
      <main id="main">
        <div style={{ marginTop: 24 }}>
          <p className="eyebrow">Free public-domain books</p>
          <h1 className="serif" style={{ fontWeight: 400, fontSize: 'clamp(28px, 3vw + 16px, 44px)', lineHeight: 1.15, margin: '8px 0 0' }}>
            Discover
          </h1>
        </div>

        <div className="seg" role="tablist" aria-label="Catalog" style={{ marginTop: 24, maxWidth: 440 }}>
          {(Object.keys(SOURCES) as Source[]).map((s) => (
            <button key={s} role="tab" aria-selected={source === s} onClick={() => pickSource(s)}>
              {SOURCES[s].label}
            </button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 14, margin: '12px 0 16px', maxWidth: 560 }}>
          {info.blurb}
        </p>
        <form
          role="search"
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(input.trim());
          }}
          style={{ marginBottom: 16 }}
        >
          <label className="sr-only" htmlFor="cat-search">
            Search {info.label}
          </label>
          <input id="cat-search" className="field" type="search" placeholder="Search titles and authors" value={input} onChange={(e) => setInput(e.target.value)} enterKeyHint="search" autoComplete="off" />
          <button className="btn btn-primary" type="submit" aria-label="Search">
            <IconSearch width={18} height={18} />
            <span className="label-wide">Search</span>
          </button>
        </form>

        <div className="filters">
          {source === 'gutenberg' ? (
            <div className="chips" role="group" aria-label="Collection">
              {(Object.keys(COLLECTIONS) as Collection[]).map((c) => (
                <button key={c} type="button" className="chip chip-strong" aria-pressed={collection === c} onClick={() => setCollection(c)}>
                  {COLLECTIONS[c].label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="chips chips-scroll" role="group" aria-label="Genre">
            <button type="button" className="chip" aria-pressed={genre === null} onClick={() => setGenre(null)}>
              All genres
            </button>
            {genresFor(source).map((g) => (
              <button key={g} type="button" className="chip" aria-pressed={genre === g} onClick={() => setGenre(genre === g ? null : g)}>
                {GENRES[g].label}
              </button>
            ))}
          </div>
          {source === 'gutenberg' ? (
            <p className="muted filters-note" aria-live="polite">
              {COLLECTIONS[collection].blurb}
            </p>
          ) : null}
        </div>

        {state === 'loading' ? (
          <ul className="shelf" aria-busy="true" aria-label="Loading books">
            {Array.from({ length: 10 }, (_, i) => (
              <li key={i}>
                <div className="cover" style={{ boxShadow: 'none', opacity: 0.45 }} />
              </li>
            ))}
          </ul>
        ) : state === 'offline' ? (
          <div className="empty" role="status">
            <h2>You’re offline</h2>
            <p>Discover needs a connection. Every book already in your library still opens offline.</p>
            <div className="actions">
              <Link className="btn btn-primary" href="/library/">
                Go to your library
              </Link>
            </div>
          </div>
        ) : state === 'error' ? (
          <div className="empty" role="alert">
            <h2>The catalog didn’t answer</h2>
            <p>{error}</p>
            <div className="actions">
              <button className="btn btn-primary" onClick={() => load(source, query, collection, genre)}>
                Try again
              </button>
            </div>
          </div>
        ) : books.length === 0 ? (
          <div className="empty" role="status">
            <h2>No books found</h2>
            <p>
              {query
                ? `Nothing matches “${query}”${genre ? ` in ${GENRES[genre].label}` : ''} on ${info.label}.`
                : genre
                  ? `${info.label} has no ${GENRES[genre].label.toLowerCase()} books here right now.`
                  : 'This catalog returned no books.'}
            </p>
            <div className="actions">
              {genre ? (
                <button className="btn btn-quiet" onClick={() => setGenre(null)}>
                  Show all genres
                </button>
              ) : null}
              {source === 'standard-ebooks' && (query || genre) ? (
                <button className="btn btn-quiet" onClick={() => pickSource('gutenberg')}>
                  Search Project Gutenberg
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <ul className="shelf">
              {books.map((b) => (
                <li key={b.key} className="book-card">
                  <button className="book-open" onClick={() => setSelected(b)} aria-label={`${b.title} by ${b.authors.join(', ') || 'unknown'}`} aria-haspopup="dialog">
                    <BookCover src={b.cover} title={b.title} author={b.authors[0]} />
                  </button>
                  <div>
                    <h3 className="book-title clamp-2">{b.title}</h3>
                    <p className="book-author clamp-2">
                      {b.authors.join(', ') || 'Unknown author'}
                      {owned?.has(b.key) ? <span className="in-lib"> · In library</span> : null}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            {next ? (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 32 }}>
                <button className="btn btn-quiet" onClick={() => load(source, query, collection, genre, next)}>
                  Show more
                </button>
              </div>
            ) : null}
          </>
        )}

        <footer className="site-foot">
          <span>
            Catalog data and books courtesy of{' '}
            <a href={SOURCES['standard-ebooks'].site} target="_blank" rel="noopener" style={{ color: 'inherit' }}>
              Standard Ebooks
            </a>{' '}
            and{' '}
            <a href={SOURCES.gutenberg.site} target="_blank" rel="noopener" style={{ color: 'inherit' }}>
              Project Gutenberg
            </a>
            . These works are in the public domain in the United States; check the copyright laws of your country before downloading.
          </span>
          <Byline />
        </footer>
      </main>

      {selected ? (
        <Sheet title={selected.title} onClose={() => setSelected(null)}>
          <div style={{ display: 'grid', gridTemplateColumns: '104px 1fr', gap: 20, alignItems: 'start' }}>
            <BookCover src={selected.cover} title={selected.title} author={selected.authors[0]} />
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0 }}>{selected.authors.join(', ') || 'Unknown author'}</p>
              <p className="muted" style={{ fontSize: 13, margin: '8px 0 0' }}>
                {SOURCES[selected.source].label}
                {selected.downloads ? ` · ${selected.downloads.toLocaleString()} downloads last month` : ''}
              </p>
              {selected.subjects.length ? (
                <p className="muted" style={{ fontSize: 13, margin: '8px 0 0' }}>
                  {selected.subjects.join(' · ')}
                </p>
              ) : null}
            </div>
          </div>
          {selected.summary ? (
            <p className="serif" style={{ fontSize: 15, lineHeight: 1.7, marginTop: 20 }}>
              {selected.summary}
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 24, alignItems: 'center' }}>
            {owned?.has(selected.key) ? (
              <button className="btn btn-primary" onClick={(e) => openBook(owned.get(selected.key)!, e.currentTarget)} data-autofocus>
                Read now
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => add(selected)} disabled={adding !== null} data-autofocus>
                {adding === selected.key ? 'Downloading…' : 'Add to library'}
              </button>
            )}
            <a className="btn btn-text" href={selected.pageUrl} target="_blank" rel="noopener">
              View on {SOURCES[selected.source].label}
            </a>
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 20 }}>
            {selected.source === 'standard-ebooks'
              ? 'Standard Ebooks editions are released into the public domain (CC0) and are free to read and share.'
              : 'From Project Gutenberg, which makes this public-domain work freely available. The ebook includes the Project Gutenberg License.'}{' '}
            Public domain in the USA; copyright may differ in your country.
          </p>
        </Sheet>
      ) : null}
    </div>
  );
}
