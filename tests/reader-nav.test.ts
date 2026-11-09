import { describe, expect, it } from 'vitest';
import { chapterFooter, chapterState, isTap, readingProgress, settlesWithin, swipeDirection, tapAction } from '@/lib/reader-nav';

const at = (x: number, y = 400, t = 0) => ({ x, y, t });

describe('gestures', () => {
  it('a leftward flick goes forward, a rightward flick goes back', () => {
    expect(swipeDirection(at(300), at(80, 410, 200))).toBe('next');
    expect(swipeDirection(at(80), at(300, 395, 200))).toBe('prev');
  });
  it('short, slow or vertical movements do not turn the page', () => {
    expect(swipeDirection(at(200), at(170, 400, 100))).toBeNull();
    expect(swipeDirection(at(300), at(80, 400, 1200))).toBeNull();
    expect(swipeDirection(at(200, 100), at(140, 500, 200))).toBeNull();
  });
  it('tap zones: edges turn, the centre opens the controls', () => {
    expect(tapAction(20, 390)).toBe('prev');
    expect(tapAction(370, 390)).toBe('next');
    expect(tapAction(195, 390)).toBe('menu');
    // wide screens cap the zone so the centre stays large
    expect(tapAction(300, 1440)).toBe('menu');
  });
  it('a tap barely moves', () => {
    expect(isTap(at(100), at(104, 402, 120))).toBe(true);
    expect(isTap(at(100), at(160, 400, 120))).toBe(false);
  });
});

describe('chapter state', () => {
  it('a cover outside the table of contents makes no claim about chapters', () => {
    const s = chapterState([], '', 1, 1, 1);
    expect(s).toEqual({ label: '', pagesLeft: null, startsHere: false });
    expect(chapterFooter(s, false)).toBe('');
  });
  it('counts pages to the next chapter inside a file that holds many chapters', () => {
    const marks = [
      { label: 'Preface', page: 1 },
      { label: 'Chapter I', page: 20 },
      { label: 'Chapter II', page: 26 },
    ];
    expect(chapterState(marks, '', 3, 3, 194)).toEqual({ label: 'Preface', pagesLeft: 16, startsHere: false });
    expect(chapterState(marks, '', 20, 20, 194)).toEqual({ label: 'Chapter I', pagesLeft: 5, startsHere: true });
    expect(chapterState(marks, '', 25, 25, 194).pagesLeft).toBe(0);
    expect(chapterFooter(chapterState(marks, '', 25, 25, 194), false)).toBe('Last page of chapter');
    expect(chapterState(marks, '', 26, 26, 194)).toEqual({ label: 'Chapter II', pagesLeft: 168, startsHere: true });
  });
  it('two-page spreads count from the right-hand page', () => {
    expect(chapterState([{ label: 'One', page: 1 }], '', 1, 2, 10).pagesLeft).toBe(8);
  });
  it('continues the previous section’s chapter when this one has no entry yet', () => {
    expect(chapterState([{ label: 'Chapter IX', page: 7 }], 'Chapter VIII', 2, 2, 12)).toEqual({ label: 'Chapter VIII', pagesLeft: 4, startsHere: false });
  });
  it('ignores entries whose anchor could not be found', () => {
    expect(chapterState([{ label: 'Lost', page: null }], 'Prev', 1, 1, 3).label).toBe('Prev');
  });
  it('footer wording', () => {
    expect(chapterFooter({ label: 'A', pagesLeft: 1 }, false)).toBe('1 page left in chapter');
    expect(chapterFooter({ label: 'A', pagesLeft: 4 }, false)).toBe('4 pages left in chapter');
    expect(chapterFooter({ label: 'A', pagesLeft: 0 }, true)).toBe('End of book');
  });
});

describe('progress', () => {
  it('prefers generated locations', () => {
    expect(readingProgress({ located: 0.42, spineIndex: 1, spineLength: 9, page: 1, totalPages: 3, atEnd: false })).toBe(0.42);
  });
  it('estimates from section and page before locations exist, so it moves with each turn', () => {
    const a = readingProgress({ spineIndex: 1, spineLength: 9, page: 1, totalPages: 100, atEnd: false });
    const b = readingProgress({ spineIndex: 1, spineLength: 9, page: 50, totalPages: 100, atEnd: false });
    expect(b).toBeGreaterThan(a);
    expect(readingProgress({ spineIndex: 0, spineLength: 9, page: 1, totalPages: 1, atEnd: false })).toBe(0);
  });
  it('the end is 100%', () => {
    expect(readingProgress({ spineIndex: 8, spineLength: 9, page: 1, totalPages: 1, atEnd: true })).toBe(1);
  });
});

describe('settlesWithin', () => {
  it('reports a stalled promise instead of waiting forever', async () => {
    expect(await settlesWithin(new Promise(() => {}), 20)).toBe(false);
    expect(await settlesWithin(Promise.resolve(1), 20)).toBe(true);
    await expect(settlesWithin(Promise.reject(new Error('bad')), 20)).rejects.toThrow('bad');
  });
});
