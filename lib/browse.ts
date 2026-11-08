/**
 * Discover's browse filters: collections (Project Gutenberg) and genres (both catalogs).
 * Kept free of parsing code so the Discover page can import it without pulling in the XML parser.
 */

/** Project Gutenberg collections. Standard Ebooks only publishes its newest releases, so it has none. */
export const COLLECTIONS = {
  favorites: { label: 'Fan favorites', blurb: 'The most-downloaded books on Project Gutenberg right now.' },
  classics: { label: 'Classics', blurb: 'Timeless works by authors born before 1900, most-read first.' },
} as const;
export type Collection = keyof typeof COLLECTIONS;

export interface Genre {
  label: string;
  /** Gutendex `topic` (matched against subjects and bookshelves). */
  gutenberg: string;
  /** Standard Ebooks' subject slug; null when that catalog has no such subject. */
  se: string | null;
}

export const GENRES = {
  adventure: { label: 'Adventure', gutenberg: 'adventure', se: 'adventure' },
  mystery: { label: 'Mystery', gutenberg: 'mystery', se: 'mystery' },
  romance: { label: 'Romance', gutenberg: 'love stories', se: null },
  'science-fiction': { label: 'Science fiction', gutenberg: 'science fiction', se: 'science-fiction' },
  fantasy: { label: 'Fantasy', gutenberg: 'fantasy', se: 'fantasy' },
  horror: { label: 'Horror', gutenberg: 'horror', se: 'horror' },
  humor: { label: 'Humor', gutenberg: 'humor', se: 'comedy' },
  poetry: { label: 'Poetry', gutenberg: 'poetry', se: 'poetry' },
  drama: { label: 'Drama', gutenberg: 'drama', se: 'drama' },
  children: { label: 'Children’s', gutenberg: 'children', se: 'childrens' },
  philosophy: { label: 'Philosophy', gutenberg: 'philosophy', se: 'philosophy' },
  history: { label: 'History', gutenberg: 'history', se: null },
  biography: { label: 'Biography', gutenberg: 'biography', se: 'biography' },
  travel: { label: 'Travel', gutenberg: 'travel', se: 'travel' },
} as const satisfies Record<string, Genre>;
export type GenreId = keyof typeof GENRES;

export function isGenre(v: string | null | undefined): v is GenreId {
  return !!v && Object.prototype.hasOwnProperty.call(GENRES, v);
}
export function isCollection(v: string | null | undefined): v is Collection {
  return !!v && Object.prototype.hasOwnProperty.call(COLLECTIONS, v);
}

/** Genres a catalog can actually filter by. */
export function genresFor(source: 'gutenberg' | 'standard-ebooks'): GenreId[] {
  return (Object.keys(GENRES) as GenreId[]).filter((g) => source === 'gutenberg' || GENRES[g].se !== null);
}

/** Classics: works by authors alive before 1900 (Gutendex `author_year_end`: born on or before this year). */
export const CLASSICS_AUTHOR_YEAR_END = 1899;

/** Whether a Standard Ebooks book's subjects match a genre. */
export function matchesSeGenre(subjects: string[], genre: GenreId) {
  const slug = GENRES[genre].se;
  if (!slug) return false;
  const want = slug.replace(/-/g, ' ').replace(/^childrens$/, "children's");
  return subjects.some((s) => s.toLowerCase().replace(/[’']/g, "'").replace(/-/g, ' ').includes(want.replace(/[’']/g, "'")));
}
