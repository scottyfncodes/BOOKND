'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookCover } from '@/components/BookCover';
import { Byline } from '@/components/Byline';
import { IconLibrary, IconSearch, Mark } from '@/components/Icons';
import { LegacyDiscover } from '@/components/LegacyDiscover';
import { LoadingBar, preloadCovers } from '@/components/LoadingBar';
import { Sheet } from '@/components/Sheet';
import { useToast } from '@/components/Toasts';
import { GENRES, isGenre, type GenreId } from '@/lib/browse';
import type { Edition, Field, RatingFilter, SearchResult, Sort, Source, Work } from '@/lib/catalog-index';
import { db } from '@/lib/db';
import { useLive } from '@/lib/hooks';
import { ink, rectOf } from '@/lib/ink';
import { describeImportError, importEpub } from '@/lib/library';

const SOURCE_LABEL: Record<Source, string> = { 'standard-ebooks': 'Standard Ebooks', gutenberg: 'Project Gutenberg' };
const SITES: Record<Source, string> = { 'standard-ebooks': 'https://standardebooks.org', gutenberg: 'https://www.gutenberg.org' };

const SORT_LABEL: Record<Sort, string> = {
  relevance: 'Best match',
  popular: 'Most popular',
  rating: 'Top rated',
  title: 'Title A–Z',
  author: 'Author A–Z',
  newest: 'Newest additions',
};
const FIELD_LABEL: Record<Field, string> = { all: 'All fields', title: 'Title', author: 'Author', subject: 'Subject', description: 'Description' };
const PER = 30;
const COVERS_FIRST = 12; // about the first two screens of covers on a phone, the first rows on desktop

interface Filters {
  q: string;
  field: Field;
  source: Source | null;
  genre: GenreId | null;
  lang: string; // 'all' or a language code
  rating: RatingFilter;
  sort: Sort | null; // null: best match when searching, most popular otherwise
}
const DEFAULTS: Filters = { q: '', field: 'all', source: null, genre: null, lang: 'en', rating: 'any', sort: null };

function fromUrl(): Filters {
  const sp = new URLSearchParams(window.location.search);
  const f = { ...DEFAULTS };
  f.q = (sp.get('q') ?? '').slice(0, 160);
  const field = sp.get('in');
  if (field && field in FIELD_LABEL) f.field = field as Field;
  const src = sp.get('source');
  if (src === 'gutenberg' || src === 'standard-ebooks') f.source = src;
  const g = sp.get('genre');
  if (isGenre(g)) f.genre = g;
  const lang = sp.get('lang');
  if (lang && /^([a-z]{2,3}|all)$/.test(lang)) f.lang = lang;
  const r = sp.get('rating');
  if (r === 'rated' || r === 'unrated') f.rating = r;
  const s = sp.get('sort');
  if (s && s in SORT_LABEL) f.sort = s as Sort;
  return f;
}
function toParams(f: Filters, page: number) {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.q && f.field !== 'all') p.set('in', f.field);
  if (f.source) p.set('source', f.source);
  if (f.genre) p.set('genre', f.genre);
  if (f.lang !== 'en') p.set('lang', f.lang);
  if (f.rating !== 'any') p.set('rating', f.rating);
  if (f.sort) p.set('sort', f.sort);
  if (page > 1) p.set('page', String(page));
  return p;
}

const nf = new Intl.NumberFormat('en');
function languageName(code: string) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function RatingLine({ work, compact }: { work: Work; compact?: boolean }) {
  const r = work.rating;
  if (!r) return <span className="rating rating-none">{compact ? 'Unrated' : 'No ratings yet'}</span>;
  return (
    <span className="rating" aria-label={`Rated ${r.value.toFixed(1)} out of 5 from ${nf.format(r.count)} ratings on ${r.source}`}>
      <span aria-hidden="true">★ {r.value.toFixed(1)}</span>
      <span className="muted" aria-hidden="true">
        {' '}
        · {nf.format(r.count)}
        {compact ? '' : ` rating${r.count === 1 ? '' : 's'}`}
      </span>
    </span>
  );
}

export default function DiscoverPage() {
  const router = useRouter();
  const toast = useToast();
  const [f, setF] = useState<Filters | null>(null);
  const [input, setInput] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  // the filters that produced `result`, so the count line never mixes a new query with the previous count
  const [shown, setShown] = useState<Filters | null>(null);
  const [works, setWorks] = useState<Work[]>([]);
  const [state, setState] = useState<'loading' | 'more' | 'ready' | 'error' | 'offline' | 'legacy'>('loading');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Work | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [status, setStatus] = useState<{ works: number; languageCount?: number; languages: { code: string; works: number }[] } | null>(null);
  const req = useRef(0);
  // once full-catalog results have been shown, a transient outage must not swap Discover to the per-source view
  const fullCatalogSeen = useRef(false);
  const [moreError, setMoreError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  // cover images for a fresh shelf, fetched before the shelf is shown so no tile appears blank
  const [covers, setCovers] = useState<{ loaded: number; total: number } | null>(null);
  const owned = useLive(async () => new Map((await db().books.toArray()).filter((b) => b.sourceKey).map((b) => [b.sourceKey!, b.id])), [], new Map());

  // filters live in the URL, so a search can be shared, reloaded and gone back to
  useEffect(() => {
    const initial = fromUrl();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setF(initial);
    setInput(initial.q);
    const onPop = () => {
      const next = fromUrl();
      setF(next);
      setInput(next.q);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    fetch('/api/catalog/status/')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s?.ok && setStatus({ works: s.loaded.works, languageCount: s.loaded.languageCount, languages: s.loaded.languages }))
      .catch(() => {});
  }, []);

  const load = useCallback(async (filters: Filters, page: number) => {
    const id = ++req.current;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setState('offline');
      return;
    }
    setState(page === 1 ? 'loading' : 'more');
    setMoreError('');
    if (page === 1) {
      setWorks([]);
      setCovers(null);
    }
    try {
      const params = toParams(filters, page);
      params.set('per', String(PER));
      if (filters.lang === 'all') params.set('lang', 'all');
      // one quiet retry for a transient failure (a server instance still loading, an upstream hiccup)
      let res: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          res = await fetch(`/api/search/?${params}`);
          if (res.status < 500) break;
        } catch (err) {
          if (attempt === 1) throw err;
        }
        if (id !== req.current) return;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
      }
      if (!res) throw new Error('The catalog is unavailable right now.');
      const data = (await res.json().catch(() => ({}))) as SearchResult & { error?: string; unavailable?: boolean };
      if (id !== req.current) return;
      if (res.status === 503 && data.unavailable && !fullCatalogSeen.current) {
        // no full catalog has reached this page yet: the per-source view is the only one that can work
        setState('legacy');
        return;
      }
      if (!res.ok) throw new Error(data.unavailable ? 'The catalog is briefly unavailable. Please try again in a moment.' : data.error || 'The catalog is unavailable right now.');
      fullCatalogSeen.current = true;
      if (page === 1) {
        // hold the shelf back until the first rows of covers are in the browser cache
        const urls = data.works
          .slice(0, COVERS_FIRST)
          .map((w) => w.editions[0]?.cover)
          .filter((u): u is string => !!u);
        setCovers({ loaded: 0, total: urls.length });
        await preloadCovers(urls, (loaded) => id === req.current && setCovers({ loaded, total: urls.length }));
        if (id !== req.current) return;
      }
      setResult(data);
      setShown(filters);
      setWorks((w) => (page === 1 ? data.works : [...w, ...data.works]));
      setState('ready');
    } catch (err) {
      if (id !== req.current) return;
      const message = err instanceof Error ? err.message : 'The catalog is unavailable right now.';
      if (page > 1) {
        // keep the books already shown; offer to try the next page again
        setMoreError(message);
        setState('ready');
        return;
      }
      setError(message);
      setState(navigator.onLine ? 'error' : 'offline');
    }
  }, []);

  useEffect(() => {
    if (!f) return;
    // fetching the catalog is the effect's job; load() updates state as results arrive
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(f, 1);
  }, [f, load]);

  useEffect(() => {
    const on = () => f && void load(f, 1);
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [f, load]);

  function update(patch: Partial<Filters>) {
    if (!f) return;
    const next = { ...f, ...patch };
    // a new search starts at the best match; leaving search drops the relevance sort
    if ('q' in patch && patch.q !== f.q && (patch.sort === undefined || patch.sort === null)) next.sort = next.q ? null : f.sort === 'relevance' ? null : f.sort;
    const qs = toParams(next, 1).toString();
    window.history.pushState(null, '', qs ? `/?${qs}` : '/');
    setF(next);
  }

  async function add(work: Work, ed: Edition) {
    setAdding(ed.key);
    try {
      const res = await fetch(`/api/download/?url=${encodeURIComponent(ed.epubUrl)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || 'The download failed.');
      }
      const bytes = await res.arrayBuffer();
      const r = await importEpub(bytes, { source: ed.source, sourceKey: ed.key, fallbackTitle: ed.title, fallbackAuthor: work.authors[0] });
      toast(r.status === 'duplicate' ? `“${r.book.title}” is already in your library.` : `“${r.book.title}” is on your shelf and ready offline.`, {
        action: { label: 'Read', run: () => openBook(r.book.id) },
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

  const ownedEdition = (w: Work) => w.editions.find((e) => owned?.has(e.key));
  const sort: Sort = result?.sort ?? f?.sort ?? 'popular';
  const languages = useMemo(() => {
    const list = status?.languages ?? [];
    const top = list.filter((l) => l.works >= 20).slice(0, 30);
    if (f && f.lang !== 'all' && !top.some((l) => l.code === f.lang)) top.push({ code: f.lang, works: 0 });
    return top;
  }, [status, f]);

  const facet = result?.facets;
  // ratings, search field, language and sort: inline on wider screens, in the Sort & filter sheet on phones
  const active = f ? (f.rating !== 'any' ? 1 : 0) + (f.q && f.field !== 'all' ? 1 : 0) + (f.lang !== 'en' ? 1 : 0) + (f.sort ? 1 : 0) : 0;
  const filterControls = (where: 'inline' | 'sheet') => {
    const id = (name: string) => (where === 'inline' ? `cat-${name}` : `sheet-${name}`);
    const ratings = (
      <div className="chips" role="group" aria-label="Ratings">
        {(['any', 'rated', 'unrated'] as const).map((r) => (
          <button key={r} type="button" className="chip" aria-pressed={(f?.rating ?? 'any') === r} onClick={() => update({ rating: r })}>
            {r === 'any' ? 'Any rating' : r === 'rated' ? 'Rated' : 'Unrated'}
            {facet && r !== 'any' ? <span className="chip-count">{nf.format(r === 'rated' ? facet.rated : facet.unrated)}</span> : null}
          </button>
        ))}
      </div>
    );
    const select = (name: string, label: string, el: ReactNode) =>
      where === 'inline' ? (
        <label className="select-label">
          <span className="sr-only">{label}</span>
          {el}
        </label>
      ) : (
        <label className="sheet-field" htmlFor={id(name)}>
          <span className="eyebrow">{label}</span>
          {el}
        </label>
      );
    const sortSelect = select(
      'sort',
      'Sort by',
      <select id={id('sort')} className="field" value={sort} onChange={(e) => update({ sort: e.target.value as Sort })}>
        {(Object.keys(SORT_LABEL) as Sort[])
          .filter((s) => s !== 'relevance' || f?.q)
          .map((s) => (
            <option key={s} value={s}>
              {SORT_LABEL[s]}
            </option>
          ))}
      </select>,
    );
    const fieldSelect = select(
      'field',
      'Search in',
      <select id={id('field')} className="field" value={f?.field ?? 'all'} onChange={(e) => update({ field: e.target.value as Field, q: input.trim() })}>
        {(Object.keys(FIELD_LABEL) as Field[]).map((k) => (
          <option key={k} value={k}>
            {k === 'all' ? 'Search all fields' : `Search ${FIELD_LABEL[k].toLowerCase()}`}
          </option>
        ))}
      </select>,
    );
    const langSelect = select(
      'lang',
      'Language',
      <select id={id('lang')} className="field" value={f?.lang ?? 'en'} onChange={(e) => update({ lang: e.target.value })}>
        <option value="all">All languages</option>
        {languages.map((l) => (
          <option key={l.code} value={l.code}>
            {languageName(l.code)}
          </option>
        ))}
      </select>,
    );
    if (where === 'inline')
      return (
        <>
          {ratings}
          <div className="selects">
            {fieldSelect}
            {langSelect}
            {sortSelect}
          </div>
        </>
      );
    return (
      <div className="sheet-filters">
        {sortSelect}
        <div className="sheet-field">
          <span className="eyebrow">Ratings</span>
          {ratings}
        </div>
        {langSelect}
        {fieldSelect}
      </div>
    );
  };

  if (state === 'legacy') return <LegacyDiscover />;

  const filtered = !!f && (f.genre || f.source || f.rating !== 'any' || f.q);

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
          <p className="muted" style={{ fontSize: 14, margin: '12px 0 0', maxWidth: 560 }}>
            {status ? `${nf.format(status.works)} free books${status.languageCount ? ` in ${status.languageCount} languages` : ''}` : 'Every free book'} from Standard Ebooks and Project Gutenberg. Standard Ebooks’ carefully typeset editions come first.
          </p>
        </div>

        <div className="seg" role="tablist" aria-label="Catalog" style={{ marginTop: 20, maxWidth: 520 }}>
          {([null, 'standard-ebooks', 'gutenberg'] as const).map((s) => (
            <button key={s ?? 'all'} role="tab" aria-selected={(f?.source ?? null) === s} onClick={() => update({ source: s })}>
              {s ? SOURCE_LABEL[s] : 'All books'}
            </button>
          ))}
        </div>

        <form
          role="search"
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: input.trim() });
          }}
          style={{ margin: '16px 0' }}
        >
          <label className="sr-only" htmlFor="cat-search">
            Search the catalog
          </label>
          <input
            id="cat-search"
            className="field"
            type="search"
            placeholder="Title, author, subject…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            enterKeyHint="search"
            autoComplete="off"
          />
          <button className="btn btn-primary" type="submit" aria-label="Search">
            <IconSearch width={18} height={18} />
            <span className="label-wide">Search</span>
          </button>
        </form>

        <div className="filters">
          <div className="chips chips-scroll" role="group" aria-label="Genre">
            <button type="button" className="chip" aria-pressed={!f?.genre} onClick={() => update({ genre: null })}>
              All genres
            </button>
            {(Object.keys(GENRES) as GenreId[]).map((g) => (
              <button key={g} type="button" className="chip" aria-pressed={f?.genre === g} onClick={() => update({ genre: f?.genre === g ? null : g })}>
                {GENRES[g].label}
              </button>
            ))}
          </div>
          <div className="filter-row">{filterControls('inline')}</div>
          <div className="count-bar">
            <p className="muted filters-note" aria-live="polite" id="result-count">
              {state === 'loading'
                ? 'Searching the whole catalog…'
                : result
                  ? (
                    <>
                      {nf.format(result.total)} {result.total === 1 ? 'book' : 'books'}
                      {shown && shown.lang !== 'all' ? ` in ${languageName(shown.lang)}` : ''}
                      {shown?.q ? ` for “${shown.q}”` : ''}
                      {/* on phones the sort is named in the Sort & filter sheet, so the count keeps to one line */}
                      <span className="count-sort">
                        {` · ${SORT_LABEL[result.sort].toLowerCase()}${result.sort === 'rating' ? ' (weighted by number of ratings)' : ''}`}
                      </span>
                    </>
                  )
                : ''}
            </p>
            <button type="button" className="btn btn-quiet filter-open" onClick={() => setFiltersOpen(true)} aria-haspopup="dialog">
              Sort &amp; filter
              {active ? (
                <span className="filter-badge" aria-label={`${active} active`}>
                  {active}
                </span>
              ) : null}
            </button>
          </div>
        </div>

        {state === 'loading' ? (
          <LoadingBar covers={covers} />
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
              <button className="btn btn-primary" onClick={() => f && load(f, 1)}>
                Try again
              </button>
            </div>
          </div>
        ) : works.length === 0 ? (
          <div className="empty" role="status">
            <h2>No books found</h2>
            <p>
              {f?.q ? `Nothing matches “${f.q}”` : 'Nothing matches these filters'}
              {f?.genre ? ` in ${GENRES[f.genre].label}` : ''}
              {f && f.lang !== 'all' ? ` in ${languageName(f.lang)}` : ''}.
            </p>
            <div className="actions">
              {f && f.lang !== 'all' ? (
                <button className="btn btn-quiet" onClick={() => update({ lang: 'all' })}>
                  Search all languages
                </button>
              ) : null}
              {filtered ? (
                <button className="btn btn-quiet" onClick={() => update({ genre: null, source: null, rating: 'any' })}>
                  Clear filters
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <h2 className="sr-only">Books</h2>
            <ul className="shelf shelf-in">
              {works.map((w) => {
                const pref = w.editions[0];
                return (
                  <li key={w.id} className="book-card">
                    <button className="book-open" onClick={() => setSelected(w)} aria-label={`${w.title} by ${w.authors.join(', ') || 'unknown'}`} aria-haspopup="dialog">
                      <BookCover src={pref.cover} title={w.title} author={w.authors[0]} />
                    </button>
                    <div>
                      <h3 className="book-title clamp-2">{w.title}</h3>
                      <p className="book-author clamp-2">
                        {w.authors.join(', ') || 'Unknown author'}
                        {ownedEdition(w) ? <span className="in-lib"> · In library</span> : null}
                      </p>
                      <p className="book-rating">
                        <RatingLine work={w} compact />
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
            {result && result.page < result.pages ? (
              <div style={{ display: 'grid', justifyItems: 'center', gap: 8, marginTop: 32 }}>
                <button className="btn btn-quiet" disabled={state === 'more'} onClick={() => f && load(f, result.page + 1)}>
                  {state === 'more' ? 'Loading…' : 'Show more'}
                </button>
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                  Showing {nf.format(works.length)} of {nf.format(result.total)}
                </p>
                {moreError ? (
                  <p role="alert" style={{ fontSize: 13, margin: 0 }}>
                    {moreError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}

        <footer className="site-foot">
          <span>
            Catalog data and books courtesy of{' '}
            <a href={SITES['standard-ebooks']} target="_blank" rel="noopener" style={{ color: 'inherit' }}>
              Standard Ebooks
            </a>{' '}
            and{' '}
            <a href={SITES.gutenberg} target="_blank" rel="noopener" style={{ color: 'inherit' }}>
              Project Gutenberg
            </a>
            ; ratings from{' '}
            <a href="https://openlibrary.org" target="_blank" rel="noopener" style={{ color: 'inherit' }}>
              Open Library
            </a>
            . These works are in the public domain in the United States; check the copyright laws of your country before downloading.
          </span>
          <Byline />
        </footer>
      </main>

      {filtersOpen ? (
        <Sheet title="Sort & filter" onClose={() => setFiltersOpen(false)}>
          {filterControls('sheet')}
          <div className="sheet-filter-actions">
            {active ? (
              <button type="button" className="btn btn-quiet" onClick={() => update({ rating: 'any', field: 'all', lang: 'en', sort: null })}>
                Reset
              </button>
            ) : null}
            <button type="button" className="btn btn-primary" onClick={() => setFiltersOpen(false)} data-autofocus>
              {state === 'loading' || !result ? 'Show books' : `Show ${nf.format(result.total)} ${result.total === 1 ? 'book' : 'books'}`}
            </button>
          </div>
        </Sheet>
      ) : null}
      {selected ? <WorkSheet work={selected} owned={owned} adding={adding} onAdd={add} onOpen={openBook} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function WorkSheet({
  work,
  owned,
  adding,
  onAdd,
  onOpen,
  onClose,
}: {
  work: Work;
  owned: Map<string, string> | undefined;
  adding: string | null;
  onAdd: (w: Work, e: Edition) => void;
  onOpen: (id: string, el?: Element | null) => void;
  onClose: () => void;
}) {
  const pref = work.editions[0];
  const r = work.rating;
  const action = (ed: Edition, primary: boolean, autofocus?: boolean) =>
    owned?.has(ed.key) ? (
      <button className={`btn ${primary ? 'btn-primary' : 'btn-quiet'}`} onClick={(e) => onOpen(owned.get(ed.key)!, e.currentTarget)} data-autofocus={autofocus || undefined}>
        Read now
      </button>
    ) : (
      <button className={`btn ${primary ? 'btn-primary' : 'btn-quiet'}`} onClick={() => onAdd(work, ed)} disabled={adding !== null} data-autofocus={autofocus || undefined}>
        {adding === ed.key ? 'Downloading…' : primary ? 'Add to library' : 'Add'}
      </button>
    );
  return (
    <Sheet title={work.title} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '104px 1fr', gap: 20, alignItems: 'start' }}>
        <BookCover src={pref.cover} title={work.title} author={work.authors[0]} />
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0 }}>{work.authors.join(', ') || 'Unknown author'}</p>
          {work.translators.length ? (
            <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>
              Translated by {work.translators.join(', ')}
            </p>
          ) : null}
          <p style={{ fontSize: 14, margin: '10px 0 0' }}>
            <RatingLine work={work} />
          </p>
          <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
            {r ? (
              <>
                From{' '}
                <a href={r.url} target="_blank" rel="noopener" style={{ color: 'inherit' }}>
                  Open Library
                </a>
                {r.method === 'gutenberg-id' ? ', matched by Project Gutenberg number' : ', matched by title and author'} · updated{' '}
                {new Date(r.updatedAt).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })}
              </>
            ) : (
              'No rating found on Open Library for this work.'
            )}
          </p>
          {work.subjects.length ? (
            <p className="muted" style={{ fontSize: 13, margin: '10px 0 0' }}>
              {work.subjects.slice(0, 5).join(' · ')}
            </p>
          ) : null}
        </div>
      </div>
      {work.description ? (
        <p className="serif" style={{ fontSize: 15, lineHeight: 1.7, marginTop: 20 }}>
          {work.description}
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 24, alignItems: 'center' }}>
        {action(pref, true, true)}
        <a className="btn btn-text" href={pref.pageUrl} target="_blank" rel="noopener">
          View on {SOURCE_LABEL[pref.source]}
        </a>
      </div>
      {work.editions.length > 1 ? (
        <section style={{ marginTop: 28 }} aria-labelledby="editions-h">
          <h3 id="editions-h" className="eyebrow" style={{ margin: '0 0 8px' }}>
            {work.editions.length} editions
          </h3>
          <ul className="list editions">
            {work.editions.map((ed, i) => (
              <li key={ed.key} className="edition">
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 500 }}>
                    {SOURCE_LABEL[ed.source]}
                    {i === 0 ? <span className="badge">Recommended</span> : null}
                  </p>
                  <p className="muted clamp-2" style={{ fontSize: 13, margin: '2px 0 0' }}>
                    {[ed.title !== work.title ? ed.title : null, languageName(ed.language), ed.translators.length ? `tr. ${ed.translators.join(', ')}` : null, ed.downloads ? `${nf.format(ed.downloads)} downloads last month` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                {action(ed, false)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="muted" style={{ fontSize: 12.5, marginTop: 20 }}>
        {pref.source === 'standard-ebooks'
          ? 'Standard Ebooks editions are released into the public domain (CC0) and are free to read and share.'
          : 'From Project Gutenberg, which makes this public-domain work freely available. The ebook includes the Project Gutenberg License.'}{' '}
        Public domain in the USA; copyright may differ in your country.
      </p>
    </Sheet>
  );
}
