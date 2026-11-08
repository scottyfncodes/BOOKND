'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, type MouseEvent } from 'react';
import { BookCover } from '@/components/BookCover';
import { Byline } from '@/components/Byline';
import { IconCompass, IconMore, IconPlus, IconSettings, IconUpload, Mark } from '@/components/Icons';
import { LibrarySettings } from '@/components/LibrarySettings';
import { BookDetails } from '@/components/BookDetails';
import { Sheet } from '@/components/Sheet';
import { useEpubImport } from '@/components/useEpubImport';
import { db, type Book } from '@/lib/db';
import { useLive } from '@/lib/hooks';
import { ink, rectOf } from '@/lib/ink';

type Sort = 'recent' | 'title' | 'author' | 'added';

const recentOf = (b: Book) => b.lastOpenedAt ?? b.addedAt;
const pct = (p?: number) => Math.round((p ?? 0) * 100);

function pressInk(e: MouseEvent<HTMLElement>) {
  if (!ink.enabled()) return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const dot = document.createElement('span');
  const size = Math.max(r.width, r.height) * 2.2;
  dot.className = 'ink-press';
  Object.assign(dot.style, { left: `${e.clientX - r.left}px`, top: `${e.clientY - r.top}px`, width: `${size}px`, height: `${size}px` });
  el.appendChild(dot);
  setTimeout(() => dot.remove(), 650);
}

export default function LibraryPage() {
  const router = useRouter();
  const books = useLive(() => db().books.toArray(), []);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [details, setDetails] = useState<Book | null>(null);
  const [dragging, setDragging] = useState(false);
  const { pick, picker, busy, importFiles } = useEpubImport(() => setAddOpen(false));

  const open = useCallback(
    (book: Book, el: HTMLElement | null) => {
      ink.play({ kind: 'open', origin: rectOf(el?.querySelector('.cover') ?? el) });
      router.push(`/read/?book=${encodeURIComponent(book.id)}`);
    },
    [router],
  );

  const continueBook = useMemo(
    () =>
      (books ?? [])
        .filter((b) => b.lastOpenedAt && (b.progress ?? 0) < 0.995)
        .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0],
    [books],
  );
  const recent = useMemo(
    () =>
      (books ?? [])
        .filter((b) => b.lastOpenedAt && b.id !== continueBook?.id)
        .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
        .slice(0, 8),
    [books, continueBook],
  );
  const shelf = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (books ?? []).filter((b) => !q || `${b.title} ${b.author}`.toLowerCase().includes(q));
    const cmp: Record<Sort, (a: Book, b: Book) => number> = {
      recent: (a, b) => recentOf(b) - recentOf(a),
      added: (a, b) => b.addedAt - a.addedAt,
      title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      author: (a, b) => a.author.localeCompare(b.author, undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title),
    };
    return list.sort(cmp[sort]);
  }, [books, query, sort]);

  const loading = books === undefined;
  const empty = !loading && books.length === 0;

  return (
    <div
      className="page"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
      }}
    >
      {picker}
      <header className="topbar">
        <Link href="/" className="wordmark grow" aria-label="BookNd home: Discover">
          <Mark />
          <span>booknd</span>
        </Link>
        <Link href="/" className="btn btn-quiet hide-narrow" aria-label="Discover free books">
          <IconCompass width={18} height={18} /> <span className="label-wide">Discover</span>
        </Link>
        <button className="btn btn-primary" onClick={(e) => (pressInk(e), setAddOpen(true))} disabled={busy} aria-haspopup="dialog">
          <IconPlus width={18} height={18} /> {busy ? 'Adding…' : 'Add book'}
        </button>
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Library settings and backup" aria-haspopup="dialog">
          <IconSettings />
        </button>
      </header>

      <main id="main" aria-busy={loading || busy}>
        <h1 className="sr-only">Your library</h1>
        {dragging ? (
          <div className="notice" style={{ marginTop: 16, justifyContent: 'center' }}>
            Drop EPUB files to add them to your library
          </div>
        ) : null}

        {loading ? (
          <div className="shelf" style={{ marginTop: 48 }} aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="cover" style={{ boxShadow: 'none', opacity: 0.5 }} />
            ))}
          </div>
        ) : empty ? (
          <section className="empty" aria-labelledby="empty-title">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/assets/brand/logo.svg" alt="booknd" width={210} height={70} className="empty-logo" />
            <h2 id="empty-title">Your shelf is waiting</h2>
            <p>Bring your own DRM-free EPUBs, or choose from thousands of free public-domain classics.</p>
            <div className="actions">
              <button className="btn btn-primary" onClick={pick}>
                <IconUpload width={18} height={18} /> Import EPUB
              </button>
              <Link className="btn btn-quiet" href="/">
                <IconCompass width={18} height={18} /> Discover free books
              </Link>
            </div>
          </section>
        ) : (
          <>
            {continueBook ? (
              <section className="hero" aria-labelledby="continue-title">
                <button className="book-open" onClick={(e) => open(continueBook, e.currentTarget)} aria-label={`Continue reading ${continueBook.title}`}>
                  <BookCover cover={continueBook.cover} title={continueBook.title} author={continueBook.author} />
                </button>
                <div style={{ minWidth: 0 }}>
                  <p className="eyebrow" id="continue-title">
                    Continue reading
                  </p>
                  <h2 className="clamp-3">{continueBook.title}</h2>
                  <p className="muted" style={{ margin: 0 }}>
                    {continueBook.author}
                  </p>
                  <div className="hero-progress">
                    <div className="progress" role="progressbar" aria-label="Reading progress" aria-valuenow={pct(continueBook.progress)} aria-valuemin={0} aria-valuemax={100}>
                      <span style={{ width: `${pct(continueBook.progress)}%` }} />
                    </div>
                    <span>{pct(continueBook.progress)}%</span>
                  </div>
                  {continueBook.chapter ? (
                    <p className="muted clamp-2" style={{ fontSize: 14, margin: '0 0 16px' }}>
                      {continueBook.chapter}
                    </p>
                  ) : null}
                  <button className="btn btn-primary" onClick={(e) => open(continueBook, e.currentTarget.closest('.hero'))}>
                    Continue
                  </button>
                </div>
              </section>
            ) : null}

            {recent.length ? (
              <section className="section" aria-labelledby="recent-title">
                <div className="section-head">
                  <h2 className="section-title" id="recent-title">
                    Recently opened
                  </h2>
                </div>
                <ul className="recent list" style={{ display: 'flex' }}>
                  {recent.map((b) => (
                    <li key={b.id} style={{ border: 0 }}>
                      <button className="book-open" onClick={(e) => open(b, e.currentTarget)} aria-label={`Open ${b.title}`} style={{ width: '100%' }}>
                        <BookCover cover={b.cover} title={b.title} author={b.author} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="section" aria-labelledby="all-title">
              <div className="section-head">
                <h2 className="section-title" id="all-title">
                  All books <span className="muted" style={{ fontSize: 15, fontFamily: 'var(--sans)' }}>{books.length}</span>
                </h2>
              </div>
              <div className="toolbar" style={{ marginBottom: 24 }}>
                <label className="sr-only" htmlFor="lib-search">
                  Search your library
                </label>
                <input
                  id="lib-search"
                  className="field"
                  type="search"
                  placeholder="Search title or author"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoComplete="off"
                />
                <label className="sr-only" htmlFor="lib-sort">
                  Sort books
                </label>
                <select id="lib-sort" className="field" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                  <option value="recent">Recent</option>
                  <option value="title">Title</option>
                  <option value="author">Author</option>
                  <option value="added">Date added</option>
                </select>
              </div>
              {shelf.length ? (
                <ul className="shelf">
                  {shelf.map((b) => (
                    <li key={b.id} className="book-card">
                      <button className="book-open" onClick={(e) => open(b, e.currentTarget)} aria-label={`Open ${b.title} by ${b.author}`}>
                        <BookCover cover={b.cover} title={b.title} author={b.author} />
                      </button>
                      {(b.progress ?? 0) > 0 ? (
                        <div className="progress" aria-hidden="true">
                          <span style={{ width: `${pct(b.progress)}%` }} />
                        </div>
                      ) : null}
                      <div className="book-meta">
                        <div style={{ minWidth: 0 }}>
                          <h3 className="book-title clamp-2">{b.title}</h3>
                          <p className="book-author clamp-2">
                            {b.author}
                            {(b.progress ?? 0) > 0 ? <span className="sr-only">, {pct(b.progress)}% read</span> : null}
                          </p>
                        </div>
                        <button className="icon-btn book-more" onClick={() => setDetails(b)} aria-label={`More about ${b.title}`} aria-haspopup="dialog">
                          <IconMore />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted" role="status">
                  No books match “{query}”.
                </p>
              )}
            </section>
          </>
        )}

        <footer className="site-foot">
          <span>Your books stay on this device. Clearing this site&apos;s browser data removes them — keep a backup in settings.</span>
          <Byline />
        </footer>
      </main>

      {addOpen ? (
        <Sheet title="Add a book" onClose={() => setAddOpen(false)}>
          <ul className="menu">
            <li>
              <button className="menu-item" onClick={pick} disabled={busy} data-autofocus>
                <span className="mi-icon">
                  <IconUpload width={20} height={20} />
                </span>
                <span>
                  {busy ? 'Adding…' : 'Import EPUB'}
                  <small>Choose DRM-free .epub files from this device</small>
                </span>
              </button>
            </li>
            <li>
              <Link className="menu-item" href="/">
                <span className="mi-icon">
                  <IconCompass width={20} height={20} />
                </span>
                <span>
                  Discover free books
                  <small>Public-domain classics from Standard Ebooks and Project Gutenberg</small>
                </span>
              </Link>
            </li>
          </ul>
        </Sheet>
      ) : null}
      {settingsOpen ? <LibrarySettings onClose={() => setSettingsOpen(false)} /> : null}
      {details ? <BookDetails book={details} onClose={() => setDetails(null)} onOpen={() => open(details, null)} /> : null}
    </div>
  );
}
