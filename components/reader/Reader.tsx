'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Book as EpubBook, Contents, Location, NavItem, Rendition } from 'epubjs';
import { db, getPref, setPref, type Book, type Bookmark, type Highlight, type HighlightColor } from '@/lib/db';
import { ink } from '@/lib/ink';
import { clampPrefs, contentCss, DEFAULT_PREFS, HIGHLIGHT_FILL, MARGINS, PAGE_GAP, THEMES, type ReaderPrefs } from '@/lib/reader-prefs';
import { chapterFooter, chapterState, isTap, readingProgress, settlesWithin, swipeDirection, tapAction, type PointerMark, type TocMark, type TurnDirection } from '@/lib/reader-nav';
import { IconBack, IconBookmark, IconCopy, IconHighlight, IconList, IconNotes, IconSearch, IconType, IconClose } from '../Icons';
import { useToast } from '../Toasts';
import { ChapterFlourish } from './ChapterFlourish';
import { ContentsSheet } from './ContentsSheet';
import { NotesSheet } from './NotesSheet';
import { SearchSheet } from './SearchSheet';
import { TypeSheet } from './TypeSheet';

type Panel = 'toc' | 'search' | 'type' | 'notes' | null;
type Selection = { cfi: string; text: string };

export interface FlatToc {
  label: string;
  href: string;
  depth: number;
}

function flattenToc(items: NavItem[], depth = 0, out: FlatToc[] = []) {
  for (const it of items) {
    out.push({ label: it.label.replace(/\s+/g, ' ').trim(), href: it.href, depth });
    if (it.subitems?.length) flattenToc(it.subitems, depth + 1, out);
  }
  return out;
}

const hrefPath = (href: string) => decodeURIComponent(href.split('#')[0]).replace(/^\.?\//, '');

/** How long opening may take before the reader offers a way out (it keeps trying behind the notice). */
const OPEN_STALL_MS = 20000;
/** How long showing a saved position may take before falling back to the start of the book. */
const RESTORE_TIMEOUT_MS = 10000;

/**
 * WebKit (Safari, every iPhone browser, the installed PWA) runs no event listeners inside a frame sandboxed
 * without scripts — and the book frame is sandboxed that way so a book's own scripts never run. epub.js
 * listens for taps, swipes and keys inside that frame, so on iPhone they silently never arrive. This checks
 * whether events reach the book; when they don't, the reader takes gestures on its own layer instead.
 */
function bookFrameDeliversEvents(contents: Contents | undefined) {
  const doc = contents?.document;
  if (!doc) return true;
  let delivered = false;
  const probe = () => (delivered = true);
  try {
    doc.addEventListener('booknd-probe', probe);
    doc.dispatchEvent(new Event('booknd-probe'));
  } catch {
    return false;
  } finally {
    doc.removeEventListener('booknd-probe', probe);
  }
  return delivered;
}

/** Where each table-of-contents entry that points into this section landed, as a page of the rendered section. */
function tocMarks(rendition: Rendition, sectionIndex: number, entries: FlatToc[]): TocMark[] {
  const contents = (rendition.getContents() as unknown as Contents[]).find((c) => (c as unknown as { sectionIndex: number }).sectionIndex === sectionIndex);
  const pageWidth = (rendition as unknown as { manager?: { layout?: { pageWidth?: number } } }).manager?.layout?.pageWidth ?? 0;
  return entries.map((it) => {
    const frag = it.href.split('#')[1];
    if (!frag) return { label: it.label, page: 1 };
    if (!contents || !pageWidth) return { label: it.label, page: null };
    let el: Element | null = null;
    try {
      el = contents.document.getElementById(decodeURIComponent(frag));
    } catch {
      /* malformed fragment */
    }
    if (!el) return { label: it.label, page: null };
    const left = el.getBoundingClientRect().left + (contents.window.scrollX || 0);
    return { label: it.label, page: Math.max(1, Math.floor(left / pageWidth) + 1) };
  });
}

export function Reader({ bookId }: { bookId: string }) {
  const router = useRouter();
  const toast = useToast();
  const viewerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<EpubBook | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const prefsRef = useRef<ReaderPrefs>(DEFAULT_PREFS);
  const highlightsRef = useRef<Highlight[]>([]);
  const lastSaved = useRef<string>('');
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const chapterRef = useRef<string>('');
  const firstRelocate = useRef(true);
  const touchStart = useRef<PointerMark | null>(null);
  const layerStart = useRef<PointerMark | null>(null);
  const fromStart = useRef(false);

  const [meta, setMeta] = useState<Book | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error' | 'stalled'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [gestureLayer, setGestureLayer] = useState(false);
  const [prefs, setPrefs] = useState<ReaderPrefs>(DEFAULT_PREFS);
  const [chrome, setChrome] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [toc, setToc] = useState<FlatToc[]>([]);
  const [loc, setLoc] = useState<{ cfi: string; endCfi: string; href: string; progress: number; label: string; pagesLeft: number | null; atStart: boolean; atEnd: boolean } | null>(null);
  const [chapter, setChapter] = useState('');
  const [flourish, setFlourish] = useState<{ key: number; label: string } | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [locationsReady, setLocationsReady] = useState(false);
  const [wide, setWide] = useState(false);

  const theme = THEMES[prefs.theme];

  // ── Persist position ────────────────────────────────────────────────
  const savePosition = useCallback(
    (immediate = false) => {
      const r = renditionRef.current;
      const cur = r?.location as Location | undefined;
      const cfi = cur?.start?.cfi;
      if (!cfi || cfi === lastSaved.current) return;
      const book = bookRef.current;
      const progress = book?.locations?.length() ? book.locations.percentageFromCfi(cfi) : undefined;
      const write = () => {
        lastSaved.current = cfi;
        void db()
          .books.update(bookId, {
            location: cfi,
            ...(progress !== undefined ? { progress: cur?.atEnd ? 1 : progress } : {}),
            chapter: chapterRef.current || undefined,
            lastOpenedAt: Date.now(),
          })
          .catch(() => {});
      };
      clearTimeout(saveTimer.current);
      if (immediate) write();
      else saveTimer.current = setTimeout(write, 350);
    },
    [bookId],
  );

  // ── Load book + rendition ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let book: EpubBook | null = null;
    const onResize = () => setWide(window.innerWidth >= 900);
    onResize();
    window.addEventListener('resize', onResize);

    (async () => {
      const [record, file, savedPrefs, marks, hls] = await Promise.all([
        db().books.get(bookId),
        db().files.get(bookId),
        getPref<Partial<ReaderPrefs>>('reader', DEFAULT_PREFS),
        db().bookmarks.where('bookId').equals(bookId).sortBy('createdAt'),
        db().highlights.where('bookId').equals(bookId).sortBy('createdAt'),
      ]);
      if (cancelled) return;
      if (!record || !file) {
        setStatus('missing');
        return;
      }
      const p = clampPrefs(savedPrefs);
      prefsRef.current = p;
      setPrefs(p);
      setMeta(record);
      setBookmarks(marks);
      highlightsRef.current = hls;
      void db().books.update(bookId, { lastOpenedAt: Date.now() });

      const { default: ePub, EpubCFI } = await import('epubjs');
      cfiRef.current = new EpubCFI() as unknown as { compare(a: string, b: string): number };
      if (cancelled || !viewerRef.current) return;
      book = ePub(await file.data.arrayBuffer(), { openAs: 'binary' } as never);
      bookRef.current = book;
      const rendition = book.renderTo(viewerRef.current, {
        width: '100%',
        height: '100%',
        flow: 'paginated',
        spread: 'auto',
        minSpreadWidth: 900,
        allowScriptedContent: false,
        gap: PAGE_GAP,
      } as never);
      renditionRef.current = rendition;

      // Typography lives in a <style> we own inside each chapter document.
      rendition.hooks.content.register((contents: Contents) => {
        const doc = contents.document;
        let style = doc.getElementById('booknd-style') as HTMLStyleElement | null;
        if (!style) {
          style = doc.createElement('style');
          style.id = 'booknd-style';
          doc.head.appendChild(style);
        }
        style.textContent = contentCss(prefsRef.current, window.location.origin);
        doc.documentElement.lang ||= record.language ?? '';
      });

      rendition.on('relocated', (l: Location) => {
        const href = hrefPath(l.start.href);
        const items = flatTocRef.current;
        const idx = l.start.index ?? book!.spine.get(l.start.href)?.index ?? -1;
        // The chapter this section continues: the nearest TOC entry from an earlier section.
        let fallback = '';
        for (const it of items) {
          if (hrefPath(it.href) === href) continue;
          const s = book!.spine.get(it.href);
          if (s && s.index < idx) fallback = it.label;
        }
        const startPage = l.start.displayed.page;
        const endPage = l.end.index === l.start.index ? Math.max(startPage, l.end.displayed.page) : startPage;
        const cs = chapterState(
          tocMarks(rendition, idx, items.filter((it) => hrefPath(it.href) === href)),
          fallback,
          startPage,
          endPage,
          l.start.displayed.total,
        );
        if (cs.label && cs.label !== chapterRef.current && !firstRelocate.current && (cs.startsHere || startPage === 1)) {
          setFlourish({ key: Date.now(), label: cs.label });
        }
        firstRelocate.current = false;
        chapterRef.current = cs.label;
        setChapter(cs.label);
        const progress = readingProgress({
          located: book!.locations?.length() ? book!.locations.percentageFromCfi(l.start.cfi) : undefined,
          spineIndex: idx,
          spineLength: (book!.spine as unknown as { length: number }).length,
          page: startPage,
          totalPages: l.start.displayed.total,
          atEnd: !!l.atEnd,
        });
        setLoc({
          cfi: l.start.cfi,
          endCfi: l.end.cfi,
          href,
          progress,
          label: cs.label,
          pagesLeft: cs.pagesLeft,
          atStart: !!l.atStart,
          atEnd: !!l.atEnd,
        });
        setSelection(null);
        savePosition();
      });

      rendition.on('selected', (cfiRange: string, contents: Contents) => {
        const text = contents.window.getSelection()?.toString().trim() ?? '';
        if (text) setSelection({ cfi: cfiRange, text: text.slice(0, 2000) });
      });

      // Taps and swipes inside the page
      rendition.on('touchstart', (e: TouchEvent) => {
        const t = e.changedTouches[0];
        touchStart.current = { x: t.screenX, y: t.screenY, t: Date.now() };
      });
      rendition.on('touchend', (e: TouchEvent) => {
        const s = touchStart.current;
        touchStart.current = null;
        if (!s) return;
        const t = e.changedTouches[0];
        const dir = swipeDirection(s, { x: t.screenX, y: t.screenY, t: Date.now() });
        if (dir) {
          if (hasSelection()) return;
          turn(dir);
          swipedAt.current = Date.now();
        }
      });
      rendition.on('click', (e: MouseEvent) => {
        if (Date.now() - swipedAt.current < 400) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest?.('a[href]')) return; // let epub.js follow internal links
        if (hasSelection()) return;
        const frame = (e.view as Window | null)?.frameElement as HTMLElement | null;
        const left = frame ? frame.getBoundingClientRect().left + e.clientX : e.clientX;
        handleTap(left);
      });
      // epub.js forwards these from passive listeners, so they can't be prevented (and needn't be).
      rendition.on('keydown', (e: KeyboardEvent) => onKey(e, true));
      // Links between chapters stay inside the reader; external links open in a new tab.
      rendition.on('linkClicked', (href: string) => {
        if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener');
      });

      await book.ready;
      const nav = await book.loaded.navigation;
      if (cancelled) return;
      const flat = flattenToc(nav.toc);
      flatTocRef.current = flat;
      setToc(flat);

      if (record.locations) {
        try {
          book.locations.load(record.locations);
          setLocationsReady(true);
        } catch {
          /* regenerate below */
        }
      }

      applyTheme(rendition, prefsRef.current);
      // A saved position that no longer fits this book (or never finishes showing) must not trap the reader:
      // fall back to the beginning, and forget a position that is plainly invalid.
      const saved = fromStart.current ? undefined : record.location || undefined;
      let shown = false;
      if (saved && savedTargetValid(book, saved)) {
        try {
          shown = await settlesWithin(displayStable(rendition, saved), RESTORE_TIMEOUT_MS);
        } catch {
          void db().books.update(bookId, { location: undefined }).catch(() => {});
        }
      } else if (saved) {
        void db().books.update(bookId, { location: undefined }).catch(() => {});
      }
      if (cancelled) return;
      if (!shown) await rendition.display();
      if (cancelled) return;
      restoreHighlights(rendition);
      setGestureLayer(forceGestureLayer() || !bookFrameDeliversEvents((rendition.getContents() as unknown as Contents[])[0]));
      setStatus('ready');

      if (!book.locations.length()) {
        // Generate page-accurate progress once, off the critical path, then cache it with the book.
        const idle = (cb: () => void) => ('requestIdleCallback' in window ? window.requestIdleCallback(cb, { timeout: 2000 }) : setTimeout(cb, 600));
        idle(async () => {
          if (cancelled || !book) return;
          try {
            await book.locations.generate(1200);
            if (cancelled) return;
            await db().books.update(bookId, { locations: book.locations.save() as unknown as string });
            setLocationsReady(true);
            lastSaved.current = '';
            savePosition(true);
            const cur = rendition.location as Location | undefined;
            if (cur?.start) setLoc((l) => (l ? { ...l, progress: cur.atEnd ? 1 : book!.locations.percentageFromCfi(cur.start.cfi) } : l));
          } catch {
            /* progress stays chapter-based */
          }
        });
      }
    })().catch((err) => {
      console.error(err);
      if (!cancelled) setStatus('error');
    });

    const onHide = () => savePosition(true);
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      cancelled = true;
      savePosition(true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
      clearTimeout(saveTimer.current);
      renditionRef.current = null;
      bookRef.current = null;
      try {
        book?.destroy();
      } catch {
        /* already gone */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, attempt]);

  // Opening that never finishes becomes a notice with a way forward, not a spinner forever.
  useEffect(() => {
    if (status !== 'loading') return;
    const t = setTimeout(() => setStatus((s) => (s === 'loading' ? 'stalled' : s)), OPEN_STALL_MS);
    return () => clearTimeout(t);
  }, [status, attempt]);

  function retry(beginning: boolean) {
    fromStart.current = beginning;
    firstRelocate.current = true;
    lastSaved.current = '';
    setLoc(null);
    setStatus('loading');
    setAttempt((a) => a + 1);
  }

  const flatTocRef = useRef<FlatToc[]>([]);
  const cfiRef = useRef<{ compare(a: string, b: string): number } | null>(null);
  const swipedAt = useRef(0);

  /**
   * Shows a CFI, then shows it again once the chapter's webfonts have loaded: font loading
   * changes pagination, and the reader must land on the exact passage, not a page number.
   */
  async function displayStable(r: Rendition, target?: string) {
    await r.display(target);
    if (!target) return;
    const docs = (r.getContents() as unknown as Contents[]).map((c) => c.document);
    await Promise.race([Promise.all(docs.map((d) => d.fonts?.ready)), new Promise((res) => setTimeout(res, 1500))]);
    if (renditionRef.current !== r) return;
    await r.display(target);
    // epub.js can land one page early when the target sits on a page boundary: step until it is visible.
    const cmp = cfiRef.current;
    if (!cmp || !target.startsWith('epubcfi(')) return;
    for (let i = 0; i < 3; i++) {
      const cur = r.location as Location | undefined;
      if (!cur?.end?.cfi || renditionRef.current !== r) return;
      if (cmp.compare(target, cur.end.cfi) > 0 && !cur.atEnd) await r.next();
      else if (cmp.compare(target, cur.start.cfi) < 0 && !cur.atStart) await r.prev();
      else return;
    }
  }

  function savedTargetValid(book: EpubBook, target: string) {
    try {
      return !!book.spine.get(target);
    } catch {
      return false;
    }
  }

  function forceGestureLayer() {
    try {
      return new URLSearchParams(window.location.search).get('gestures') === 'layer';
    } catch {
      return false;
    }
  }

  /** Turns the page; a failed turn is logged, never left as an unhandled rejection. */
  function turn(dir: TurnDirection) {
    const r = renditionRef.current;
    if (!r) return;
    (dir === 'next' ? r.next() : r.prev()).catch((err: unknown) => console.warn('Page turn failed', err));
  }

  function hasSelection() {
    const contents = renditionRef.current?.getContents() as unknown as Contents[] | undefined;
    return !!contents?.some((c) => (c.window.getSelection()?.toString() ?? '').trim().length > 0);
  }

  function handleTap(x: number) {
    const action = tapAction(x, window.innerWidth);
    if (action === 'menu') setChrome((c) => !c);
    else turn(action);
  }

  function onKey(e: KeyboardEvent, passive = false) {
    const prevent = () => !passive && e.preventDefault();
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [role="dialog"]')) return;
    const r = renditionRef.current;
    if (!r) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) {
      prevent();
      turn('next');
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) {
      prevent();
      turn('prev');
    } else if (e.key === 'Escape') {
      setChrome((c) => !c);
    }
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // ── Theme & typography ──────────────────────────────────────────────
  function applyTheme(r: Rendition, p: ReaderPrefs) {
    const css = contentCss(p, window.location.origin);
    for (const c of r.getContents() as unknown as Contents[]) {
      const el = c.document.getElementById('booknd-style');
      if (el) el.textContent = css;
    }
  }

  const updatePrefs = useCallback(
    (patch: Partial<ReaderPrefs>) => {
      const next = clampPrefs({ ...prefsRef.current, ...patch });
      const reflow = next.fontSize !== prefsRef.current.fontSize || next.lineHeight !== prefsRef.current.lineHeight || next.font !== prefsRef.current.font || next.margin !== prefsRef.current.margin;
      const themeChanged = next.theme !== prefsRef.current.theme;
      prefsRef.current = next;
      setPrefs(next);
      void setPref('reader', next);
      const r = renditionRef.current;
      if (!r) return;
      const cfi = (r.location as Location | undefined)?.start?.cfi;
      applyTheme(r, next);
      if (themeChanged) restoreHighlights(r);
      if (reflow && cfi) {
        // Reflow keeps the reader on the same passage, not the same page number.
        requestAnimationFrame(() => {
          r.resize(undefined as never, undefined as never);
          void displayStable(r, cfi);
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Margins change the viewer box itself, so let epub.js re-measure.
  useEffect(() => {
    const r = renditionRef.current;
    const cfi = (r?.location as Location | undefined)?.start?.cfi;
    if (r && cfi && status === 'ready') {
      requestAnimationFrame(() => {
        r.resize(undefined as never, undefined as never);
        void displayStable(r, cfi);
      });
    }
  }, [prefs.margin, wide, status]);

  // ── Highlights ──────────────────────────────────────────────────────
  function addHighlightMark(r: Rendition, h: Highlight, fresh = false) {
    const dark = THEMES[prefsRef.current.theme].dark;
    try {
      r.annotations.remove(h.cfi, 'highlight');
    } catch {
      /* none yet */
    }
    r.annotations.highlight(
      h.cfi,
      { id: h.id },
      () => setPanel('notes'),
      fresh && ink.enabled() ? 'bk-hl-new' : 'bk-hl',
      { fill: HIGHLIGHT_FILL[h.color], 'fill-opacity': dark ? '0.45' : '0.34', 'mix-blend-mode': dark ? 'screen' : 'multiply' },
    );
  }
  function restoreHighlights(r: Rendition) {
    for (const h of highlightsRef.current) addHighlightMark(r, h);
  }

  async function createHighlight(color: HighlightColor) {
    const r = renditionRef.current;
    if (!selection || !r) return;
    const exists = highlightsRef.current.find((h) => h.cfi === selection.cfi);
    if (exists) {
      await db().highlights.update(exists.id!, { color });
      exists.color = color;
      addHighlightMark(r, exists);
    } else {
      const h: Highlight = { bookId, cfi: selection.cfi, text: selection.text, color, chapter: chapterRef.current || undefined, createdAt: Date.now() };
      h.id = await db().highlights.add(h);
      highlightsRef.current = [...highlightsRef.current, h];
      addHighlightMark(r, h, true);
    }
    for (const c of r.getContents() as unknown as Contents[]) c.window.getSelection()?.removeAllRanges();
    setSelection(null);
  }

  async function removeHighlight(h: Highlight) {
    await db().highlights.delete(h.id!);
    highlightsRef.current = highlightsRef.current.filter((x) => x.id !== h.id);
    try {
      renditionRef.current?.annotations.remove(h.cfi, 'highlight');
    } catch {
      /* not shown */
    }
  }

  // ── Bookmarks ───────────────────────────────────────────────────────
  const currentBookmark = useMemo(() => {
    if (!loc || !bookRef.current) return undefined;
    // compare CFIs within the visible range
    const cmp = (a: string, b: string) => {
      try {
        return cfiRef.current ? cfiRef.current.compare(a, b) : a.localeCompare(b);
      } catch {
        return a.localeCompare(b);
      }
    };
    return bookmarks.find((b) => b.cfi === loc.cfi || (cmp(b.cfi, loc.cfi) >= 0 && cmp(b.cfi, loc.endCfi) <= 0));
  }, [bookmarks, loc]);

  async function toggleBookmark() {
    if (!loc) return;
    if (currentBookmark) {
      await db().bookmarks.delete(currentBookmark.id!);
      setBookmarks((b) => b.filter((x) => x.id !== currentBookmark.id));
      toast('Bookmark removed.');
    } else {
      let label = chapter || meta?.title || 'Bookmark';
      try {
        const range = await bookRef.current?.getRange(loc.cfi);
        const snippet = range?.toString().replace(/\s+/g, ' ').trim().slice(0, 90);
        if (snippet) label = snippet;
      } catch {
        /* keep chapter label */
      }
      const b: Bookmark = { bookId, cfi: loc.cfi, label, progress: loc.progress, createdAt: Date.now() };
      b.id = await db().bookmarks.add(b);
      setBookmarks((list) => [...list, b]);
      toast('Page bookmarked.');
    }
  }

  // ── Navigation helpers ──────────────────────────────────────────────
  const goTo = useCallback((target: string) => {
    setPanel(null);
    setChrome(false);
    void renditionRef.current?.display(target);
  }, []);

  function close() {
    savePosition(true);
    ink.play({ kind: 'close' });
    router.push('/library/');
  }

  const pct = loc ? Math.round(loc.progress * 100) : 0;
  const margin = wide ? MARGINS[prefs.margin].pxWide : MARGINS[prefs.margin].px;

  return (
    <div
      className={`reader theme-${prefs.theme}`}
      style={{ '--r-bg': theme.bg, '--r-text': theme.text, '--r-muted': theme.muted, '--r-chrome': theme.chrome, '--r-margin': `${margin}px`, '--r-inset': `${Math.max(0, margin - PAGE_GAP / 2)}px`, colorScheme: theme.dark ? 'dark' : 'light' } as React.CSSProperties}
      data-chrome={chrome ? 'on' : 'off'}
    >
      <ThemeColor color={theme.bg} />
      <h1 className="sr-only">{meta ? `${meta.title} by ${meta.author}` : 'Reader'}</h1>

      <div className="reader-running" aria-hidden={chrome}>
        <span className="clamp-1">{chapter || meta?.title}</span>
      </div>

      <div
        className="reader-stage"
        onClick={(e) => {
          // taps in the margins outside the page
          if (e.target === e.currentTarget) handleTap(e.clientX);
        }}
      >
        <div
          ref={viewerRef}
          className="reader-viewer"
          role="document"
          aria-label={meta ? `${meta.title}, ${chapter || ''}` : 'Book'}
          aria-busy={status === 'loading'}
        />
        {gestureLayer && status === 'ready' ? (
          // Takes taps and swipes where the browser won't deliver them into the book (see bookFrameDeliversEvents).
          <div
            className="reader-gestures"
            aria-hidden="true"
            data-testid="reader-gestures"
            onPointerDown={(e) => {
              if (e.isPrimary) layerStart.current = { x: e.clientX, y: e.clientY, t: Date.now() };
            }}
            onPointerCancel={() => (layerStart.current = null)}
            onPointerUp={(e) => {
              const s = layerStart.current;
              layerStart.current = null;
              if (!s || !e.isPrimary) return;
              const end = { x: e.clientX, y: e.clientY, t: Date.now() };
              const dir = swipeDirection(s, end);
              if (dir) turn(dir);
              else if (isTap(s, end)) handleTap(e.clientX);
            }}
          />
        ) : null}
      </div>

      <div className="reader-foot" aria-hidden={chrome}>
        <span>{status === 'ready' && loc ? chapterFooter(loc, loc.atEnd) : ''}</span>
        <span>{status === 'ready' && loc ? `${pct}%` : ''}</span>
        <div className="reader-progress" aria-hidden="true">
          <span style={{ width: `${loc ? loc.progress * 100 : 0}%`, opacity: locationsReady ? 1 : 0.5 }} />
        </div>
      </div>

      {status === 'loading' ? (
        <div className="reader-status" role="status">
          <span className="loader-drop" aria-hidden="true" /> Opening {meta?.title ?? 'book'}…
        </div>
      ) : null}
      {status === 'stalled' ? (
        <div className="reader-status" role="alert">
          <div style={{ display: 'grid', gap: 16, justifyItems: 'center', textAlign: 'center', maxWidth: 360 }}>
            <p className="serif" style={{ fontSize: 20, margin: 0 }}>
              {meta?.title ?? 'This book'} is taking a long time to open.
            </p>
            <p style={{ margin: 0, opacity: 0.75 }}>You can keep waiting, try again, or start from the first page.</p>
            <button className="btn btn-primary" onClick={() => retry(false)}>
              Try again
            </button>
            {meta?.location ? (
              <button className="btn btn-text" style={{ color: 'var(--r-text)' }} onClick={() => retry(true)}>
                Open from the beginning
              </button>
            ) : null}
            <Link href="/library/" className="btn btn-text" style={{ color: 'var(--r-text)' }}>
              Back to library
            </Link>
          </div>
        </div>
      ) : null}
      {status === 'missing' || status === 'error' ? (
        <div className="reader-status" role="alert">
          <div style={{ display: 'grid', gap: 16, justifyItems: 'center', textAlign: 'center', maxWidth: 360 }}>
            <p className="serif" style={{ fontSize: 20, margin: 0 }}>
              {status === 'missing' ? 'This book isn’t in your library.' : 'This book couldn’t be opened.'}
            </p>
            <p style={{ margin: 0, opacity: 0.75 }}>
              {status === 'missing'
                ? 'It may have been removed, or this browser’s data was cleared.'
                : 'The EPUB may be damaged or use features BookNd can’t display yet.'}
            </p>
            <Link href="/library/" className="btn btn-primary">
              Back to library
            </Link>
          </div>
        </div>
      ) : null}

      {flourish && status === 'ready' ? <ChapterFlourish key={flourish.key} label={flourish.label} onDone={() => setFlourish(null)} /> : null}

      {/* Controls: revealed by tapping the centre of the page */}
      <header className="reader-bar top" hidden={!chrome}>
        <button className="icon-btn" onClick={close} aria-label="Back to library">
          <IconBack />
        </button>
        <div className="reader-title">
          <strong className="clamp-1">{meta?.title}</strong>
          <span className="clamp-1">{chapter}</span>
        </div>
        <button className="icon-btn" onClick={toggleBookmark} aria-pressed={!!currentBookmark} aria-label={currentBookmark ? 'Remove bookmark' : 'Bookmark this page'} disabled={status !== 'ready'}>
          <IconBookmark filled={!!currentBookmark} />
        </button>
      </header>
      {/* Always reachable, whatever the book or renderer is doing; the top bar has its own when it is open. */}
      <button className="icon-btn reader-exit" onClick={close} aria-label="Back to library" hidden={chrome}>
        <IconBack />
      </button>
      <nav className="reader-bar bottom" hidden={!chrome} aria-label="Reader tools">
        <div className="scrubber">
          <button className="btn btn-text" onClick={() => turn('prev')} aria-label="Previous page" disabled={loc?.atStart}>
            ‹
          </button>
          <input
            type="range"
            min={0}
            max={1000}
            step={1}
            value={Math.round((loc?.progress ?? 0) * 1000)}
            disabled={!locationsReady}
            aria-label="Position in book"
            aria-valuetext={`${pct}%`}
            onChange={(e) => {
              const b = bookRef.current;
              if (!b?.locations.length()) return;
              const cfi = b.locations.cfiFromPercentage(Number(e.target.value) / 1000);
              if (cfi) void renditionRef.current?.display(cfi);
            }}
          />
          <button className="btn btn-text" onClick={() => turn('next')} aria-label="Next page" disabled={loc?.atEnd}>
            ›
          </button>
        </div>
        <div className="tools">
          <button className="tool" onClick={() => setPanel('toc')} aria-haspopup="dialog">
            <IconList />
            <span>Contents</span>
          </button>
          <button className="tool" onClick={() => setPanel('search')} aria-haspopup="dialog">
            <IconSearch />
            <span>Search</span>
          </button>
          <button className="tool" onClick={() => setPanel('type')} aria-haspopup="dialog">
            <IconType />
            <span>Aa</span>
          </button>
          <button className="tool" onClick={() => setPanel('notes')} aria-haspopup="dialog">
            <IconNotes />
            <span>Notes</span>
          </button>
        </div>
      </nav>

      {selection ? (
        <div className="selection-bar" role="toolbar" aria-label="Selected text">
          <IconHighlight width={20} height={20} aria-hidden />
          {(['oxide', 'sage', 'stone'] as HighlightColor[]).map((c) => (
            <button key={c} className="swatch" style={{ background: HIGHLIGHT_FILL[c] }} onClick={() => createHighlight(c)} aria-label={`Highlight in ${c}`} />
          ))}
          <button
            className="icon-btn"
            aria-label="Copy text"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(selection.text);
                toast('Copied.');
              } catch {
                toast('Copy isn’t available here.', { tone: 'error' });
              }
            }}
          >
            <IconCopy />
          </button>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setSelection(null)}>
            <IconClose />
          </button>
        </div>
      ) : null}

      {panel === 'toc' ? <ContentsSheet toc={toc} currentHref={loc?.href} onPick={goTo} onClose={() => setPanel(null)} /> : null}
      {panel === 'search' && bookRef.current ? <SearchSheet book={bookRef.current} onPick={goTo} onClose={() => setPanel(null)} /> : null}
      {panel === 'type' ? <TypeSheet prefs={prefs} onChange={updatePrefs} onClose={() => setPanel(null)} /> : null}
      {panel === 'notes' ? (
        <NotesSheet
          bookId={bookId}
          bookmarks={bookmarks}
          onDeleteBookmark={async (b) => {
            await db().bookmarks.delete(b.id!);
            setBookmarks((l) => l.filter((x) => x.id !== b.id));
          }}
          onDeleteHighlight={removeHighlight}
          onPick={goTo}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </div>
  );
}

/** Keeps the browser chrome (iOS status bar area) in the reading theme's colour. */
function ThemeColor({ color }: { color: string }) {
  useEffect(() => {
    const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    const prev = metas.map((m) => m.content);
    metas.forEach((m) => (m.content = color));
    return () => metas.forEach((m, i) => (m.content = prev[i]));
  }, [color]);
  return null;
}
