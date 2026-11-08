import { describe, expect, it } from 'vitest';
import { GENRES, genresFor, isCollection, isGenre, matchesSeGenre } from '@/lib/browse';

describe('Discover browse filters', () => {
  it('accepts only known genres and collections', () => {
    expect(isGenre('mystery')).toBe(true);
    expect(isGenre('toString')).toBe(false);
    expect(isGenre('<script>')).toBe(false);
    expect(isCollection('classics')).toBe(true);
    expect(isCollection('favorites')).toBe(true);
    expect(isCollection('constructor')).toBe(false);
  });
  it('offers Standard Ebooks only the genres it publishes', () => {
    const se = genresFor('standard-ebooks');
    expect(se).not.toContain('romance');
    expect(se).not.toContain('history');
    expect(se).toContain('science-fiction');
    expect(genresFor('gutenberg')).toHaveLength(Object.keys(GENRES).length);
  });
  it('matches Standard Ebooks subjects to genres', () => {
    expect(matchesSeGenre(['Science Fiction', 'Fiction'], 'science-fiction')).toBe(true);
    expect(matchesSeGenre(['Children’s'], 'children')).toBe(true);
    expect(matchesSeGenre(['Comedy'], 'humor')).toBe(true);
    expect(matchesSeGenre(['Fiction'], 'mystery')).toBe(false);
    expect(matchesSeGenre(['Romance'], 'romance')).toBe(false);
  });
});
