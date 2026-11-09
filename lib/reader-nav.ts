/**
 * Pure reader logic: gestures, chapter boundaries and progress. Kept out of the component so it can be
 * unit-tested and so the gesture rules are identical whether events come from the book's iframe or from
 * the reader's own gesture layer (used where the browser never delivers events into the sandboxed book).
 */

export type TurnDirection = 'next' | 'prev';
export type TapAction = TurnDirection | 'menu';

export interface PointerMark {
  x: number;
  y: number;
  t: number;
}

/** A horizontal flick turns the page; anything slow, short or mostly vertical does not. */
export function swipeDirection(start: PointerMark, end: PointerMark): TurnDirection | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4 && end.t - start.t < 800) return dx < 0 ? 'next' : 'prev';
  return null;
}

/** A pointer that barely moved is a tap. */
export function isTap(start: PointerMark, end: PointerMark) {
  return Math.abs(end.x - start.x) < 12 && Math.abs(end.y - start.y) < 12 && end.t - start.t < 600;
}

/** Edge taps turn the page; the centre shows the controls. */
export function tapAction(x: number, width: number): TapAction {
  const zone = Math.min(width * 0.3, 260);
  if (x < zone) return 'prev';
  if (x > width - zone) return 'next';
  return 'menu';
}

export interface TocMark {
  label: string;
  /** The 1-based page (column) of the rendered section the entry starts on, or null if it can't be found. */
  page: number | null;
}

export interface ChapterState {
  /** The chapter being read, or '' for front matter that isn't in the table of contents. */
  label: string;
  /** Pages after the visible one(s) before the next chapter begins; null when unknown or not in a chapter. */
  pagesLeft: number | null;
  /** The visible page is the first page of a table-of-contents entry. */
  startsHere: boolean;
}

/**
 * Works out the chapter from where its table-of-contents entries actually landed in the rendered section,
 * so one file that holds many chapters (Project Gutenberg splits books this way) still reports the right
 * chapter and the pages left in it, not in the whole file.
 *
 * `marks` are the TOC entries that point into the current section, in book order; `fallback` is the
 * nearest entry from an earlier section (the chapter this section continues), or ''.
 */
export function chapterState(marks: TocMark[], fallback: string, startPage: number, endPage: number, totalPages: number): ChapterState {
  let label = fallback;
  let startsHere = false;
  let next: number | null = null;
  for (const m of marks) {
    if (m.page === null) continue;
    if (m.page <= startPage) {
      label = m.label;
      startsHere = m.page === startPage;
    } else if (next === null || m.page < next) {
      next = m.page;
    }
  }
  if (!label) return { label: '', pagesLeft: null, startsHere: false };
  const boundary = next ?? totalPages + 1;
  return { label, pagesLeft: Math.max(0, boundary - endPage - 1), startsHere };
}

/** The footer's left label. Empty for front matter and unknown positions rather than a wrong claim. */
export function chapterFooter(state: Pick<ChapterState, 'label' | 'pagesLeft'>, atEnd: boolean) {
  if (atEnd) return 'End of book';
  if (!state.label || state.pagesLeft === null) return '';
  if (state.pagesLeft === 0) return 'Last page of chapter';
  return `${state.pagesLeft} ${state.pagesLeft === 1 ? 'page' : 'pages'} left in chapter`;
}

/**
 * Reading progress, 0–1. Uses the book's generated locations when they exist; until then it estimates
 * from the section and the page within it, so it moves with every page turn instead of sitting at 0%.
 */
export function readingProgress(o: { located?: number; spineIndex: number; spineLength: number; page: number; totalPages: number; atEnd: boolean }) {
  if (o.atEnd) return 1;
  if (o.located !== undefined && Number.isFinite(o.located)) return Math.min(1, Math.max(0, o.located));
  const sections = Math.max(1, o.spineLength);
  const within = o.totalPages > 1 ? (Math.max(1, o.page) - 1) / o.totalPages : 0;
  return Math.min(1, Math.max(0, (Math.max(0, o.spineIndex) + within) / sections));
}

/** Resolves (true) if the promise settles in time, false if it doesn't: a stalled renderer must not trap the reader. */
export async function settlesWithin<T>(p: Promise<T>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((res) => (timer = setTimeout(() => res(false), ms)));
  try {
    return await Promise.race([p.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
